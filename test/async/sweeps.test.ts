import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../../src/domain/matching/engine.js', () => ({
  matchListing: vi.fn(async () => ({ newQualifying: [], possibleNeedingInfo: [], staled: [] })),
  staleMatchesForListing: vi.fn(async () => []),
  matchRequest: vi.fn(),
}));

import { db, pool } from '../../src/db/client.js';
import { buyerRequests, inboxItems, interests, listings, users } from '../../src/db/schema.js';
import { addInboxItem, getInbox, markInboxRead } from '../../src/domain/inbox.service.js';
import { expressInterest } from '../../src/domain/interactions.service.js';
import * as engine from '../../src/domain/matching/engine.js';
import { updateProfile } from '../../src/domain/users.service.js';
import { setMailerForTesting, type Mail } from '../../src/infra/mailer.js';
import { dispatch } from '../../src/infra/jobs.js';
import { registerAllHandlers } from '../../src/jobs/handlers.js';
import { isoWeek, runDigestSweep, runMaintenanceSweep } from '../../src/jobs/sweeps.js';
import type { UserContext } from '../../src/domain/types.js';
import { makeUser, resetDb, setupTestDb } from '../helpers/db.js';
import { insertListing, insertRequest } from './fixtures.js';

const DAY = 86400_000;

afterAll(() => pool.end());

describe('maintenance sweep', () => {
  let seller: UserContext, buyer: UserContext;
  beforeAll(async () => {
    await setupTestDb();
    registerAllHandlers();
  });
  beforeEach(async () => {
    await resetDb();
    seller = await makeUser('seller@test.dev');
    buyer = await makeUser('buyer@test.dev');
  });

  it('expires listings past expiresAt, stales matches and notifies interested buyers and the seller', async () => {
    const l = await insertListing(seller, { title: 'Vase', expiresAt: new Date(Date.now() + DAY) });
    const keep = await insertListing(seller, { expiresAt: new Date(Date.now() + 5 * DAY) });
    await expressInterest(buyer, { listingId: l.id });
    await db.update(listings).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(listings.id, l.id));

    const r = await runMaintenanceSweep();
    expect(r.listingsExpired).toBe(1);
    expect((await db.select().from(listings).where(eq(listings.id, l.id)))[0].status).toBe('expired');
    expect((await db.select().from(listings).where(eq(listings.id, keep.id)))[0].status).toBe('active');
    expect(vi.mocked(engine.staleMatchesForListing)).toHaveBeenCalledWith(l.id);
    expect((await getInbox(buyer)).items.map((i) => i.title)).toEqual(['The Vase listing has expired']);
    expect((await getInbox(seller)).items.map((i) => i.title)).toContain('Your Vase listing has expired');
    // Expiry does not withdraw interests (seller may relist).
    expect((await db.select().from(interests))[0].status).toBe('pending');
    expect((await runMaintenanceSweep()).listingsExpired).toBe(0);
  });

  it('expires requests and warns 3 days before expiry (once)', async () => {
    const old = await insertRequest(buyer, { expiresAt: new Date(Date.now() - 1000) });
    const soon = await insertRequest(buyer, { summary: 'oak desk', expiresAt: new Date(Date.now() + 2 * DAY) });
    const later = await insertRequest(buyer, { expiresAt: new Date(Date.now() + 10 * DAY) });
    const r = await runMaintenanceSweep();
    expect(r.requestsExpired).toBe(1);
    expect(r.expiryWarnings).toBe(1);
    const statuses = Object.fromEntries((await db.select().from(buyerRequests)).map((x) => [x.id, x.status]));
    expect(statuses).toEqual({ [old.id]: 'expired', [soon.id]: 'active', [later.id]: 'active' });
    const items = (await getInbox(buyer)).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'request_expiring', title: 'Your saved search expires soon' });
    expect(items[0].body).toContain('"oak desk"');
    expect((await runMaintenanceSweep()).expiryWarnings).toBe(0);
  });

  it('asks sellers to re-confirm availability after 14 days, once per ISO week', async () => {
    const stale = await insertListing(seller, { title: 'Shelf', availabilityConfirmedAt: new Date(Date.now() - 15 * DAY) });
    await insertListing(seller, { availabilityConfirmedAt: new Date(Date.now() - 2 * DAY) });
    await insertListing(seller, { status: 'paused', availabilityConfirmedAt: new Date(Date.now() - 30 * DAY) });
    const r = await runMaintenanceSweep();
    expect(r.availabilityChecks).toBe(1);
    expect((await runMaintenanceSweep()).availabilityChecks).toBe(0);
    const [item] = (await getInbox(seller)).items;
    expect(item).toMatchObject({ type: 'availability_check', title: 'Is your Shelf still available?' });
    const [row] = await db.select().from(inboxItems);
    expect(row.dedupeKey).toBe(`availability:${stale.id}:${isoWeek(new Date())}`);
    // Next week it asks again.
    expect((await runMaintenanceSweep(new Date(Date.now() + 7 * DAY))).availabilityChecks).toBeGreaterThanOrEqual(1);
  });

  it('isoWeek follows ISO-8601', () => {
    expect(isoWeek(new Date('2026-01-01T12:00:00Z'))).toBe('2026-W01');
    expect(isoWeek(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
    expect(isoWeek(new Date('2026-10-22T12:00:00Z'))).toBe('2026-W43');
  });

  it('runs through dispatch as sweep.maintenance', async () => {
    await insertRequest(buyer, { expiresAt: new Date(Date.now() - 1000) });
    await dispatch('sweep.maintenance', {});
    expect((await db.select().from(buyerRequests))[0].status).toBe('expired');
  });
});

