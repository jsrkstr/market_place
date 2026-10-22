/**
 * Listings: create/update/publish/status, completeness and missing fields, dedupe, demand signals
 * and price guidance. The model supplies structured attributes with provenance; this service
 * validates, normalises and persists them and never fills in unknown values.
 */
import { createHash } from 'node:crypto';
import { and, asc, cosineDistance, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { buyerRequests, interests, listingImages, listings, matches, messages, type ListingRow } from '../db/schema.js';
import { embedOne } from '../infra/embeddings.js';
import { coarsen } from '../infra/geocoder.js';
import { dispatch } from '../infra/jobs.js';
import { forbidden, invalid, notFound } from './errors.js';
import { logEvent } from './events.js';
import {
  canonicalAttributeKey,
  familyLabel,
  formatPrice,
  isNormalizedValue,
  normalizeAttributes,
  normalizeCurrency,
  parseCondition,
  vocabularyFor,
} from './normalize.js';
import { toOwnerView, toPublicListingView, type ListingImageRow } from './privacy.js';
import { categoryLabel, dimensionsMatter, getCategory, resolveCategory } from './taxonomy.js';
import { CONDITION_RANK } from './types.js';
import { resolveLocation } from './users.service.js';
import type {
  Attributes,
  AttributeValue,
  Condition,
  ListingOwnerView,
  ListingStatus,
  LocationInput,
  MissingField,
  PriceGuidance,
  PublicListingView,
  UserContext,
} from './types.js';

export interface ListingInput {
  /** The seller's own words (text or transcribed voice), stored verbatim. */
  rawText?: string;
  title?: string;
  description?: string;
  /** Category slug or free text; normalised against the taxonomy. */
  category?: string;
  attributes?: Attributes;
  /** Seller's asking price. null = explicitly unknown. */
  priceCents?: number | null;
  currency?: string;
  /** Model-provided estimate (always labelled ai_estimated). */
  priceEstimate?: { lowCents: number; highCents: number } | null;
  condition?: AttributeValue<Condition> | null;
  quantity?: number;
  location?: LocationInput;
  pickupOptions?: string[];
  /** Photo captions/observations from the model, merged into description signals for embeddings. */
  imageObservations?: string[];
}

export interface CreateListingResult {
  listing: ListingOwnerView;
  published: boolean;
  /** Reasons a publish request was not honoured (e.g. "location is required"). */
  publishBlockers: string[];
  missingFields: MissingField[];
  priceGuidance: PriceGuidance | null;
  /** Set when an existing listing by the same seller looks like the same item; no new listing was created. */
  duplicateOf: string | null;
}

export type ListingStatusAction = 'pause' | 'reactivate' | 'mark_sold' | 'withdraw' | 'confirm_available';

export interface ListingDemand {
  listingId: string;
  /** Computed: active saved requests whose constraints this listing satisfies or might satisfy. NOT buyer interest. */
  possibleMatches: number;
  /** Of possibleMatches, how many are blocked only by missing info on the listing. */
  possibleMatchesNeedingInfo: number;
  /** Explicit: buyers who pressed "interested". */
  interestedBuyers: number;
  pendingInterests: { interestId: string; message: string | null; createdAt: string }[];
  /** Missing fields that would firm up possible matches, most valuable first. */
  suggestedFields: MissingField[];
  note: string;
}


const LISTING_TTL_DAYS = 60;
const DAY_MS = 86_400_000;
const NON_TERMINAL: ListingStatus[] = ['draft', 'active', 'paused'];
const DUPLICATE_COSINE = 0.95;

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

interface Prepared {
  rawText: string | null;
  title: string | null;
  description: string | null;
  category: string | null;
  attributes: Attributes;
  priceCents: number | null;
  currency: string;
  priceSource: 'seller' | 'ai_estimate' | null;
  priceEstimateLowCents: number | null;
  priceEstimateHighCents: number | null;
  condition: AttributeValue<Condition> | null;
  conditionRank: number | null;
  quantity: number;
  pickupOptions: string[];
}

const clean = (s: string | null | undefined) => (s == null ? null : s.trim() || null);

function resolveListingCategory(category: string | undefined | null, ...fallbacks: (string | null | undefined)[]): string | null {
  if (category) return resolveCategory(category) ?? resolveFirst(fallbacks) ?? 'other';
  return resolveFirst(fallbacks);
}

function resolveFirst(texts: (string | null | undefined)[]): string | null {
  for (const t of texts) {
    const c = resolveCategory(t);
    if (c) return c;
  }
  return null;
}

function normalizeCondition(c: AttributeValue<Condition> | null | undefined): AttributeValue<Condition> | null {
  if (!c || c.value == null) return null;
  const value = parseCondition(String(c.value));
  if (!value) return null;
  return { value, source: c.source ?? 'seller_stated', ...(c.confidence != null ? { confidence: c.confidence } : {}) };
}

/** Merge a patch onto an existing listing (or nothing, for creation) and normalise the result. */
function prepare(input: ListingInput, base?: ListingRow): Prepared {
  const has = <K extends keyof ListingInput>(k: K) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined;

  let attributes: Attributes = base ? { ...base.attributes } : {};
  if (input.attributes) {
    for (const [k, v] of Object.entries(input.attributes)) {
      const key = canonicalAttributeKey(k);
      if (!v || v.value == null || v.value === '') delete attributes[key]; // explicit null clears a value
    }
    attributes = { ...attributes, ...normalizeAttributes(input.attributes) };
  }
  if (input.imageObservations?.length) {
    const prev = (attributes.image_observations?.value as string[] | undefined) ?? [];
    const obs = [...new Set([...prev, ...input.imageObservations.map((o) => o.trim()).filter(Boolean)])];
    attributes.image_observations = { value: obs, source: 'ai_inferred' };
  }

  let quantity = base?.quantity ?? 1;
  if (has('quantity') && input.quantity != null) {
    if (!Number.isInteger(input.quantity) || input.quantity < 1) throw invalid('quantity must be a positive whole number');
    quantity = input.quantity;
    attributes.quantity = { value: quantity, source: 'seller_stated' };
  }

  const title = has('title') ? clean(input.title) : (base?.title ?? null);
  const description = has('description') ? clean(input.description) : (base?.description ?? null);
  const rawText = has('rawText') ? clean(input.rawText) : (base?.rawText ?? null);
  const category = has('category')
    ? resolveListingCategory(input.category, title, rawText)
    : (base?.category ?? resolveListingCategory(null, title, rawText));

  let priceCents = base?.priceCents ?? null;
  if (has('priceCents') || input.priceCents === null) {
    if (input.priceCents != null && (!Number.isInteger(input.priceCents) || input.priceCents < 0)) throw invalid('priceCents must be a non-negative integer');
    priceCents = input.priceCents ?? null;
  }
  let estLow = base?.priceEstimateLowCents ?? null;
  let estHigh = base?.priceEstimateHighCents ?? null;
  if (has('priceEstimate') || input.priceEstimate === null) {
    estLow = input.priceEstimate?.lowCents ?? null;
    estHigh = input.priceEstimate?.highCents ?? null;
    if (estLow != null && estHigh != null && estLow > estHigh) [estLow, estHigh] = [estHigh, estLow];
  }

  const condition = has('condition') || input.condition === null ? normalizeCondition(input.condition) : (base?.condition ?? null);
  return {
    rawText,
    title,
    description,
    category,
    attributes,
    priceCents,
    currency: has('currency') ? normalizeCurrency(input.currency) : (base?.currency ?? 'EUR'),
    priceSource: priceCents != null ? 'seller' : null,
    priceEstimateLowCents: estLow,
    priceEstimateHighCents: estHigh,
    condition,
    conditionRank: condition ? CONDITION_RANK[condition.value] : null,
    quantity,
    pickupOptions: has('pickupOptions') ? (input.pickupOptions ?? []).map((p) => p.trim()).filter(Boolean) : (base?.pickupOptions ?? []),
  };
}

function attributeText(attrs: Attributes): string[] {
  const out: string[] = [];
  for (const [key, av] of Object.entries(attrs)) {
    if (key === 'image_observations' || key === 'quantity') continue;
    const vocab = vocabularyFor(key);
    const value = Array.isArray(av.value) ? av.value.join(', ') : String(av.value);
    const families = vocab && isNormalizedValue(av) ? av.normalized.map((f) => familyLabel(vocab, f)).filter((f) => !value.includes(f)) : [];
    out.push(`${key.replace(/_/g, ' ')}: ${value}${families.length ? ` (${families.join(', ')})` : ''}`);
  }
  return out;
}

/** Title + category + normalised attributes + description + photo observations. */
function embeddingText(p: Prepared): string {
  const obs = (p.attributes.image_observations?.value as string[] | undefined) ?? [];
  return [p.title, categoryLabel(p.category), ...attributeText(p.attributes), p.condition ? `condition: ${p.condition.value}` : null, p.description, ...obs]
    .filter(Boolean)
    .join('\n');
}

function contentHash(p: Prepared): string {
  const attrs = Object.keys(p.attributes)
    .filter((k) => k !== 'image_observations')
    .sort()
    .map((k) => [k, p.attributes[k].value]);
  const payload = JSON.stringify([p.title?.toLowerCase(), p.category, p.description?.toLowerCase(), attrs, p.priceCents, p.condition?.value, p.quantity]);
  return createHash('sha256').update(payload).digest('hex');
}

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

interface FieldRule {
  field: string;
  value: number;
  reason: string;
  applies?: (p: Prepared) => boolean;
  present: (p: Prepared, ctx: { hasLocation: boolean; photoCount: number }) => boolean;
}

const hasAttr = (p: Prepared, ...keys: string[]) => keys.some((k) => p.attributes[k] != null);

const FIELD_RULES: FieldRule[] = [
  { field: 'title', value: 1, reason: 'A short title is required to publish.', present: (p) => !!p.title },
  { field: 'category', value: 1, reason: 'Say what the item is so it can be matched with buyers.', present: (p) => !!p.category },
  { field: 'price', value: 0.95, reason: 'An asking price is required to publish, and buyers filter by budget.', present: (p) => p.priceCents != null },
  {
    field: 'location',
    value: 0.9,
    reason: 'A rough area (district or postcode) is required to publish and lets nearby buyers find it. The exact address stays private.',
    present: (_p, c) => c.hasLocation,
  },
  { field: 'photos', value: 0.8, reason: 'Photos let buyers check the look and condition; listings without them get far less interest.', present: (_p, c) => c.photoCount > 0 },
  {
    field: 'dimensions',
    value: 0.7,
    reason: 'Buyers filter furniture by size; give width × depth × height in cm.',
    applies: (p) => dimensionsMatter(p.category),
    present: (p) => hasAttr(p, 'width_cm', 'depth_cm', 'height_cm'),
  },
  { field: 'condition', value: 0.6, reason: 'Many buyers set a minimum condition; listings without one only show as "condition not stated".', present: (p) => !!p.condition },
  { field: 'colour', value: 0.5, reason: 'Colour is one of the most common buyer preferences.', present: (p) => hasAttr(p, 'colour') },
  { field: 'material', value: 0.4, reason: 'Material (e.g. solid wood, metal, velvet) helps buyers with specific tastes.', present: (p) => hasAttr(p, 'material') },
  { field: 'brand', value: 0.3, reason: 'Brand and model help buyers searching for a specific item.', present: (p) => hasAttr(p, 'brand', 'model') },
];

function computeCompleteness(p: Prepared, ctx: { hasLocation: boolean; photoCount: number }): { completeness: number; missingFields: MissingField[] } {
  let total = 0;
  let got = 0;
  const missingFields: MissingField[] = [];
  for (const r of FIELD_RULES) {
    if (r.applies && !r.applies(p)) continue;
    total += r.value;
    if (r.present(p, ctx)) got += r.value;
    else missingFields.push({ field: r.field, reason: r.reason, value: r.value });
  }
  missingFields.sort((a, b) => b.value - a.value);
  return { completeness: total ? Math.round((got / total) * 100) / 100 : 0, missingFields };
}

function publishBlockersFor(p: { title: string | null; category: string | null; priceCents: number | null; priceEstimateLowCents?: number | null; priceEstimateHighCents?: number | null; currency: string }, hasLocation: boolean): string[] {
  const b: string[] = [];
  if (!p.title) b.push('A title is required.');
  if (!p.category) b.push('A category is required (what is the item?).');
  if (!hasLocation) b.push('A location (city, district or postcode) is required.');
  if (p.priceCents == null) {
    const est =
      p.priceEstimateLowCents != null && p.priceEstimateHighCents != null
        ? ` The estimate ${formatPrice(p.priceEstimateLowCents, p.currency)}–${formatPrice(p.priceEstimateHighCents, p.currency)} is only a suggestion; the seller must confirm a price.`
        : '';
    b.push(`An asking price from the seller is required.${est}`);
  }
  return b;
}

// ---------------------------------------------------------------------------
// Loading & views
// ---------------------------------------------------------------------------

async function imagesFor(listingId: string): Promise<ListingImageRow[]> {
  return db.select().from(listingImages).where(eq(listingImages.listingId, listingId)).orderBy(asc(listingImages.position));
}

async function loadListing(listingId: string): Promise<ListingRow> {
  const [row] = await db.select().from(listings).where(eq(listings.id, listingId));
  if (!row) throw notFound('Listing');
  return row;
}

async function loadOwned(ctx: UserContext, listingId: string): Promise<ListingRow> {
  const row = await loadListing(listingId);
  if (row.sellerId !== ctx.userId) throw forbidden();
  return row;
}

const hasLoc = (row: Pick<ListingRow, 'publicLat' | 'publicLng'>) => row.publicLat != null && row.publicLng != null;

function preparedFromRow(row: ListingRow): Prepared {
  return {
    rawText: row.rawText,
    title: row.title,
    description: row.description,
    category: row.category,
    attributes: row.attributes,
    priceCents: row.priceCents,
    currency: row.currency,
    priceSource: row.priceSource,
    priceEstimateLowCents: row.priceEstimateLowCents,
    priceEstimateHighCents: row.priceEstimateHighCents,
    condition: row.condition,
    conditionRank: row.conditionRank,
    quantity: row.quantity,
    pickupOptions: row.pickupOptions,
  };
}

async function buildResult(row: ListingRow, opts: { publishBlockers?: string[]; duplicateOf?: string | null } = {}): Promise<CreateListingResult> {
  const images = await imagesFor(row.id);
  const priceGuidance = await getPriceGuidance({
    category: row.category ?? undefined,
    condition: row.condition?.value,
    currency: row.currency,
    modelEstimate:
      row.priceEstimateLowCents != null && row.priceEstimateHighCents != null
        ? { lowCents: row.priceEstimateLowCents, highCents: row.priceEstimateHighCents }
        : null,
    excludeListingId: row.id,
  });
  return {
    listing: toOwnerView(row, images),
    published: row.status === 'active',
    publishBlockers: opts.publishBlockers ?? [],
    missingFields: row.missingFields,
    priceGuidance,
    duplicateOf: opts.duplicateOf ?? null,
  };
}

const plusDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS);

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function createListing(
  ctx: UserContext,
  input: ListingInput & { publish?: boolean; idempotencyKey?: string },
): Promise<CreateListingResult> {
  if (input.idempotencyKey) {
    const [existing] = await db
      .select()
      .from(listings)
      .where(and(eq(listings.sellerId, ctx.userId), eq(listings.idempotencyKey, input.idempotencyKey)));
    if (existing) return buildResult(existing);
  }

  const p = prepare(input);
  const loc = await resolveUserLocation(input.location);
  const text = embeddingText(p);
  const embedding = await embedOne(text);
  const hash = contentHash(p);

  // Dedupe against the seller's own non-terminal listings in the same category.
  const dupConds: SQL[] = [
    eq(listings.sellerId, ctx.userId),
    inArray(listings.status, NON_TERMINAL),
    p.category ? eq(listings.category, p.category) : isNull(listings.category),
  ];
  const [dup] = await db
    .select()
    .from(listings)
    .where(and(...dupConds, or(eq(listings.contentHash, hash), sql`1 - (${cosineDistance(listings.embedding, embedding)}) > ${DUPLICATE_COSINE}`)))
    .limit(1);
  if (dup) {
    return buildResult(dup, {
      duplicateOf: dup.id,
      publishBlockers: input.publish ? [`A very similar listing already exists (${dup.id}); update that one instead of creating a new one.`] : [],
    });
  }

  const blockers = publishBlockersFor(p, !!loc);
  const publish = !!input.publish && blockers.length === 0;
  const now = new Date();
  const { completeness, missingFields } = computeCompleteness(p, { hasLocation: !!loc, photoCount: 0 });
  const pub = loc ? coarsen(loc) : null;
  const values = {
    id: newId('lst'),
    sellerId: ctx.userId,
    status: (publish ? 'active' : 'draft') as ListingStatus,
    ...p,
    exactLat: loc?.lat ?? null,
    exactLng: loc?.lng ?? null,
    exactAddress: clean(input.location?.exactAddress),
    publicLat: pub?.lat ?? null,
    publicLng: pub?.lng ?? null,
    areaLabel: loc?.label ?? null,
    completeness,
    missingFields,
    availabilityConfirmedAt: publish ? now : null,
    publishedAt: publish ? now : null,
    expiresAt: publish ? plusDays(now, LISTING_TTL_DAYS) : null,
    embedding,
    contentHash: hash,
    idempotencyKey: input.idempotencyKey ?? null,
  };
  const [row] = await db.insert(listings).values(values).onConflictDoNothing().returning();
  if (!row) {
    // Lost an idempotency race: return the listing the concurrent call created.
    const [existing] = await db
      .select()
      .from(listings)
      .where(and(eq(listings.sellerId, ctx.userId), eq(listings.idempotencyKey, input.idempotencyKey ?? '')));
    if (existing) return buildResult(existing);
    throw invalid('Could not create the listing');
  }

  await logEvent({ type: 'listing_created', actorId: ctx.userId, listingId: row.id, data: { category: row.category, completeness } });
  if (publish) {
    await logEvent({ type: 'listing_published', actorId: ctx.userId, listingId: row.id });
    await dispatch('listing.changed', { listingId: row.id, reason: 'published' });
  }
  return buildResult(row, { publishBlockers: input.publish ? blockers : row.status === 'draft' ? blockers : [] });
}

