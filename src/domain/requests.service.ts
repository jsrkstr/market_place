/**
 * Buyer requests (demand): create/update/status, immediate matching, saved matches and feedback.
 * Ephemeral searches use the same engine without persisting anything.
 */
import { and, desc, eq, gt, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { buyerRequests, listings, matches, type BuyerRequestRow, type ListingRow } from '../db/schema.js';
import { embedOne } from '../infra/embeddings.js';
import { dispatch } from '../infra/jobs.js';
import { forbidden, invalid, notFound } from './errors.js';
import { logEvent } from './events.js';
import { loadImages, matchRequest, requestEmbeddingText } from './matching/engine.js';
import { DEFAULT_LIMIT } from './matching/scorer.js';
import { attributeFamilies, canonicalAttributeKey, familyLabel, normalizeCurrency, normalizeTerms, parseCondition, wantedFamilies, type Vocabulary } from './normalize.js';
import { toPublicListingView } from './privacy.js';
import { resolveCategory } from './taxonomy.js';
import { getUser, resolveLocation } from './users.service.js';
import type {
  AllowExceptions,
  HardConstraints,
  LocationInput,
  MatchStatus,
  MatchView,
  RequestStatus,
  SoftPreference,
  UserContext,
} from './types.js';

export interface BuyerRequestInput {
  /** The buyer's own words, verbatim. */
  rawText: string;
  summary?: string;
  category?: string;
  /** Hard constraints as given by the model; `origin` may be omitted in favour of `location`. */
  hardConstraints?: Omit<HardConstraints, 'origin'>;
  /** Where the buyer wants to collect from. Falls back to the user's default location. */
  location?: LocationInput;
  softPreferences?: SoftPreference[];
  allowExceptions?: AllowExceptions;
  neededBy?: string; // ISO date
  notify?: boolean;
  /** Days until the saved request expires (default 30, max 180). */
  expiresInDays?: number;
}

export interface BuyerRequestView {
  id: string;
  status: RequestStatus;
  rawText: string;
  summary: string | null;
  category: string | null;
  hardConstraints: HardConstraints;
  softPreferences: SoftPreference[];
  allowExceptions: AllowExceptions;
  neededBy: string | null;
  notify: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  counts: { suggested: number; interested: number; dismissed: number };
}

export interface SearchResult {
  request: BuyerRequestView | null; // null for ephemeral searches
  matches: MatchView[]; // qualifying, best first
  nearMisses: MatchView[]; // only when buyer allowed exceptions; clearly labelled
  /** Human-readable notes, e.g. "No location given, distance not applied". */
  notes: string[];
  totalCandidatesConsidered: number;
}

const DAY_MS = 86_400_000;
const DEFAULT_TTL_DAYS = 30;
const MAX_TTL_DAYS = 180;
const MAX_LIMIT = 20;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const clampLimit = (n: number | undefined) => Math.min(MAX_LIMIT, Math.max(1, n ?? DEFAULT_LIMIT));

// ---------------------------------------------------------------------------
// Input normalisation
// ---------------------------------------------------------------------------

function sanitizeConstraints(hc: Partial<HardConstraints> | undefined): HardConstraints {
  const out: HardConstraints = {};
  if (!hc) return out;
  const pos = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined);
  if (pos(hc.maxPriceCents) != null) out.maxPriceCents = Math.round(hc.maxPriceCents!);
  if (pos(hc.minPriceCents) != null) out.minPriceCents = Math.round(hc.minPriceCents!);
  if (out.maxPriceCents != null || out.minPriceCents != null || hc.currency) out.currency = normalizeCurrency(hc.currency);
  if (pos(hc.maxDistanceKm) != null) out.maxDistanceKm = hc.maxDistanceKm;
  if (hc.origin) out.origin = hc.origin;
  if (hc.minCondition) {
    const c = parseCondition(String(hc.minCondition));
    if (!c) throw invalid(`Unknown condition "${hc.minCondition}". Use new, like_new, good, fair or poor.`);
    out.minCondition = c;
  }
  if (hc.quantity != null) {
    if (!Number.isInteger(hc.quantity) || hc.quantity < 1) throw invalid('quantity must be a positive whole number');
    out.quantity = hc.quantity;
  }
  for (const k of ['maxDimensionsCm', 'minDimensionsCm'] as const) {
    const b = hc[k];
    if (b && Object.values(b).some((v) => pos(v) != null)) {
      out[k] = Object.fromEntries(Object.entries(b).filter(([, v]) => pos(v) != null));
    }
  }
  const attrList = (l: { attribute: string; values: string[] }[] | undefined) =>
    (l ?? [])
      .filter((a) => a?.attribute && a.values?.length)
      .map((a) => ({ attribute: canonicalAttributeKey(a.attribute), values: a.values.map((v) => v.trim()).filter(Boolean) }));
  if (hc.requiredAttributes?.length) out.requiredAttributes = attrList(hc.requiredAttributes);
  if (hc.excludedAttributes?.length) out.excludedAttributes = attrList(hc.excludedAttributes);
  return out;
}

