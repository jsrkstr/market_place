/**
 * Matching engine: one scorer, two directions.
 * - matchRequest: request → active inventory (immediate search / saved request).
 * - matchListing: listing → active saved requests (async discovery after publish/update).
 * Neither creates inbox items; job handlers decide who to notify from the return values.
 */
import { and, cosineDistance, eq, gt, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { newId } from '../../db/ids.js';
import { buyerRequests, listingImages, listings, matches, type BuyerRequestRow, type ListingRow, type MatchRow } from '../../db/schema.js';
import { embedOne } from '../../infra/embeddings.js';
import { notFound } from '../errors.js';
import { toPublicListingView, type ListingImageRow } from '../privacy.js';
import { categoryLabel, getCategory } from '../taxonomy.js';
import type { MatchStatus, MatchView, ScoreBreakdown } from '../types.js';
import { explainMatch } from './explain.js';
import { CANDIDATE_LIMIT, evaluateHardConstraints, findCandidates, type Evaluation, type RequestLike } from './hardFilter.js';
import { cosineSimilarity, DEFAULT_LIMIT, scoreListing } from './scorer.js';

export interface EngineResult {
  matches: MatchView[];
  nearMisses: MatchView[];
  totalCandidatesConsidered: number;
}

/** Statuses a re-evaluation may move to `stale`. Interested/connected are buyer actions and kept. */
const REEVALUATED: MatchStatus[] = ['suggested', 'seen'];
const MAX_NEAR_MISSES = 3;

interface Scored {
  listing: ListingRow;
  evaluation: Evaluation;
  score: number;
  breakdown: ScoreBreakdown;
  relevant: boolean;
  qualifies: boolean;
  nearMiss: boolean;
  explanation: string;
}

/** Text used to embed a buyer request (also used by requests.service). */
export function requestEmbeddingText(r: Pick<BuyerRequestRow, 'rawText' | 'summary' | 'category' | 'softPreferences' | 'hardConstraints'>): string {
  const prefs = (r.softPreferences ?? []).map((p) => `${p.attribute.replace(/_/g, ' ')}: ${p.values.join(', ')}`);
  const required = (r.hardConstraints?.requiredAttributes ?? []).map((p) => `${p.attribute.replace(/_/g, ' ')}: ${p.values.join(', ')}`);
  return [r.rawText, r.summary, categoryLabel(r.category), ...prefs, ...required].filter(Boolean).join('\n');
}

function evaluateAndScore(listing: ListingRow, req: RequestLike, cosine: number | null, maxDismissedCosine: number | null): Scored {
  const evaluation = evaluateHardConstraints(listing, req);
  const { score, breakdown, relevant } = scoreListing({ listing, request: req, evaluation, cosine, maxDismissedCosine });
  const nearMiss = evaluation.nearMiss;
  return {
    listing,
    evaluation,
    score,
    breakdown,
    relevant,
    qualifies: evaluation.pass && !nearMiss && relevant,
    nearMiss,
    explanation: explainMatch({ listing, evaluation, breakdown, nearMiss }),
  };
}

function maxCosine(embedding: number[] | null, others: number[][]): number | null {
  if (!embedding || !others.length) return null;
  return Math.max(...others.map((o) => cosineSimilarity(embedding, o)));
}

async function dismissedEmbeddings(requestId: string): Promise<number[][]> {
  const rows = await db
    .select({ embedding: listings.embedding })
    .from(matches)
    .innerJoin(listings, eq(listings.id, matches.listingId))
    .where(and(eq(matches.requestId, requestId), eq(matches.status, 'dismissed')));
  return rows.map((r) => r.embedding).filter((e): e is number[] => !!e);
}

export async function loadImages(listingIds: string[]): Promise<Map<string, ListingImageRow[]>> {
  const map = new Map<string, ListingImageRow[]>();
  if (!listingIds.length) return map;
  const rows = await db.select().from(listingImages).where(inArray(listingImages.listingId, listingIds));
  for (const r of rows) map.set(r.listingId, [...(map.get(r.listingId) ?? []), r]);
  return map;
}

function toView(s: Scored, images: Map<string, ListingImageRow[]>, req: RequestLike, saved: MatchRow | null): MatchView {
  return {
    matchId: saved?.id ?? null,
    listing: toPublicListingView(s.listing, images.get(s.listing.id) ?? [], req.hardConstraints?.origin ?? null),
    score: s.score,
    qualifies: s.qualifies,
    nearMiss: s.nearMiss,
    explanation: s.explanation,
    unknowns: s.evaluation.unknowns,
    status: saved?.status ?? null,
  };
}

/** Upsert match rows; never touches dismissed rows. Returns the rows actually written. */
async function upsertMatches(scored: Scored[], req: { id: string; version: number }): Promise<Map<string, MatchRow>> {
  const out = new Map<string, MatchRow>();
  if (!scored.length) return out;
  const now = new Date();
  const rows = await db
    .insert(matches)
    .values(
      scored.map((s) => ({
        id: newId('mat'),
        requestId: req.id,
        listingId: s.listing.id,
        score: s.score,
        breakdown: s.breakdown,
        explanation: s.explanation,
        qualifies: s.qualifies,
        nearMiss: s.nearMiss,
        unknowns: s.evaluation.unknowns,
        status: 'suggested' as const,
        listingVersion: s.listing.version,
        requestVersion: req.version,
      })),
    )
    .onConflictDoUpdate({
      target: [matches.requestId, matches.listingId],
      set: {
        score: sql`excluded.score`,
        breakdown: sql`excluded.breakdown`,
        explanation: sql`excluded.explanation`,
        qualifies: sql`excluded.qualifies`,
        nearMiss: sql`excluded.near_miss`,
        unknowns: sql`excluded.unknowns`,
        listingVersion: sql`excluded.listing_version`,
        requestVersion: sql`excluded.request_version`,
        // A previously stale/closed pair that qualifies again becomes a suggestion again.
        status: sql`CASE WHEN ${matches.status} IN ('stale', 'closed') THEN 'suggested' ELSE ${matches.status} END`,
        updatedAt: now,
      },
      setWhere: sql`${matches.status} <> 'dismissed'`,
    })
    .returning();
  for (const r of rows) out.set(r.listingId, r);
  return out;
}

async function markStale(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await db.update(matches).set({ status: 'stale', updatedAt: new Date() }).where(inArray(matches.id, ids));
}

const isLive = (l: ListingRow, now = new Date()) => l.status === 'active' && (!l.expiresAt || l.expiresAt > now);

/**
 * Score current active inventory for a request (persisted or ephemeral).
 * When `persist` is true (request has an id in DB), upserts match rows, marks no-longer-qualifying
 * rows stale, and returns MatchViews with matchIds.
 */
export async function matchRequest(
  request: BuyerRequestRow,
  opts: { persist: boolean; limit?: number; viewerId: string },
): Promise<EngineResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const req: BuyerRequestRow = request.embedding ? request : { ...request, embedding: await embedOne(requestEmbeddingText(request)) };

  const candidates = await findCandidates(req, { viewerId: opts.viewerId, persisted: opts.persist, limit: CANDIDATE_LIMIT });
  const dismissed = opts.persist ? await dismissedEmbeddings(req.id) : [];

  const scored = candidates
    .map((c) => evaluateAndScore(c.row, req, c.cosine, maxCosine(c.row.embedding, dismissed)))
    .filter((s) => s.evaluation.pass && s.relevant)
    .sort((a, b) => b.score - a.score);
  const qualifying = scored.filter((s) => !s.nearMiss).slice(0, limit);
  const allowsExceptions = !!(req.allowExceptions?.budgetPct || req.allowExceptions?.distanceKm);
  const nearMisses = allowsExceptions ? scored.filter((s) => s.nearMiss).slice(0, Math.min(MAX_NEAR_MISSES, limit)) : [];

  let saved = new Map<string, MatchRow>();
  if (opts.persist) {
    saved = await upsertMatches([...qualifying, ...nearMisses], req);
    await reevaluateExisting(req, new Set(saved.keys()), dismissed);
  }

  const images = await loadImages([...qualifying, ...nearMisses].map((s) => s.listing.id));
  // When persisting, only rows that were actually written are returned (dismissed pairs never come back).
  const keep = (s: Scored) => !opts.persist || saved.has(s.listing.id);
  return {
    matches: qualifying.filter(keep).map((s) => toView(s, images, req, saved.get(s.listing.id) ?? null)),
    nearMisses: nearMisses.filter(keep).map((s) => toView(s, images, req, saved.get(s.listing.id) ?? null)),
    totalCandidatesConsidered: candidates.length,
  };
}