async function resolveUserLocation(loc: LocationInput | undefined) {
  if (!loc) return null;
  return resolveLocation(loc);
}

export async function updateListing(ctx: UserContext, listingId: string, patch: ListingInput): Promise<CreateListingResult> {
  const row = await loadOwned(ctx, listingId);
  if (row.status === 'sold' || row.status === 'withdrawn') throw invalid(`This listing is ${row.status} and can no longer be edited.`);

  const p = prepare(patch, row);
  let locPatch: Partial<ListingRow> = {};
  if (patch.location) {
    const loc = await resolveLocation(patch.location);
    if (loc) {
      const pub = coarsen(loc);
      locPatch = {
        exactLat: loc.lat,
        exactLng: loc.lng,
        exactAddress: clean(patch.location.exactAddress),
        publicLat: pub.lat,
        publicLng: pub.lng,
        areaLabel: loc.label,
      };
    }
  }
  const located = hasLoc({ publicLat: locPatch.publicLat ?? row.publicLat, publicLng: locPatch.publicLng ?? row.publicLng });
  const blockers = publishBlockersFor(p, located);
  if (row.status === 'active' && blockers.length) {
    throw invalid(`An active listing must keep these details: ${blockers.join(' ')} Pause the listing first if needed.`);
  }

  const before = embeddingText(preparedFromRow(row));
  const text = embeddingText(p);
  const hash = contentHash(p);
  const locationChanged = Object.keys(locPatch).length > 0 && (locPatch.exactLat !== row.exactLat || locPatch.exactLng !== row.exactLng);
  const changed = hash !== row.contentHash || text !== before || locationChanged || JSON.stringify(p.pickupOptions) !== JSON.stringify(row.pickupOptions);
  if (!changed) return buildResult(row, { publishBlockers: row.status === 'draft' ? blockers : [] });

  const photoCount = (await imagesFor(row.id)).length;
  const { completeness, missingFields } = computeCompleteness(p, { hasLocation: located, photoCount });
  const embedding = text !== before || !row.embedding ? await embedOne(text) : row.embedding;
  const [updated] = await db
    .update(listings)
    .set({ ...p, ...locPatch, completeness, missingFields, embedding, contentHash: hash, version: row.version + 1, updatedAt: new Date() })
    .where(eq(listings.id, row.id))
    .returning();

  await logEvent({ type: 'listing_updated', actorId: ctx.userId, listingId: row.id, data: { version: updated.version } });
  if (updated.status !== 'draft') await dispatch('listing.changed', { listingId: row.id, reason: 'updated' });
  return buildResult(updated, { publishBlockers: updated.status === 'draft' ? blockers : [] });
}

