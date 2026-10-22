/** Tools used by both sides: inbox, messages, price guidance, profile. */
import { z } from 'zod';
import { getInbox, markInboxRead, type InboxItemView } from '../../domain/inbox.service.js';
import { invalid } from '../../domain/errors.js';
import { getConversation, listMyInterests, sendMessage, shareContact } from '../../domain/interactions.service.js';
import { getPriceGuidance } from '../../domain/listings.service.js';
import type { InboxType } from '../../domain/types.js';
import { CONDITIONS } from '../../domain/types.js';
import { setDefaultLocation, updateProfile } from '../../domain/users.service.js';
import { formatRange, lines, plural, respond } from '../respond.js';
import {
  appsMeta,
  attributes,
  buyerLocation,
  conversationText,
  id,
  priceEstimate,
  READ_ONLY,
  WRITE,
  WRITE_IDEMPOTENT,
  type ToolDeps,
} from './common.js';

/** Inbox sections, in display order. Computed "possible" signals are always kept apart from explicit actions. */
const INBOX_SECTIONS: { types: InboxType[]; heading: string }[] = [
  { types: ['buyer_interest'], heading: 'Confirmed buyer interest (a buyer explicitly said they are interested)' },
  { types: ['interest_response'], heading: 'Seller responses to your interest' },
  { types: ['new_message'], heading: 'New messages' },
  { types: ['info_request'], heading: 'Questions or info that would help' },
  { types: ['new_match'], heading: 'Possible matches for your saved requests (not yet checked with the seller)' },
  { types: ['possible_demand'], heading: 'Possible demand: saved searches that might fit your listing (NOT confirmed interest)' },
  { types: ['availability_check'], heading: 'Please confirm these are still available' },
  { types: ['listing_unavailable'], heading: 'No longer available' },
  { types: ['request_expiring'], heading: 'Saved requests expiring soon' },
];

