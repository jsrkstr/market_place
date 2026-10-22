/**
 * Async consequences of a listing change: reverse matching against saved requests, buyer/seller
 * inbox notices, and stale propagation when the listing stops being available.
 *
 * Wording rule: computed matches are "possible"; only an explicit buyer action is "interest".
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { buyerRequests, interests, listings, matches, type ListingRow } from '../db/schema.js';
import { addInboxItem } from '../domain/inbox.service.js';
import { withdrawPendingInterestsForListing } from '../domain/interactions.service.js';
// Namespace import: the engine may still be a declare-only contract stub during parallel development.
import * as engine from '../domain/matching/engine.js';
import type { ListingStatus } from '../domain/types.js';

export const itemName = (title: string | null) => title?.trim() || 'item';

export function formatPrice(cents: number | null, currency: string, source: string | null): string | null {
  if (cents == null) return null;
  const amount = new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
  return source === 'ai_estimate' ? `about ${amount} (estimated, not set by the seller)` : amount;
}

/**
 * Turns an engine "unknown" into a short field phrase. Accepts field keys ("width_cm") and the
 * engine's detail strings ("price not stated", "location approximate (~3 km, you said 2 km)").
 */
export function unknownToField(u: string): string {
  const t = u.trim().toLowerCase();
  if (t.startsWith('location')) return 'location';
  if (t.startsWith('exact type')) return 'the exact item type';
  return t
    .replace(/\s*\(.*\)\s*$/, '')
    .replace(/\s+not stated$/, '')
    .replace(/_cm$/, '')
    .replace(/[_.]/g, ' ')
    .replace(/\//g, ' and ')
    .trim();
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

const UNAVAILABLE_COPY: Record<Exclude<ListingStatus, 'draft' | 'active'>, (name: string) => { title: string; body: string }> = {
  paused: (n) => ({ title: `The ${n} is currently unavailable`, body: `The seller paused this listing, so it isn't available right now.` }),
  sold: (n) => ({ title: `The ${n} has been sold`, body: `The seller marked this item as sold. It is no longer available.` }),
  withdrawn: (n) => ({ title: `The ${n} is no longer available`, body: `The seller withdrew this listing. It is no longer available.` }),
  expired: (n) => ({ title: `The ${n} listing has expired`, body: `This listing expired and is no longer shown as available.` }),
};

export async function handleListingChanged(listingId: string): Promise<void> {
  const [listing] = await db.select().from(listings).where(eq(listings.id, listingId));
  if (!listing) return;
  if (listing.status === 'active') await onActive(listing);
  else if (listing.status !== 'draft') await onUnavailable(listing);
}

async function onActive(listing: ListingRow): Promise<void> {
  const result = await engine.matchListing(listing.id);
  const name = itemName(listing.title);

  // 1. Buyers: new qualifying matches for saved requests that want notifications.
  if (result.newQualifying.length) {
    const reqIds = [...new Set(result.newQualifying.map((m) => m.requestId))];
    const reqs = await db
      .select({ id: buyerRequests.id, notify: buyerRequests.notify, status: buyerRequests.status, summary: buyerRequests.summary, rawText: buyerRequests.rawText })
      .from(buyerRequests)
      .where(inArray(buyerRequests.id, reqIds));
    const byId = new Map(reqs.map((r) => [r.id, r]));
    const price = formatPrice(listing.priceCents, listing.currency, listing.priceSource);
    for (const m of result.newQualifying) {
      const req = byId.get(m.requestId);
      if (!req || !req.notify || req.status !== 'active') continue;
      const search = req.summary?.trim() || req.rawText;
      const details = [price, listing.areaLabel].filter(Boolean).join(', ');
      await addInboxItem({
        userId: m.buyerId,
        type: 'new_match',
        title: `New match for your saved search: ${name}`,
        body: `A newly listed ${name}${details ? ` (${details})` : ''} fits your saved search "${search}". Ask to see the listing details before deciding.`,
        payload: { matchId: m.matchId, requestId: m.requestId, listingId: listing.id, score: m.score },
        dedupeKey: `match:${m.matchId}`,
      });
      await db
        .update(matches)
        .set({ notifiedAt: new Date() })
        .where(and(eq(matches.id, m.matchId), isNull(matches.notifiedAt)));
    }
  }

  // 2. Seller: possible demand blocked only by missing info. Clearly NOT confirmed interest.
  if (result.possibleNeedingInfo.length) {
    const n = new Set(result.possibleNeedingInfo.map((p) => p.requestId)).size;
    const counts = new Map<string, number>();
    for (const p of result.possibleNeedingInfo) {
      for (const f of new Set(p.unknowns.map(unknownToField).filter(Boolean))) counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    const fields = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f).slice(0, 3);
    const searches = n === 1 ? "1 buyer's saved search" : `${n} buyers' saved searches`;
    await addInboxItem({
      userId: listing.sellerId,
      type: 'possible_demand',
      title: `Your ${name} may match ${searches}`,
      body:
        `Your ${name} may match ${searches}. ` +
        (fields.length ? `Adding ${joinWords(fields)} would let us confirm whether it fits. ` : '') +
        'This is a possible match, not confirmed interest.',
      payload: { listingId: listing.id, possibleMatches: n, suggestedFields: fields, confirmedInterest: false },
      dedupeKey: `possible_demand:${listing.id}:v${listing.version}`,
    });
  }

  // 3. Matches the listing no longer satisfies after an edit: tell buyers who had expressed interest.
  if (result.staled.length) {
    const interested = await interestedBuyerIds(listing.id, result.staled.map((s) => s.buyerId));
    for (const buyerId of interested) {
      await addInboxItem({
        userId: buyerId,
        type: 'listing_unavailable',
        title: `The ${name} no longer matches your saved search`,
        body: `The seller changed this listing and it no longer fits what you asked for. Check the details before arranging anything.`,
        payload: { listingId: listing.id, status: listing.status, reason: 'no_longer_matches' },
        dedupeKey: `unavailable:${listing.id}:${buyerId}:changed:v${listing.version}`,
      });
    }
  }
}

/** Buyers with an open (pending/accepted) interest on the listing, optionally restricted to a set. */
async function interestedBuyerIds(listingId: string, restrictTo?: string[]): Promise<string[]> {
  const rows = await db
    .select({ buyerId: interests.buyerId })
    .from(interests)
    .where(and(eq(interests.listingId, listingId), inArray(interests.status, ['pending', 'accepted'])));
  const ids = rows.map((r) => r.buyerId);
  return restrictTo ? ids.filter((id) => restrictTo.includes(id)) : ids;
}

async function onUnavailable(listing: ListingRow): Promise<void> {
  const status = listing.status as Exclude<ListingStatus, 'draft' | 'active'>;
  const staled = await engine.staleMatchesForListing(listing.id);

  const notify = new Set<string>(staled.filter((s) => s.wasInterested).map((s) => s.buyerId));
  for (const b of await interestedBuyerIds(listing.id)) notify.add(b);

  const withdrawn =
    status === 'sold' || status === 'withdrawn' ? await withdrawPendingInterestsForListing(listing.id) : [];
  const withdrawnFor = new Map(withdrawn.map((w) => [w.buyerId, w.interestId]));
  for (const w of withdrawn) notify.add(w.buyerId);

  const copy = UNAVAILABLE_COPY[status](itemName(listing.title));
  for (const buyerId of notify) {
    const interestId = withdrawnFor.get(buyerId);
    await addInboxItem({
      userId: buyerId,
      type: 'listing_unavailable',
      title: copy.title,
      body: copy.body + (interestId ? ' Your pending interest has been closed.' : ''),
      payload: { listingId: listing.id, status, interestId: interestId ?? null, interestWithdrawn: !!interestId },
      dedupeKey: `unavailable:${listing.id}:${buyerId}:${status}`,
    });
  }
}
