import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, pool } from '../../src/db/client.js';
import { listings } from '../../src/db/schema.js';
import {
  createListing,
  getListingDemand,
  getOwnListing,
  getPriceGuidance,
  getPublicListing,
  publishListing,
  setListingStatus,
  updateListing,
} from '../../src/domain/listings.service.js';
import { registerHandler } from '../../src/infra/jobs.js';
import { makeUser, resetDb, setupTestDb } from '../helpers/db.js';
import { sellerChair } from './fixtures.js';

const dispatched: { listingId: string; reason: string }[] = [];

beforeAll(async () => {
  await setupTestDb();
  registerHandler('listing.changed', async (p) => {
    dispatched.push(p);
  });
});
beforeEach(async () => {
  await resetDb();
  dispatched.length = 0;
});
afterAll(() => pool.end());

describe('createListing', () => {
  it('saves the seller example as a draft with ranked missing fields, then publishes it', async () => {
    const seller = await makeUser('seller@test.dev');
    const { publish: _p, ...input } = { ...sellerChair, publish: false };
    const r = await createListing(seller, input);
    expect(r.published).toBe(false);
    expect(r.listing.status).toBe('draft');
    expect(r.listing.category).toBe('furniture/seating/dining-chair');
    expect(r.listing.attributes.colour).toMatchObject({ value: ['white'], normalized: ['white'], source: 'seller_stated' });
    expect(r.listing.attributes.model.source).toBe('ai_inferred');
    expect(r.listing.areaLabel).toBe('Paris');
    // price and location present; photos then dimensions are the most valuable missing fields
    expect(r.missingFields.map((m) => m.field)).toEqual(['photos', 'dimensions', 'material']);
    expect(r.missingFields[0].reason).toMatch(/photo/i);
    expect(r.listing.completeness).toBeGreaterThan(0.5);
    expect(r.listing.completeness).toBeLessThan(1);
    expect(dispatched).toHaveLength(0); // drafts are not matched

    const p = await publishListing(seller, r.listing.id);
    expect(p.published).toBe(true);
    expect(p.listing.availabilityConfirmedAt).not.toBeNull();
    const days = (Date.parse(p.listing.expiresAt!) - Date.now()) / 86_400_000;
    expect(Math.round(days)).toBe(60);
    expect(dispatched).toEqual([{ listingId: r.listing.id, reason: 'published' }]);

    // Exact coordinates are stored privately, coarse ones publicly.
    const [row] = await db.select().from(listings).where(eq(listings.id, r.listing.id));
    expect(row.exactLat).toBe(48.8566);
    expect(row.publicLat).toBe(48.855);
    expect(row.conditionRank).toBe(2);
    expect(row.embedding).toHaveLength(1536);
  });

  it('refuses to publish without a price and explains why', async () => {
    const seller = await makeUser('seller@test.dev');
    const r = await createListing(seller, {
      title: 'Oak bookcase',
      category: 'bookcase',
      priceEstimate: { lowCents: 3000, highCents: 6000 },
      location: { text: 'Paris 11e' },
      publish: true,
    });
    expect(r.published).toBe(false);
    expect(r.listing.status).toBe('draft');
    expect(r.publishBlockers.join(' ')).toMatch(/asking price/);
    expect(r.publishBlockers.join(' ')).toMatch(/only a suggestion/);
    expect(r.priceGuidance?.basis).toBe('ai_estimate');
    expect(r.missingFields[0].field).toBe('price');
  });

  it('publishes immediately when essentials are present', async () => {
    const seller = await makeUser('seller@test.dev');
    const r = await createListing(seller, { ...sellerChair, publish: true });
    expect(r.published).toBe(true);
    expect(r.publishBlockers).toEqual([]);
    expect(dispatched).toHaveLength(1);
  });

  it('is idempotent per seller + key', async () => {
    const seller = await makeUser('seller@test.dev');
    const a = await createListing(seller, { ...sellerChair, idempotencyKey: 'k1' });
    const b = await createListing(seller, { ...sellerChair, title: 'changed', idempotencyKey: 'k1' });
    expect(b.listing.id).toBe(a.listing.id);
    expect(b.duplicateOf).toBeNull();
    const all = await db.select().from(listings);
    expect(all).toHaveLength(1);
  });

  it('dedupes the same item from the same seller and creates nothing', async () => {
    const seller = await makeUser('seller@test.dev');
    const other = await makeUser('seller2@test.dev');
    const a = await createListing(seller, { ...sellerChair, publish: true });
    const b = await createListing(seller, { ...sellerChair, publish: true });
    expect(b.duplicateOf).toBe(a.listing.id);
    expect(b.listing.id).toBe(a.listing.id);
    expect(b.publishBlockers[0]).toMatch(/similar listing already exists/);
    // Near-identical wording also counts (embedding similarity).
    const c = await createListing(seller, { ...sellerChair, description: 'white IKEA dining chair' });
    expect(c.duplicateOf).toBe(a.listing.id);
    // A different seller may list the same thing.
    const d = await createListing(other, { ...sellerChair });
    expect(d.duplicateOf).toBeNull();
    // A different item from the same seller is not a duplicate.
    const e = await createListing(seller, {
      title: 'Green velvet armchair',
      category: 'armchair',
      attributes: { colour: { value: 'green', source: 'seller_stated' }, material: { value: 'velvet', source: 'seller_stated' } },
      priceCents: 9000,
      location: { text: 'Paris' },
    });
    expect(e.duplicateOf).toBeNull();
    expect(await db.select().from(listings)).toHaveLength(3);
  });
});

