import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../../src/db/client.js';
import { inboxItems } from '../../src/db/schema.js';
import { addInboxItem, getInbox, listUndigestedForUser, markInboxRead } from '../../src/domain/inbox.service.js';
import { makeUser, resetDb, setupTestDb } from '../helpers/db.js';

describe('inbox', () => {
  beforeAll(setupTestDb);
  beforeEach(resetDb);
  afterAll(() => pool.end());

  it('is idempotent per (user, dedupeKey)', async () => {
    const u = await makeUser('a@test.dev');
    const other = await makeUser('b@test.dev');
    const item = { userId: u.userId, type: 'new_match' as const, title: 't', body: 'b', dedupeKey: 'match:1' };
    expect(await addInboxItem(item)).toBe(true);
    expect(await addInboxItem({ ...item, title: 'changed' })).toBe(false);
    // Same key for another user is a separate item.
    expect(await addInboxItem({ ...item, userId: other.userId })).toBe(true);
    const rows = await db.select().from(inboxItems).where(eq(inboxItems.userId, u.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('t');
  });

  it('returns newest first, marks read on request, and filters unread', async () => {
    const u = await makeUser('a@test.dev');
    for (const k of ['1', '2', '3']) {
      await addInboxItem({ userId: u.userId, type: 'new_match', title: `item ${k}`, body: '', dedupeKey: k });
      await new Promise((r) => setTimeout(r, 5));
    }
    const first = await getInbox(u, { markRead: true, limit: 2 });
    expect(first.items.map((i) => i.title)).toEqual(['item 3', 'item 2']);
    expect(first.items.every((i) => !i.read)).toBe(true); // shown as unread the time they're delivered
    expect(first.unreadCount).toBe(1);
    expect(typeof first.items[0].createdAt).toBe('string');

    const unread = await getInbox(u, { unreadOnly: true });
    expect(unread.items.map((i) => i.title)).toEqual(['item 1']);
    expect(await markInboxRead(u, 'all')).toBe(1);
    expect((await getInbox(u)).unreadCount).toBe(0);
  });

  it('markInboxRead only touches the caller’s items', async () => {
    const a = await makeUser('a@test.dev');
    const b = await makeUser('b@test.dev');
    await addInboxItem({ userId: b.userId, type: 'new_match', title: 'x', body: '', dedupeKey: 'k' });
    const [row] = await db.select().from(inboxItems);
    expect(await markInboxRead(a, [row.id])).toBe(0);
    expect((await getInbox(b)).unreadCount).toBe(1);
  });

  it('lists undigested unread items', async () => {
    const u = await makeUser('a@test.dev');
    await addInboxItem({ userId: u.userId, type: 'new_match', title: 'one', body: '', dedupeKey: '1' });
    await addInboxItem({ userId: u.userId, type: 'new_match', title: 'two', body: '', dedupeKey: '2' });
    await db.update(inboxItems).set({ emailedAt: new Date() }).where(eq(inboxItems.dedupeKey, '2'));
    expect((await listUndigestedForUser(u.userId)).map((i) => i.title)).toEqual(['one']);
  });
});
