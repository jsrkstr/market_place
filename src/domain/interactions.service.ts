/**
 * Buyer ↔ seller interactions: explicit interest, seller response, relayed messages and
 * consent-based contact sharing. Real contact details are never sent automatically and the seller's
 * exact address is never returned; pickup details are arranged through relayed messages.
 */
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { buyerRequests, interests, listings, matches, messages, users, type InterestRow } from '../db/schema.js';
import { DomainError, forbidden, invalid, notFound } from './errors.js';
import { logEvent } from './events.js';
import { addInboxItem } from './inbox.service.js';
import type { InterestStatus, UserContext } from './types.js';

export interface InterestView {
  interestId: string;
  listingId: string;
  listingTitle: string | null;
  role: 'buyer' | 'seller';
  status: InterestStatus;
  /** Contact details only appear once BOTH parties opted in (seller accepted and shared, buyer shared). */
  counterpartContact: { email: string; displayName: string | null } | null;
  messages: { from: 'me' | 'them'; body: string; at: string }[];
  createdAt: string;
}

const MAX_MESSAGE_LENGTH = 2000;
const SNIPPET_LENGTH = 280;

const itemName = (title: string | null) => title?.trim() || 'item';
const snippet = (s: string) => (s.length > SNIPPET_LENGTH ? `${s.slice(0, SNIPPET_LENGTH - 1)}…` : s);

function cleanMessage(body: string | undefined | null): string | null {
  if (body == null) return null;
  const t = body.trim();
  if (!t) return null;
  if (t.length > MAX_MESSAGE_LENGTH) throw invalid(`Messages are limited to ${MAX_MESSAGE_LENGTH} characters`);
  return t;
}

/** Contact is shared only when the seller accepted and both sides opted in. */
function contactVisible(i: InterestRow): boolean {
  return i.status === 'accepted' && i.buyerContactShared && i.sellerContactShared;
}

async function loadInterestFor(ctx: UserContext, interestId: string): Promise<{ interest: InterestRow; role: 'buyer' | 'seller' }> {
  const [interest] = await db.select().from(interests).where(eq(interests.id, interestId));
  // Non-participants get not_found so interest ids cannot be probed.
  if (!interest) throw notFound('Interest');
  if (interest.buyerId === ctx.userId) return { interest, role: 'buyer' };
  if (interest.sellerId === ctx.userId) return { interest, role: 'seller' };
  throw notFound('Interest');
}

async function buildView(
  interest: InterestRow,
  viewerId: string,
  opts: { messageLimit?: number } = {},
): Promise<InterestView> {
  const role: 'buyer' | 'seller' = interest.buyerId === viewerId ? 'buyer' : 'seller';
  const [listing] = await db.select({ title: listings.title }).from(listings).where(eq(listings.id, interest.listingId));

  let msgRows: { senderId: string; body: string; createdAt: Date }[];
  if (opts.messageLimit != null) {
    msgRows = (
      await db
        .select({ senderId: messages.senderId, body: messages.body, createdAt: messages.createdAt })
        .from(messages)
        .where(eq(messages.interestId, interest.id))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(opts.messageLimit)
    ).reverse();
  } else {
    msgRows = await db
      .select({ senderId: messages.senderId, body: messages.body, createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.interestId, interest.id))
      .orderBy(asc(messages.createdAt), asc(messages.id));
  }

  let counterpartContact: InterestView['counterpartContact'] = null;
  if (contactVisible(interest)) {
    const counterpartId = role === 'buyer' ? interest.sellerId : interest.buyerId;
    const [u] = await db
      .select({ email: users.email, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, counterpartId));
    if (u) counterpartContact = { email: u.email, displayName: u.displayName };
  }

  return {
    interestId: interest.id,
    listingId: interest.listingId,
    listingTitle: listing?.title ?? null,
    role,
    status: interest.status,
    counterpartContact,
    messages: msgRows.map((m) => ({
      from: m.senderId === viewerId ? 'me' : 'them',
      body: m.body,
      at: m.createdAt.toISOString(),
    })),
    createdAt: interest.createdAt.toISOString(),
  };
}

