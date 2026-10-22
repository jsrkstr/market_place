/**
 * End-to-end journeys from the plan's Verification section, driven through the MCP client SDK
 * against the real HTTP server (inline jobs, fake embeddings/geocoder).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDb, setupTestDb } from './helpers/db.js';
import { startHarness, type Harness, type McpUser } from './mcp/harness.js';

let h: Harness;
let seller: McpUser, buyer: McpUser, buyer2: McpUser, seller2: McpUser;

// State carried between the sequential journey steps.
let chairId: string;
let chairMatchId: string;
let requestId: string;
let interestId: string;

beforeAll(async () => {
  await setupTestDb();
  await resetDb();
  h = await startHarness();
  [seller, buyer, buyer2, seller2] = await Promise.all(['tok-seller', 'tok-buyer', 'tok-buyer2', 'tok-seller2'].map((t) => h.connect(t)));
});
afterAll(async () => {
  await h?.close();
});

describe('marketplace journeys over MCP', () => {
  it('1. seller drafts, then publishes, the white IKEA chairs in Paris 11e', async () => {
    const draft = await seller.call('create_listing', {
      rawText: 'Selling two white IKEA dining chairs, good condition, 20 euros, pickup Paris 11e',
      title: 'Two white IKEA dining chairs',
      category: 'dining chair',
      attributes: {
        brand: { value: 'IKEA', source: 'seller_stated' },
        colour: { value: ['ivory'], source: 'ai_inferred', confidence: 0.8 },
        material: { value: ['wood'], source: 'ai_inferred', confidence: 0.7 },
      },
      condition: { value: 'good', source: 'seller_stated' },
      priceCents: 2000,
      currency: 'EUR',
      quantity: 2,
      location: { text: 'Paris 11e' },
      publish: false,
      idempotencyKey: 'chair-1',
    });
    expect(draft.published).toBe(false);
    expect(draft.listing.status).toBe('draft');
    expect(draft._text).toContain('€20');
    expect(draft._text).toMatch(/draft/i);
    chairId = draft.listing.id;

    // Drafts are private: buyers cannot see them.
    expect((await buyer.raw('get_listing_details', { listingId: chairId })).isError).toBe(true);

    // Idempotent retry returns the same listing.
    const retry = await seller.call('create_listing', { title: 'Two white IKEA dining chairs', priceCents: 2000, location: { text: 'Paris 11e' }, idempotencyKey: 'chair-1' });
    expect(retry.listing.id).toBe(chairId);

    const pub = await seller.call('publish_listing', { listingId: chairId });
    expect(pub.published).toBe(true);
    expect(pub.listing.status).toBe('active');

    const mine = await seller.call('get_my_listings', {});
    expect(mine.listings.map((l: any) => l.id)).toContain(chairId);
  });

  it('a buyer cannot read the owner view of, or modify, the seller’s listing', async () => {
    for (const [tool, args] of [
      ['get_my_listings', { listingId: chairId }],
      ['update_listing', { listingId: chairId, priceCents: 1 }],
      ['publish_listing', { listingId: chairId }],
      ['set_listing_status', { listingId: chairId, action: 'withdraw' }],
      ['get_listing_demand', { listingId: chairId }],
      ['attach_listing_photos', { listingId: chairId, files: [{ download_url: 'http://127.0.0.1:1/x.jpg', file_id: 'f1' }] }],
      ['get_photo_upload_link', { listingId: chairId }],
    ] as const) {
      const r = await buyer.raw(tool, args);
      expect(r.isError, tool).toBe(true);
    }
    // The public projection is still available to buyers, without private fields.
    const pub = await buyer.call('get_listing_details', { listingId: chairId });
    expect(pub.listing.priceCents).toBe(2000);
    expect(JSON.stringify(pub)).not.toMatch(/exactLat|exact_lat|seller@test\.dev|hasExactAddress/);
    const own = await seller.call('get_my_listings', { listingId: chairId });
    expect(own.listings[0].priceCents).toBe(2000);
    expect(own.listings[0].status).toBe('active');
  });

  it('2. buyer saves "two beige/off-white dining chairs ≤ €80, ≤ 2 km" and gets an immediate explained match', async () => {
    const r = await buyer.call('create_buyer_request', {
      rawText: 'I need two beige or off-white dining chairs, max 80 euros total, within 2 km of Bastille',
      summary: '2 beige/off-white dining chairs, ≤ €80, ≤ 2 km from Bastille',
      category: 'dining chair',
      hardConstraints: { maxPriceCents: 8000, currency: 'EUR', maxDistanceKm: 2, quantity: 2 },
      softPreferences: [{ attribute: 'colour', values: ['beige', 'off-white'], weight: 0.8 }],
      location: { text: 'bastille' },
    });
    expect(r.request.id).toBeTruthy();
    requestId = r.request.id;
    const m = r.matches.find((x: any) => x.listing.id === chairId);
    expect(m, r._text).toBeTruthy();
    expect(m.qualifies).toBe(true);
    expect(m.explanation.length).toBeGreaterThan(0);
    expect(m.matchId).toBeTruthy();
    chairMatchId = m.matchId;
    expect(r._text).toContain('Request saved');
    expect(r._text).toContain(m.explanation);
    expect(JSON.stringify(r)).not.toMatch(/exactLat|seller@test\.dev/);
  });

  it('3. buyer2 saves a lamp request; seller2 later publishes a lamp; buyer2 sees a new_match in the inbox', async () => {
    const req = await buyer2.call('create_buyer_request', {
      rawText: 'Looking for a floor lamp under 50 euros near Montreuil',
      category: 'floor lamp',
      hardConstraints: { maxPriceCents: 5000, maxDistanceKm: 5 },
      location: { text: 'montreuil' },
      notify: true,
    });
    expect(req.matches).toHaveLength(0);

    const lamp = await seller2.call('create_listing', {
      rawText: 'Brass floor lamp, works fine, 30€, Montreuil',
      title: 'Brass floor lamp',
      category: 'floor lamp',
      attributes: { material: { value: ['brass'], source: 'seller_stated' } },
      condition: { value: 'good', source: 'seller_stated' },
      priceCents: 3000,
      location: { text: 'montreuil' },
      publish: true,
    });
    expect(lamp.published).toBe(true);

    const inbox = await buyer2.call('get_inbox', {});
    const item = inbox.items.find((i: any) => i.type === 'new_match');
    expect(item, inbox._text).toBeTruthy();
    expect(inbox._text).toMatch(/Possible matches/);

    const saved = await buyer2.call('get_request_matches', { requestId: req.request.id });
    expect(saved.matches.map((m: any) => m.listing.id)).toContain(lamp.listing.id);

    const marked = await buyer2.call('mark_inbox_read', { ids: 'all' });
    expect(marked.marked).toBeGreaterThan(0);
  });

  it('4. buyer expresses interest; seller sees confirmed interest, accepts; messages flow; contact is gated', async () => {
    const i = await buyer.call('express_interest', { listingId: chairId, matchId: chairMatchId, message: 'Hi! Are both chairs still available?' });
    interestId = i.conversation.interestId;
    expect(interestId).toBeTruthy();
    expect(i.conversation.counterpartContact).toBeNull();

    const inbox = await seller.call('get_inbox', {});
    expect(inbox.items.some((x: any) => x.type === 'buyer_interest'), inbox._text).toBe(true);
    expect(inbox._text).toMatch(/Confirmed buyer interest/);

    const demand = await seller.call('get_listing_demand', { listingId: chairId });
    expect(demand.demand.interestedBuyers).toBe(1);

    const accepted = await seller.call('respond_to_interest', { interestId, action: 'accept', message: 'Yes, both available. Saturday works.' });
    expect(accepted.conversation.status).toBe('accepted');
    expect(accepted.conversation.counterpartContact).toBeNull();

    await buyer.call('send_message', { interestId, body: 'Great, Saturday 11am?' });
    const sellerView = await seller.call('get_conversation', { interestId });
    const bodies = sellerView.conversation.messages.map((m: any) => m.body);
    expect(bodies).toContain('Great, Saturday 11am?');
    expect(bodies).toContain('Yes, both available. Saturday works.');
    expect(sellerView.conversation.counterpartContact).toBeNull();

    // Buyer opts in alone: still gated.
    const b1 = await buyer.call('send_message', { interestId, shareContact: true });
    expect(b1.conversation.counterpartContact).toBeNull();
    // Seller opts in too: now both see each other's contact.
    const s1 = await seller.call('respond_to_interest', { interestId, action: 'share_contact' });
    expect(s1.conversation.counterpartContact?.email).toBe('buyer@test.dev');
    const b2 = await buyer.call('get_conversation', { interestId });
    expect(b2.conversation.counterpartContact?.email).toBe('seller@test.dev');

    const convs = await buyer.call('list_my_conversations', { role: 'buyer' });
    expect(convs.conversations.map((c: any) => c.interestId)).toContain(interestId);
  });

  it('5. seller marks it sold; the match disappears for the buyer and the buyer is told it is unavailable', async () => {
    const r = await seller.call('set_listing_status', { listingId: chairId, action: 'mark_sold' });
    expect(r.listing.status).toBe('sold');

    const matches = await buyer.call('get_request_matches', { requestId });
    expect(matches.matches.map((m: any) => m.listing.id)).not.toContain(chairId);

    const inbox = await buyer.call('get_inbox', {});
    expect(inbox.items.some((x: any) => x.type === 'listing_unavailable'), inbox._text).toBe(true);
  });
});
