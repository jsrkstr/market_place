/** Seller tools: create and manage listings, see demand, respond to buyers. */
import { z } from 'zod';
import {
  createListing,
  getListingDemand,
  getMyListings,
  getOwnListing,
  publishListing,
  setListingStatus,
  updateListing,
  type CreateListingResult,
} from '../../domain/listings.service.js';
import { respondToInterest, sendMessage, shareContact } from '../../domain/interactions.service.js';
import { attachPhotosFromFiles, createUploadLink } from '../../domain/photos.service.js';
import { invalid } from '../../domain/errors.js';
import { LISTING_STATUSES } from '../../domain/types.js';
import { formatPrice, formatRange, lines, plural, respond } from '../respond.js';
import {
  appsMeta,
  attributes,
  conditionInput,
  DESTRUCTIVE,
  id,
  listingLine,
  missingFieldsHint,
  priceEstimate,
  READ_ONLY,
  sellerLocation,
  conversationText,
  WRITE,
  WRITE_IDEMPOTENT,
  type ToolDeps,
} from './common.js';


/** Fields shared by create_listing and update_listing (mirrors ListingInput). */
const listingFields = {
  rawText: z.string().optional().describe("The seller's own words (typed or transcribed voice), verbatim."),
  title: z.string().max(120).optional().describe('Short, factual title, e.g. "White IKEA dining chair". No hype, no guessed model names stated as fact.'),
  description: z.string().max(4000).optional().describe('Plain description built from what the seller said and what is visible. Mark guesses as "possibly".'),
  category: z.string().optional().describe('Category, e.g. "dining chair", "floor lamp", "sofa", or a slug like furniture/seating/dining-chair.'),
  attributes: attributes.optional(),
  priceCents: z
    .number()
    .int()
    .nonnegative()
    .nullable()
    .optional()
    .describe("The seller's asking price in minor units (cents), e.g. 2000 = €20. Only a price the seller stated or accepted. null = seller does not know yet."),
  currency: z.string().length(3).optional().describe('ISO currency code. Defaults to EUR.'),
  priceEstimate: priceEstimate.nullable().optional(),
  condition: conditionInput.nullable().optional(),
  quantity: z.number().int().positive().optional().describe('Number of identical units, e.g. 4 for a set of four chairs. Default 1.'),
  location: sellerLocation.optional(),
  pickupOptions: z.array(z.string()).optional().describe('E.g. ["pickup", "can help carry downstairs", "delivery nearby for a fee"].'),
  imageObservations: z
    .array(z.string())
    .optional()
    .describe('Short factual observations from the photos (e.g. "small scratch on left leg", "label reads IKEA").'),
};

