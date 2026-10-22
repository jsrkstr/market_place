import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// The matching engine belongs to domain-core; mock it so these tests pin down the notification logic.
vi.mock('../../src/domain/matching/engine.js', () => ({
  matchListing: vi.fn(),
  staleMatchesForListing: vi.fn(),
  matchRequest: vi.fn(),
}));

import { db, pool } from '../../src/db/client.js';
import { interests, listings, matches } from '../../src/db/schema.js';
import { getInbox } from '../../src/domain/inbox.service.js';
import { expressInterest, respondToInterest } from '../../src/domain/interactions.service.js';
import * as engine from '../../src/domain/matching/engine.js';
import { dispatch } from '../../src/infra/jobs.js';
import { registerAllHandlers } from '../../src/jobs/handlers.js';
import { unknownToField } from '../../src/jobs/listingChanged.js';
import type { UserContext } from '../../src/domain/types.js';
import { makeUser, resetDb, setupTestDb } from '../helpers/db.js';
import { insertListing, insertMatch, insertRequest } from './fixtures.js';

const matchListing = vi.mocked(engine.matchListing);
const staleMatches = vi.mocked(engine.staleMatchesForListing);
const empty = { newQualifying: [], possibleNeedingInfo: [], staled: [] };

describe('listing.changed handler', () => {
  let seller: UserContext, buyer: UserContext, buyer2: UserContext;

  beforeAll(async () => {
    await setupTestDb();
    registerAllHandlers();
  });
  beforeEach(async () => {
    await resetDb();
    vi.clearAllMocks();
    seller = await makeUser('seller@test.dev');
    buyer = await makeUser('buyer@test.dev');
    buyer2 = await makeUser('buyer2@test.dev');
  });
  afterAll(() => pool.end());

  it('notifies buyers of new qualifying matches only for active, notify=true requests (once)', async () => {
    const l = await insertListing(seller, { title: 'Cream chair', priceCents: 2500 });
    const r1 = await insertRequest(buyer);
    const r2 = await insertRequest(buyer2, { notify: false });
    const m1 = await insertMatch(r1.id, l.id);
    const m2 = await insertMatch(r2.id, l.id);
    matchListing.mockResolvedValue({
      ...empty,
      newQualifying: [
        { matchId: m1.id, requestId: r1.id, buyerId: buyer.userId, score: 0.8 },
        { matchId: m2.id, requestId: r2.id, buyerId: buyer2.userId, score: 0.7 },
      ],
    });
    await dispatch('listing.changed', { listingId: l.id, reason: 'published' });
    await dispatch('listing.changed', { listingId: l.id, reason: 'updated' });

    const items = (await getInbox(buyer)).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'new_match', title: 'New match for your saved search: Cream chair' });
    expect(items[0].body).toContain('€25');
    expect(items[0].body).toContain('Paris 11e');
    expect(items[0].body).not.toContain('rue Secrète');
    expect(items[0].payload).toMatchObject({ matchId: m1.id, listingId: l.id, requestId: r1.id });
    expect((await db.select().from(matches).where(eq(matches.id, m1.id)))[0].notifiedAt).not.toBeNull();
    expect((await getInbox(buyer2)).items).toHaveLength(0);
    expect((await db.select().from(matches).where(eq(matches.id, m2.id)))[0].notifiedAt).toBeNull();
  });

  it('tells the seller about possible demand, worded as possible (not interest), once per version', async () => {
    const l = await insertListing(seller, { title: 'Oak chair' });
    const r1 = await insertRequest(buyer);
    const r2 = await insertRequest(buyer2);
    matchListing.mockResolvedValue({
      ...empty,
      possibleNeedingInfo: [
        { requestId: r1.id, unknowns: ['width_cm', 'colour'] },
        { requestId: r2.id, unknowns: ['width_cm'] },
      ],
    });
    await dispatch('listing.changed', { listingId: l.id, reason: 'published' });
    await dispatch('listing.changed', { listingId: l.id, reason: 'updated' });
    let items = (await getInbox(seller)).items;
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('possible_demand');
    expect(items[0].body).toBe(
      "Your Oak chair may match 2 buyers' saved searches. Adding width and colour would let us confirm whether it fits. This is a possible match, not confirmed interest.",
    );
    expect(items[0].body.toLowerCase()).not.toContain('interested');
    expect(items[0].payload).toMatchObject({ possibleMatches: 2, confirmedInterest: false });

    await db.update(listings).set({ version: 2 }).where(eq(listings.id, l.id));
    await dispatch('listing.changed', { listingId: l.id, reason: 'updated' });
    items = (await getInbox(seller)).items;
    expect(items).toHaveLength(2);
  });

  it('when an edit stales matches, only buyers who expressed interest are told', async () => {
    const l = await insertListing(seller, { title: 'Desk' });
    const r1 = await insertRequest(buyer);
    const r2 = await insertRequest(buyer2);
    const m1 = await insertMatch(r1.id, l.id);
    const m2 = await insertMatch(r2.id, l.id);
    await expressInterest(buyer, { listingId: l.id });
    matchListing.mockResolvedValue({
      ...empty,
      staled: [
        { matchId: m1.id, requestId: r1.id, buyerId: buyer.userId },
        { matchId: m2.id, requestId: r2.id, buyerId: buyer2.userId },
      ],
    });
    await dispatch('listing.changed', { listingId: l.id, reason: 'updated' });
    const items = (await getInbox(buyer)).items.filter((i) => i.type === 'listing_unavailable');
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('The Desk no longer matches your saved search');
    expect((await getInbox(buyer2)).items).toHaveLength(0);
  });

  it('on sold: stales matches, notifies interested buyers, withdraws pending interests', async () => {
    const l = await insertListing(seller, { title: 'Lamp' });
    const r1 = await insertRequest(buyer);
    const r2 = await insertRequest(buyer2);
    const m1 = await insertMatch(r1.id, l.id);
    await insertMatch(r2.id, l.id);
    const i = await expressInterest(buyer, { listingId: l.id, matchId: m1.id });
    staleMatches.mockResolvedValue([
      { matchId: m1.id, requestId: r1.id, buyerId: buyer.userId, wasInterested: true },
    ]);
    await db.update(listings).set({ status: 'sold' }).where(eq(listings.id, l.id));
    await dispatch('listing.changed', { listingId: l.id, reason: 'status_changed' });
    await dispatch('listing.changed', { listingId: l.id, reason: 'status_changed' });

    expect(matchListing).not.toHaveBeenCalled();
    expect(staleMatches).toHaveBeenCalledWith(l.id);
    const items = (await getInbox(buyer)).items.filter((x) => x.type === 'listing_unavailable');
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('The Lamp has been sold');
    expect(items[0].body).toContain('Your pending interest has been closed.');
    expect(items[0].payload).toMatchObject({ interestId: i.interestId, interestWithdrawn: true });
    expect((await db.select().from(interests).where(eq(interests.id, i.interestId)))[0].status).toBe('withdrawn');
    expect((await getInbox(buyer2)).items).toHaveLength(0);
  });

  it('on pause: notifies interested buyers but keeps interests open', async () => {
    const l = await insertListing(seller, { title: 'Rug' });
    const i = await expressInterest(buyer, { listingId: l.id });
    await respondToInterest(seller, i.interestId, { action: 'accept' });
    staleMatches.mockResolvedValue([]);
    await db.update(listings).set({ status: 'paused' }).where(eq(listings.id, l.id));
    await dispatch('listing.changed', { listingId: l.id, reason: 'status_changed' });
    const items = (await getInbox(buyer)).items.filter((x) => x.type === 'listing_unavailable');
    expect(items.map((x) => x.title)).toEqual(['The Rug is currently unavailable']);
    expect((await db.select().from(interests).where(eq(interests.id, i.interestId)))[0].status).toBe('accepted');
  });

  it('ignores drafts and missing listings', async () => {
    const l = await insertListing(seller, { status: 'draft' });
    await dispatch('listing.changed', { listingId: l.id, reason: 'updated' });
    await dispatch('listing.changed', { listingId: 'lst_missing', reason: 'updated' });
    expect(matchListing).not.toHaveBeenCalled();
    expect(staleMatches).not.toHaveBeenCalled();
  });

  it('turns engine unknown details into short field phrases', () => {
    expect(unknownToField('price not stated')).toBe('price');
    expect(unknownToField('width/height not stated')).toBe('width and height');
    expect(unknownToField('location approximate (~3 km, you said 2 km)')).toBe('location');
    expect(unknownToField("colour not stated (you don't want red)")).toBe('colour');
    expect(unknownToField('exact type not stated (listed as seating)')).toBe('the exact item type');
    expect(unknownToField('width_cm')).toBe('width');
  });
});