/** Finds the buyer's match row for a listing (via their saved requests), validating an explicit matchId. */
async function resolveMatchId(buyerId: string, listingId: string, matchId?: string): Promise<string | null> {
  if (matchId) {
    const [m] = await db
      .select({ id: matches.id, listingId: matches.listingId, buyerId: buyerRequests.buyerId })
      .from(matches)
      .innerJoin(buyerRequests, eq(buyerRequests.id, matches.requestId))
      .where(eq(matches.id, matchId));
    if (!m || m.buyerId !== buyerId) throw notFound('Match');
    if (m.listingId !== listingId) throw invalid('That match is for a different listing');
    return m.id;
  }
  const [m] = await db
    .select({ id: matches.id })
    .from(matches)
    .innerJoin(buyerRequests, eq(buyerRequests.id, matches.requestId))
    .where(and(eq(matches.listingId, listingId), eq(buyerRequests.buyerId, buyerId)))
    .orderBy(desc(matches.qualifies), desc(matches.score))
    .limit(1);
  return m?.id ?? null;
}

async function insertMessage(interestId: string, senderId: string, body: string): Promise<string> {
  const id = newId('msg');
  await db.insert(messages).values({ id, interestId, senderId, body });
  await db.update(interests).set({ updatedAt: new Date() }).where(eq(interests.id, interestId));
  return id;
}

export async function expressInterest(
  ctx: UserContext,
  input: { listingId: string; matchId?: string; message?: string; shareContact?: boolean },
): Promise<InterestView> {
  const [listing] = await db.select().from(listings).where(eq(listings.id, input.listingId));
  if (!listing || listing.status === 'draft') throw notFound('Listing');
  if (listing.sellerId === ctx.userId) throw invalid('You cannot express interest in your own listing');
  if (listing.status !== 'active') throw invalid('This item is no longer available');

  const message = cleanMessage(input.message);
  const matchId = await resolveMatchId(ctx.userId, listing.id, input.matchId);

  // Upsert on (listing, buyer): repeated calls return the same interest.
  const [created] = await db
    .insert(interests)
    .values({
      id: newId('int'),
      listingId: listing.id,
      buyerId: ctx.userId,
      sellerId: listing.sellerId,
      matchId,
      buyerContactShared: input.shareContact === true,
    })
    .onConflictDoNothing({ target: [interests.listingId, interests.buyerId] })
    .returning();

  let interest: InterestRow;
  let reopened = false;
  if (created) {
    interest = created;
  } else {
    const [existing] = await db
      .select()
      .from(interests)
      .where(and(eq(interests.listingId, listing.id), eq(interests.buyerId, ctx.userId)));
    if (existing.status === 'declined') throw invalid('The seller has already declined your interest in this item');
    reopened = existing.status === 'withdrawn'; // listing came back after being paused/withdrawn
    const [updated] = await db
      .update(interests)
      .set({
        matchId: existing.matchId ?? matchId,
        buyerContactShared: existing.buyerContactShared || input.shareContact === true,
        status: reopened ? 'pending' : existing.status,
        updatedAt: new Date(),
      })
      .where(eq(interests.id, existing.id))
      .returning();
    interest = updated;
  }

  const linkedMatch = interest.matchId;
  if (linkedMatch) {
    await db
      .update(matches)
      .set({ status: 'interested', updatedAt: new Date() })
      .where(and(eq(matches.id, linkedMatch), sql`${matches.status} <> 'connected'`));
  }

  const messageId = message ? await insertMessage(interest.id, ctx.userId, message) : null;
  const name = itemName(listing.title);

  if (created || reopened) {
    await logEvent({
      type: 'interest_expressed',
      actorId: ctx.userId,
      listingId: listing.id,
      matchId: linkedMatch,
      data: { interestId: interest.id, withMessage: !!message, reopened },
    });
    // Confirmed demand: an explicit buyer action. Never include buyer contact details here.
    await addInboxItem({
      userId: listing.sellerId,
      type: 'buyer_interest',
      title: `A buyer is interested in your ${name}`,
      body:
        `A buyer pressed "interested" on your ${name}.` +
        (message ? ` Their message: "${snippet(message)}"` : '') +
        ' You can accept, decline or reply; contact details are only shared if you both agree.',
      payload: { interestId: interest.id, listingId: listing.id, message },
      dedupeKey: reopened ? `interest:${interest.id}:reopened:${interest.updatedAt.getTime()}` : `interest:${interest.id}`,
    });
  } else if (messageId) {
    await notifyNewMessage(interest, ctx.userId, messageId, message!, listing.title);
  }
  if (input.shareContact) await logContactShared(ctx.userId, interest);

  return buildView(interest, ctx.userId);
}

