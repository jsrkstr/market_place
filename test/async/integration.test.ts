/**
 * End-to-end async flow against the real listings/requests services and matching engine.
 * Skipped while those are still declare-only contract stubs (domain-core agent).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../../src/db/client.js';
import { interests, matches } from '../../src/db/schema.js';
import { getInbox } from '../../src/domain/inbox.service.js';
import { expressInterest } from '../../src/domain/interactions.service.js';
import * as listingsSvc from '../../src/domain/listings.service.js';
import * as engine from '../../src/domain/matching/engine.js';
import * as requestsSvc from '../../src/domain/requests.service.js';
import { registerAllHandlers } from '../../src/jobs/handlers.js';
import { makeUser, resetDb, setupTestDb } from '../helpers/db.js';

const implemented =
  typeof listingsSvc.createListing === 'function' &&
  typeof requestsSvc.createBuyerRequest === 'function' &&
  typeof engine.matchListing === 'function' &&
  typeof engine.staleMatchesForListing === 'function';

describe.runIf(implemented)('async flow with real domain services', () => {
  beforeAll(async () => {
    await setupTestDb();
    registerAllHandlers();
  });
  beforeEach(resetDb);
  afterAll(() => pool.end());

  it('saved request → later listing → new_match inbox → interest → sold → unavailable', async () => {
    const seller = await makeUser('seller@test.dev');
    const buyer = await makeUser('buyer@test.dev');

    await requestsSvc.createBuyerRequest(buyer, {
      rawText: 'floor lamp under 80 euros near Paris 11e',
      category: 'floor lamp',
      hardConstraints: { maxPriceCents: 8000, maxDistanceKm: 5 },
      location: { text: 'paris 11e' },
      notify: true,
    });
    expect((await getInbox(buyer)).items).toHaveLength(0);

    const created = await listingsSvc.createListing(seller, {
      title: 'Arc floor lamp',
      category: 'floor lamp',
      priceCents: 4000,
      condition: { value: 'good', source: 'seller_stated' },
      location: { text: 'bastille' },
      attributes: { colour: { value: ['white'], source: 'seller_stated' } },
      publish: true,
    });
    expect(created.published).toBe(true);
    const listingId = created.listing.id;

    const newMatch = (await getInbox(buyer)).items.find((i) => i.type === 'new_match');
    expect(newMatch, 'buyer should be told about the new qualifying match').toBeDefined();
    expect(newMatch!.payload.listingId).toBe(listingId);
    const [m] = await db.select().from(matches).where(eq(matches.id, String(newMatch!.payload.matchId)));
    expect(m.notifiedAt).not.toBeNull();

    await expressInterest(buyer, { listingId, message: 'Still available?' });
    expect((await getInbox(seller)).items.some((i) => i.type === 'buyer_interest')).toBe(true);

    await listingsSvc.setListingStatus(seller, listingId, 'mark_sold');
    const gone = (await getInbox(buyer)).items.find((i) => i.type === 'listing_unavailable');
    expect(gone?.title).toBe('The Arc floor lamp has been sold');
    expect((await db.select().from(matches).where(eq(matches.id, m.id)))[0].status).toBe('stale');
    expect((await db.select().from(interests))[0].status).toBe('withdrawn');
  });
});

describe.skipIf(implemented)('async flow with real domain services (pending)', () => {
  it.todo('domain-core services are still contract stubs; re-run once implemented');
});