describe('digest sweep', () => {
  const sent: Mail[] = [];
  beforeAll(async () => {
    await setupTestDb();
    setMailerForTesting({ send: async (m) => void sent.push(m) });
  });
  beforeEach(async () => {
    await resetDb();
    sent.length = 0;
  });
  afterAll(() => setMailerForTesting(null));

  it('emails one short summary per opted-in user with unread, un-emailed items', async () => {
    const a = await makeUser('a@test.dev');
    const b = await makeUser('b@test.dev');
    const c = await makeUser('c@test.dev');
    await updateProfile(a, { displayName: 'Ana' });
    await updateProfile(b, { notifyEmail: false });
    for (const k of ['1', '2']) await addInboxItem({ userId: a.userId, type: 'new_match', title: `Match ${k}`, body: 'secret body', dedupeKey: k });
    await addInboxItem({ userId: b.userId, type: 'new_match', title: 'B', body: '', dedupeKey: 'b' });
    await addInboxItem({ userId: c.userId, type: 'new_match', title: 'C', body: '', dedupeKey: 'c' });
    await markInboxRead(c, 'all');

    expect(await runDigestSweep()).toEqual({ emailsSent: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('a@test.dev');
    expect(sent[0].subject).toBe('You have 2 new marketplace updates');
    expect(sent[0].text).toContain('Hi Ana');
    expect(sent[0].text).toContain('- Match 2\n- Match 1');
    expect(sent[0].text).toContain(`open the Marketplace app in ChatGPT and ask "what's new?"`);
    expect(sent[0].text).not.toContain('secret body');

    const rows = await db.select().from(inboxItems).where(eq(inboxItems.userId, a.userId));
    expect(rows.every((r) => r.emailedAt)).toBe(true);
    expect((await db.select().from(users).where(eq(users.id, a.userId)))[0].lastDigestAt).not.toBeNull();

    expect(await runDigestSweep()).toEqual({ emailsSent: 0 });
    await addInboxItem({ userId: a.userId, type: 'new_match', title: 'Match 3', body: '', dedupeKey: '3' });
    await runDigestSweep();
    expect(sent[1].subject).toBe('You have 1 new marketplace update');
  });
});
