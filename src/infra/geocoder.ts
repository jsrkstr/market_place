import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { geocodeCache } from '../db/schema.js';

export interface GeocodeResult {
  lat: number;
  lng: number;
  /** Coarse, shareable label such as "Paris 11e" or "Montreuil". */
  label: string;
}

export interface Geocoder {
  geocode(query: string): Promise<GeocodeResult | null>;
}

class NominatimGeocoder implements Geocoder {
  private last = 0;

  async geocode(query: string): Promise<GeocodeResult | null> {
    // Nominatim usage policy: max 1 request/second, identifying User-Agent.
    const wait = this.last + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = Date.now();
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '1');
    url.searchParams.set('addressdetails', '1');
    const res = await fetch(url, { headers: { 'User-Agent': config.GEOCODER_USER_AGENT } });
    if (!res.ok) return null;
    const [hit] = (await res.json()) as Array<{
      lat: string;
      lon: string;
      display_name: string;
      address?: Record<string, string>;
    }>;
    if (!hit) return null;
    const a = hit.address ?? {};
    const area = a.suburb ?? a.city_district ?? a.neighbourhood ?? a.town ?? a.village;
    const city = a.city ?? a.town ?? a.municipality;
    const label = [area, city].filter((x, i, arr) => x && arr.indexOf(x) === i).join(', ') || hit.display_name;
    return { lat: Number(hit.lat), lng: Number(hit.lon), label };
  }
}

/** Offline geocoder with a few known places (tests/demo). Unknown queries resolve to null. */
export const FAKE_PLACES: Record<string, GeocodeResult> = {
  paris: { lat: 48.8566, lng: 2.3522, label: 'Paris' },
  'paris 11e': { lat: 48.8592, lng: 2.3797, label: 'Paris 11e' },
  'paris 11': { lat: 48.8592, lng: 2.3797, label: 'Paris 11e' },
  '75011': { lat: 48.8592, lng: 2.3797, label: 'Paris 11e' },
  'paris 12e': { lat: 48.8412, lng: 2.3876, label: 'Paris 12e' },
  'paris 20e': { lat: 48.8646, lng: 2.3984, label: 'Paris 20e' },
  'paris 15e': { lat: 48.8421, lng: 2.2928, label: 'Paris 15e' },
  'paris 18e': { lat: 48.8925, lng: 2.3444, label: 'Paris 18e' },
  bastille: { lat: 48.8531, lng: 2.3692, label: 'Bastille, Paris' },
  montreuil: { lat: 48.8638, lng: 2.4485, label: 'Montreuil' },
  lyon: { lat: 45.764, lng: 4.8357, label: 'Lyon' },
};

class FakeGeocoder implements Geocoder {
  async geocode(query: string): Promise<GeocodeResult | null> {
    return FAKE_PLACES[query.trim().toLowerCase()] ?? null;
  }
}

class CachedGeocoder implements Geocoder {
  constructor(private inner: Geocoder) {}

  async geocode(query: string): Promise<GeocodeResult | null> {
    const key = query.trim().toLowerCase();
    if (!key) return null;
    const [cached] = await db.select().from(geocodeCache).where(eq(geocodeCache.query, key));
    if (cached) return cached.lat == null ? null : { lat: cached.lat, lng: cached.lng!, label: cached.label! };
    const result = await this.inner.geocode(key);
    await db
      .insert(geocodeCache)
      .values({ query: key, lat: result?.lat ?? null, lng: result?.lng ?? null, label: result?.label ?? null })
      .onConflictDoNothing();
    return result;
  }
}

let geocoder: Geocoder | null = null;

export function getGeocoder(): Geocoder {
  if (!geocoder) geocoder = config.GEOCODER === 'fake' ? new FakeGeocoder() : new CachedGeocoder(new NominatimGeocoder());
  return geocoder;
}

export function setGeocoderForTesting(g: Geocoder | null): void {
  geocoder = g;
}

/** Great-circle distance in km. */
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Round coordinates to roughly 500 m so public locations never reveal an address. */
export function coarsen(p: { lat: number; lng: number }): { lat: number; lng: number } {
  return { lat: Math.round(p.lat * 200) / 200, lng: Math.round(p.lng * 200) / 200 };
}
