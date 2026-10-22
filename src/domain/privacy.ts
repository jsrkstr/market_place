/**
 * Projections of listings. Buyers only ever see `toPublicListingView`: area label and a rounded
 * distance, never exact coordinates, address or seller identity.
 */
import type { ListingRow } from '../db/schema.js';
import { listingImages } from '../db/schema.js';
import { haversineKm } from '../infra/geocoder.js';
import { signedImageUrl } from '../infra/storage.js';
import type { Attributes, GeoPoint, ListingOwnerView, PublicListingView } from './types.js';

export type ListingImageRow = typeof listingImages.$inferSelect;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function imageViews(images: ListingImageRow[]): { id: string; url: string }[] {
  return [...images].sort((a, b) => a.position - b.position).map((i) => ({ id: i.id, url: signedImageUrl(i.storageKey) }));
}

/** Round a distance for display: under 1 km to 0.5 km steps (min 0.5), otherwise whole km. */
export function roundDistanceKm(km: number): number {
  if (km < 1) return Math.max(0.5, Math.round(km * 2) / 2);
  return Math.round(km);
}

/** Best known point for distance: exact (private) when present, otherwise the public coarse point. */
export function listingPoint(row: Pick<ListingRow, 'exactLat' | 'exactLng' | 'publicLat' | 'publicLng'>): GeoPoint | null {
  if (row.exactLat != null && row.exactLng != null) return { lat: row.exactLat, lng: row.exactLng };
  if (row.publicLat != null && row.publicLng != null) return { lat: row.publicLat, lng: row.publicLng };
  return null;
}

export function approxDistanceKm(row: ListingRow, origin: GeoPoint | null | undefined): number | null {
  const p = listingPoint(row);
  if (!origin || !p) return null;
  return roundDistanceKm(haversineKm(origin, p));
}

/** Attribute keys that are internal bookkeeping and never shown publicly. */
const PRIVATE_ATTRIBUTE_KEYS = new Set(['exact_address', 'address', 'phone', 'email', 'contact']);

function publicAttributes(attrs: Attributes): Attributes {
  return Object.fromEntries(Object.entries(attrs).filter(([k]) => !PRIVATE_ATTRIBUTE_KEYS.has(k)));
}

export function toPublicListingView(
  row: ListingRow,
  images: ListingImageRow[],
  origin?: GeoPoint | null,
): PublicListingView {
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    description: row.description,
    category: row.category,
    attributes: publicAttributes(row.attributes),
    priceCents: row.priceCents,
    currency: row.currency,
    priceSource: row.priceSource ?? null,
    condition: row.condition ?? null,
    quantity: row.quantity,
    areaLabel: row.areaLabel,
    approxDistanceKm: approxDistanceKm(row, origin),
    pickupOptions: row.pickupOptions,
    images: imageViews(images),
    availabilityConfirmedAt: iso(row.availabilityConfirmedAt),
    listedAt: (row.publishedAt ?? row.createdAt).toISOString(),
  };
}

export function toOwnerView(row: ListingRow, images: ListingImageRow[]): ListingOwnerView {
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    description: row.description,
    category: row.category,
    attributes: row.attributes,
    priceCents: row.priceCents,
    currency: row.currency,
    priceSource: row.priceSource ?? null,
    priceEstimate:
      row.priceEstimateLowCents != null || row.priceEstimateHighCents != null
        ? { lowCents: row.priceEstimateLowCents, highCents: row.priceEstimateHighCents }
        : null,
    condition: row.condition ?? null,
    quantity: row.quantity,
    areaLabel: row.areaLabel,
    hasExactAddress: row.exactAddress != null,
    pickupOptions: row.pickupOptions,
    images: imageViews(images),
    completeness: row.completeness,
    missingFields: row.missingFields,
    availabilityConfirmedAt: iso(row.availabilityConfirmedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    expiresAt: iso(row.expiresAt),
  };
}