/** Re-check existing suggested/seen matches not in this round's results: refresh them or mark stale. */
async function reevaluateExisting(req: BuyerRequestRow, justWritten: Set<string>, dismissed: number[][]): Promise<void> {
  const conds: SQL[] = [eq(matches.requestId, req.id), inArray(matches.status, REEVALUATED)];
  if (justWritten.size) conds.push(notInArray(matches.listingId, [...justWritten]));
  const rows = await db.select({ match: matches, listing: listings }).from(matches).innerJoin(listings, eq(listings.id, matches.listingId)).where(and(...conds));
  const stale: string[] = [];
  for (const { match, listing } of rows) {
    if (!isLive(listing) || listing.sellerId === req.buyerId) {
      stale.push(match.id);
      continue;
    }
    const cos = req.embedding && listing.embedding ? cosineSimilarity(req.embedding, listing.embedding) : null;
    const s = evaluateAndScore(listing, req, cos, maxCosine(listing.embedding, dismissed));
    if (!s.evaluation.pass || !s.relevant || (s.nearMiss && !(req.allowExceptions?.budgetPct || req.allowExceptions?.distanceKm))) {
      stale.push(match.id);
      continue;
    }
    await db
      .update(matches)
      .set({
        score: s.score,
        breakdown: s.breakdown,
        explanation: s.explanation,
        qualifies: s.qualifies,
        nearMiss: s.nearMiss,
        unknowns: s.evaluation.unknowns,
        listingVersion: listing.version,
        requestVersion: req.version,
        updatedAt: new Date(),
      })
      .where(eq(matches.id, match.id));
  }
  await markStale(stale);
}