function sanitizePreferences(prefs: SoftPreference[] | undefined): SoftPreference[] {
  return (prefs ?? [])
    .filter((p) => p?.attribute && p.values?.length)
    .map((p) => ({
      attribute: canonicalAttributeKey(p.attribute),
      values: p.values.map((v) => v.trim()).filter(Boolean),
      weight: Math.min(1, Math.max(0, p.weight ?? 0.5)),
    }));
}

function resolveRequestCategory(input: { category?: string; summary?: string | null; rawText?: string }): string | null {
  return resolveCategory(input.category) ?? resolveCategory(input.summary) ?? resolveCategory(input.rawText);
}

async function resolveOrigin(ctx: UserContext, location: LocationInput | undefined): Promise<HardConstraints['origin'] | undefined> {
  const loc = await resolveLocation(location);
  if (loc) return { lat: loc.lat, lng: loc.lng, label: loc.label };
  const user = await getUser(ctx.userId);
  if (user.defaultLat != null && user.defaultLng != null) {
    return { lat: user.defaultLat, lng: user.defaultLng, label: user.defaultLocationLabel ?? undefined };
  }
  return undefined;
}

function notesFor(row: Pick<BuyerRequestRow, 'hardConstraints' | 'category'>, input?: { category?: string }): string[] {
  const hc = row.hardConstraints;
  const notes: string[] = [];
  if (!hc.origin) notes.push('No location given (and no default location set), so distance was not applied.');
  else if (hc.maxDistanceKm == null) notes.push(`No maximum distance given; results nearer ${hc.origin.label ?? 'you'} rank higher.`);
  if (hc.maxPriceCents == null) notes.push('No budget given, so price was not filtered.');
  if (!row.category) {
    notes.push(input?.category ? `Category "${input.category}" is not recognised; searched all categories.` : 'No category recognised; searched all categories.');
  }
  return notes;
}

function expiryFrom(days: number | undefined, now = new Date()): Date {
  const d = Math.min(MAX_TTL_DAYS, Math.max(1, Math.round(days ?? DEFAULT_TTL_DAYS)));
  return new Date(now.getTime() + d * DAY_MS);
}

async function buildRow(ctx: UserContext, input: BuyerRequestInput): Promise<Omit<BuyerRequestRow, 'id' | 'createdAt' | 'updatedAt'>> {
  if (!input.rawText?.trim()) throw invalid('rawText (the buyer\'s own words) is required');
  const hardConstraints = sanitizeConstraints(input.hardConstraints);
  const origin = await resolveOrigin(ctx, input.location);
  if (origin) hardConstraints.origin = origin;
  const base = {
    buyerId: ctx.userId,
    status: 'active' as RequestStatus,
    rawText: input.rawText.trim(),
    summary: input.summary?.trim() || null,
    category: resolveRequestCategory(input),
    hardConstraints,
    softPreferences: sanitizePreferences(input.softPreferences),
    allowExceptions: sanitizeExceptions(input.allowExceptions),
    neededBy: input.neededBy ? parseDate(input.neededBy) : null,
    notify: input.notify ?? true,
    version: 1,
    expiresAt: expiryFrom(input.expiresInDays),
    cancelledAt: null,
    cancelReason: null,
  };
  return { ...base, embedding: await embedOne(requestEmbeddingText(base)) };
}

