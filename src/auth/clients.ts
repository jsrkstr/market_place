import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  OAuthClientMetadataSchema,
  type OAuthClientInformationFull,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { assertPublicHost } from '../infra/netguard.js';
import { oauthClients } from '../db/schema.js';
import { isAllowedRedirectUri } from './constants.js';
import { deriveClientSecret } from './crypto.js';

type ClientRow = typeof oauthClients.$inferSelect;

const MAX_REDIRECT_URIS = 10;

function validateRedirectUris(uris: string[]): void {
  if (!uris.length) throw new InvalidClientMetadataError('redirect_uris is required');
  if (uris.length > MAX_REDIRECT_URIS) throw new InvalidClientMetadataError('Too many redirect_uris');
  for (const uri of uris) {
    if (uri.length > 2000 || !isAllowedRedirectUri(uri)) {
      throw new InvalidClientMetadataError(`redirect_uri must be https (or http://localhost): ${uri}`);
    }
  }
}

function isPublic(meta: Record<string, unknown>): boolean {
  return meta.token_endpoint_auth_method === 'none';
}

function rowToClient(row: ClientRow): OAuthClientInformationFull {
  const meta = row.metadata as Record<string, unknown>;
  const { client_secret: _s, client_id: _i, ...rest } = meta;
  const info: OAuthClientInformationFull = {
    ...(rest as Partial<OAuthClientInformationFull>),
    client_id: row.clientId,
    redirect_uris: row.redirectUris,
    client_name: row.clientName ?? undefined,
  };
  if (!isPublic(meta) && row.clientSecretHash) {
    info.client_secret = deriveClientSecret(row.clientId);
    info.client_secret_expires_at = 0;
  }
  return info;
}

// ---------------------------------------------------------------------------
// Client ID Metadata Documents (client_id is an https URL serving the client's metadata JSON).
// ---------------------------------------------------------------------------
const CIMD_TIMEOUT_MS = 5000;
const CIMD_MAX_BYTES = 64 * 1024;
const CIMD_TTL_MS = 10 * 60 * 1000;
const CIMD_CACHE_MAX = 500;

const cimdCache = new Map<string, { client: OAuthClientInformationFull; expires: number }>();

export function isCimdClientId(clientId: string): boolean {
  return clientId.startsWith('https://');
}

/** Validates the URL shape required for a CIMD client_id. */
function validCimdUrl(clientId: string): URL | null {
  if (clientId.length > 2000 || !URL.canParse(clientId)) return null;
  const u = new URL(clientId);
  if (u.protocol !== 'https:' || u.hash || u.username || u.password) return null;
  if (u.pathname === '/' || /(^|\/)\.\.?(\/|$)/.test(u.pathname)) return null;
  return u;
}

export type CimdFetcher = (url: URL) => Promise<unknown>;

async function defaultCimdFetcher(url: URL): Promise<unknown> {
  await assertPublicHost(url);
  const res = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!res.ok || !res.body) throw new Error(`CIMD fetch failed: ${res.status}`);
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > CIMD_MAX_BYTES) throw new Error('CIMD document too large');
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > CIMD_MAX_BYTES) {
      await reader.cancel();
      throw new Error('CIMD document too large');
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

let cimdFetcher: CimdFetcher = defaultCimdFetcher;

/** Test hook: replace how CIMD documents are fetched (null restores the default). Also clears the cache. */
export function setCimdFetcherForTesting(f: CimdFetcher | null): void {
  cimdFetcher = f ?? defaultCimdFetcher;
  cimdCache.clear();
}

const CimdDocumentSchema = OAuthClientMetadataSchema.extend({ client_id: z.string() });

async function resolveCimdClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
  const hit = cimdCache.get(clientId);
  if (hit && hit.expires > Date.now()) return hit.client;
  const url = validCimdUrl(clientId);
  if (!url) return undefined;

  let client: OAuthClientInformationFull | undefined;
  try {
    const doc = CimdDocumentSchema.parse(await cimdFetcher(url));
    if (doc.client_id !== clientId) throw new Error('client_id in document does not match its URL');
    const method = doc.token_endpoint_auth_method ?? 'none';
    if (method !== 'none') throw new Error('CIMD clients must be public (token_endpoint_auth_method=none)');
    validateRedirectUris(doc.redirect_uris);
    const metadata = { ...doc, token_endpoint_auth_method: 'none', cimd: true };
    await db
      .insert(oauthClients)
      .values({ clientId, clientName: doc.client_name ?? null, redirectUris: doc.redirect_uris, metadata })
      .onConflictDoUpdate({
        target: oauthClients.clientId,
        set: { clientName: doc.client_name ?? null, redirectUris: doc.redirect_uris, metadata },
      });
    client = { ...doc, token_endpoint_auth_method: 'none', client_id: clientId };
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') console.warn(`[auth] CIMD resolution failed for ${clientId}: ${(err as Error).message}`);
    return undefined;
  }
  if (cimdCache.size >= CIMD_CACHE_MAX) cimdCache.delete(cimdCache.keys().next().value!);
  cimdCache.set(clientId, { client, expires: Date.now() + CIMD_TTL_MS });
  return client;
}

/** Postgres-backed client store: dynamic registration (RFC 7591) + Client ID Metadata Documents. */
export class PgClientsStore implements OAuthRegisteredClientsStore {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    if (typeof clientId !== 'string' || !clientId || clientId.length > 2000) return undefined;
    if (isCimdClientId(clientId)) return resolveCimdClient(clientId);
    const [row] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId));
    return row ? rowToClient(row) : undefined;
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): Promise<OAuthClientInformationFull> {
    validateRedirectUris(client.redirect_uris);
    const method = client.token_endpoint_auth_method ?? 'client_secret_post';
    if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) {
      throw new InvalidClientMetadataError(`Unsupported token_endpoint_auth_method: ${method}`);
    }
    for (const g of client.grant_types ?? []) {
      if (g !== 'authorization_code' && g !== 'refresh_token') throw new InvalidClientMetadataError(`Unsupported grant_type: ${g}`);
    }
    const clientId = newId('cli');
    const isPublicClient = method === 'none';
    const secret = isPublicClient ? undefined : deriveClientSecret(clientId);
    const { client_secret: _s, client_secret_expires_at: _e, ...meta } = client;
    const metadata: Record<string, unknown> = {
      ...meta,
      token_endpoint_auth_method: method,
      grant_types: client.grant_types ?? ['authorization_code', 'refresh_token'],
      response_types: client.response_types ?? ['code'],
    };
    await db.insert(oauthClients).values({
      clientId,
      clientSecretHash: secret ? createHash('sha256').update(secret).digest('hex') : null,
      clientName: client.client_name?.slice(0, 200) ?? null,
      redirectUris: client.redirect_uris,
      metadata,
    });
    return {
      ...(metadata as Partial<OAuthClientInformationFull>),
      redirect_uris: client.redirect_uris,
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    };
  }
}