export async function publishListing(ctx: UserContext, listingId: string): Promise<CreateListingResult> {
  const row = await loadOwned(ctx, listingId);
  if (row.status === 'active') return buildResult(row);
  if (row.status !== 'draft' && row.status !== 'expired') {
    throw invalid(`This listing is ${row.status}; use set_listing_status to change it.`);
  }
  const blockers = publishBlockersFor(row, hasLoc(row));
  if (blockers.length) return buildResult(row, { publishBlockers: blockers });
  const now = new Date();
  const [updated] = await db
    .update(listings)
    .set({ status: 'active', publishedAt: now, availabilityConfirmedAt: now, expiresAt: plusDays(now, LISTING_TTL_DAYS), updatedAt: now })
    .where(eq(listings.id, row.id))
    .returning();
  await logEvent({ type: 'listing_published', actorId: ctx.userId, listingId: row.id });
  await dispatch('listing.changed', { listingId: row.id, reason: 'published' });
  return buildResult(updated);
}

const TRANSITIONS: Record<ListingStatusAction, { from: ListingStatus[]; to: ListingStatus | null }> = {
  pause: { from: ['active'], to: 'paused' },
  reactivate: { from: ['paused', 'expired'], to: 'active' },
  mark_sold: { from: ['active', 'paused', 'expired'], to: 'sold' },
  withdraw: { from: ['draft', 'active', 'paused', 'expired'], to: 'withdrawn' },
  confirm_available: { from: ['active', 'paused'], to: null },
};

