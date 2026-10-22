import type { DbOrTx } from '../db/client.js';
import { db as defaultDb } from '../db/client.js';
import { newId } from '../db/ids.js';
import { events } from '../db/schema.js';

export type EventType =
  | 'listing_created'
  | 'listing_published'
  | 'listing_updated'
  | 'listing_status_changed'
  | 'photo_added'
  | 'request_created'
  | 'request_updated'
  | 'request_status_changed'
  | 'search_performed'
  | 'match_suggested'
  | 'match_seen'
  | 'match_dismissed'
  | 'interest_expressed'
  | 'interest_accepted'
  | 'interest_declined'
  | 'message_sent'
  | 'contact_shared'
  | 'sold_via_marketplace';

export async function logEvent(
  e: {
    type: EventType;
    actorId?: string | null;
    listingId?: string | null;
    requestId?: string | null;
    matchId?: string | null;
    data?: Record<string, unknown>;
  },
  tx: DbOrTx = defaultDb,
): Promise<void> {
  await tx.insert(events).values({ id: newId('evt'), ...e, data: e.data ?? {} });
}