export async function respondToInterest(
  ctx: UserContext,
  interestId: string,
  input: { action: 'accept' | 'decline'; message?: string; shareContact?: boolean },
): Promise<InterestView> {
  const { interest, role } = await loadInterestFor(ctx, interestId);
  if (role !== 'seller') throw forbidden('Only the seller can respond to interest');
  if (interest.status === 'withdrawn') throw invalid('This interest was withdrawn because the item is no longer available');

  const target: InterestStatus = input.action === 'accept' ? 'accepted' : 'declined';
  if (interest.status !== 'pending' && interest.status !== target) {
    throw new DomainError('conflict', `You already ${interest.status} this interest`);
  }
  const [listing] = await db.select().from(listings).where(eq(listings.id, interest.listingId));
  if (target === 'accepted' && listing?.status !== 'active') throw invalid('This listing is not active');

  const message = cleanMessage(input.message);
  const firstResponse = interest.status === 'pending';
  const shareNow = target === 'accepted' && input.shareContact === true && !interest.sellerContactShared;

  const [updated] = await db
    .update(interests)
    .set({
      status: target,
      respondedAt: interest.respondedAt ?? new Date(),
      sellerContactShared: interest.sellerContactShared || shareNow,
      updatedAt: new Date(),
    })
    .where(eq(interests.id, interest.id))
    .returning();

  if (updated.matchId) {
    await db
      .update(matches)
      .set({ status: target === 'accepted' ? 'connected' : 'closed', updatedAt: new Date() })
      .where(eq(matches.id, updated.matchId));
  }
  if (message) await insertMessage(updated.id, ctx.userId, message);

  if (firstResponse) {
    await logEvent({
      type: target === 'accepted' ? 'interest_accepted' : 'interest_declined',
      actorId: ctx.userId,
      listingId: updated.listingId,
      matchId: updated.matchId,
      data: { interestId: updated.id },
    });
    const name = itemName(listing?.title ?? null);
    await addInboxItem({
      userId: updated.buyerId,
      type: 'interest_response',
      title: target === 'accepted' ? `The seller accepted your interest in the ${name}` : `The seller declined your interest in the ${name}`,
      body:
        (target === 'accepted'
          ? 'You can now message the seller through the marketplace to arrange pickup.'
          : "The seller isn't going ahead with you for this item. Your saved searches stay active.") +
        (message ? ` Seller's message: "${snippet(message)}"` : ''),
      payload: { interestId: updated.id, listingId: updated.listingId, status: target, message },
      dedupeKey: `interest_response:${updated.id}:${target}`,
    });
  }
  if (shareNow) await logContactShared(ctx.userId, updated);

  return buildView(updated, ctx.userId);
}

async function notifyNewMessage(
  interest: InterestRow,
  senderId: string,
  messageId: string,
  body: string,
  listingTitle: string | null,
): Promise<void> {
  const recipientId = senderId === interest.buyerId ? interest.sellerId : interest.buyerId;
  const from = senderId === interest.buyerId ? 'the buyer' : 'the seller';
  await addInboxItem({
    userId: recipientId,
    type: 'new_message',
    title: `New message about the ${itemName(listingTitle)}`,
    body: `Message from ${from}: "${snippet(body)}"`,
    payload: { interestId: interest.id, listingId: interest.listingId, messageId },
    dedupeKey: `msg:${messageId}`,
  });
}