export function registerSellerTools({ server, ctx }: ToolDeps): void {
  server.registerTool(
    'create_listing',
    {
      title: 'Create listing',
      description: `Create a listing for something the user wants to sell, from their words (text or voice) and photos.
How to use:
- Extract everything you reasonably can from the seller's words and photos: title, category, brand/model, colour, material, style, dimensions, condition, quantity, pickup area. Tag EVERY value's source honestly: seller_stated (they said it), ai_inferred (you saw/deduced it), ai_estimated (your numeric guess). Add a confidence for ai_* values.
- Never invent unknowns. If you cannot tell, leave the field out; the server tracks what is missing.
- Never put your own price guess in priceCents. Offer it only as priceEstimate (an estimate) unless the seller states or explicitly accepts a price.
- Before publishing, show the seller a short summary and confirm the title, price and rough pickup area. Only then call with publish: true. Otherwise (or if anything essential is unconfirmed) call with publish: false to save a draft, and publish later with publish_listing.
- Pass a fresh idempotencyKey per new item so a retry never creates a duplicate.
- Afterwards, mention at most the top 1-2 missing fields that would help buyers (from missingFields). Do not quiz the seller. If duplicateOf is set, tell the seller they already have this item listed.
- If they shared photos, call attach_listing_photos with the returned listing id.`,
      inputSchema: {
        ...listingFields,
        publish: z.boolean().default(false).describe('true only after the seller confirmed title, price and pickup area.'),
        idempotencyKey: z.string().max(200).optional().describe('Unique key for this item (e.g. a random string); retries with the same key return the same listing.'),
      },
      annotations: WRITE,
      _meta: appsMeta('Saving your listing…', 'Listing saved'),
    },
    (args) => respond(async () => listingResult(await createListing(ctx, args), 'Created')),
  );

  server.registerTool(
    'attach_listing_photos',
    {
      title: 'Attach photos to a listing',
      description: `Attach the photos the seller shared in this chat to one of their listings. Pass the uploaded image files in "files".
Optional captions (same order as files) describe what each photo shows. If you cannot pass files here, call get_photo_upload_link instead and give the seller the link.`,
      inputSchema: {
        listingId: id('Listing'),
        files: z
          .array(
            z.object({
              download_url: z.string().url().describe('Temporary download URL of the uploaded file.'),
              file_id: z.string().describe('File id from the chat.'),
              mime_type: z.string().optional(),
              file_name: z.string().optional(),
            }),
          )
          .min(1)
          .max(12),
        captions: z.array(z.string()).optional().describe('Short factual caption per photo, same order as files.'),
      },
      annotations: WRITE,
      _meta: appsMeta('Uploading photos…', 'Photos attached', { 'openai/fileParams': ['files'] }),
    },
    ({ listingId, files, captions }) =>
      respond(async () => {
        const r = await attachPhotosFromFiles(
          ctx,
          listingId,
          files.map((f) => ({ downloadUrl: f.download_url, fileId: f.file_id, mimeType: f.mime_type, fileName: f.file_name })),
          captions,
        );
        return {
          text: lines(
            `Attached ${plural(r.added.length, 'photo')} to listing ${listingId}.`,
            r.failed.length ? `${plural(r.failed.length, 'photo')} failed: ${r.failed.map((f) => f.error).join('; ')}. Offer get_photo_upload_link as a fallback.` : null,
          ),
          data: { listingId, ...r },
        };
      }),
  );

  server.registerTool(
    'get_photo_upload_link',
    {
      title: 'Get a photo upload link',
      description:
        'Get a one-time link where the seller can upload photos for a listing in their browser. Use when photos cannot be passed to attach_listing_photos. Share the link as-is and mention when it expires.',
      inputSchema: { listingId: id('Listing') },
      annotations: WRITE,
      _meta: appsMeta('Creating upload link…', 'Upload link ready'),
    },
    ({ listingId }) =>
      respond(async () => {
        const r = await createUploadLink(ctx, listingId);
        return { text: `Upload photos here: ${r.url} (expires ${r.expiresAt}).`, data: { listingId, ...r } };
      }),
  );

  server.registerTool(
    'update_listing',
    {
      title: 'Update listing',
      description: `Change details of one of the seller's listings. Send only the fields that change; attributes are merged by key. Keep provenance honest (a value the seller just confirmed becomes seller_stated). Matching re-runs automatically for published listings.`,
      inputSchema: { listingId: id('Listing'), ...listingFields },
      annotations: WRITE_IDEMPOTENT,
      _meta: appsMeta('Updating listing…', 'Listing updated'),
    },
    ({ listingId, ...patch }) => respond(async () => listingResult(await updateListing(ctx, listingId, patch), 'Updated')),
  );

  server.registerTool(
    'publish_listing',
    {
      title: 'Publish listing',
      description:
        'Publish a draft listing so buyers can find it. Only call after the seller confirmed title, price and pickup area. If publishBlockers come back, ask the seller for exactly those items.',
      inputSchema: { listingId: id('Listing') },
      annotations: WRITE_IDEMPOTENT,
      _meta: appsMeta('Publishing…', 'Listing published'),
    },
    ({ listingId }) => respond(async () => listingResult(await publishListing(ctx, listingId), 'Listing')),
  );

  server.registerTool(
    'set_listing_status',
    {
      title: 'Change listing status',
      description: `Pause, reactivate, mark sold, withdraw, or confirm a listing is still available.
Use mark_sold when the seller says it sold (anywhere), withdraw when they no longer want to sell, confirm_available when they confirm it is still for sale. Interested buyers are notified automatically when an item becomes unavailable.`,
      inputSchema: {
        listingId: id('Listing'),
        action: z.enum(['pause', 'reactivate', 'mark_sold', 'withdraw', 'confirm_available']),
      },
      annotations: DESTRUCTIVE,
      _meta: appsMeta('Updating status…', 'Status updated'),
    },
    ({ listingId, action }) =>
      respond(async () => {
        const l = await setListingStatus(ctx, listingId, action);
        return { text: `Listing "${l.title ?? listingId}" is now ${l.status}.`, data: { listing: l } };
      }),
  );

  server.registerTool(
    'get_my_listings',
    {
      title: 'My listings',
      description:
        "List the seller's own listings (optionally filtered by status), or pass listingId to get full detail of one of them, including missing fields and completeness.",
      inputSchema: {
        listingId: id('Listing').optional(),
        status: z.array(z.enum(LISTING_STATUSES)).optional().describe('Filter, e.g. ["draft","active"]. Default: all.'),
      },
      annotations: READ_ONLY,
      _meta: appsMeta('Loading your listings…', 'Listings loaded'),
    },
    ({ listingId, status }) =>
      respond(async () => {
        if (listingId) {
          const l = await getOwnListing(ctx, listingId);
          return { text: lines(listingLine(l), missingFieldsHint(l.missingFields)), data: { listings: [l] } };
        }
        const ls = await getMyListings(ctx, { status });
        return {
          text: ls.length ? lines(`You have ${plural(ls.length, 'listing')}:`, ...ls.map(listingLine)) : 'You have no listings yet.',
          data: { listings: ls },
        };
      }),
  );

  server.registerTool(
    'get_listing_demand',
    {
      title: 'Demand for a listing',
      description: `Honest demand signals for one of the seller's listings. Two separate numbers, never merge them:
- possibleMatches: saved buyer requests that might fit (computed, NOT interest). Say "N saved searches possibly match".
- interestedBuyers: buyers who explicitly said they are interested.
If suggestedFields is non-empty, suggest the top 1-2 to firm up possible matches. Never exaggerate demand.`,
      inputSchema: { listingId: id('Listing') },
      annotations: READ_ONLY,
      _meta: appsMeta('Checking demand…', 'Demand checked'),
    },
    ({ listingId }) =>
      respond(async () => {
        const d = await getListingDemand(ctx, listingId);
        return {
          text: lines(
            `Possible matches (saved buyer searches, not confirmed interest): ${d.possibleMatches}` +
              (d.possibleMatchesNeedingInfo ? ` (${d.possibleMatchesNeedingInfo} need more info from you)` : ''),
            `Buyers who expressed interest: ${d.interestedBuyers}` + (d.pendingInterests.length ? ` (${d.pendingInterests.length} awaiting your reply)` : ''),
            missingFieldsHint(d.suggestedFields),
            d.note,
          ),
          data: { demand: d },
        };
      }),
  );

  server.registerTool(
    'respond_to_interest',
    {
      title: 'Respond to a buyer',
      description: `Respond to a buyer's interest in one of your listings: accept, decline, reply with a message, or share contact details.
Messages are relayed; no contact details are exchanged unless the seller opts in (shareContact) and the buyer does too. Never put an exact address in a message before the seller has accepted; arrange pickup details through messages after acceptance.`,
      inputSchema: {
        interestId: id('Interest'),
        action: z.enum(['accept', 'decline', 'reply', 'share_contact']),
        message: z.string().max(2000).optional().describe('Message to the buyer (required for reply).'),
        shareContact: z.boolean().optional().describe('Seller opts in to sharing their email with this buyer (accept only). Ask first.'),
      },
      annotations: WRITE,
      _meta: appsMeta('Sending your response…', 'Response sent'),
    },
    ({ interestId, action, message, shareContact: share }) =>
      respond(async () => {
        let v;
        if (action === 'reply') {
          if (!message) throw invalid('A message is required to reply');
          v = await sendMessage(ctx, interestId, message);
        } else if (action === 'share_contact') {
          v = await shareContact(ctx, interestId);
        } else {
          v = await respondToInterest(ctx, interestId, { action, message, shareContact: share });
        }
        return { text: conversationText(v), data: { conversation: v } };
      }),
  );
}

function listingResult(r: CreateListingResult, verb: string) {
  const l = r.listing;
  if (r.duplicateOf) {
    return {
      text: `This looks like a listing you already have (id ${r.duplicateOf}); no new listing was created.\n${listingLine(l)}`,
      data: { ...r },
    };
  }
  const guidance = r.priceGuidance;
  const guidanceRange = guidance ? formatRange(guidance.lowCents, guidance.highCents, guidance.currency) : null;
  return {
    text: lines(
      `${verb}: ${listingLine(l).slice(2)}`,
      r.published ? 'It is live and buyers can find it.' : 'Saved as a draft (not visible to buyers yet).',
      r.publishBlockers.length ? `Cannot publish yet: ${r.publishBlockers.join('; ')}.` : null,
      l.priceCents != null ? `Asking price: ${formatPrice(l.priceCents, l.currency)}.` : null,
      guidanceRange ? `Price guidance (${guidance!.basis.replace(/_/g, ' ')}, an estimate): ${guidanceRange}.` : null,
      missingFieldsHint(r.missingFields),
    ),
    data: { ...r },
  };
}