export async function setListingStatus(ctx: UserContext, listingId: string, action: ListingStatusAction): Promise<ListingOwnerView> {
  const row = await loadOwned(ctx, listingId);
  const t = TRANSITIONS[action];
  if (!t) throw invalid(`Unknown action ${action}`);
  if (!t.from.includes(row.status)) throw invalid(`Cannot ${action.replace('_', ' ')} a listing that is ${row.status}.`);

  const now = new Date();
  const set: Partial<typeof listings.$inferInsert> = { updatedAt: now };
  if (t.to) set.status = t.to;
  if (action === 'reactivate') {
    const blockers = publishBlockersFor(row, hasLoc(row));
    if (blockers.length) throw invalid(`Cannot reactivate yet: ${blockers.join(' ')}`);
    set.availabilityConfirmedAt = now;
    if (!row.expiresAt || row.expiresAt < plusDays(now, 7)) set.expiresAt = plusDays(now, LISTING_TTL_DAYS);
  }
  if (action === 'confirm_available') {
    set.availabilityConfirmedAt = now;
    // Re-confirming also keeps the listing from expiring soon.
    if (!row.expiresAt || row.expiresAt < plusDays(now, LISTING_TTL_DAYS)) set.expiresAt = plusDays(now, LISTING_TTL_DAYS);
  }
  const [updated] = await db.update(listings).set(set).where(eq(listings.id, row.id)).returning();
  await logEvent({ type: 'listing_status_changed', actorId: ctx.userId, listingId: row.id, data: { action, from: row.status, to: updated.status } });
  if (row.status !== 'draft') {
    await dispatch('listing.changed', { listingId: row.id, reason: 'status_changed' });
  }
  return toOwnerView(updated, await imagesFor(row.id));
}