/** Relay a message to the other participant. Contact details are never added automatically. */
export async function sendMessage(ctx: UserContext, interestId: string, body: string): Promise<InterestView> {
  const { interest } = await loadInterestFor(ctx, interestId);
  if (interest.status === 'declined' || interest.status === 'withdrawn') {
    throw invalid(`This conversation is closed (interest ${interest.status})`);
  }
  const text = cleanMessage(body);
  if (!text) throw invalid('Message is empty');
  const messageId = await insertMessage(interest.id, ctx.userId, text);
  const [listing] = await db.select({ title: listings.title }).from(listings).where(eq(listings.id, interest.listingId));
  await notifyNewMessage(interest, ctx.userId, messageId, text, listing?.title ?? null);
  await logEvent({
    type: 'message_sent',
    actorId: ctx.userId,
    listingId: interest.listingId,
    matchId: interest.matchId,
    data: { interestId: interest.id, messageId },
  });
  const [fresh] = await db.select().from(interests).where(eq(interests.id, interest.id));
  return buildView(fresh, ctx.userId);
}

async function logContactShared(actorId: string, interest: InterestRow): Promise<void> {
  await logEvent({
    type: 'contact_shared',
    actorId,
    listingId: interest.listingId,
    matchId: interest.matchId,
    data: { interestId: interest.id, side: actorId === interest.buyerId ? 'buyer' : 'seller' },
  });
}

/** Opt in to sharing your own contact with the counterpart. It becomes visible only once both sides opted in and the seller accepted. */
export async function shareContact(ctx: UserContext, interestId: string): Promise<InterestView> {
  const { interest, role } = await loadInterestFor(ctx, interestId);
  if (interest.status === 'declined' || interest.status === 'withdrawn') {
    throw invalid(`Contact cannot be shared on a ${interest.status} interest`);
  }
  const already = role === 'buyer' ? interest.buyerContactShared : interest.sellerContactShared;
  let current = interest;
  if (!already) {
    const [updated] = await db
      .update(interests)
      .set(role === 'buyer' ? { buyerContactShared: true, updatedAt: new Date() } : { sellerContactShared: true, updatedAt: new Date() })
      .where(eq(interests.id, interest.id))
      .returning();
    current = updated;
    await logContactShared(ctx.userId, current);
  }
  return buildView(current, ctx.userId);
}

export async function getConversation(ctx: UserContext, interestId: string): Promise<InterestView> {
  const { interest } = await loadInterestFor(ctx, interestId);
  return buildView(interest, ctx.userId);
}

/** Interests where the user is buyer or seller, most recently active first (last 5 messages each). */
export async function listMyInterests(ctx: UserContext, opts: { role?: 'buyer' | 'seller' } = {}): Promise<InterestView[]> {
  const where =
    opts.role === 'buyer'
      ? eq(interests.buyerId, ctx.userId)
      : opts.role === 'seller'
        ? eq(interests.sellerId, ctx.userId)
        : or(eq(interests.buyerId, ctx.userId), eq(interests.sellerId, ctx.userId));
  const rows = await db.select().from(interests).where(where).orderBy(desc(interests.updatedAt)).limit(100);
  return Promise.all(rows.map((r) => buildView(r, ctx.userId, { messageLimit: 5 })));
}

/**
 * Used by jobs when a listing is sold/withdrawn: marks pending interests 'withdrawn'.
 * Returns the affected interests so callers can notify buyers.
 */
export async function withdrawPendingInterestsForListing(
  listingId: string,
): Promise<{ interestId: string; buyerId: string; matchId: string | null }[]> {
  const rows = await db
    .update(interests)
    .set({ status: 'withdrawn', updatedAt: new Date() })
    .where(and(eq(interests.listingId, listingId), inArray(interests.status, ['pending'])))
    .returning({ interestId: interests.id, buyerId: interests.buyerId, matchId: interests.matchId });
  return rows;
}