describe('updates and status', () => {
  it('bumps version, re-embeds on content change and dispatches for non-drafts', async () => {
    const seller = await makeUser('seller@test.dev');
    const r = await createListing(seller, { ...sellerChair, publish: true });
    const [before] = await db.select().from(listings).where(eq(listings.id, r.listing.id));
    dispatched.length = 0;
    const u = await updateListing(seller, r.listing.id, {
      attributes: { width_cm: { value: 45, source: 'seller_stated' }, height_cm: { value: 80, source: 'seller_stated' } },
      description: 'Sturdy, solid pine.',
    });
    const [after] = await db.select().from(listings).where(eq(listings.id, r.listing.id));
    expect(after.version).toBe(before.version + 1);
    expect(after.embedding).not.toEqual(before.embedding);
    expect(u.missingFields.map((m) => m.field)).not.toContain('dimensions');
    expect(u.listing.attributes.colour).toBeDefined(); // merged, not replaced
    expect(dispatched).toEqual([{ listingId: r.listing.id, reason: 'updated' }]);

    // No-op update changes nothing.
    await updateListing(seller, r.listing.id, { description: 'Sturdy, solid pine.' });
    const [same] = await db.select().from(listings).where(eq(listings.id, r.listing.id));
    expect(same.version).toBe(after.version);

    // An active listing cannot lose its price.
    await expect(updateListing(seller, r.listing.id, { priceCents: null })).rejects.toThrow(/asking price/);
  });

  it('owner-only status changes; sold is terminal; drafts are private', async () => {
    const seller = await makeUser('seller@test.dev');
    const buyer = await makeUser('buyer@test.dev');
    const r = await createListing(seller, { ...sellerChair, publish: true });
    await expect(setListingStatus(buyer, r.listing.id, 'mark_sold')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(getOwnListing(buyer, r.listing.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(updateListing(buyer, r.listing.id, { title: 'x' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(getListingDemand(buyer, r.listing.id)).rejects.toMatchObject({ code: 'forbidden' });

    const paused = await setListingStatus(seller, r.listing.id, 'pause');
    expect(paused.status).toBe('paused');
    const re = await setListingStatus(seller, r.listing.id, 'reactivate');
    expect(re.status).toBe('active');
    const sold = await setListingStatus(seller, r.listing.id, 'mark_sold');
    expect(sold.status).toBe('sold');
    await expect(setListingStatus(seller, r.listing.id, 'reactivate')).rejects.toMatchObject({ code: 'invalid' });
    expect(dispatched.filter((d) => d.reason === 'status_changed')).toHaveLength(3);

    const pub = await getPublicListing(r.listing.id);
    expect(pub.status).toBe('sold');
    const draft = await createListing(seller, { title: 'Vase', category: 'vase' });
    await expect(getPublicListing(draft.listing.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('confirm_available refreshes the availability timestamp', async () => {
    const seller = await makeUser('seller@test.dev');
    const r = await createListing(seller, { ...sellerChair, publish: true });
    const old = new Date(Date.now() - 20 * 86_400_000);
    await db.update(listings).set({ availabilityConfirmedAt: old }).where(eq(listings.id, r.listing.id));
    const v = await setListingStatus(seller, r.listing.id, 'confirm_available');
    expect(Date.parse(v.availabilityConfirmedAt!)).toBeGreaterThan(Date.now() - 5000);
  });
});

describe('getPriceGuidance', () => {
  it('uses p25/p75 of comparables when there are at least 3, otherwise labels the AI estimate', async () => {
    const s = await makeUser('seller@test.dev');
    const g0 = await getPriceGuidance({ category: 'dining chair', condition: 'good' });
    expect(g0.basis).toBe('insufficient_data');
    expect(g0.lowCents).toBeNull();
    const g1 = await getPriceGuidance({ category: 'dining chair', modelEstimate: { lowCents: 1500, highCents: 3000 } });
    expect(g1).toMatchObject({ basis: 'ai_estimate', lowCents: 1500, highCents: 3000 });

    const colours = ['red', 'blue', 'green', 'black', 'yellow'];
    for (const [i, price] of [1000, 2000, 3000, 4000, 5000].entries()) {
      await createListing(s, {
        title: `${colours[i]} chair ${i}`,
        category: 'dining chair',
        attributes: { colour: { value: colours[i], source: 'seller_stated' } },
        description: `unique description number ${i} ${'x'.repeat(i)}`,
        priceCents: price,
        condition: { value: 'good', source: 'seller_stated' },
        location: { text: 'Paris' },
        publish: true,
      });
    }
    const g = await getPriceGuidance({ category: 'dining chair', condition: 'good' });
    expect(g.basis).toBe('marketplace_comparables');
    expect(g.comparableCount).toBe(5);
    expect(g.lowCents).toBe(2000);
    expect(g.highCents).toBe(4000);
    expect(g.note).toMatch(/asking prices/);
  });
});