/** Recompute completeness/missing fields, e.g. after photos were attached by another service. */
export async function refreshListingCompleteness(listingId: string): Promise<void> {
  const row = await loadListing(listingId);
  const photoCount = (await imagesFor(row.id)).length;
  const { completeness, missingFields } = computeCompleteness(preparedFromRow(row), { hasLocation: hasLoc(row), photoCount });
  await db.update(listings).set({ completeness, missingFields, updatedAt: new Date() }).where(eq(listings.id, row.id));
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getMyListings(ctx: UserContext, opts: { status?: ListingStatus[] } = {}): Promise<ListingOwnerView[]> {
  const conds: SQL[] = [eq(listings.sellerId, ctx.userId)];
  if (opts.status?.length) conds.push(inArray(listings.status, opts.status));
  const rows = await db.select().from(listings).where(and(...conds)).orderBy(desc(listings.updatedAt));
  if (!rows.length) return [];
  const imgs = await db.select().from(listingImages).where(inArray(listingImages.listingId, rows.map((r) => r.id)));
  return rows.map((r) => toOwnerView(r, imgs.filter((i) => i.listingId === r.id)));
}

export async function getOwnListing(ctx: UserContext, listingId: string): Promise<ListingOwnerView> {
  const row = await loadOwned(ctx, listingId);
  return toOwnerView(row, await imagesFor(row.id));
}

/** Public projection; `origin` (viewer location) is used only to compute a rounded distance. */
export async function getPublicListing(listingId: string, origin?: { lat: number; lng: number } | null): Promise<PublicListingView> {
  const row = await loadListing(listingId);
  if (row.status === 'draft') throw notFound('Listing'); // drafts are private
  const view = toPublicListingView(row, await imagesFor(row.id), origin ?? null);
  // An active listing past its expiry is not presented as available.
  if (view.status === 'active' && row.expiresAt && row.expiresAt < new Date()) view.status = 'expired';
  return view;
}

/** Map a hard-constraint unknown (from match breakdowns) to the listing field that would resolve it. */
function fieldForConstraint(constraint: string): string | null {
  if (constraint === 'distance') return 'location';
  if (constraint === 'price') return 'price';
  if (constraint === 'condition') return 'condition';
  if (constraint === 'quantity') return 'quantity';
  if (constraint.startsWith('dimensions')) return 'dimensions';
  if (constraint === 'category') return 'category';
  const m = constraint.match(/^(?:required|excluded)\.(.+)$/);
  return m ? canonicalAttributeKey(m[1]) : null;
}

export async function getListingDemand(ctx: UserContext, listingId: string): Promise<ListingDemand> {
  const row = await loadOwned(ctx, listingId);
  const now = new Date();
  const possible = await db
    .select({ breakdown: matches.breakdown })
    .from(matches)
    .innerJoin(buyerRequests, eq(buyerRequests.id, matches.requestId))
    .where(
      and(
        eq(matches.listingId, row.id),
        eq(matches.qualifies, true),
        inArray(matches.status, ['suggested', 'seen', 'interested', 'connected']),
        eq(buyerRequests.status, 'active'),
        or(isNull(buyerRequests.expiresAt), sql`${buyerRequests.expiresAt} > ${now}`),
      ),
    );

  const fieldCounts = new Map<string, number>();
  let needingInfo = 0;
  for (const m of possible) {
    const unknown = m.breakdown.constraintChecks.filter((c) => c.ok === null);
    if (unknown.length) needingInfo++;
    const fields = new Set<string>();
    for (const c of unknown) {
      const f = fieldForConstraint(c.constraint);
      if (f) fields.add(f);
    }
    for (const h of m.breakdown.preferenceHits) if (!h.found) fields.add(canonicalAttributeKey(h.attribute));
    for (const f of fields) fieldCounts.set(f, (fieldCounts.get(f) ?? 0) + 1);
  }

  const ints = await db
    .select({ id: interests.id, status: interests.status, buyerId: interests.buyerId, createdAt: interests.createdAt })
    .from(interests)
    .where(and(eq(interests.listingId, row.id), ne(interests.status, 'withdrawn')));
  const pending = ints.filter((i) => i.status === 'pending');
  const firstMessages = new Map<string, string>();
  if (pending.length) {
    const msgs = await db
      .select()
      .from(messages)
      .where(inArray(messages.interestId, pending.map((i) => i.id)))
      .orderBy(asc(messages.createdAt));
    for (const m of msgs) {
      const buyer = pending.find((i) => i.id === m.interestId)?.buyerId;
      if (m.senderId === buyer && !firstMessages.has(m.interestId)) firstMessages.set(m.interestId, m.body);
    }
  }

  // Missing fields that matching buyers care about first, then the listing's own ranking.
  const missing = row.missingFields;
  const reasonFor = (field: string): MissingField => {
    const known = missing.find((f) => f.field === field || (field === 'model' && f.field === 'brand'));
    const n = fieldCounts.get(field) ?? 0;
    return {
      field: known?.field ?? field,
      reason: `${n} possibly matching request${n === 1 ? '' : 's'} can't confirm this. ${known?.reason ?? ''}`.trim(),
      // Fields that would firm up actual possible matches outrank generic completeness advice.
      value: Math.min(1, Math.max(known?.value ?? 0.5, 0.85) + 0.05 * n),
    };
  };
  const blocking = [...fieldCounts.keys()].map(reasonFor).sort((a, b) => b.value - a.value);
  const suggested: MissingField[] = [...blocking, ...missing.filter((f) => !blocking.some((b) => b.field === f.field))];

  const interested = new Set(ints.filter((i) => i.status === 'pending' || i.status === 'accepted').map((i) => i.buyerId)).size;
  const note =
    `${possible.length} active saved request${possible.length === 1 ? '' : 's'} possibly match this listing` +
    (needingInfo ? ` (${needingInfo} only if missing details check out)` : '') +
    `; ${interested} buyer${interested === 1 ? ' has' : 's have'} explicitly expressed interest. ` +
    'Possible matches are computed by the marketplace, not confirmed buyer interest.';

  return {
    listingId: row.id,
    possibleMatches: possible.length,
    possibleMatchesNeedingInfo: needingInfo,
    interestedBuyers: interested,
    pendingInterests: pending.map((i) => ({ interestId: i.id, message: firstMessages.get(i.id) ?? null, createdAt: i.createdAt.toISOString() })),
    suggestedFields: suggested,
    note,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}

const MIN_COMPARABLES = 3;

export async function getPriceGuidance(input: {
  category?: string;
  attributes?: Attributes;
  condition?: Condition;
  currency?: string;
  modelEstimate?: { lowCents: number; highCents: number } | null;
  excludeListingId?: string;
}): Promise<PriceGuidance> {
  const currency = normalizeCurrency(input.currency);
  const category = resolveCategory(input.category ?? null);
  const condition = input.condition ? parseCondition(input.condition) : null;

  const comparables = async (cat: string, subtree: boolean): Promise<number[]> => {
    const conds: (SQL | undefined)[] = [
      inArray(listings.status, ['active', 'sold']),
      eq(listings.priceSource, 'seller'),
      isNotNull(listings.priceCents),
      eq(listings.currency, currency),
      subtree ? or(eq(listings.category, cat), sql`${listings.category} LIKE ${`${cat}/%`}`) : eq(listings.category, cat),
    ];
    if (condition) {
      const r = CONDITION_RANK[condition];
      conds.push(or(isNull(listings.conditionRank), and(gte(listings.conditionRank, r - 1), lte(listings.conditionRank, r + 1))));
    }
    if (input.excludeListingId) conds.push(ne(listings.id, input.excludeListingId));
    const rows = await db.select({ p: listings.priceCents }).from(listings).where(and(...conds)).orderBy(desc(listings.updatedAt)).limit(200);
    return rows.map((r) => r.p!).sort((a, b) => a - b);
  };

  if (category) {
    let prices = await comparables(category, false);
    let scope = categoryLabel(category)?.toLowerCase() ?? category;
    const parent = getCategory(category)?.parent;
    if (prices.length < MIN_COMPARABLES && parent && (getCategory(parent)?.depth ?? 0) >= 2) {
      prices = await comparables(parent, true);
      scope = `${categoryLabel(parent)?.toLowerCase()} (broader category)`;
    }
    if (prices.length >= MIN_COMPARABLES) {
      return {
        currency,
        lowCents: percentile(prices, 0.25),
        highCents: percentile(prices, 0.75),
        basis: 'marketplace_comparables',
        comparableCount: prices.length,
        note:
          `Middle half of asking prices for ${prices.length} comparable ${scope} listings on this marketplace` +
          `${condition ? ' in similar condition' : ''}. These are asking prices, not confirmed sale prices.`,
      };
    }
  }
  const est = input.modelEstimate;
  if (est && est.lowCents != null && est.highCents != null) {
    return {
      currency,
      lowCents: Math.min(est.lowCents, est.highCents),
      highCents: Math.max(est.lowCents, est.highCents),
      basis: 'ai_estimate',
      comparableCount: 0,
      note: 'Not enough comparable listings on this marketplace yet; this range is an AI estimate, not market data.',
    };
  }
  return {
    currency,
    lowCents: null,
    highCents: null,
    basis: 'insufficient_data',
    comparableCount: 0,
    note: 'Not enough comparable listings on this marketplace to suggest a price.',
  };
}
