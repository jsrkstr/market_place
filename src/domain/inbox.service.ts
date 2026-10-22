/**
 * Per-user inbox. An MCP server cannot push into ChatGPT, so asynchronous discovery (new matches,
 * buyer interest, availability checks…) lands here; the model reads it at the start of a conversation
 * and the daily digest emails a summary of unread items.
 */
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/client.js';
import { db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { inboxItems } from '../db/schema.js';
import type { InboxType, UserContext } from './types.js';

export interface InboxItemView {
  id: string;
  type: InboxType;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

type InboxRow = typeof inboxItems.$inferSelect;

const toView = (r: InboxRow): InboxItemView => ({
  id: r.id,
  type: r.type,
  title: r.title,
  body: r.body,
  payload: r.payload,
  read: r.readAt != null,
  createdAt: r.createdAt.toISOString(),
});

/** Idempotent on (userId, dedupeKey). Returns false when it already existed. */
export async function addInboxItem(
  item: { userId: string; type: InboxType; title: string; body: string; payload?: Record<string, unknown>; dedupeKey: string },
  tx: DbOrTx = db,
): Promise<boolean> {
  const inserted = await tx
    .insert(inboxItems)
    .values({
      id: newId('inb'),
      userId: item.userId,
      type: item.type,
      title: item.title,
      body: item.body,
      payload: item.payload ?? {},
      dedupeKey: item.dedupeKey,
    })
    .onConflictDoNothing({ target: [inboxItems.userId, inboxItems.dedupeKey] })
    .returning({ id: inboxItems.id });
  return inserted.length > 0;
}

/** Newest first. `markRead` marks the returned items read (after reading them, so they still show as unread). */
export async function getInbox(
  ctx: UserContext,
  opts: { unreadOnly?: boolean; markRead?: boolean; limit?: number } = {},
): Promise<{ items: InboxItemView[]; unreadCount: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const where = opts.unreadOnly
    ? and(eq(inboxItems.userId, ctx.userId), isNull(inboxItems.readAt))
    : eq(inboxItems.userId, ctx.userId);
  const rows = await db
    .select()
    .from(inboxItems)
    .where(where)
    .orderBy(desc(inboxItems.createdAt), desc(inboxItems.id))
    .limit(limit);
  const items = rows.map(toView);

  if (opts.markRead) {
    const ids = rows.filter((r) => !r.readAt).map((r) => r.id);
    if (ids.length) await markInboxRead(ctx, ids);
  }
  const unreadCount = await countUnread(ctx.userId);
  return { items, unreadCount };
}

export async function markInboxRead(ctx: UserContext, ids: string[] | 'all'): Promise<number> {
  if (ids !== 'all' && ids.length === 0) return 0;
  const conds = [eq(inboxItems.userId, ctx.userId), isNull(inboxItems.readAt)];
  if (ids !== 'all') conds.push(inArray(inboxItems.id, ids));
  const updated = await db
    .update(inboxItems)
    .set({ readAt: new Date() })
    .where(and(...conds))
    .returning({ id: inboxItems.id });
  return updated.length;
}

async function countUnread(userId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(inboxItems)
    .where(and(eq(inboxItems.userId, userId), isNull(inboxItems.readAt)));
  return r?.n ?? 0;
}

/** Unread items not yet included in an email digest, oldest first. Used by the digest sweep. */
export async function listUndigestedForUser(userId: string, limit = 50): Promise<InboxItemView[]> {
  const rows = await db
    .select()
    .from(inboxItems)
    .where(and(eq(inboxItems.userId, userId), isNull(inboxItems.readAt), isNull(inboxItems.emailedAt)))
    .orderBy(inboxItems.createdAt)
    .limit(limit);
  return rows.map(toView);
}

export async function markEmailed(ids: string[], at = new Date()): Promise<void> {
  if (!ids.length) return;
  await db.update(inboxItems).set({ emailedAt: at }).where(inArray(inboxItems.id, ids));
}
