import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, pool } from '../../src/db/client.js';
import { buyerRequests, matches } from '../../src/db/schema.js';
import { createListing, getListingDemand, setListingStatus, updateListing, type ListingInput } from '../../src/domain/listings.service.js';
import { matchListing, staleMatchesForListing } from '../../src/domain/matching/engine.js';
import {
  createBuyerRequest,
  getMyRequests,
  getRequestMatches,
  giveMatchFeedback,
  searchListings,
  setBuyerRequestStatus,
  updateBuyerRequest,
} from '../../src/domain/requests.service.js';
import { setDefaultLocation } from '../../src/domain/users.service.js';
import type { UserContext } from '../../src/domain/types.js';
import { makeUser, resetDb, setupTestDb } from '../helpers/db.js';
import { buyerChairs, sellerChair } from './fixtures.js';

let seller: UserContext;
let seller2: UserContext;
let buyer: UserContext;
let buyer2: UserContext;

beforeAll(setupTestDb);
beforeEach(async () => {
  await resetDb();
  seller = await makeUser('seller@test.dev');
  seller2 = await makeUser('seller2@test.dev');
  buyer = await makeUser('buyer@test.dev');
  buyer2 = await makeUser('buyer2@test.dev');
});
afterAll(() => pool.end());

const chair = (over: Partial<ListingInput> & { colour?: string; legs?: string }): ListingInput => ({
  title: over.title ?? `${over.colour ?? ''} dining chair`.trim(),
  category: 'dining chair',
  attributes: {
    ...(over.colour ? { colour: { value: over.colour, source: 'seller_stated' as const } } : {}),
    ...(over.legs ? { legs_material: { value: over.legs, source: 'seller_stated' as const } } : {}),
    ...over.attributes,
  },
  priceCents: 3000,
  condition: { value: 'good', source: 'seller_stated' },
  location: { text: 'Paris' },
  ...over,
});

async function publish(ctx: UserContext, input: ListingInput) {
  const r = await createListing(ctx, { publish: true, ...input });
  expect(r.published, r.publishBlockers.join()).toBe(true);
  return r.listing.id;
}

describe('brief scenario', () => {
  it('the buyer example immediately matches the seller example, with an honest explanation', async () => {
    const chairId = await publish(seller, sellerChair);
    const r = await createBuyerRequest(buyer, buyerChairs);
    expect(r.request?.category).toBe('furniture/seating/dining-chair');
    expect(r.request?.hardConstraints.origin?.label).toBe('Paris');
    expect(r.notes).toEqual([]);
    const m = r.matches.find((x) => x.listing.id === chairId)!;
    expect(m).toBeDefined();
    expect(m.matchId).toMatch(/^mat_/);
    expect(m.qualifies).toBe(true);
    expect(m.nearMiss).toBe(false);
    expect(m.explanation).toContain('€20, within your €80 budget');
    expect(m.explanation).toContain('White (close to your beige/off-white)');
    expect(m.explanation).toContain('Wooden legs: not stated');
    expect(m.unknowns).toContain('quantity not stated (you need 2)');
    expect(m.unknowns).toContain('dimensions not stated');
    // Public projection only.
    expect(JSON.stringify(m.listing)).not.toMatch(/seller@|usr_|exactLat|exactAddress/);
    expect(m.listing.approxDistanceKm).toBe(0.5);
    // Returned matches are marked notified so async jobs don't notify again.
    const [row] = await db.select().from(matches).where(eq(matches.id, m.matchId!));
    expect(row.notifiedAt).not.toBeNull();
  });

  it('ranks a cream/ivory wooden chair above a plain white one and drops contradicting ones', async () => {
    const white = await publish(seller, sellerChair);
    const ivory = await publish(seller2, chair({ title: 'Ivory dining chair', colour: 'ivory', legs: 'oak' }));
    const black = await publish(seller2, chair({ title: 'Black metal bistro chair', colour: 'black', legs: 'metal' }));
    const r = await searchListings(buyer, buyerChairs);
    const ids = r.matches.map((m) => m.listing.id);
    expect(ids[0]).toBe(ivory);
    expect(ids).toContain(white);
    expect(ids).not.toContain(black);
    expect(r.matches[0].explanation).toMatch(/^Ivory \(you wanted beige\/off-white\) · Oak legs \(you wanted wood\)/);
  });

  it('a clear contradiction of a strong preference is left off the shortlist; an unknown value is not', async () => {
    const strong = { ...buyerChairs, softPreferences: [{ attribute: 'colour', values: ['beige', 'off-white'], weight: 0.8 }] };
    const green = await publish(seller, chair({ title: 'Modern dining chair', colour: 'sage green', legs: 'oak' }));
    const unknown = await publish(seller2, chair({ title: 'Modern dining chair', legs: 'oak' }));
    const ids = (await searchListings(buyer, strong)).matches.map((m) => m.listing.id);
    expect(ids).not.toContain(green);
    expect(ids).toContain(unknown);
  });
});

