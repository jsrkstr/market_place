import { db } from '../../src/db/client.js';
import { newId } from '../../src/db/ids.js';
import { buyerRequests, listings, matches, type BuyerRequestRow, type ListingRow, type MatchRow } from '../../src/db/schema.js';
import { embedOne } from '../../src/infra/embeddings.js';
import type { UserContext } from '../../src/domain/types.js';

/** Inserts a listing row directly (bypassing listings.service) for async/interaction tests. */
export async function insertListing(seller: UserContext, over: Partial<typeof listings.$inferInsert> = {}): Promise<ListingRow> {
  const title = over.title ?? 'White IKEA dining chair';
  const [row] = await db
    .insert(listings)
    .values({
      id: newId('lst'),
      sellerId: seller.userId,
      status: 'active',
      title,
      description: 'Solid white chair, light wear.',
      category: 'furniture/seating/dining-chair',
      priceCents: 2000,
      priceSource: 'seller',
      exactLat: 48.85912,
      exactLng: 2.37954,
      exactAddress: '12 rue Secrète, 75011 Paris',
      publicLat: 48.86,
      publicLng: 2.38,
      areaLabel: 'Paris 11e',
      publishedAt: new Date(),
      availabilityConfirmedAt: new Date(),
      embedding: await embedOne(title),
      ...over,
    })
    .returning();
  return row;
}

export async function insertRequest(buyer: UserContext, over: Partial<typeof buyerRequests.$inferInsert> = {}): Promise<BuyerRequestRow> {
  const [row] = await db
    .insert(buyerRequests)
    .values({
      id: newId('req'),
      buyerId: buyer.userId,
      rawText: 'two off-white dining chairs under 80 euros near Bastille',
      summary: '2 off-white dining chairs, max €80',
      category: 'furniture/seating/dining-chair',
      expiresAt: new Date(Date.now() + 30 * 86400_000),
      ...over,
    })
    .returning();
  return row;
}

export async function insertMatch(requestId: string, listingId: string, over: Partial<typeof matches.$inferInsert> = {}): Promise<MatchRow> {
  const [row] = await db
    .insert(matches)
    .values({
      id: newId('mat'),
      requestId,
      listingId,
      score: 0.8,
      breakdown: {
        semantic: 0.8, attributeFit: 0.8, distance: 1, price: 1, completeness: 0.5, freshness: 1, feedbackPenalty: 0,
        preferenceHits: [], constraintChecks: [],
      },
      explanation: 'test',
      qualifies: true,
      listingVersion: 1,
      requestVersion: 1,
      ...over,
    })
    .returning();
  return row;
}

/** Smallest valid PNG (1×1). */
export const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
