/**
 * Periodic sweeps: expiry of listings/requests, expiry warnings, availability re-confirmation prompts
 * and the email digest of unread inbox items.
 */
import { and, eq, gt, inArray, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { buyerRequests, inboxItems, listings, users } from '../db/schema.js';
import { logEvent } from '../domain/events.js';
import { addInboxItem, listUndigestedForUser, markEmailed } from '../domain/inbox.service.js';
import { getMailer } from '../infra/mailer.js';
import { handleListingChanged, itemName } from './listingChanged.js';

const DAY = 24 * 3600 * 1000;
export const AVAILABILITY_CHECK_DAYS = 14;
export const REQUEST_EXPIRY_WARNING_DAYS = 3;

/** ISO-8601 week label, e.g. "2026-W43". */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / DAY + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const fmtDate = (d: Date) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Paris' });

export interface MaintenanceResult {
  listingsExpired: number;
  requestsExpired: number;
  expiryWarnings: number;
  availabilityChecks: number;
}

export async function runMaintenanceSweep(now = new Date()): Promise<MaintenanceResult> {
  return {
    listingsExpired: await expireListings(now),
    requestsExpired: await expireRequests(now),
    expiryWarnings: await warnExpiringRequests(now),
    availabilityChecks: await promptAvailabilityChecks(now),
  };
}

async function expireListings(now: Date): Promise<number> {
  const expired = await db
    .update(listings)
    .set({ status: 'expired', updatedAt: now })
    .where(and(inArray(listings.status, ['active', 'paused']), isNotNull(listings.expiresAt), lte(listings.expiresAt, now)))
    .returning({ id: listings.id, sellerId: listings.sellerId, title: listings.title, expiresAt: listings.expiresAt });
  for (const l of expired) {
    await logEvent({ type: 'listing_status_changed', listingId: l.id, data: { to: 'expired', by: 'system' } });
    // Stale matches + notices to interested buyers.
    await handleListingChanged(l.id);
    const name = itemName(l.title);
    await addInboxItem({
      userId: l.sellerId,
      type: 'availability_check',
      title: `Your ${name} listing has expired`,
      body: `Your ${name} listing expired and is no longer shown to buyers. If it's still available, ask to relist it.`,
      payload: { listingId: l.id, status: 'expired' },
      dedupeKey: `listing_expired:${l.id}:${l.expiresAt?.toISOString()}`,
    });
  }
  return expired.length;
}

async function expireRequests(now: Date): Promise<number> {
  const expired = await db
    .update(buyerRequests)
    .set({ status: 'expired', updatedAt: now })
    .where(and(inArray(buyerRequests.status, ['active', 'paused']), isNotNull(buyerRequests.expiresAt), lte(buyerRequests.expiresAt, now)))
    .returning({ id: buyerRequests.id, buyerId: buyerRequests.buyerId });
  for (const r of expired) {
    await logEvent({ type: 'request_status_changed', actorId: null, requestId: r.id, data: { to: 'expired', by: 'system' } });
  }
  return expired.length;
}

async function warnExpiringRequests(now: Date): Promise<number> {
  const soon = new Date(now.getTime() + REQUEST_EXPIRY_WARNING_DAYS * DAY);
  const rows = await db
    .select()
    .from(buyerRequests)
    .where(and(eq(buyerRequests.status, 'active'), gt(buyerRequests.expiresAt, now), lte(buyerRequests.expiresAt, soon)));
  let n = 0;
  for (const r of rows) {
    const label = r.summary?.trim() || r.rawText;
    // Keyed on the expiry date so extending the request re-arms the warning.
    const added = await addInboxItem({
      userId: r.buyerId,
      type: 'request_expiring',
      title: 'Your saved search expires soon',
      body: `Your saved search "${label}" expires on ${fmtDate(r.expiresAt!)}. Ask to extend it if you're still looking.`,
      payload: { requestId: r.id, expiresAt: r.expiresAt!.toISOString() },
      dedupeKey: `request_expiring:${r.id}:${r.expiresAt!.toISOString().slice(0, 10)}`,
    });
    if (added) n++;
  }
  return n;
}

async function promptAvailabilityChecks(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - AVAILABILITY_CHECK_DAYS * DAY);
  const rows = await db
    .select({ id: listings.id, sellerId: listings.sellerId, title: listings.title })
    .from(listings)
    .where(
      and(
        eq(listings.status, 'active'),
        lt(sql`coalesce(${listings.availabilityConfirmedAt}, ${listings.publishedAt}, ${listings.createdAt})`, cutoff),
      ),
    );
  const week = isoWeek(now);
  let n = 0;
  for (const l of rows) {
    const name = itemName(l.title);
    const added = await addInboxItem({
      userId: l.sellerId,
      type: 'availability_check',
      title: `Is your ${name} still available?`,
      body: `Please confirm your ${name} is still available, or mark it sold, so buyers only see items they can actually get. Listings that haven't been confirmed recently rank lower.`,
      payload: { listingId: l.id },
      dedupeKey: `availability:${l.id}:${week}`,
    });
    if (added) n++;
  }
  return n;
}

/** One short email per user summarising unread, not-yet-emailed inbox items. */
export async function runDigestSweep(now = new Date()): Promise<{ emailsSent: number }> {
  const candidates = await db
    .selectDistinct({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .innerJoin(inboxItems, eq(inboxItems.userId, users.id))
    .where(and(eq(users.notifyEmail, true), isNull(inboxItems.readAt), isNull(inboxItems.emailedAt)));

  let emailsSent = 0;
  for (const u of candidates) {
    try {
      const items = await listUndigestedForUser(u.id, 100);
      if (!items.length) continue;
      const shown = items.slice(-10).reverse(); // newest first
      const more = items.length - shown.length;
      const lines = shown.map((i) => `- ${i.title}`);
      if (more > 0) lines.push(`- …and ${more} more`);
      const count = items.length === 1 ? '1 new marketplace update' : `${items.length} new marketplace updates`;
      await getMailer().send({
        to: u.email,
        subject: `You have ${count}`,
        text: [
          `Hi ${u.displayName?.trim() || 'there'},`,
          '',
          `You have ${count}:`,
          ...lines,
          '',
          `To see them, open the Marketplace app in ChatGPT and ask "what's new?".`,
          '',
          'You get this email because email updates are on. Ask the app to turn them off at any time.',
        ].join('\n'),
      });
      await markEmailed(items.map((i) => i.id), now);
      await db.update(users).set({ lastDigestAt: now }).where(eq(users.id, u.id));
      emailsSent++;
    } catch (err) {
      console.error(`[digest] failed for ${u.id}`, err);
    }
  }
  return { emailsSent };
}