function sanitizeExceptions(ex: AllowExceptions | undefined): AllowExceptions {
  const out: AllowExceptions = {};
  if (ex?.budgetPct && ex.budgetPct > 0) out.budgetPct = Math.min(ex.budgetPct, 50);
  if (ex?.distanceKm && ex.distanceKm > 0) out.distanceKm = ex.distanceKm;
  return out;
}

function parseDate(s: string): Date {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw invalid(`Invalid date "${s}"`);
  return d;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

async function countsFor(requestIds: string[]): Promise<Map<string, BuyerRequestView['counts']>> {
  const out = new Map<string, BuyerRequestView['counts']>();
  if (!requestIds.length) return out;
  const rows = await db
    .select({ requestId: matches.requestId, status: matches.status, n: sql<number>`count(*)::int` })
    .from(matches)
    .where(inArray(matches.requestId, requestIds))
    .groupBy(matches.requestId, matches.status);
  for (const id of requestIds) out.set(id, { suggested: 0, interested: 0, dismissed: 0 });
  for (const r of rows) {
    const c = out.get(r.requestId)!;
    if (r.status === 'suggested' || r.status === 'seen') c.suggested += r.n;
    else if (r.status === 'interested' || r.status === 'connected') c.interested += r.n;
    else if (r.status === 'dismissed') c.dismissed += r.n;
  }
  return out;
}

function toView(r: BuyerRequestRow, counts: BuyerRequestView['counts']): BuyerRequestView {
  return {
    id: r.id,
    status: r.status,
    rawText: r.rawText,
    summary: r.summary,
    category: r.category,
    hardConstraints: r.hardConstraints,
    softPreferences: r.softPreferences,
    allowExceptions: r.allowExceptions,
    neededBy: iso(r.neededBy),
    notify: r.notify,
    expiresAt: iso(r.expiresAt),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    counts,
  };
}

async function viewOf(r: BuyerRequestRow): Promise<BuyerRequestView> {
  return toView(r, (await countsFor([r.id])).get(r.id)!);
}

async function loadOwned(ctx: UserContext, requestId: string): Promise<BuyerRequestRow> {
  const [r] = await db.select().from(buyerRequests).where(eq(buyerRequests.id, requestId));
  if (!r) throw notFound('Request');
  if (r.buyerId !== ctx.userId) throw forbidden();
  return r;
}

/** Matches handed to the buyer in this conversation must not be re-notified by async jobs. */
async function markNotified(views: MatchView[]): Promise<void> {
  const ids = views.map((v) => v.matchId).filter((x): x is string => !!x);
  if (ids.length) await db.update(matches).set({ notifiedAt: new Date() }).where(and(inArray(matches.id, ids), isNull(matches.notifiedAt)));
}

async function runPersistedMatch(ctx: UserContext, row: BuyerRequestRow, limit: number, notes: string[]): Promise<SearchResult> {
  const res = await matchRequest(row, { persist: true, limit, viewerId: ctx.userId });
  await markNotified([...res.matches, ...res.nearMisses]);
  if (!res.matches.length) notes.push('No matching items right now; the request is saved and new listings will be matched as they appear.');
  return { request: await viewOf(row), matches: res.matches, nearMisses: res.nearMisses, notes, totalCandidatesConsidered: res.totalCandidatesConsidered };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function createBuyerRequest(ctx: UserContext, input: BuyerRequestInput, opts: { limit?: number } = {}): Promise<SearchResult> {
  const values = await buildRow(ctx, input);
  const [row] = await db.insert(buyerRequests).values({ id: newId('req'), ...values }).returning();
  await logEvent({ type: 'request_created', actorId: ctx.userId, requestId: row.id, data: { category: row.category } });
  const result = await runPersistedMatch(ctx, row, clampLimit(opts.limit), notesFor(row, input));
  await dispatch('request.changed', { requestId: row.id, reason: 'created' });
  return result;
}

/** Immediate search that does not persist a request. */
export async function searchListings(ctx: UserContext, input: BuyerRequestInput, opts: { limit?: number } = {}): Promise<SearchResult> {
  const values = await buildRow(ctx, input);
  const now = new Date();
  const row: BuyerRequestRow = { id: 'ephemeral', ...values, createdAt: now, updatedAt: now };
  const res = await matchRequest(row, { persist: false, limit: clampLimit(opts.limit), viewerId: ctx.userId });
  await logEvent({ type: 'search_performed', actorId: ctx.userId, data: { category: row.category, results: res.matches.length } });
  const notes = notesFor(row, input);
  if (!res.matches.length) notes.push('No matching items right now. Saving this as a request will match new listings as they appear.');
  return { request: null, matches: res.matches, nearMisses: res.nearMisses, notes, totalCandidatesConsidered: res.totalCandidatesConsidered };
}

export async function updateBuyerRequest(
  ctx: UserContext,
  requestId: string,
  patch: Partial<BuyerRequestInput>,
  opts: { limit?: number } = {},
): Promise<SearchResult> {
  const row = await loadOwned(ctx, requestId);
  if (row.status === 'cancelled' || row.status === 'fulfilled') throw invalid(`This request is ${row.status}; create a new one instead.`);

  const next: Partial<BuyerRequestRow> = {};
  if (patch.rawText !== undefined) {
    if (!patch.rawText.trim()) throw invalid('rawText cannot be empty');
    next.rawText = patch.rawText.trim();
  }
  if (patch.summary !== undefined) next.summary = patch.summary?.trim() || null;
  if (patch.category !== undefined) next.category = resolveRequestCategory({ category: patch.category });
  if (patch.hardConstraints !== undefined) {
    // Shallow merge; keys explicitly set to null are removed.
    const merged: Record<string, unknown> = { ...row.hardConstraints };
    for (const [k, v] of Object.entries(patch.hardConstraints ?? {})) {
      if (v === null) delete merged[k];
      else if (v !== undefined) merged[k] = v;
    }
    next.hardConstraints = sanitizeConstraints(merged as HardConstraints);
  }
  if (patch.location !== undefined) {
    const loc = await resolveLocation(patch.location);
    next.hardConstraints = { ...(next.hardConstraints ?? row.hardConstraints) };
    if (loc) next.hardConstraints.origin = { lat: loc.lat, lng: loc.lng, label: loc.label };
  }
  if (patch.softPreferences !== undefined) next.softPreferences = sanitizePreferences(patch.softPreferences);
  if (patch.allowExceptions !== undefined) next.allowExceptions = sanitizeExceptions(patch.allowExceptions);
  if (patch.neededBy !== undefined) next.neededBy = patch.neededBy ? parseDate(patch.neededBy) : null;
  if (patch.notify !== undefined) next.notify = patch.notify;
  if (patch.expiresInDays !== undefined) next.expiresAt = expiryFrom(patch.expiresInDays);

  const merged = { ...row, ...next };
  const text = requestEmbeddingText(merged);
  if (text !== requestEmbeddingText(row) || !row.embedding) next.embedding = await embedOne(text);
  const [updated] = await db
    .update(buyerRequests)
    .set({ ...next, version: row.version + 1, updatedAt: new Date() })
    .where(eq(buyerRequests.id, row.id))
    .returning();
  await logEvent({ type: 'request_updated', actorId: ctx.userId, requestId: row.id, data: { version: updated.version } });

  let result: SearchResult;
  if (updated.status === 'active' && (!updated.expiresAt || updated.expiresAt > new Date())) {
    result = await runPersistedMatch(ctx, updated, clampLimit(opts.limit), notesFor(updated, patch));
  } else {
    result = { request: await viewOf(updated), matches: [], nearMisses: [], notes: [`Request is ${updated.status}; matching runs again once it is active.`], totalCandidatesConsidered: 0 };
  }
  await dispatch('request.changed', { requestId: row.id, reason: 'updated' });
  return result;
}

const REQUEST_TRANSITIONS: Record<'pause' | 'resume' | 'cancel' | 'fulfilled', { from: RequestStatus[]; to: RequestStatus }> = {
  pause: { from: ['active'], to: 'paused' },
  resume: { from: ['paused', 'expired'], to: 'active' },
  cancel: { from: ['active', 'paused', 'expired'], to: 'cancelled' },
  fulfilled: { from: ['active', 'paused', 'expired'], to: 'fulfilled' },
};

export async function setBuyerRequestStatus(
  ctx: UserContext,
  requestId: string,
  action: 'pause' | 'resume' | 'cancel' | 'fulfilled',
  reason?: string,
): Promise<BuyerRequestView> {
  const row = await loadOwned(ctx, requestId);
  const t = REQUEST_TRANSITIONS[action];
  if (!t) throw invalid(`Unknown action ${action}`);
  if (row.status === t.to) return viewOf(row);
  if (!t.from.includes(row.status)) throw invalid(`Cannot ${action} a request that is ${row.status}.`);

  const now = new Date();
  const set: Partial<typeof buyerRequests.$inferInsert> = { status: t.to, updatedAt: now };
  if (action === 'cancel') {
    set.cancelledAt = now;
    set.cancelReason = reason?.trim() || null;
  }
  if (action === 'resume' && (!row.expiresAt || row.expiresAt <= now)) set.expiresAt = expiryFrom(DEFAULT_TTL_DAYS, now);
  const [updated] = await db.update(buyerRequests).set(set).where(eq(buyerRequests.id, row.id)).returning();
  if (t.to === 'cancelled' || t.to === 'fulfilled') {
    await db
      .update(matches)
      .set({ status: 'closed', updatedAt: now })
      .where(and(eq(matches.requestId, row.id), inArray(matches.status, ['suggested', 'seen'] as MatchStatus[])));
  }
  await logEvent({ type: 'request_status_changed', actorId: ctx.userId, requestId: row.id, data: { action, from: row.status, to: t.to, reason } });
  await dispatch('request.changed', { requestId: row.id, reason: 'status_changed' });
  return viewOf(updated);
}

export async function getMyRequests(ctx: UserContext, opts: { status?: RequestStatus[] } = {}): Promise<BuyerRequestView[]> {
  const conds: SQL[] = [eq(buyerRequests.buyerId, ctx.userId)];
  if (opts.status?.length) conds.push(inArray(buyerRequests.status, opts.status));
  const rows = await db.select().from(buyerRequests).where(and(...conds)).orderBy(desc(buyerRequests.updatedAt));
  const counts = await countsFor(rows.map((r) => r.id));
  return rows.map((r) => toView(r, counts.get(r.id)!));
}

/** Saved matches for a request, best/newest first, excluding stale/dismissed unless asked. Marks returned items seen. */
export async function getRequestMatches(
  ctx: UserContext,
  requestId: string,
  opts: { includeDismissed?: boolean; limit?: number } = {},
): Promise<{ request: BuyerRequestView; matches: MatchView[] }> {
  const req = await loadOwned(ctx, requestId);
  const now = new Date();
  const excluded: MatchStatus[] = opts.includeDismissed ? ['stale', 'closed'] : ['stale', 'closed', 'dismissed'];
  const rows = await db
    .select({ match: matches, listing: listings })
    .from(matches)
    .innerJoin(listings, eq(listings.id, matches.listingId))
    .where(
      and(
        eq(matches.requestId, req.id),
        notInArray(matches.status, excluded),
        // Never present unavailable inventory as active.
        eq(listings.status, 'active'),
        or(isNull(listings.expiresAt), gt(listings.expiresAt, now)),
      ),
    )
    .orderBy(desc(matches.qualifies), desc(matches.score), desc(matches.createdAt))
    .limit(Math.min(50, opts.limit ?? 10));

  const images = await loadImages(rows.map((r) => r.listing.id));
  const toSee = rows.filter((r) => r.match.status === 'suggested').map((r) => r.match.id);
  if (toSee.length) await db.update(matches).set({ status: 'seen', seenAt: now, updatedAt: now }).where(inArray(matches.id, toSee));

  const views: MatchView[] = rows.map(({ match, listing }) => ({
    matchId: match.id,
    listing: toPublicListingView(listing, images.get(listing.id) ?? [], req.hardConstraints.origin ?? null),
    score: match.score,
    qualifies: match.qualifies,
    nearMiss: match.nearMiss,
    explanation: match.explanation,
    unknowns: match.unknowns,
    status: match.status === 'suggested' ? 'seen' : match.status,
  }));
  return { request: await viewOf(req), matches: views };
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

const NEGATION = /\b(?:don ?t (?:like|want)|do not (?:like|want)|dont (?:like|want)|not a fan of|no|not|hate|dislike|without|avoid|too much|pas de|pas d|sans|n aime pas|deteste)\b/;
const ATTRIBUTE_NOUNS: [RegExp, Vocabulary][] = [
  [/\b(colou?r|couleur|shade|tone)\b/, 'colour'],
  [/\b(material|matiere|fabric)\b/, 'material'],
  [/\b(style|look|design)\b/, 'style'],
];
const DARK = new Set(['black', 'brown']);
const LIGHT = new Set(['white']);

interface Adjustment {
  attribute: string;
  values: string[];
}

/** Derive concrete request adjustments from a free-text dismissal reason. Conservative: only clear signals. */
export function adjustmentsFromReason(reason: string, listing: ListingRow): Adjustment[] {
  const t = ` ${reason
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
  const out: Adjustment[] = [];
  const add = (attribute: string, values: string[]) => {
    if (!values.length) return;
    const existing = out.find((a) => a.attribute === attribute);
    if (existing) existing.values = [...new Set([...existing.values, ...values])];
    else out.push({ attribute, values });
  };
  const listingFamilies = (attr: string) => attributeFamilies(listing.attributes, attr) ?? [];
  const materialAttr = (phrase: string) => (/\b(leg|legs|pied|pieds)\b/.test(phrase) ? 'legs_material' : /\bframe\b/.test(phrase) ? 'frame_material' : 'material');

  // Tone complaints map onto the listing's actual colour families.
  if (/\btoo (dark|sombre|fonce)\b/.test(t)) add('colour', listingFamilies('colour').filter((f) => DARK.has(f)).map((f) => familyLabel('colour', f)));
  if (/\btoo (light|bright|pale|clair)\b/.test(t)) add('colour', listingFamilies('colour').filter((f) => LIGHT.has(f)).map((f) => familyLabel('colour', f)));

  // "too vintage", "too rustic" → that style.
  const tooStyle = t.match(/\btoo ([a-z ]{3,25})/);
  if (tooStyle) add('style', normalizeTerms('style', tooStyle[1]).map((x) => x.family));

  const neg = t.match(NEGATION);
  if (neg) {
    const after = t.slice((neg.index ?? 0) + neg[0].length, (neg.index ?? 0) + neg[0].length + 40);
    for (const vocab of ['material', 'colour', 'style'] as Vocabulary[]) {
      const terms = normalizeTerms(vocab, after).map((x) => x.family);
      if (!terms.length) continue;
      add(vocab === 'material' ? materialAttr(after) : vocab, terms);
      break; // a phrase like "no metal legs" names one thing
    }
    // "don't like the colour" without a value → the listing's own colour.
    for (const [re, vocab] of ATTRIBUTE_NOUNS) {
      if (re.test(after) && !out.some((a) => a.attribute === vocab)) add(vocab, listingFamilies(vocab));
    }
  } else {
    // No negation: a value named in a dismissal reason that the listing actually has ("metal legs").
    for (const vocab of ['material', 'colour', 'style'] as Vocabulary[]) {
      for (const term of normalizeTerms(vocab, t)) {
        const attr = vocab === 'material' ? materialAttr(t) : vocab;
        const has = listingFamilies(attr).includes(term.family) || (attr !== vocab && listingFamilies(vocab).includes(term.family));
        if (has) add(attr, [term.family]);
      }
    }
  }
  return out;
}

export async function giveMatchFeedback(
  ctx: UserContext,
  matchId: string,
  feedback: { action: 'dismiss' | 'undo_dismiss'; reason?: string },
): Promise<{ matchId: string; status: string; adjusted: string[] }> {
  const [found] = await db
    .select({ match: matches, request: buyerRequests, listing: listings })
    .from(matches)
    .innerJoin(buyerRequests, eq(buyerRequests.id, matches.requestId))
    .innerJoin(listings, eq(listings.id, matches.listingId))
    .where(eq(matches.id, matchId));
  if (!found) throw notFound('Match');
  if (found.request.buyerId !== ctx.userId) throw forbidden();
  const { match, request, listing } = found;
  const now = new Date();

  if (feedback.action === 'undo_dismiss') {
    if (match.status !== 'dismissed') return { matchId, status: match.status, adjusted: [] };
    await db.update(matches).set({ status: 'seen', dismissReason: null, updatedAt: now }).where(eq(matches.id, matchId));
    return { matchId, status: 'seen', adjusted: ['Restored this match. Earlier preference adjustments were kept; edit the request to change them.'] };
  }

  const reason = feedback.reason?.trim() || null;
  await db.update(matches).set({ status: 'dismissed', dismissReason: reason, updatedAt: now }).where(eq(matches.id, matchId));
  await logEvent({ type: 'match_dismissed', actorId: ctx.userId, requestId: request.id, listingId: listing.id, matchId, data: { reason } });

  const adjusted: string[] = [];
  if (reason) {
    const hc: HardConstraints = { ...request.hardConstraints, excludedAttributes: [...(request.hardConstraints.excludedAttributes ?? [])] };
    let prefs = request.softPreferences.map((p) => ({ ...p, values: [...p.values] }));
    for (const adj of adjustmentsFromReason(reason, listing)) {
      const existing = hc.excludedAttributes!.find((e) => e.attribute === adj.attribute);
      const already = new Set(wantedFamilies(adj.attribute, existing?.values ?? []));
      const fresh = adj.values.filter((v) => !wantedFamilies(adj.attribute, [v]).every((f) => already.has(f)));
      if (!fresh.length) continue;
      if (existing) existing.values.push(...fresh);
      else hc.excludedAttributes!.push({ attribute: adj.attribute, values: fresh });
      adjusted.push(`Excluded ${adj.attribute.replace(/_/g, ' ')}: ${fresh.join(', ')}`);
      // A preference for something now excluded no longer makes sense.
      const excludedFams = new Set(wantedFamilies(adj.attribute, fresh));
      prefs = prefs
        .map((p) => (p.attribute === adj.attribute ? { ...p, values: p.values.filter((v) => !wantedFamilies(p.attribute, [v]).some((f) => excludedFams.has(f))) } : p))
        .filter((p) => p.values.length);
    }
    if (adjusted.length) {
      const [updated] = await db
        .update(buyerRequests)
        .set({ hardConstraints: hc, softPreferences: prefs, version: request.version + 1, updatedAt: now })
        .where(eq(buyerRequests.id, request.id))
        .returning();
      // Re-evaluate saved suggestions against the adjusted request (stale ones drop out).
      if (updated.status === 'active') await matchRequest(updated, { persist: true, viewerId: ctx.userId });
    }
  }
  adjusted.push('Similar items will rank lower for this request.');
  return { matchId, status: 'dismissed', adjusted };
}