describe('hard constraints', () => {
  it('budget and distance violations never qualify', async () => {
    const tooExpensive = await publish(seller, chair({ title: 'Cream chair, pricey', colour: 'cream', priceCents: 12000 }));
    const slightlyOver = await publish(seller, chair({ title: 'Cream chair, bit over', colour: 'cream', priceCents: 8500, location: { text: 'bastille' } }));
    const lyon = await publish(seller2, chair({ title: 'Cream chair in Lyon', colour: 'cream', location: { text: 'lyon' } }));
    const far = await publish(seller2, chair({ title: 'Cream chair in the 20th', colour: 'cream', location: { text: 'paris 20e' } }));
    const near = await publish(seller2, chair({ title: 'Cream chair at Bastille', colour: 'cream', location: { text: 'bastille' } }));

    const strict = await searchListings(buyer, buyerChairs);
    const ids = strict.matches.map((m) => m.listing.id);
    expect(ids).toEqual([near]);
    expect(strict.nearMisses).toEqual([]);

    // Exceptions only produce labelled near-misses, never qualifying matches.
    const relaxed = await searchListings(buyer, { ...buyerChairs, allowExceptions: { budgetPct: 10 } });
    expect(relaxed.matches.map((m) => m.listing.id)).toEqual([near]);
    expect(relaxed.nearMisses.map((m) => m.listing.id)).toEqual([slightlyOver]);
    expect(relaxed.nearMisses[0]).toMatchObject({ qualifies: false, nearMiss: true });
    expect(relaxed.nearMisses[0].explanation).toContain('Near-miss: €85, 6% over your €80 budget');
    for (const id of [tooExpensive, lyon, far]) {
      expect([...relaxed.matches, ...relaxed.nearMisses].map((m) => m.listing.id)).not.toContain(id);
    }

    // Reverse direction agrees.
    const req = await createBuyerRequest(buyer2, buyerChairs);
    for (const id of [tooExpensive, lyon, far, slightlyOver]) {
      const res = await matchListing(id);
      expect(res.newQualifying.map((n) => n.requestId)).not.toContain(req.request!.id);
    }
  });

  it('flags unknown dimensions but excludes known violations', async () => {
    const unknown = await publish(seller, chair({ title: 'Cream chair', colour: 'cream' }));
    const wide = await publish(seller, chair({ title: 'Wide cream chair', colour: 'cream', attributes: { width_cm: { value: 60, source: 'seller_stated' } } }));
    const fits = await publish(seller2, chair({ title: 'Narrow cream chair', colour: 'cream', attributes: { width_cm: { value: 45, source: 'seller_stated' } } }));
    const r = await searchListings(buyer, { ...buyerChairs, hardConstraints: { ...buyerChairs.hardConstraints, maxDimensionsCm: { widthCm: 50 } } });
    const byId = new Map(r.matches.map((m) => [m.listing.id, m]));
    expect(byId.has(wide)).toBe(false);
    expect(byId.get(unknown)?.unknowns).toContain('width not stated');
    expect(byId.get(fits)?.unknowns).not.toContain('width not stated');
    expect(byId.get(fits)?.explanation).toContain('Width 45 cm fits');
  });

  it('required colour uses families: cream request matches an ivory listing', async () => {
    const ivory = await publish(seller, chair({ title: 'Dining chair', colour: 'ivory' }));
    const grey = await publish(seller, chair({ title: 'Dining chair grey', colour: 'charcoal' }));
    const unstated = await publish(seller2, chair({ title: 'Dining chair plain' }));
    const r = await searchListings(buyer, {
      rawText: 'cream dining chair',
      category: 'dining chair',
      hardConstraints: { requiredAttributes: [{ attribute: 'color', values: ['cream'] }] },
      location: { text: 'Paris' },
    });
    const ids = r.matches.map((m) => m.listing.id);
    expect(ids).toContain(ivory);
    expect(ids).not.toContain(grey);
    expect(ids).toContain(unstated);
    expect(r.matches.find((m) => m.listing.id === unstated)!.unknowns).toContain('colour not stated');
    expect(r.notes).toContain('No budget given, so price was not filtered.');
  });

  it('a request for "chair" covers dining chairs and armchairs but not lamps', async () => {
    const dining = await publish(seller, chair({ title: 'Wooden dining chair', colour: 'brown' }));
    const arm = await publish(seller, { title: 'Armchair, comfy reading chair', category: 'armchair', priceCents: 4000, location: { text: 'Paris' } });
    const lamp = await publish(seller2, { title: 'Chair-side floor lamp', category: 'floor lamp', priceCents: 4000, location: { text: 'Paris' } });
    const r = await searchListings(buyer, { rawText: 'a chair', category: 'chair', location: { text: 'Paris' } });
    const ids = r.matches.map((m) => m.listing.id);
    expect(ids).toEqual(expect.arrayContaining([dining, arm]));
    expect(ids).not.toContain(lamp);
  });

  it('never shows the buyer their own listings', async () => {
    await publish(buyer, chair({ title: 'Cream chair', colour: 'cream' }));
    const r = await searchListings(buyer, buyerChairs);
    expect(r.matches).toEqual([]);
  });
});

