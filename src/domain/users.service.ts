import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { users, type UserRow } from '../db/schema.js';
import { getGeocoder } from '../infra/geocoder.js';
import { invalid, notFound } from './errors.js';
import type { LocationInput, UserContext } from './types.js';

export async function findOrCreateUserByEmail(email: string): Promise<UserRow> {
  const normalized = email.trim().toLowerCase();
  const [existing] = await db.select().from(users).where(eq(users.email, normalized));
  if (existing) return existing;
  const [created] = await db
    .insert(users)
    .values({ id: newId('usr'), email: normalized })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [raced] = await db.select().from(users).where(eq(users.email, normalized));
  return raced;
}

export async function getUser(userId: string): Promise<UserRow> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) throw notFound('User');
  return u;
}

/**
 * Resolve a LocationInput into coordinates + a coarse label.
 * Explicit lat/lng wins; otherwise text is geocoded. Returns null if nothing usable was given.
 */
export async function resolveLocation(
  loc: LocationInput | undefined | null,
): Promise<{ lat: number; lng: number; label: string } | null> {
  if (!loc) return null;
  if (loc.lat != null && loc.lng != null) return { lat: loc.lat, lng: loc.lng, label: loc.text ?? 'Pinned location' };
  const query = loc.text ?? loc.exactAddress;
  if (!query) return null;
  const hit = await getGeocoder().geocode(query);
  if (!hit) throw invalid(`Could not find the location "${query}". Ask for a city, district or postcode.`);
  return hit;
}

export async function setDefaultLocation(ctx: UserContext, loc: LocationInput): Promise<{ label: string }> {
  const r = await resolveLocation(loc);
  if (!r) throw invalid('A location is required');
  await db
    .update(users)
    .set({ defaultLat: r.lat, defaultLng: r.lng, defaultLocationLabel: r.label, updatedAt: new Date() })
    .where(eq(users.id, ctx.userId));
  return { label: r.label };
}

export async function updateProfile(
  ctx: UserContext,
  patch: { displayName?: string; notifyEmail?: boolean },
): Promise<UserRow> {
  const [u] = await db
    .update(users)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(users.id, ctx.userId))
    .returning();
  return u;
}
