/**
 * Hard constraints. SQL narrows inventory (status, expiry, category subtree, price, quantity,
 * condition, bounding box) and ranks the survivors by vector similarity; `evaluateHardConstraints`
 * then checks every constraint exactly in JS (shared by both matching directions).
 *
 * Rule: a KNOWN violation excludes the listing; an UNKNOWN value passes and is reported.
 * Near-misses only exist for constraints the buyer explicitly relaxed via allowExceptions.
 */
import { and, cosineDistance, desc, eq, gt, gte, inArray, isNull, like, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { listings, type BuyerRequestRow, type ListingRow } from '../../db/schema.js';
import { haversineKm } from '../../infra/geocoder.js';
import { attributeFamilies, attributeDisplay, canonicalAttributeKey, familySimilarity, formatPrice, wantedFamilies } from '../normalize.js';
import { listingPoint, roundDistanceKm } from '../privacy.js';
import { ancestors, dimensionsMatter, getCategory, isInSubtree } from '../taxonomy.js';
import { CONDITION_RANK, type GeoPoint, type ScoreBreakdown } from '../types.js';

/** The parts of a request matching needs; ephemeral searches build this without a DB row. */
export type RequestLike = Pick<
  BuyerRequestRow,
  'id' | 'buyerId' | 'category' | 'hardConstraints' | 'softPreferences' | 'allowExceptions' | 'embedding' | 'version'
>;

export type ConstraintCheck = ScoreBreakdown['constraintChecks'][number];

export interface Evaluation {
  /** False when a known value violates a constraint that was not relaxed. */
  pass: boolean;
  /** Passes only thanks to an exception the buyer allowed (budget/distance). */
  nearMiss: boolean;
  checks: ConstraintCheck[];
  /** Human-readable unknowns ("dimensions not stated"). */
  unknowns: string[];
  /** Listing fields whose absence left a hard constraint unverified (for seller info requests). */
  unknownFields: string[];
  /** Exact distance in km (server-side only), null when not computable. */
  distanceKm: number | null;
  /** True when the listing's location is area-level only (no address given). */
  approximateLocation: boolean;
}

/** Extra tolerance for listings whose location is only an area (city/district centroid). */
export const APPROX_LOCATION_SLACK_KM = 1;
/** Values inferred by the model with low confidence are treated as unknown for hard constraints. */
const MIN_INFERRED_CONFIDENCE = 0.5;
export const CANDIDATE_LIMIT = 50;

const DIM_AXES = [
  ['widthCm', 'width_cm', 'width'],
  ['depthCm', 'depth_cm', 'depth'],
  ['heightCm', 'height_cm', 'height'],
] as const;

function knownFamilies(listing: ListingRow, attribute: string): string[] | null {
  const av = listing.attributes[canonicalAttributeKey(attribute)];
  if (!av) return null;
  if (av.source.startsWith('ai_') && av.confidence != null && av.confidence < MIN_INFERRED_CONFIDENCE) return null;
  return attributeFamilies(listing.attributes, attribute);
}

function knownNumber(listing: ListingRow, key: string): number | null {
  const av = listing.attributes[key];
  if (!av || typeof av.value !== 'number') return null;
  if (av.source.startsWith('ai_') && av.confidence != null && av.confidence < MIN_INFERRED_CONFIDENCE) return null;
  return av.value;
}

const humanAttr = (a: string) => canonicalAttributeKey(a).replace(/_/g, ' ');

export function evaluateHardConstraints(listing: ListingRow, req: RequestLike): Evaluation {
  const hc = req.hardConstraints ?? {};
  const ex = req.allowExceptions ?? {};
  const checks: ConstraintCheck[] = [];
  const unknowns: string[] = [];
  const unknownFields: string[] = [];
  let pass = true;
  let nearMiss = false;
  const unknown = (constraint: string, detail: string, field: string) => {
    checks.push({ constraint, ok: null, detail });
    unknowns.push(detail);
    unknownFields.push(field);
  };

  // Listings in active inventory must be within the request's category subtree. A listing filed
  // under a broader category ("seating" when the buyer wants "dining chair") passes as unverified.
  if (req.category && !isInSubtree(req.category, listing.category)) {
    if (listing.category && ancestors(req.category).includes(listing.category) && (getCategory(listing.category)?.depth ?? 0) >= 2) {
      unknown('category', `exact type not stated (listed as ${getCategory(listing.category)?.label.toLowerCase()})`, 'category');
    } else {
      checks.push({ constraint: 'category', ok: false, detail: 'different category' });
      pass = false;
    }
  }

  // Price (per unit).
  if (hc.maxPriceCents != null || hc.minPriceCents != null) {
    const cur = hc.currency ?? 'EUR';
    if (listing.priceCents == null) unknown('price', 'price not stated', 'price');
    else if (listing.currency !== cur) {
      checks.push({ constraint: 'price', ok: false, detail: `priced in ${listing.currency}, budget in ${cur}` });
      pass = false;
    } else {
      const p = listing.priceCents;
      const max = hc.maxPriceCents;
      if (hc.minPriceCents != null && p < hc.minPriceCents) {
        checks.push({ constraint: 'min_price', ok: false, detail: `${formatPrice(p, cur)}, below your minimum` });
        pass = false;
      }
      if (max != null) {
        const allowed = ex.budgetPct ? Math.floor(max * (1 + ex.budgetPct / 100)) : max;
        if (p <= max) checks.push({ constraint: 'price', ok: true, detail: `${formatPrice(p, cur)}, within your ${formatPrice(max, cur)} budget` });
        else if (p <= allowed) {
          const pct = Math.round(((p - max) / max) * 100);
          checks.push({ constraint: 'price', ok: false, detail: `${formatPrice(p, cur)}, ${pct}% over your ${formatPrice(max, cur)} budget` });
          nearMiss = true;
        } else {
          checks.push({ constraint: 'price', ok: false, detail: `${formatPrice(p, cur)}, over your ${formatPrice(max, cur)} budget` });
          pass = false;
        }
      }
    }
  }

  // Distance: exact coordinates when known, otherwise the public area point.
  const point = listingPoint(listing);
  const approximateLocation = listing.exactAddress == null;
  const distanceKm = hc.origin && point ? haversineKm(hc.origin, point) : null;
  if (hc.origin && hc.maxDistanceKm != null) {
    const max = hc.maxDistanceKm;
    if (distanceKm == null) unknown('distance', 'location not stated', 'location');
    else {
      const shown = roundDistanceKm(distanceKm);
      const slack = approximateLocation ? APPROX_LOCATION_SLACK_KM : 0;
      if (distanceKm <= max) checks.push({ constraint: 'distance', ok: true, detail: `~${shown} km away` });
      else if (distanceKm <= max + slack) {
        unknown('distance', `location approximate (~${shown} km, you said ${max} km)`, 'location');
      } else if (ex.distanceKm && distanceKm <= max + ex.distanceKm + slack) {
        checks.push({ constraint: 'distance', ok: false, detail: `~${shown} km away, beyond your ${max} km` });
        nearMiss = true;
      } else {
        checks.push({ constraint: 'distance', ok: false, detail: `~${shown} km away, beyond your ${max} km` });
        pass = false;
      }
    }
  }

  // Quantity: only meaningful when the seller actually stated how many they have.
  const needed = hc.quantity ?? 1;
  if (needed > 1) {
    const stated = listing.attributes.quantity != null;
    if (!stated && listing.quantity < needed) unknown('quantity', `quantity not stated (you need ${needed})`, 'quantity');
    else if (listing.quantity >= needed) checks.push({ constraint: 'quantity', ok: true, detail: `${listing.quantity} available` });
    else {
      checks.push({ constraint: 'quantity', ok: false, detail: `only ${listing.quantity} available, you need ${needed}` });
      pass = false;
    }
  }

  // Condition.
  if (hc.minCondition) {
    const min = CONDITION_RANK[hc.minCondition];
    if (listing.conditionRank == null) unknown('condition', 'condition not stated', 'condition');
    else if (listing.conditionRank >= min) checks.push({ constraint: 'condition', ok: true, detail: `condition ${listing.condition?.value ?? 'ok'}` });
    else {
      checks.push({ constraint: 'condition', ok: false, detail: `condition ${listing.condition?.value} is below ${hc.minCondition}` });
      pass = false;
    }
  }

  // Dimensions.
  const bounds = [hc.maxDimensionsCm, hc.minDimensionsCm];
  if (bounds.some((b) => b && Object.values(b).some((v) => v != null))) {
    const missing: string[] = [];
    for (const [boundKey, attrKey, label] of DIM_AXES) {
      const maxV = hc.maxDimensionsCm?.[boundKey];
      const minV = hc.minDimensionsCm?.[boundKey];
      if (maxV == null && minV == null) continue;
      const v = knownNumber(listing, attrKey);
      if (v == null) {
        missing.push(label);
        continue;
      }
      if ((maxV != null && v > maxV) || (minV != null && v < minV)) {
        checks.push({ constraint: `dimensions.${label}`, ok: false, detail: `${label} ${v} cm is outside your limit` });
        pass = false;
      } else checks.push({ constraint: `dimensions.${label}`, ok: true, detail: `${label} ${v} cm fits` });
    }
    if (missing.length) unknown('dimensions', `${missing.join('/')} not stated`, 'dimensions');
  } else if (dimensionsMatter(listing.category) && !DIM_AXES.some(([, k]) => listing.attributes[k] != null)) {
    // Informational: furniture without measurements is worth flagging even without explicit bounds.
    unknowns.push('dimensions not stated');
  }

  // Required attribute values.
  for (const r of hc.requiredAttributes ?? []) {
    const found = knownFamilies(listing, r.attribute);
    const name = humanAttr(r.attribute);
    if (!found) {
      unknown(`required.${name}`, `${name} not stated`, canonicalAttributeKey(r.attribute));
      continue;
    }
    const sim = familySimilarity(r.attribute, wantedFamilies(r.attribute, r.values), found);
    const shown = attributeDisplay(listing.attributes, r.attribute);
    if (sim >= 1) checks.push({ constraint: `required.${name}`, ok: true, detail: `${name}: ${shown}` });
    else {
      checks.push({ constraint: `required.${name}`, ok: false, detail: `${name} is ${shown}, you need ${r.values.join('/')}` });
      pass = false;
    }
  }

  // Excluded attribute values.
  for (const r of hc.excludedAttributes ?? []) {
    const found = knownFamilies(listing, r.attribute);
    const name = humanAttr(r.attribute);
    if (!found) {
      unknown(`excluded.${name}`, `${name} not stated (you don't want ${r.values.join('/')})`, canonicalAttributeKey(r.attribute));
      continue;
    }
    const hit = familySimilarity(r.attribute, wantedFamilies(r.attribute, r.values), found) >= 1;
    if (hit) {
      checks.push({ constraint: `excluded.${name}`, ok: false, detail: `${name} is ${attributeDisplay(listing.attributes, r.attribute)}` });
      pass = false;
    } else checks.push({ constraint: `excluded.${name}`, ok: true, detail: `${name} not ${r.values.join('/')}` });
  }

  return { pass, nearMiss: pass && nearMiss, checks, unknowns, unknownFields, distanceKm, approximateLocation };
}

/** SQL fragment: listing category is within the requested subtree (or a generic ancestor at depth ≥ 2). */
function categoryCondition(category: string): SQL {
  const generic = ancestors(category).filter((a) => (getCategory(a)?.depth ?? 0) >= 2);
  const parts = [eq(listings.category, category), like(listings.category, `${category}/%`)];
  if (generic.length) parts.push(inArray(listings.category, generic));
  return or(...parts)!;
}

export interface Candidate {
  row: ListingRow;
  /** Raw cosine similarity to the request embedding (null if either side has no embedding). */
  cosine: number | null;
}

/**
 * Active, unexpired listings admitted by the SQL-checkable constraints, top `limit` by vector
 * similarity. Excludes the viewer's own listings and listings dismissed for this request.
 */
export async function findCandidates(
  req: RequestLike,
  opts: { viewerId: string; limit?: number; persisted: boolean },
): Promise<Candidate[]> {
  const hc = req.hardConstraints ?? {};
  const ex = req.allowExceptions ?? {};
  const conds: (SQL | undefined)[] = [
    eq(listings.status, 'active'),
    or(isNull(listings.expiresAt), gt(listings.expiresAt, new Date())),
    ne(listings.sellerId, opts.viewerId),
  ];
  if (req.category) conds.push(categoryCondition(req.category));
  if (hc.maxPriceCents != null) {
    const allowed = ex.budgetPct ? Math.floor(hc.maxPriceCents * (1 + ex.budgetPct / 100)) : hc.maxPriceCents;
    conds.push(or(isNull(listings.priceCents), and(eq(listings.currency, hc.currency ?? 'EUR'), lte(listings.priceCents, allowed))));
  }
  if (hc.minPriceCents != null) conds.push(or(isNull(listings.priceCents), gte(listings.priceCents, hc.minPriceCents)));
  const needed = hc.quantity ?? 1;
  if (needed > 1) conds.push(or(gte(listings.quantity, needed), sql`${listings.attributes}->'quantity' IS NULL`));
  if (hc.minCondition) conds.push(or(isNull(listings.conditionRank), gte(listings.conditionRank, CONDITION_RANK[hc.minCondition])));
  if (hc.origin && hc.maxDistanceKm != null) conds.push(boundingBox(hc.origin, hc.maxDistanceKm + Math.max(ex.distanceKm ?? 0, 0) + APPROX_LOCATION_SLACK_KM));
  if (opts.persisted) {
    conds.push(sql`NOT EXISTS (SELECT 1 FROM matches m WHERE m.listing_id = ${listings.id} AND m.request_id = ${req.id} AND m.status = 'dismissed')`);
  }

  const emb = req.embedding;
  const distance = emb ? cosineDistance(listings.embedding, emb) : null;
  return db.transaction(async (tx) => {
    // Let HNSW keep scanning when filters discard many neighbours (pgvector ≥ 0.8).
    // No-op on older pgvector versions where the setting doesn't exist.
    if (emb) {
      await tx.execute(
        sql`SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true) WHERE current_setting('hnsw.iterative_scan', true) IS NOT NULL`,
      );
    }
    const rows = await tx
      .select({ row: listings, cosine: distance ? sql<number | null>`1 - (${distance})` : sql<null>`NULL` })
      .from(listings)
      .where(and(...conds))
      .orderBy(...(distance ? [sql`${distance} ASC NULLS LAST`] : [desc(listings.publishedAt)]))
      .limit(opts.limit ?? CANDIDATE_LIMIT);
    return rows.map((r) => ({ row: r.row, cosine: r.cosine == null ? null : Number(r.cosine) }));
  });
}

function boundingBox(origin: GeoPoint, radiusKm: number): SQL {
  const dLat = radiusKm / 111.32;
  const dLng = radiusKm / (111.32 * Math.max(Math.cos((origin.lat * Math.PI) / 180), 0.01));
  const lat = sql`COALESCE(${listings.exactLat}, ${listings.publicLat})`;
  const lng = sql`COALESCE(${listings.exactLng}, ${listings.publicLng})`;
  // Listings without coordinates pass (distance unknown) and are reported as such.
  return sql`(${lat} IS NULL OR (${lat} BETWEEN ${origin.lat - dLat} AND ${origin.lat + dLat} AND ${lng} BETWEEN ${origin.lng - dLng} AND ${origin.lng + dLng}))`;
}
