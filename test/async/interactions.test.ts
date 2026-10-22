import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, pool } from '../../src/db/client.js';
import { events, inboxItems, matches, messages } from '../../src/db/schema.js';
import { getInbox } from '../../src/domain/inbox.service.js';
import {
  expressInterest,
  getConversation,
  listMyInterests,
  respondToInterest,
  sendMessage,
  shareContact,
} from '../../src/domain/interactions.service.js';
import { updateProfile } from '../../src/domain/users.service.js';
import type { UserContext } from '../../src/domain/types.js';
import { makeUser, resetDb, setupTestDb } from '../helpers/db.js';
import { insertListing, insertMatch, insertRequest } from './fixtures.js';

const BUYER_EMAIL = 'buyer.private@test.dev';
const SELLER_EMAIL = 'seller.private@test.dev';

describe('interactions', () => {
  let seller: UserContext, buyer: UserContext, stranger: UserContext;

  beforeAll(setupTestDb);
  beforeEach(async () => {
    await resetDb();
    seller = await makeUser(SELLER_EMAIL);
    buyer = await makeUser(BUYER_EMAIL);
    stranger = await makeUser('stranger@test.dev');
  });
  afterAll(() => pool.end());

  it('only a non-owner may express interest, and only on active listings', async () => {
    const l = await insertListing(seller);
    await expect(expressInterest(seller, { listingId: l.id })).rejects.toMatchObject({ code: 'invalid' });
    const sold = await insertListing(seller, { status: 'sold' });
    await expect(expressInterest(buyer, { listingId: sold.id })).rejects.toThrow(/no longer available/);
    const draft = await insertListing(seller, { status: 'draft' });
    await expect(expressInterest(buyer, { listingId: draft.id })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('is idempotent, links the buyer’s match and notifies the seller with confirmed-interest wording', async () => {
    const l = await insertListing(seller, { title: 'White IKEA chair' });
    const req = await insertRequest(buyer);
    const m = await insertMatch(req.id, l.id);

    const v1 = await expressInterest(buyer, { listingId: l.id, message: 'Is it still wobbly-free?' });
    const v2 = await expressInterest(buyer, { listingId: l.id });
    expect(v2.interestId).toBe(v1.interestId);
    expect(v1.role).toBe('buyer');
    expect(v1.status).toBe('pending');
    expect(v1.counterpartContact).toBeNull();

    const [mm] = await db.select().from(matches).where(eq(matches.id, m.id));
    expect(mm.status).toBe('interested');

    const sellerInbox = await getInbox(seller);
    const interestItems = sellerInbox.items.filter((i) => i.type === 'buyer_interest');
    expect(interestItems).toHaveLength(1);
    expect(interestItems[0].title).toBe('A buyer is interested in your White IKEA chair');
    expect(interestItems[0].body).toContain('Is it still wobbly-free?');
    expect(interestItems[0].payload).toMatchObject({ interestId: v1.interestId, listingId: l.id });
    // No buyer contact leaks into anything the seller can see.
    const allSellerItems = await db.select().from(inboxItems).where(eq(inboxItems.userId, seller.userId));
    expect(JSON.stringify(allSellerItems)).not.toContain(BUYER_EMAIL);
    expect(JSON.stringify(await getConversation(seller, v1.interestId))).not.toContain(BUYER_EMAIL);

    const evts = await db.select().from(events).where(eq(events.type, 'interest_expressed'));
    expect(evts).toHaveLength(1);
  });

  it('rejects a matchId belonging to someone else', async () => {
    const l = await insertListing(seller);
    const otherReq = await insertRequest(stranger);
    const m = await insertMatch(otherReq.id, l.id);
    await expect(expressInterest(buyer, { listingId: l.id, matchId: m.id })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('accept connects the match and notifies the buyer; decline closes it', async () => {
    const l = await insertListing(seller, { title: 'Oak table' });
    const req = await insertRequest(buyer);
    const m = await insertMatch(req.id, l.id);
    const i = await expressInterest(buyer, { listingId: l.id, matchId: m.id });

    await expect(respondToInterest(buyer, i.interestId, { action: 'accept' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(respondToInterest(stranger, i.interestId, { action: 'accept' })).rejects.toMatchObject({ code: 'not_found' });

    const accepted = await respondToInterest(seller, i.interestId, { action: 'accept', message: 'Sure, come Saturday' });
    expect(accepted.status).toBe('accepted');
    expect((await db.select().from(matches).where(eq(matches.id, m.id)))[0].status).toBe('connected');
    const buyerInbox = await getInbox(buyer);
    const resp = buyerInbox.items.find((x) => x.type === 'interest_response')!;
    expect(resp.title).toBe('The seller accepted your interest in the Oak table');
    expect(resp.body).toContain('Sure, come Saturday');
    // Repeating the same action is idempotent; switching is a conflict.
    await respondToInterest(seller, i.interestId, { action: 'accept' });
    await expect(respondToInterest(seller, i.interestId, { action: 'decline' })).rejects.toMatchObject({ code: 'conflict' });

    const l2 = await insertListing(seller, { title: 'Lamp' });
    const m2 = await insertMatch(req.id, l2.id);
    const i2 = await expressInterest(buyer, { listingId: l2.id });
    const declined = await respondToInterest(seller, i2.interestId, { action: 'decline' });
    expect(declined.status).toBe('declined');
    expect((await db.select().from(matches).where(eq(matches.id, m2.id)))[0].status).toBe('closed');
    const items = (await getInbox(buyer)).items.filter((x) => x.type === 'interest_response');
    expect(items.map((x) => x.title)).toContain('The seller declined your interest in the Lamp');
    // A declined buyer cannot re-open by expressing interest again.
    await expect(expressInterest(buyer, { listingId: l2.id })).rejects.toThrow(/declined/);
  });

  it('gates contact on acceptance and both sides opting in, and never returns the address', async () => {
    await updateProfile(seller, { displayName: 'Sam' });
    const l = await insertListing(seller);
    const i = await expressInterest(buyer, { listingId: l.id, shareContact: true });
    // Pending: nothing even though the buyer opted in.
    expect((await shareContact(seller, i.interestId)).counterpartContact).toBeNull();
    expect((await getConversation(buyer, i.interestId)).counterpartContact).toBeNull();

    const l2 = await insertListing(seller);
    const j = await expressInterest(buyer, { listingId: l2.id });
    await respondToInterest(seller, j.interestId, { action: 'accept', shareContact: true });
    // Accepted, seller opted in, buyer not yet: still hidden both ways.
    expect((await getConversation(buyer, j.interestId)).counterpartContact).toBeNull();
    expect((await getConversation(seller, j.interestId)).counterpartContact).toBeNull();
    const afterShare = await shareContact(buyer, j.interestId);
    expect(afterShare.counterpartContact).toEqual({ email: SELLER_EMAIL, displayName: 'Sam' });
    expect((await getConversation(seller, j.interestId)).counterpartContact?.email).toBe(BUYER_EMAIL);
    expect(JSON.stringify(afterShare)).not.toContain('rue Secrète');

    // Accepting i now (both had opted in) reveals contact there too.
    const accepted = await respondToInterest(seller, i.interestId, { action: 'accept' });
    expect(accepted.counterpartContact?.email).toBe(BUYER_EMAIL);
  });

  it('relays messages between participants only', async () => {
    const l = await insertListing(seller, { title: 'Mirror' });
    const i = await expressInterest(buyer, { listingId: l.id });
    await expect(sendMessage(stranger, i.interestId, 'hi')).rejects.toMatchObject({ code: 'not_found' });
    await expect(getConversation(stranger, i.interestId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(sendMessage(buyer, i.interestId, '   ')).rejects.toMatchObject({ code: 'invalid' });

    await sendMessage(buyer, i.interestId, 'What are the dimensions?');
    const conv = await sendMessage(seller, i.interestId, '60 × 90 cm');
    expect(conv.messages.map((m) => [m.from, m.body])).toEqual([
      ['them', 'What are the dimensions?'],
      ['me', '60 × 90 cm'],
    ]);
    const sellerMsgs = (await getInbox(seller)).items.filter((x) => x.type === 'new_message');
    expect(sellerMsgs).toHaveLength(1);
    expect(sellerMsgs[0].title).toBe('New message about the Mirror');
    const buyerMsgs = (await getInbox(buyer)).items.filter((x) => x.type === 'new_message');
    expect(buyerMsgs).toHaveLength(1);
    expect(buyerMsgs[0].body).toContain('60 × 90 cm');

    expect((await listMyInterests(seller, { role: 'seller' })).map((x) => x.interestId)).toEqual([i.interestId]);
    expect(await listMyInterests(seller, { role: 'buyer' })).toEqual([]);
    expect(await listMyInterests(stranger)).toEqual([]);
  });

  it('rejects messages on declined interests', async () => {
    const l = await insertListing(seller);
    const i = await expressInterest(buyer, { listingId: l.id });
    await respondToInterest(seller, i.interestId, { action: 'decline' });
    await expect(sendMessage(buyer, i.interestId, 'please?')).rejects.toThrow(/closed/);
    const msgs = await db.select().from(messages).where(and(eq(messages.interestId, i.interestId)));
    expect(msgs).toHaveLength(0);
  });
});
