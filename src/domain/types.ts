/**
 * Shared domain types. These are interface-independent: nothing here knows about MCP or ChatGPT.
 */

/** Where a piece of information came from. Never present ai_* values as verified facts. */
export type Provenance = 'seller_stated' | 'buyer_stated' | 'ai_inferred' | 'ai_estimated' | 'system';

export interface AttributeValue<T = unknown> {
  value: T;
  source: Provenance;
  /** 0..1, mostly meaningful for ai_* sources. */
  confidence?: number;
}

/**
 * Free-form product attributes keyed by canonical attribute name.
 * Well-known keys: brand, model, colour, material, style, width_cm, depth_cm, height_cm,
 * age_years, legs_material, seat_material, features, ...
 * `colour`/`material`/`style` values are string arrays after normalisation.
 */
export type Attributes = Record<string, AttributeValue>;

export const LISTING_STATUSES = ['draft', 'active', 'paused', 'sold', 'withdrawn', 'expired'] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export const REQUEST_STATUSES = ['active', 'paused', 'fulfilled', 'cancelled', 'expired'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const MATCH_STATUSES = ['suggested', 'seen', 'interested', 'dismissed', 'connected', 'stale', 'closed'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

/** Ordered worst → best is NOT the order here; use CONDITION_RANK. */
export const CONDITIONS = ['new', 'like_new', 'good', 'fair', 'poor'] as const;
export type Condition = (typeof CONDITIONS)[number];
export const CONDITION_RANK: Record<Condition, number> = { poor: 0, fair: 1, good: 2, like_new: 3, new: 4 };

export const INTEREST_STATUSES = ['pending', 'accepted', 'declined', 'withdrawn'] as const;
export type InterestStatus = (typeof INTEREST_STATUSES)[number];

export const INBOX_TYPES = [
  'new_match', // buyer: a new qualifying listing for a saved request
  'buyer_interest', // seller: a buyer explicitly expressed interest (confirmed demand)
  'possible_demand', // seller: active requests *possibly* match; more info would help (NOT confirmed interest)
  'info_request', // seller: a buyer asked a question about a listing
  'availability_check', // seller: please confirm the item is still available
  'listing_unavailable', // buyer: an item they matched/interested in is no longer available
  'interest_response', // buyer: seller accepted/declined their interest
  'new_message', // either: new relayed message
  'request_expiring', // buyer: saved request about to expire
] as const;
export type InboxType = (typeof INBOX_TYPES)[number];

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface LocationInput {
  /** Free text such as "Paris 11e", "near Gare de Lyon", "75011". Geocoded server-side. */
  text?: string;
  lat?: number;
  lng?: number;
  /** Seller's exact address. Stored privately, never shown to buyers. */
  exactAddress?: string;
}

export interface DimensionBounds {
  widthCm?: number;
  depthCm?: number;
  heightCm?: number;
}

export interface HardConstraints {
  maxPriceCents?: number;
  minPriceCents?: number;
  currency?: string;
  maxDistanceKm?: number;
  /** Search origin. Resolved from LocationInput at write time. */
  origin?: GeoPoint & { label?: string };
  minCondition?: Condition;
  /** Number of identical units needed (e.g. 2 chairs). */
  quantity?: number;
  maxDimensionsCm?: DimensionBounds;
  minDimensionsCm?: DimensionBounds;
  /** Must-have attribute values, e.g. { attribute: 'colour', values: ['white'] }. Unknown values → "unverified". */
  requiredAttributes?: { attribute: string; values: string[] }[];
  /** Must-not-have values, e.g. { attribute: 'material', values: ['plastic'] }. */
  excludedAttributes?: { attribute: string; values: string[] }[];
}

export interface SoftPreference {
  attribute: string;
  values: string[];
  /** 0..1, default 0.5. */
  weight: number;
}

/** Exceptions the buyer explicitly allowed. Without these, hard constraints are strict. */
export interface AllowExceptions {
  /** e.g. 10 → items up to 10% over budget may be shown as labelled near-misses. */
  budgetPct?: number;
  /** extra km beyond maxDistanceKm. */
  distanceKm?: number;
}

export interface UserContext {
  userId: string;
}

export interface MissingField {
  field: string;
  /** Why this would help, phrased for the seller. */
  reason: string;
  /** 0..1, higher = more valuable to provide. */
  value: number;
}

export interface PriceGuidance {
  currency: string;
  lowCents: number | null;
  highCents: number | null;
  /** 'marketplace_comparables' when computed from our inventory; 'ai_estimate' when only the model's estimate exists. */
  basis: 'marketplace_comparables' | 'ai_estimate' | 'insufficient_data';
  comparableCount: number;
  note: string;
}

/** Listing as seen by its owner (full detail incl. private fields). */
export interface ListingOwnerView {
  id: string;
  status: ListingStatus;
  title: string | null;
  description: string | null;
  category: string | null;
  attributes: Attributes;
  priceCents: number | null;
  currency: string;
  priceSource: 'seller' | 'ai_estimate' | null;
  priceEstimate: { lowCents: number | null; highCents: number | null } | null;
  condition: AttributeValue<Condition> | null;
  quantity: number;
  areaLabel: string | null;
  hasExactAddress: boolean;
  pickupOptions: string[];
  images: { id: string; url: string }[];
  completeness: number;
  missingFields: MissingField[];
  availabilityConfirmedAt: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}

/** Listing as seen by buyers. Never includes exact location, address, or seller contact. */
export interface PublicListingView {
  id: string;
  status: ListingStatus;
  title: string | null;
  description: string | null;
  category: string | null;
  attributes: Attributes;
  priceCents: number | null;
  currency: string;
  priceSource: 'seller' | 'ai_estimate' | null;
  condition: AttributeValue<Condition> | null;
  quantity: number;
  areaLabel: string | null;
  /** Rounded distance from the viewer's origin, if known. */
  approxDistanceKm: number | null;
  pickupOptions: string[];
  images: { id: string; url: string }[];
  availabilityConfirmedAt: string | null;
  listedAt: string;
}

export interface ScoreBreakdown {
  semantic: number;
  attributeFit: number;
  distance: number;
  price: number;
  completeness: number;
  freshness: number;
  feedbackPenalty: number;
  /** Per-preference details used to build explanations. */
  preferenceHits: { attribute: string; wanted: string[]; found: string[] | null; matched: boolean }[];
  /** Hard constraints that were checked; value null = unknown on the listing. */
  constraintChecks: { constraint: string; ok: boolean | null; detail: string }[];
}

export interface MatchView {
  matchId: string | null; // null for ephemeral searches
  listing: PublicListingView;
  score: number;
  qualifies: boolean;
  /** Labelled near-miss: violates a constraint the buyer allowed exceptions for. */
  nearMiss: boolean;
  explanation: string;
  unknowns: string[];
  status: MatchStatus | null;
}