export function registerSharedTools({ server, ctx }: ToolDeps): void {
  server.registerTool(
    'get_inbox',
    {
      title: 'Marketplace inbox',
      description: `Call this at the start of any marketplace conversation and whenever the user asks what's new.
Shows new possible matches for saved requests, buyer interest, messages, questions, availability checks and items that became unavailable.
Always distinguish possible matches (computed by the marketplace) from confirmed buyer interest (a person explicitly acted). Summarise briefly, most important first. After the user has seen the items, call mark_inbox_read.`,
      inputSchema: {
        unreadOnly: z.boolean().default(true).describe('Only unread items (default true).'),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: READ_ONLY,
      _meta: appsMeta('Checking your inbox…', 'Inbox checked'),
    },
    ({ unreadOnly, limit }) =>
      respond(async () => {
        const r = await getInbox(ctx, { unreadOnly, markRead: false, limit });
        return { text: inboxText(r.items, r.unreadCount), data: { ...r } };
      }),
  );

  server.registerTool(
    'mark_inbox_read',
    {
      title: 'Mark inbox items read',
      description: 'Mark inbox items as read after the user has seen them. Pass the item ids, or "all".',
      inputSchema: { ids: z.union([z.array(z.string()).min(1), z.literal('all')]) },
      annotations: WRITE_IDEMPOTENT,
      _meta: appsMeta('Marking as read…', 'Marked as read'),
    },
    ({ ids }) =>
      respond(async () => {
        const n = await markInboxRead(ctx, ids);
        return { text: `Marked ${plural(n, 'item')} as read.`, data: { marked: n } };
      }),
  );

  server.registerTool(
    'send_message',
    {
      title: 'Send a message',
      description: `Send a relayed message in an existing buyer–seller conversation (identified by interestId), and/or opt in to sharing the user's email with the other side (shareContact: true, only after the user agreed).
Contact details are revealed only once both sides opted in and the seller accepted. Never include exact addresses or phone numbers in a message unless the user explicitly asks to and the seller has accepted.`,
      inputSchema: {
        interestId: id('Interest (conversation)'),
        body: z.string().min(1).max(2000).optional().describe('Message text.'),
        shareContact: z.boolean().optional().describe("The user agrees to share their email with the other side."),
      },
      annotations: WRITE,
      _meta: appsMeta('Sending message…', 'Message sent'),
    },
    ({ interestId, body, shareContact: share }) =>
      respond(async () => {
        if (!body && !share) throw invalid('Provide a message body or shareContact: true');
        let v = body ? await sendMessage(ctx, interestId, body) : null;
        if (share) v = await shareContact(ctx, interestId);
        return { text: conversationText(v!), data: { conversation: v } };
      }),
  );

  server.registerTool(
    'get_conversation',
    {
      title: 'Get conversation',
      description: 'Show the status and messages of one buyer–seller conversation, and whether contact details have been shared.',
      inputSchema: { interestId: id('Interest (conversation)') },
      annotations: READ_ONLY,
      _meta: appsMeta('Loading conversation…', 'Conversation loaded'),
    },
    ({ interestId }) =>
      respond(async () => {
        const v = await getConversation(ctx, interestId);
        return { text: conversationText(v), data: { conversation: v } };
      }),
  );

  server.registerTool(
    'list_my_conversations',
    {
      title: 'My conversations',
      description: 'List the user’s buyer–seller conversations (interests), as buyer, seller or both.',
      inputSchema: { role: z.enum(['buyer', 'seller']).optional().describe('Filter by the user’s role. Default: both.') },
      annotations: READ_ONLY,
      _meta: appsMeta('Loading conversations…', 'Conversations loaded'),
    },
    ({ role }) =>
      respond(async () => {
        const vs = await listMyInterests(ctx, { role });
        return {
          text: vs.length
            ? lines(
                `${plural(vs.length, 'conversation')}:`,
                ...vs.map((v) => `- "${v.listingTitle ?? v.listingId}" · you are the ${v.role} · ${v.status} · ${plural(v.messages.length, 'message')} · id ${v.interestId}`),
              )
            : 'No conversations yet.',
          data: { conversations: vs },
        };
      }),
  );

  server.registerTool(
    'get_price_guidance',
    {
      title: 'Price guidance',
      description: `Get a price range for an item from comparable listings on this marketplace, optionally combined with your own estimate (modelEstimate).
The result is always an estimate; say so ("estimated", "similar items here sold for around…"). There is no external market data. Prices are in minor units (cents).`,
      inputSchema: {
        category: z.string().optional(),
        attributes: attributes.optional(),
        condition: z.enum(CONDITIONS).optional(),
        currency: z.string().length(3).optional().describe('Default EUR.'),
        modelEstimate: priceEstimate.nullable().optional(),
        listingId: id('Listing to exclude from comparables (the item being priced)').optional(),
      },
      annotations: READ_ONLY,
      _meta: appsMeta('Estimating price…', 'Price estimated'),
    },
    ({ listingId, ...input }) =>
      respond(async () => {
        const g = await getPriceGuidance({ ...input, excludeListingId: listingId });
        const range = formatRange(g.lowCents, g.highCents, g.currency);
        return {
          text: lines(
            range
              ? `Estimated price: ${range} (${g.basis === 'marketplace_comparables' ? `from ${plural(g.comparableCount, 'comparable listing')}` : g.basis.replace(/_/g, ' ')}).`
              : 'Not enough data for a price estimate.',
            g.note,
          ),
          data: { guidance: g },
        };
      }),
  );

  server.registerTool(
    'set_default_location',
    {
      title: 'Set default location',
      description:
        'Save the user’s usual area (e.g. "Paris 11e", a postcode or a neighbourhood) so searches and listings can default to it. Only a coarse area is needed; never ask for a street address.',
      inputSchema: { location: buyerLocation.describe('The area, e.g. { text: "Paris 11e" }.') },
      annotations: WRITE_IDEMPOTENT,
      _meta: appsMeta('Saving location…', 'Location saved'),
    },
    ({ location }) =>
      respond(async () => {
        const r = await setDefaultLocation(ctx, location);
        return { text: `Default area set to ${r.label}.`, data: { defaultLocation: r } };
      }),
  );

  server.registerTool(
    'update_profile',
    {
      title: 'Update profile',
      description: 'Update the user’s display name (shown to the other side in conversations) and whether they get email digests of unread inbox items.',
      inputSchema: {
        displayName: z.string().min(1).max(60).optional(),
        notifyEmail: z.boolean().optional().describe('Receive a daily email digest of unread marketplace updates.'),
      },
      annotations: WRITE_IDEMPOTENT,
      _meta: appsMeta('Updating profile…', 'Profile updated'),
    },
    (patch) =>
      respond(async () => {
        const u = await updateProfile(ctx, patch);
        const profile = { displayName: u.displayName, notifyEmail: u.notifyEmail, defaultLocation: u.defaultLocationLabel };
        return {
          text: `Profile updated: name ${profile.displayName ?? '(not set)'}, email digests ${profile.notifyEmail ? 'on' : 'off'}.`,
          data: { profile },
        };
      }),
  );
}

function inboxText(items: InboxItemView[], unreadCount: number): string {
  if (!items.length) return 'Nothing new in your marketplace inbox.';
  const out = [`${plural(unreadCount, 'unread update')}.`];
  const seen = new Set<string>();
  for (const s of INBOX_SECTIONS) {
    const group = items.filter((i) => s.types.includes(i.type));
    if (!group.length) continue;
    out.push(`${s.heading}:`, ...group.map((i) => `- ${i.title}: ${i.body}`));
    group.forEach((i) => seen.add(i.id));
  }
  const rest = items.filter((i) => !seen.has(i.id));
  if (rest.length) out.push('Other:', ...rest.map((i) => `- ${i.title}: ${i.body}`));
  return out.join('\n');
}
