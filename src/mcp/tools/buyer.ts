/** Buyer tools: search, saved requests, matches, feedback, interest. */
import { z } from 'zod';
import { expressInterest } from '../../domain/interactions.service.js';
import { getPublicListing } from '../../domain/listings.service.js';
import {
  createBuyerRequest,
  getMyRequests,
  getRequestMatches,
  giveMatchFeedback,
  searchListings,
  setBuyerRequestStatus,
  updateBuyerRequest,
  type BuyerRequestView,
  type SearchResult,
} from '../../domain/requests.service.js';
import { CONDITIONS, REQUEST_STATUSES } from '../../domain/types.js';
import { getUser } from '../../domain/users.service.js';
import { formatPrice, lines, plural, respond } from '../respond.js';
import {
  appsMeta,
  buyerLocation,
  conversationText,
  DESTRUCTIVE,
  id,
  matchLine,
  publicListingLine,
  READ_ONLY,
  WRITE,
  WRITE_IDEMPOTENT,
  type ToolDeps,
} from './common.js';

const dims = z
  .object({ widthCm: z.number().positive().optional(), depthCm: z.number().positive().optional(), heightCm: z.number().positive().optional() })
  .describe('Dimension bounds in cm.');

const attributeValues = z.object({
  attribute: z.string().describe('Attribute name, e.g. colour, material, style, brand.'),
  values: z.array(z.string()).min(1),
});

/** Mirrors BuyerRequestInput. */
const requestFields = {
  rawText: z.string().min(1).describe("The buyer's own words, verbatim."),
  summary: z.string().max(200).optional().describe('One-line summary, e.g. "2 off-white dining chairs, ≤ €80, ≤ 2 km from Paris 12e".'),
  category: z.string().optional().describe('E.g. "dining chair", "floor lamp", "sofa".'),
  hardConstraints: z
    .object({
      maxPriceCents: z.number().int().nonnegative().optional().describe('Total budget in minor units (cents): €80 = 8000.'),
      minPriceCents: z.number().int().nonnegative().optional(),
      currency: z.string().length(3).optional().describe('ISO code; default EUR. Ask if the buyer used an ambiguous currency.'),
      maxDistanceKm: z.number().positive().optional(),
      minCondition: z.enum(CONDITIONS).optional(),
      quantity: z.number().int().positive().optional().describe('Identical units needed, e.g. 2 chairs.'),
      maxDimensionsCm: dims.optional(),
      minDimensionsCm: dims.optional(),
      requiredAttributes: z.array(attributeValues).optional().describe('Must-haves the buyer was firm about ("must be wood").'),
      excludedAttributes: z.array(attributeValues).optional().describe('Deal-breakers ("no plastic").'),
    })
    .optional()
    .describe('Only what the buyer stated as a requirement (budget, distance, quantity, must-haves). Everything else is a soft preference.'),
  location: buyerLocation.optional(),
  softPreferences: z
    .array(attributeValues.extend({ weight: z.number().min(0).max(1).default(0.5).describe('How much it matters, 0..1.') }))
    .optional()
    .describe('Nice-to-haves, e.g. colour beige/off-white, style scandinavian.'),
  allowExceptions: z
    .object({
      budgetPct: z.number().min(0).max(100).optional().describe('Show items up to this % over budget as labelled exceptions.'),
      distanceKm: z.number().min(0).optional().describe('Extra km beyond maxDistanceKm for labelled exceptions.'),
    })
    .optional()
    .describe('Only if the buyer said they are flexible ("could stretch a bit").'),
  limit: z.number().int().min(1).max(20).default(5).describe('How many results to return.'),
};

const REQUEST_GUIDANCE = `Turning the buyer's words into input:
- Separate hard constraints (stated limits: budget, distance, quantity, must-haves, deal-breakers) from soft preferences (colour, style, material they would like). Do not turn preferences into hard constraints.
- Prices are in minor units (cents) with a currency, default EUR: "€80" = 8000.
- If an essential is genuinely ambiguous, ask ONE clarifying question instead of assuming: e.g. no location given and the user has no saved default (the result notes will say so), or an unclear budget currency. Otherwise just call the tool.
- Never ask for an exact address; a neighbourhood or postcode is enough.
Presenting results: a short list, each with the server-provided explanation and its "unverified" unknowns (say "not stated by the seller", never guess). Near-misses are only shown as clearly labelled exceptions to the buyer's limits. Do not oversell; do not mention internal scores.`;