describe('requests', () => {
  it('ephemeral search persists nothing', async () => {
    await publish(seller, sellerChair);
    const r = await searchListings(buyer, buyerChairs);
    expect(r.request).toBeNull();
    expect(r.matches.length).toBeGreaterThan(0);
    expect(r.matches.every((m) => m.matchId === null && m.status === null)).toBe(true);
    expect(await db.select().from(buyerRequests)).toHaveLength(0);
    expect(await db.select().from(matches)).toHaveLength(0);
  });

  it('notes when distance/budget could not be applied, and falls back to the default location', async () => {
    await publish(seller, sellerChair);
    const r = await searchListings(buyer, { rawText: 'dining chair', category: 'dining chair', hardConstraints: { maxDistanceKm: 2 } });
    expect(r.notes.join(' ')).toMatch(/distance was not applied/);
    expect(r.notes.join(' ')).toMatch(/No budget given/);
    expect(r.matches[0].listing.approxDistanceKm).toBeNull();
    await setDefaultLocation(buyer, { text: 'Paris 11e' });
    const r2 = await searchListings(buyer, { rawText: 'dining chair', category: 'dining chair', hardConstraints: { maxDistanceKm: 3 } });
    expect(r2.notes.join(' ')).not.toMatch(/distance/);
    expect(r2.matches[0].listing.approxDistanceKm).toBe(2);
  });

  it('only the owner can read or modify a request', async () => {
    await publish(seller, sellerChair);
    const r = await createBuyerRequest(buyer, buyerChairs);
    const id = r.request!.id;
    const matchId = r.matches[0].matchId!;
    await expect(getRequestMatches(buyer2, id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateBuyerRequest(buyer2, id, { summary: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(setBuyerRequestStatus(buyer2, id, 'cancel')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(giveMatchFeedback(buyer2, matchId, { action: 'dismiss' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await getMyRequests(buyer2)).toEqual([]);
    const mine = await getMyRequests(buyer);
    expect(mine).toHaveLength(1);
    expect(mine[0].counts.suggested).toBe(1);
  });

  it('getRequestMatches marks seen and update re-matches, staling what no longer qualifies', async () => {
    const cheap = await publish(seller, sellerChair); // €20
    const mid = await publish(seller2, chair({ title: 'Cream dining chair', colour: 'cream' })); // €30
    const r = await createBuyerRequest(buyer, buyerChairs);
    const id = r.request!.id;
    const got = await getRequestMatches(buyer, id);
    expect(got.matches.map((m) => m.listing.id).sort()).toEqual([cheap, mid].sort());
    expect(got.matches.every((m) => m.status === 'seen')).toBe(true);

    const u = await updateBuyerRequest(buyer, id, { hardConstraints: { maxPriceCents: 2500 } });
    expect(u.matches.map((m) => m.listing.id)).toEqual([cheap]);
    const [stale] = await db.select().from(matches).where(and(eq(matches.requestId, id), eq(matches.listingId, mid)));
    expect(stale.status).toBe('stale');
    expect((await getRequestMatches(buyer, id)).matches.map((m) => m.listing.id)).toEqual([cheap]);
    const [req] = await db.select().from(buyerRequests).where(eq(buyerRequests.id, id));
    expect(req.version).toBe(2);
    expect(req.hardConstraints.maxDistanceKm).toBe(2); // shallow merge kept the rest
  });

  it('a dismissed listing is never re-suggested, the reason adjusts the request, and similar items rank lower', async () => {
    const metal = await publish(seller, chair({ title: 'Cream chair with black metal legs', colour: 'cream', legs: 'metal' }));
    const similar = await publish(seller2, chair({ title: 'Cream chair with black metal legs', colour: 'cream', description: 'same model' }));
    const r = await createBuyerRequest(buyer, buyerChairs);
    const id = r.request!.id;
    const m = r.matches.find((x) => x.listing.id === metal)!;
    const before = r.matches.find((x) => x.listing.id === similar)!;

    const fb = await giveMatchFeedback(buyer, m.matchId!, { action: 'dismiss', reason: "I don't like metal legs" });
    expect(fb.status).toBe('dismissed');
    expect(fb.adjusted[0]).toBe('Excluded legs material: metal');
    const [req] = await db.select().from(buyerRequests).where(eq(buyerRequests.id, id));
    expect(req.hardConstraints.excludedAttributes).toEqual([{ attribute: 'legs_material', values: ['metal'] }]);

    // Re-matching (update) and the reverse direction both leave it dismissed.
    const u = await updateBuyerRequest(buyer, id, { summary: 'two chairs, no metal' });
    expect(u.matches.map((x) => x.listing.id)).not.toContain(metal);
    await updateListing(seller, metal, { description: 'Now with a fresh description' });
    await matchListing(metal);
    const [row] = await db.select().from(matches).where(eq(matches.id, m.matchId!));
    expect(row.status).toBe('dismissed');
    expect(row.dismissReason).toBe("I don't like metal legs");
    expect((await getRequestMatches(buyer, id)).matches.map((x) => x.listing.id)).not.toContain(metal);

    // The similar listing (legs material unknown) now carries a feedback penalty.
    const after = u.matches.find((x) => x.listing.id === similar)!;
    expect(after).toBeDefined();
    expect(after.unknowns).toContain("legs material not stated (you don't want metal)");
    expect(after.score).toBeLessThan(before.score);
    const [simRow] = await db.select().from(matches).where(eq(matches.id, after.matchId!));
    expect(simRow.breakdown.feedbackPenalty).toBeGreaterThan(0);

    const undo = await giveMatchFeedback(buyer, m.matchId!, { action: 'undo_dismiss' });
    expect(undo.status).toBe('seen');
  });

  it('maps tone complaints to the listing colour', async () => {
    const id = await publish(seller, chair({ title: 'Dark chair', colour: 'black' }));
    const r = await createBuyerRequest(buyer, { rawText: 'dining chair', category: 'dining chair', location: { text: 'Paris' } });
    const m = r.matches.find((x) => x.listing.id === id)!;
    const fb = await giveMatchFeedback(buyer, m.matchId!, { action: 'dismiss', reason: 'too dark' });
    expect(fb.adjusted[0]).toBe('Excluded colour: black');
    const vague = await giveMatchFeedback(buyer, m.matchId!, { action: 'dismiss', reason: 'just not for me' });
    expect(vague.adjusted).toEqual(['Similar items will rank lower for this request.']);
  });

  it('cancel closes open matches', async () => {
    await publish(seller, sellerChair);
    const r = await createBuyerRequest(buyer, buyerChairs);
    const v = await setBuyerRequestStatus(buyer, r.request!.id, 'cancel', 'found one');
    expect(v.status).toBe('cancelled');
    const rows = await db.select().from(matches).where(eq(matches.requestId, r.request!.id));
    expect(rows.every((x) => x.status === 'closed')).toBe(true);
  });
});

describe('reverse matching and availability', () => {
  it('matchListing finds a saved request when a matching listing is published later', async () => {
    const r = await createBuyerRequest(buyer, buyerChairs);
    expect(r.matches).toEqual([]);
    expect(r.notes.join(' ')).toMatch(/request is saved/);
    const other = await createBuyerRequest(buyer2, { rawText: 'floor lamp', category: 'floor lamp', location: { text: 'Paris' } });

    const id = await publish(seller, sellerChair);
    const res = await matchListing(id);
    expect(res.newQualifying).toHaveLength(1);
    expect(res.newQualifying[0]).toMatchObject({ requestId: r.request!.id, buyerId: buyer.userId });
    expect(res.possibleNeedingInfo).toEqual([{ requestId: r.request!.id, unknowns: ['quantity not stated (you need 2)', 'dimensions not stated'] }]);
    expect(res.newQualifying.map((n) => n.requestId)).not.toContain(other.request!.id);

    // Idempotent upsert: one row per pair; once notified it's no longer "new".
    await db.update(matches).set({ notifiedAt: new Date() }).where(eq(matches.id, res.newQualifying[0].matchId));
    const again = await matchListing(id);
    expect(again.newQualifying).toEqual([]);
    expect(await db.select().from(matches).where(eq(matches.listingId, id))).toHaveLength(1);

    // Demand is reported honestly: possible matches vs explicit interest.
    const demand = await getListingDemand(seller, id);
    expect(demand).toMatchObject({ possibleMatches: 1, possibleMatchesNeedingInfo: 1, interestedBuyers: 0, pendingInterests: [] });
    expect(demand.note).toMatch(/not confirmed buyer interest/);
    expect(demand.suggestedFields[0].field).toBe('quantity');

    // Seller fixes the price above budget → the match goes stale.
    await updateListing(seller, id, { priceCents: 9000 });
    const changed = await matchListing(id);
    expect(changed.staled).toEqual([{ matchId: res.newQualifying[0].matchId, requestId: r.request!.id, buyerId: buyer.userId }]);
  });

  it('a sold listing turns its matches stale and disappears from saved matches', async () => {
    const id = await publish(seller, sellerChair);
    const r = await createBuyerRequest(buyer, buyerChairs);
    const r2 = await createBuyerRequest(buyer2, buyerChairs);
    await db.update(matches).set({ status: 'interested' }).where(eq(matches.id, r2.matches[0].matchId!));

    await setListingStatus(seller, id, 'mark_sold');
    expect((await getRequestMatches(buyer, r.request!.id)).matches).toEqual([]); // even before the job runs
    const staled = await staleMatchesForListing(id);
    expect(staled).toHaveLength(2);
    expect(staled.find((s) => s.buyerId === buyer2.userId)?.wasInterested).toBe(true);
    expect(staled.find((s) => s.buyerId === buyer.userId)?.wasInterested).toBe(false);
    const rows = await db.select().from(matches).where(eq(matches.listingId, id));
    expect(rows.every((x) => x.status === 'stale')).toBe(true);
    expect((await matchListing(id)).staled).toEqual([]); // nothing left to stale
  });
});
