/** Shared zod schemas, annotations, Apps SDK metadata and text formatters used by the tool modules. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ListingOwnerView, MatchView, PublicListingView, UserContext } from '../../domain/types.js';
import { CONDITIONS } from '../../domain/types.js';
import type { InterestView } from '../../domain/interactions.service.js';
import { formatPrice, formatRange, lines } from '../respond.js';

/** What every tool module receives: the MCP server and the authenticated caller. */
export interface ToolDeps {
  server: McpServer;
  ctx: UserContext;
}

// ---------------------------------------------------------------------------
// Annotations + Apps SDK metadata
// ---------------------------------------------------------------------------

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
export const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
export const WRITE_IDEMPOTENT: ToolAnnotations = { ...WRITE, idempotentHint: true };
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

/** OAuth requirement advertised to the Apps SDK (ChatGPT) so it prompts the user to sign in. */
export const SECURITY_SCHEMES = [{ type: 'oauth2', scopes: ['marketplace'] }];

/** Apps SDK tool metadata: status strings shown while/after the tool runs, plus auth requirements. */
export function appsMeta(invoking: string, invoked: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'openai/toolInvocation/invoking': invoking,
    'openai/toolInvocation/invoked': invoked,
    securitySchemes: SECURITY_SCHEMES,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Reusable input schemas
// ---------------------------------------------------------------------------

export const id = (what: string) => z.string().min(1).describe(`${what} id, exactly as returned by an earlier tool call.`);

export const sellerProvenance = z
  .enum(['seller_stated', 'ai_inferred', 'ai_estimated'])
  .describe(
    'Where this value came from: seller_stated = the seller said/wrote it; ai_inferred = you read it from a photo or context (e.g. colour, likely brand); ai_estimated = your guess of a number (e.g. dimensions, age).',
  );

export const confidence = z.number().min(0).max(1).optional().describe('Your confidence 0..1. Required in spirit for ai_* values.');

export const attributeValue = z.object({
  value: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
    .describe('The value. Use arrays for colour/material/style (e.g. ["white"]); numbers for *_cm and age_years.'),
  source: sellerProvenance,
  confidence,
});

export const attributes = z
  .record(z.string(), attributeValue)
  .describe(
    'Product attributes keyed by name. Common keys: brand, model, colour, material, style, width_cm, depth_cm, height_cm, seat_height_cm, age_years, legs_material, seat_material, features. Only include values you actually know or can see; omit unknowns.',
  );

export const conditionInput = z
  .object({ value: z.enum(CONDITIONS), source: sellerProvenance, confidence })
  .describe('Condition on the scale new > like_new > good > fair > poor, with provenance.');

export const sellerLocation = z
  .object({
    text: z.string().optional().describe('Rough pickup area as the seller said it, e.g. "Paris 11e", "near Bastille", "75011".'),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    exactAddress: z
      .string()
      .optional()
      .describe('Only if the seller volunteers it. Stored privately and never shown to buyers. Never ask for it.'),
  })
  .describe('Pickup area. Only an approximate area is ever shown to buyers.');

export const buyerLocation = z
  .object({
    text: z.string().optional().describe('Area to collect from, e.g. "Paris 12e", "Montreuil". Never an exact address.'),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  })
  .describe("Where the buyer can collect from. Omit to use the buyer's saved default location.");

export const priceEstimate = z
  .object({ lowCents: z.number().int().nonnegative(), highCents: z.number().int().nonnegative() })
  .describe('Your own estimated price range in minor units (cents). Always treated and shown as an estimate.');

// ---------------------------------------------------------------------------
// Text formatters (summaries only; structuredContent carries the full data)
// ---------------------------------------------------------------------------

export function listingLine(l: ListingOwnerView): string {
  const price = l.priceCents != null ? formatPrice(l.priceCents, l.currency) : estimateText(l);
  const area = l.areaLabel ? ` · ${l.areaLabel}` : '';
  return `- ${l.title ?? 'Untitled item'} (${l.status}) · ${price}${area} · id ${l.id}`;
}

function estimateText(l: ListingOwnerView): string {
  const r = formatRange(l.priceEstimate?.lowCents, l.priceEstimate?.highCents, l.currency);
  return r ? `no asking price (estimated ${r})` : 'no asking price';
}

export function publicListingLine(l: PublicListingView): string {
  const parts = [l.title ?? 'Untitled item', formatPrice(l.priceCents, l.currency)];
  if (l.priceSource === 'ai_estimate') parts[1] += ' (estimated)';
  if (l.approxDistanceKm != null) parts.push(`~${l.approxDistanceKm} km away`);
  else if (l.areaLabel) parts.push(l.areaLabel);
  return parts.join(' · ');
}

export function matchLine(m: MatchView, i: number): string {
  const label = m.nearMiss ? '[EXCEPTION - outside your limits] ' : '';
  const unknowns = m.unknowns.length ? `\n   Unverified: ${m.unknowns.join(', ')}` : '';
  const ref = m.matchId ? `match ${m.matchId}, listing ${m.listing.id}` : `listing ${m.listing.id}`;
  return `${i + 1}. ${label}${publicListingLine(m.listing)}\n   ${m.explanation}${unknowns}\n   (${ref})`;
}

export function missingFieldsHint(fields: { field: string; reason: string }[], max = 2): string | null {
  if (!fields.length) return null;
  return `Most useful to add: ${fields
    .slice(0, max)
    .map((f) => `${f.field} (${f.reason.replace(/[.\s]+$/, '')})`)
    .join('; ')}.`;
}

export function conversationText(v: InterestView): string {
  const last = v.messages.slice(-5).map((m) => `  ${m.from === 'me' ? 'You' : v.role === 'seller' ? 'Buyer' : 'Seller'}: ${m.body}`);
  return lines(
    `Conversation about "${v.listingTitle ?? v.listingId}" (you are the ${v.role}) · status: ${v.status} · id ${v.interestId}`,
    v.counterpartContact
      ? `Contact shared by both sides: ${v.counterpartContact.displayName ?? ''} <${v.counterpartContact.email}>`.replace('  ', ' ')
      : 'Contact details are not shared (both sides must opt in after the seller accepts); messages are relayed.',
    last.length ? 'Recent messages:' : 'No messages yet.',
    ...last,
  );
}