/**
 * Reverse direction: evaluate one listing against all active saved requests. Upserts match rows.
 * Returns newly-qualifying matches (first time qualifying for that request/listing pair), and
 * possible matches blocked only by unknown listing info.
 */
export async function matchListing(listingId: string): Promise<{
  newQualifying: { matchId: string; requestId: string; buyerId: string; score: number }[];
  possibleNeedingInfo: { requestId: string; unknowns: string[] }[];
  staled: { matchId: string; requestId: string; buyerId: string }[];
}> {
  const [listing] = await db.select().from(listings).where(eq(listings.id, listingId));
  if (!listing) throw notFound('Listing');
  if (!isLive(listing)) {
    const staled = await staleMatchesForListing(listingId);
    return { newQualifying: [], possibleNeedingInfo: [], staled: staled.map(({ matchId, requestId, buyerId }) => ({ matchId, requestId, buyerId })) };
  }

  const now = new Date();
  const conds: (SQL | undefined)[] = [
    eq(buyerRequests.status, 'active'),
    or(isNull(buyerRequests.expiresAt), gt(buyerRequests.expiresAt, now)),
    sql`${buyerRequests.buyerId} <> ${listing.sellerId}`,
    sql`NOT EXISTS (SELECT 1 FROM matches m WHERE m.request_id = ${buyerRequests.id} AND m.listing_id = ${listing.id} AND m.status = 'dismissed')`,
  ];
  if (listing.category) {
    const cat = listing.category;
    const parts: SQL[] = [
      sql`${buyerRequests.category} IS NULL`,
      sql`${buyerRequests.category} = ${cat}`,
      sql`${cat} LIKE ${buyerRequests.category} || '/%'`,
    ];
    // A generic listing ("seating") may satisfy a more specific request ("dining chair") as unverified.
    if ((getCategory(cat)?.depth ?? 0) >= 2) parts.push(sql`${buyerRequests.category} LIKE ${`${cat}/%`}`);
    conds.push(or(...parts));
  } else conds.push(isNull(buyerRequests.category));
  if (listing.priceCents != null) {
    conds.push(sql`(
      ${buyerRequests.hardConstraints}->>'maxPriceCents' IS NULL
      OR ${listing.priceCents} <= (${buyerRequests.hardConstraints}->>'maxPriceCents')::numeric
         * (1 + COALESCE((${buyerRequests.allowExceptions}->>'budgetPct')::numeric, 0) / 100)
    )`);
  }
  if (listing.conditionRank != null) {
    conds.push(sql`(
      ${buyerRequests.hardConstraints}->>'minCondition' IS NULL
      OR ${listing.conditionRank} >= CASE ${buyerRequests.hardConstraints}->>'minCondition'
        WHEN 'poor' THEN 0 WHEN 'fair' THEN 1 WHEN 'good' THEN 2 WHEN 'like_new' THEN 3 WHEN 'new' THEN 4 ELSE 0 END
    )`);
  }

  const distance = listing.embedding ? cosineDistance(buyerRequests.embedding, listing.embedding) : null;
  const requests = await db
    .select({ req: buyerRequests, cosine: distance ? sql<number | null>`1 - (${distance})` : sql<null>`NULL` })
    .from(buyerRequests)
    .where(and(...conds))
    .orderBy(distance ? sql`${distance} ASC NULLS LAST` : sql`${buyerRequests.createdAt} DESC`)
    .limit(1000);

  // Similarity of this listing to listings each request's buyer dismissed (feedback penalty).
  const penalties = new Map<string, number>();
  if (requests.length && listing.embedding) {
    const rows = await db
      .select({ requestId: matches.requestId, sim: sql<number>`MAX(1 - (${cosineDistance(listings.embedding, listing.embedding)}))` })
      .from(matches)
      .innerJoin(listings, eq(listings.id, matches.listingId))
      .where(and(eq(matches.status, 'dismissed'), inArray(matches.requestId, requests.map((r) => r.req.id))))
      .groupBy(matches.requestId);
    for (const r of rows) if (r.sim != null) penalties.set(r.requestId, Number(r.sim));
  }

  const existing = await db.select().from(matches).where(eq(matches.listingId, listing.id));

  const toWrite: { scored: Scored; req: BuyerRequestRow }[] = [];
  const possibleNeedingInfo: { requestId: string; unknowns: string[] }[] = [];
  const staleIds: string[] = [];
  const admitted = new Set<string>();
  for (const { req, cosine } of requests) {
    const s = evaluateAndScore(listing, req, cosine == null ? null : Number(cosine), penalties.get(req.id) ?? null);
    const allowsExceptions = !!(req.allowExceptions?.budgetPct || req.allowExceptions?.distanceKm);
    if (!s.evaluation.pass || !s.relevant || (s.nearMiss && !allowsExceptions)) continue;
    admitted.add(req.id);
    toWrite.push({ scored: s, req });
    if (s.evaluation.unknownFields.length) possibleNeedingInfo.push({ requestId: req.id, unknowns: s.evaluation.unknowns });
  }

  // Existing suggestions for requests that no longer admit this listing become stale.
  for (const m of existing) {
    if (!admitted.has(m.requestId) && REEVALUATED.includes(m.status)) staleIds.push(m.id);
  }

  const newQualifying: { matchId: string; requestId: string; buyerId: string; score: number }[] = [];
  for (const { scored, req } of toWrite) {
    const saved = await upsertMatches([scored], req);
    const row = saved.get(listing.id);
    if (row && scored.qualifies && row.notifiedAt == null && row.status === 'suggested') {
      newQualifying.push({ matchId: row.id, requestId: req.id, buyerId: req.buyerId, score: row.score });
    }
  }

  await markStale(staleIds);
  const buyerOf = new Map(requests.map((r) => [r.req.id, r.req.buyerId]));
  const staledRequests = existing.filter((m) => staleIds.includes(m.id));
  const missingBuyers = staledRequests.filter((m) => !buyerOf.has(m.requestId)).map((m) => m.requestId);
  if (missingBuyers.length) {
    const rows = await db.select({ id: buyerRequests.id, buyerId: buyerRequests.buyerId }).from(buyerRequests).where(inArray(buyerRequests.id, missingBuyers));
    for (const r of rows) buyerOf.set(r.id, r.buyerId);
  }
  return {
    newQualifying: newQualifying.sort((a, b) => b.score - a.score),
    possibleNeedingInfo,
    staled: staledRequests.map((m) => ({ matchId: m.id, requestId: m.requestId, buyerId: buyerOf.get(m.requestId)! })),
  };
}

/** Mark all non-terminal matches of a listing stale (listing paused/sold/withdrawn/expired). Returns affected. */
export async function staleMatchesForListing(
  listingId: string,
): Promise<{ matchId: string; requestId: string; buyerId: string; wasInterested: boolean }[]> {
  const res = await db.execute<{ id: string; request_id: string; buyer_id: string; old_status: string }>(sql`
    WITH old AS (
      SELECT id, status FROM matches
      WHERE listing_id = ${listingId} AND status IN ('suggested', 'seen', 'interested')
      FOR UPDATE
    )
    UPDATE matches m SET status = 'stale', updated_at = now()
    FROM old, buyer_requests r
    WHERE m.id = old.id AND r.id = m.request_id
    RETURNING m.id, m.request_id, r.buyer_id, old.status AS old_status
  `);
  return res.rows.map((r) => ({ matchId: r.id, requestId: r.request_id, buyerId: r.buyer_id, wasInterested: r.old_status === 'interested' }));
}
