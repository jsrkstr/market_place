import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from 'drizzle-orm/pg-core';
import type {
  AllowExceptions,
  Attributes,
  AttributeValue,
  Condition,
  HardConstraints,
  InboxType,
  InterestStatus,
  ListingStatus,
  MatchStatus,
  MissingField,
  RequestStatus,
  ScoreBreakdown,
  SoftPreference,
} from '../domain/types.js';

const id = () => text('id').primaryKey();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();
const EMBEDDING_DIMS = 1536;

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  displayName: text('display_name'),
  defaultLat: doublePrecision('default_lat'),
  defaultLng: doublePrecision('default_lng'),
  defaultLocationLabel: text('default_location_label'),
  notifyEmail: boolean('notify_email').notNull().default(true),
  lastDigestAt: timestamp('last_digest_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Listings (inventory)
// ---------------------------------------------------------------------------
export const listings = pgTable(
  'listings',
  {
    id: id(),
    sellerId: text('seller_id')
      .notNull()
      .references(() => users.id),
    status: text('status').$type<ListingStatus>().notNull().default('draft'),
    rawText: text('raw_text'),
    title: text('title'),
    description: text('description'),
    /** Canonical taxonomy slug, e.g. "furniture/seating/dining-chair". */
    category: text('category'),
    attributes: jsonb('attributes').$type<Attributes>().notNull().default({}),
    priceCents: integer('price_cents'),
    currency: text('currency').notNull().default('EUR'),
    priceSource: text('price_source').$type<'seller' | 'ai_estimate'>(),
    priceEstimateLowCents: integer('price_estimate_low_cents'),
    priceEstimateHighCents: integer('price_estimate_high_cents'),
    condition: jsonb('condition').$type<AttributeValue<Condition>>(),
    /** Denormalised rank of condition.value for SQL filtering (CONDITION_RANK); null when unknown. */
    conditionRank: integer('condition_rank'),
    quantity: integer('quantity').notNull().default(1),
    /** Private: exact coordinates/address. Never returned to buyers. */
    exactLat: doublePrecision('exact_lat'),
    exactLng: doublePrecision('exact_lng'),
    exactAddress: text('exact_address'),
    /** Public: rounded (~500 m) coordinates and a human area label. */
    publicLat: doublePrecision('public_lat'),
    publicLng: doublePrecision('public_lng'),
    areaLabel: text('area_label'),
    pickupOptions: jsonb('pickup_options').$type<string[]>().notNull().default([]),
    completeness: real('completeness').notNull().default(0),
    missingFields: jsonb('missing_fields').$type<MissingField[]>().notNull().default([]),
    availabilityConfirmedAt: timestamp('availability_confirmed_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMS }),
    /** Hash of normalised content for duplicate detection per seller. */
    contentHash: text('content_hash'),
    idempotencyKey: text('idempotency_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('listings_seller_idx').on(t.sellerId),
    index('listings_status_category_idx').on(t.status, t.category),
    index('listings_geo_idx').on(t.exactLat, t.exactLng),
    index('listings_embedding_hnsw').using('hnsw', t.embedding.op('vector_cosine_ops')),
    uniqueIndex('listings_seller_idem_uq').on(t.sellerId, t.idempotencyKey),
  ],
);

export const listingImages = pgTable(
  'listing_images',
  {
    id: id(),
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    mimeType: text('mime_type').notNull(),
    source: text('source').$type<'chatgpt_file' | 'upload_link' | 'url'>().notNull(),
    aiCaption: text('ai_caption'),
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('listing_images_listing_idx').on(t.listingId)],
);

/** One-time tokens for the browser photo-upload fallback. */
export const uploadTokens = pgTable('upload_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  listingId: text('listing_id')
    .notNull()
    .references(() => listings.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Buyer requests (demand)
// ---------------------------------------------------------------------------
export const buyerRequests = pgTable(
  'buyer_requests',
  {
    id: id(),
    buyerId: text('buyer_id')
      .notNull()
      .references(() => users.id),
    status: text('status').$type<RequestStatus>().notNull().default('active'),
    rawText: text('raw_text').notNull(),
    /** Short normalised summary, e.g. "2 modern beige dining chairs, wooden legs". */
    summary: text('summary'),
    category: text('category'),
    hardConstraints: jsonb('hard_constraints').$type<HardConstraints>().notNull().default({}),
    softPreferences: jsonb('soft_preferences').$type<SoftPreference[]>().notNull().default([]),
    allowExceptions: jsonb('allow_exceptions').$type<AllowExceptions>().notNull().default({}),
    neededBy: timestamp('needed_by', { withTimezone: true }),
    notify: boolean('notify').notNull().default(true),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMS }),
    version: integer('version').notNull().default(1),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('requests_buyer_idx').on(t.buyerId),
    index('requests_status_category_idx').on(t.status, t.category),
    index('requests_embedding_hnsw').using('hnsw', t.embedding.op('vector_cosine_ops')),
  ],
);

// ---------------------------------------------------------------------------
// Matches (listing ↔ request relationships)
// ---------------------------------------------------------------------------
export const matches = pgTable(
  'matches',
  {
    id: id(),
    requestId: text('request_id')
      .notNull()
      .references(() => buyerRequests.id, { onDelete: 'cascade' }),
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    score: real('score').notNull(),
    breakdown: jsonb('breakdown').$type<ScoreBreakdown>().notNull(),
    explanation: text('explanation').notNull(),
    qualifies: boolean('qualifies').notNull(),
    nearMiss: boolean('near_miss').notNull().default(false),
    unknowns: jsonb('unknowns').$type<string[]>().notNull().default([]),
    status: text('status').$type<MatchStatus>().notNull().default('suggested'),
    dismissReason: text('dismiss_reason'),
    listingVersion: integer('listing_version').notNull(),
    requestVersion: integer('request_version').notNull(),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    seenAt: timestamp('seen_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('matches_request_listing_uq').on(t.requestId, t.listingId),
    index('matches_listing_idx').on(t.listingId),
    index('matches_request_status_idx').on(t.requestId, t.status),
  ],
);

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------
export const interests = pgTable(
  'interests',
  {
    id: id(),
    listingId: text('listing_id')
      .notNull()
      .references(() => listings.id, { onDelete: 'cascade' }),
    buyerId: text('buyer_id')
      .notNull()
      .references(() => users.id),
    sellerId: text('seller_id')
      .notNull()
      .references(() => users.id),
    matchId: text('match_id').references(() => matches.id, { onDelete: 'set null' }),
    status: text('status').$type<InterestStatus>().notNull().default('pending'),
    buyerContactShared: boolean('buyer_contact_shared').notNull().default(false),
    sellerContactShared: boolean('seller_contact_shared').notNull().default(false),
    respondedAt: timestamp('responded_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('interests_listing_buyer_uq').on(t.listingId, t.buyerId),
    index('interests_seller_idx').on(t.sellerId),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    interestId: text('interest_id')
      .notNull()
      .references(() => interests.id, { onDelete: 'cascade' }),
    senderId: text('sender_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('messages_interest_idx').on(t.interestId, t.createdAt)],
);

export const inboxItems = pgTable(
  'inbox_items',
  {
    id: id(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    type: text('type').$type<InboxType>().notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    /** Prevents duplicate notifications for the same underlying event. */
    dedupeKey: text('dedupe_key').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    emailedAt: timestamp('emailed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('inbox_dedupe_uq').on(t.userId, t.dedupeKey),
    index('inbox_user_unread_idx').on(t.userId, t.readAt),
  ],
);

/** Append-only event log for outcome measurement (listing → match → interest → connection → sale). */
export const events = pgTable(
  'events',
  {
    id: id(),
    type: text('type').notNull(),
    actorId: text('actor_id'),
    listingId: text('listing_id'),
    requestId: text('request_id'),
    matchId: text('match_id'),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('events_type_time_idx').on(t.type, t.createdAt)],
);

// ---------------------------------------------------------------------------
// OAuth 2.1 authorization server state
// ---------------------------------------------------------------------------
export const oauthClients = pgTable('oauth_clients', {
  clientId: text('client_id').primaryKey(),
  clientSecretHash: text('client_secret_hash'),
  clientName: text('client_name'),
  redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});

export const oauthAuthCodes = pgTable('oauth_auth_codes', {
  codeHash: text('code_hash').primaryKey(),
  clientId: text('client_id')
    .notNull()
    .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
  resource: text('resource'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

export const oauthTokens = pgTable(
  'oauth_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    kind: text('kind').$type<'access' | 'refresh'>().notNull(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    resource: text('resource'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('oauth_tokens_user_idx').on(t.userId)],
);

/** Email one-time login codes used by the OAuth authorize page. */
export const loginCodes = pgTable('login_codes', {
  id: id(),
  email: text('email').notNull(),
  codeHash: text('code_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------
export const geocodeCache = pgTable('geocode_cache', {
  query: text('query').primaryKey(),
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  label: text('label'),
  createdAt: createdAt(),
});

export type ListingRow = typeof listings.$inferSelect;
export type BuyerRequestRow = typeof buyerRequests.$inferSelect;
export type MatchRow = typeof matches.$inferSelect;
export type InterestRow = typeof interests.$inferSelect;
export type UserRow = typeof users.$inferSelect;