export function registerBuyerTools({ server, ctx }: ToolDeps): void {
  server.registerTool(
    'search_listings',
    {
      title: 'Search listings',
      description: `Quick, one-off search of items for sale. Nothing is saved. Use it for "show me what's out there" questions.
If the buyer wants ongoing alerts, or there are no great matches yet, use create_buyer_request instead (it saves the request and keeps matching new listings).
${REQUEST_GUIDANCE}`,
      inputSchema: requestFields,
      annotations: READ_ONLY,
      _meta: appsMeta('Searching listings…', 'Search complete'),
    },
    ({ limit, ...input }) => respond(async () => searchText(await searchListings(ctx, input, { limit }), false)),
  );

  server.registerTool(
    'create_buyer_request',
    {
      title: 'Save a buyer request',
      description: `Save what the buyer is looking for and get the best current matches immediately. The marketplace keeps matching new listings and puts them in the buyer's inbox.
Use this when the buyer wants ongoing alerts or when there are no great matches yet; use search_listings for a quick look.
${REQUEST_GUIDANCE}
Tell the buyer the request is saved and that new matches will show up in their marketplace inbox (and email digest, if enabled).`,
      inputSchema: {
        ...requestFields,
        neededBy: z.string().optional().describe('ISO date if the buyer has a deadline.'),
        notify: z.boolean().default(true).describe('Send new matches to the inbox / email digest.'),
        expiresInDays: z.number().int().min(1).max(180).optional().describe('Default 30.'),
      },
      annotations: WRITE,
      _meta: appsMeta('Saving your request and finding matches…', 'Request saved'),
    },
    ({ limit, ...input }) => respond(async () => searchText(await createBuyerRequest(ctx, input, { limit }), true)),
  );

  server.registerTool(
    'update_buyer_request',
    {
      title: 'Update a buyer request',
      description: `Change a saved request (budget, distance, preferences, …). Send only the fields that change. Matching re-runs and the fresh top matches are returned; present them as with create_buyer_request.`,
      inputSchema: {
        requestId: id('Request'),
        ...requestFields,
        rawText: requestFields.rawText.optional(),
        neededBy: z.string().optional(),
        notify: z.boolean().optional(),
        expiresInDays: z.number().int().min(1).max(180).optional(),
      },
      annotations: WRITE_IDEMPOTENT,
      _meta: appsMeta('Updating your request…', 'Request updated'),
    },
    ({ requestId, limit, ...patch }) => respond(async () => searchText(await updateBuyerRequest(ctx, requestId, patch, { limit }), true)),
  );

  server.registerTool(
    'set_buyer_request_status',
    {
      title: 'Pause, resume or close a request',
      description:
        'Pause or resume a saved request, cancel it, or mark it fulfilled (the buyer found what they needed, here or elsewhere). Paused/cancelled requests stop producing matches.',
      inputSchema: {
        requestId: id('Request'),
        action: z.enum(['pause', 'resume', 'cancel', 'fulfilled']),
        reason: z.string().max(500).optional(),
      },
      annotations: DESTRUCTIVE,
      _meta: appsMeta('Updating request…', 'Request updated'),
    },
    ({ requestId, action, reason }) =>
      respond(async () => {
        const r = await setBuyerRequestStatus(ctx, requestId, action, reason);
        return { text: `Request "${r.summary ?? r.rawText}" is now ${r.status}.`, data: { request: r } };
      }),
  );

  server.registerTool(
    'get_my_requests',
    {
      title: 'My saved requests',
      description: "List the buyer's saved requests with their match counts.",
      inputSchema: { status: z.array(z.enum(REQUEST_STATUSES)).optional().describe('Filter, default all.') },
      annotations: READ_ONLY,
      _meta: appsMeta('Loading your requests…', 'Requests loaded'),
    },
    ({ status }) =>
      respond(async () => {
        const rs = await getMyRequests(ctx, { status });
        return {
          text: rs.length ? lines(`${plural(rs.length, 'saved request')}:`, ...rs.map(requestLine)) : 'No saved requests yet.',
          data: { requests: rs },
        };
      }),
  );

  server.registerTool(
    'get_request_matches',
    {
      title: 'Matches for a saved request',
      description: `Saved matches for one of the buyer's requests, best/newest first. Items that are no longer available are excluded.
Present a short list with each explanation and its unverified points; label exceptions clearly.`,
      inputSchema: {
        requestId: id('Request'),
        includeDismissed: z.boolean().default(false),
        limit: z.number().int().min(1).max(50).default(10),
      },
      annotations: READ_ONLY,
      _meta: appsMeta('Loading matches…', 'Matches loaded'),
    },
    ({ requestId, includeDismissed, limit }) =>
      respond(async () => {
        const r = await getRequestMatches(ctx, requestId, { includeDismissed, limit });
        return {
          text: lines(
            `Matches for "${r.request.summary ?? r.request.rawText}":`,
            r.matches.length ? r.matches.map(matchLine).join('\n') : 'No current matches. New ones will appear in the inbox.',
          ),
          data: { ...r },
        };
      }),
  );

  server.registerTool(
    'give_match_feedback',
    {
      title: 'Feedback on a match',
      description: `Dismiss a match the buyer doesn't want (with the reason in their words, e.g. "too dark", "too far") so similar items rank lower for this request, or undo a dismissal. If the buyer IS interested, use express_interest instead.`,
      inputSchema: {
        matchId: id('Match'),
        action: z.enum(['dismiss', 'undo_dismiss']),
        reason: z.string().max(500).optional(),
      },
      annotations: WRITE_IDEMPOTENT,
      _meta: appsMeta('Saving feedback…', 'Feedback saved'),
    },
    ({ matchId, action, reason }) =>
      respond(async () => {
        const r = await giveMatchFeedback(ctx, matchId, { action, reason });
        return {
          text: lines(`Match ${r.status}.`, r.adjusted.length ? `Adjusted: ${r.adjusted.join('; ')}.` : null),
          data: { ...r },
        };
      }),
  );

  server.registerTool(
    'get_listing_details',
    {
      title: 'Listing details',
      description: `Full public details of a listing: description, attributes with their source, condition, approximate area and distance, photos and when availability was last confirmed.
Attributes tagged ai_inferred / ai_estimated are not verified: say "possibly" / "estimated". The exact address is never available; pickup is arranged by message after the seller accepts.`,
      inputSchema: { listingId: id('Listing') },
      annotations: READ_ONLY,
      _meta: appsMeta('Loading listing…', 'Listing loaded'),
    },
    ({ listingId }) =>
      respond(async () => {
        const u = await getUser(ctx.userId);
        const origin = u.defaultLat != null && u.defaultLng != null ? { lat: u.defaultLat, lng: u.defaultLng } : null;
        const l = await getPublicListing(listingId, origin);
        const unverified = Object.entries(l.attributes)
          .filter(([, a]) => a.source === 'ai_inferred' || a.source === 'ai_estimated')
          .map(([k]) => k);
        return {
          text: lines(
            publicListingLine(l),
            l.status !== 'active' ? `Status: ${l.status} (not currently available).` : null,
            l.description,
            unverified.length ? `Not confirmed by the seller: ${unverified.join(', ')}.` : null,
            l.availabilityConfirmedAt ? `Availability last confirmed ${l.availabilityConfirmedAt}.` : null,
          ),
          data: { listing: l },
        };
      }),
  );

  server.registerTool(
    'express_interest',
    {
      title: 'Express interest',
      description: `Tell the seller the buyer is interested in a listing, optionally with a question or message (e.g. "Are the legs solid wood? Could I pick up Saturday?").
Only call when the buyer clearly wants to contact the seller. No contact details are shared unless the buyer opts in (shareContact) and the seller accepts; replies arrive in the inbox.`,
      inputSchema: {
        listingId: id('Listing'),
        matchId: id('Match').optional().describe('The match id, if this came from a saved request.'),
        message: z.string().max(2000).optional(),
        shareContact: z.boolean().optional().describe('Buyer opts in to sharing their email once the seller accepts. Ask first.'),
      },
      annotations: WRITE,
      _meta: appsMeta('Contacting the seller…', 'Seller notified'),
    },
    (input) =>
      respond(async () => {
        const v = await expressInterest(ctx, input);
        return { text: lines('The seller has been notified of your interest.', conversationText(v)), data: { conversation: v } };
      }),
  );
}

function requestLine(r: BuyerRequestView): string {
  const budget = r.hardConstraints.maxPriceCents != null ? ` · ≤ ${formatPrice(r.hardConstraints.maxPriceCents, r.hardConstraints.currency ?? 'EUR')}` : '';
  return `- "${r.summary ?? r.rawText}" (${r.status})${budget} · ${plural(r.counts.suggested, 'match', 'matches')}, ${r.counts.interested} interested · id ${r.id}`;
}

function searchText(r: SearchResult, saved: boolean) {
  return {
    text: lines(
      saved && r.request ? `Request saved (id ${r.request.id}); new matches will appear in the inbox.` : null,
      r.matches.length
        ? `${plural(r.matches.length, 'match', 'matches')}:\n${r.matches.map(matchLine).join('\n')}`
        : 'No listings match all requirements right now.',
      r.nearMisses.length
        ? `Exceptions (outside the stated limits, shown because the buyer allowed some flexibility):\n${r.nearMisses.map(matchLine).join('\n')}`
        : null,
      r.notes.length ? `Notes: ${r.notes.join(' ')}` : null,
    ),
    data: { ...r },
  };
}
