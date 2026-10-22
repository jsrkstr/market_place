import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { db } from '../db/client.js';
import { oauthAuthCodes, oauthTokens } from '../db/schema.js';
import { PgClientsStore } from './clients.js';
import {
  ACCESS_TOKEN_TTL_S,
  AUTH_CODE_TTL_S,
  DEFAULT_SCOPES,
  REFRESH_TOKEN_TTL_S,
  SUPPORTED_SCOPES,
  canonicalResource,
} from './constants.js';
import { hmac, randomToken } from './crypto.js';
import { renderLoginStart } from './login.js';

const codeHash = (code: string) => hmac('auth-code', code);
const tokenHash = (token: string) => hmac('oauth-token', token);

/** Grants only scopes we know; an empty/unknown request falls back to the default scope set. */
export function grantScopes(requested: string[] | undefined): string[] {
  const known = (requested ?? []).filter((s) => SUPPORTED_SCOPES.includes(s));
  return known.length ? [...new Set(known)] : DEFAULT_SCOPES;
}

/** Validates an RFC 8707 resource parameter; throws invalid_target if it isn't ours. */
export function checkResource(resource: string | URL | undefined): string | null {
  const canon = canonicalResource(resource);
  if (canon === null) throw new InvalidTargetError('Unknown resource; expected this server\'s /mcp endpoint');
  return canon ?? null;
}

export interface IssueCodeInput {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string | null;
}

/** Creates a single-use authorization code (only its hash is stored). */
export async function issueAuthorizationCode(input: IssueCodeInput): Promise<string> {
  const code = randomToken();
  await db.insert(oauthAuthCodes).values({
    codeHash: codeHash(code),
    clientId: input.clientId,
    userId: input.userId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    scopes: input.scopes,
    resource: input.resource,
    expiresAt: new Date(Date.now() + AUTH_CODE_TTL_S * 1000),
  });
  return code;
}

async function issueTokens(clientId: string, userId: string, scopes: string[], resource: string | null): Promise<OAuthTokens> {
  const access = randomToken();
  const refresh = randomToken();
  const now = Date.now();
  await db.insert(oauthTokens).values([
    { tokenHash: tokenHash(access), kind: 'access', clientId, userId, scopes, resource, expiresAt: new Date(now + ACCESS_TOKEN_TTL_S * 1000) },
    { tokenHash: tokenHash(refresh), kind: 'refresh', clientId, userId, scopes, resource, expiresAt: new Date(now + REFRESH_TOKEN_TTL_S * 1000) },
  ]);
  return {
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_S,
    refresh_token: refresh,
    scope: scopes.join(' '),
  };
}

/** Revokes every live token a client holds for a user (used on code replay / refresh-token reuse). */
async function revokeGrant(clientId: string, userId: string): Promise<void> {
  await db
    .update(oauthTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(oauthTokens.clientId, clientId), eq(oauthTokens.userId, userId), isNull(oauthTokens.revokedAt)));
}

export interface AccessTokenInfo {
  userId: string;
  clientId: string;
  scopes: string[];
  resource: string | null;
  expiresAt: number;
}

export async function lookupAccessToken(token: string): Promise<AccessTokenInfo | null> {
  if (!token || token.length > 512) return null;
  const [row] = await db
    .select()
    .from(oauthTokens)
    .where(
      and(
        eq(oauthTokens.tokenHash, tokenHash(token)),
        eq(oauthTokens.kind, 'access'),
        isNull(oauthTokens.revokedAt),
        gt(oauthTokens.expiresAt, new Date()),
      ),
    );
  if (!row) return null;
  return {
    userId: row.userId,
    clientId: row.clientId,
    scopes: row.scopes,
    resource: row.resource,
    expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
  };
}

/** OAuthServerProvider backed by Postgres; the interactive login lives in ./login.ts. */
export class PgOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new PgClientsStore();

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const resource = checkResource(params.resource);
    renderLoginStart(res, {
      clientId: client.client_id,
      clientName: client.client_name,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: grantScopes(params.scopes),
      resource,
    });
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const [row] = await db.select().from(oauthAuthCodes).where(eq(oauthAuthCodes.codeHash, codeHash(authorizationCode)));
    if (!row || row.clientId !== client.client_id || row.expiresAt.getTime() <= Date.now()) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    if (row.usedAt) {
      // Replay of a used code: revoke what it produced (RFC 9700 §4.5).
      await revokeGrant(row.clientId, row.userId);
      throw new InvalidGrantError('Authorization code already used');
    }
    return row.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    // PKCE was verified by the SDK token handler against challengeForAuthorizationCode().
    const hash = codeHash(authorizationCode);
    const [row] = await db.select().from(oauthAuthCodes).where(eq(oauthAuthCodes.codeHash, hash));
    if (!row || row.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
    if (redirectUri !== undefined && redirectUri !== row.redirectUri) throw new InvalidGrantError('redirect_uri mismatch');
    const requested = checkResource(resource);
    if (requested && row.resource && requested !== row.resource) throw new InvalidTargetError('resource mismatch');

    // Atomically consume the code (single use).
    const [consumed] = await db
      .update(oauthAuthCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(oauthAuthCodes.codeHash, hash), isNull(oauthAuthCodes.usedAt), gt(oauthAuthCodes.expiresAt, new Date())))
      .returning();
    if (!consumed) throw new InvalidGrantError('Invalid or expired authorization code');

    return issueTokens(row.clientId, row.userId, row.scopes, row.resource ?? requested);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const hash = tokenHash(refreshToken);
    const [row] = await db
      .select()
      .from(oauthTokens)
      .where(and(eq(oauthTokens.tokenHash, hash), eq(oauthTokens.kind, 'refresh')));
    if (!row || row.clientId !== client.client_id) throw new InvalidGrantError('Invalid refresh token');
    if (row.revokedAt) {
      // Reuse of a rotated/revoked refresh token: treat the grant as compromised. With no family column
      // in the schema, the "family" is every token this client holds for this user.
      await revokeGrant(row.clientId, row.userId);
      throw new InvalidGrantError('Refresh token has been revoked');
    }
    if (row.expiresAt.getTime() <= Date.now()) throw new InvalidGrantError('Refresh token expired');

    let granted = row.scopes;
    if (scopes?.length) {
      if (!scopes.every((s) => row.scopes.includes(s))) throw new InvalidScopeError('Requested scope exceeds the original grant');
      granted = scopes;
    }
    const requested = checkResource(resource);
    if (requested && row.resource && requested !== row.resource) throw new InvalidTargetError('resource mismatch');

    // Rotate: revoke the presented token atomically so concurrent use can't mint two pairs.
    const [rotated] = await db
      .update(oauthTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(oauthTokens.tokenHash, hash), isNull(oauthTokens.revokedAt)))
      .returning({ tokenHash: oauthTokens.tokenHash });
    if (!rotated) throw new InvalidGrantError('Refresh token has been revoked');

    return issueTokens(row.clientId, row.userId, granted, row.resource ?? requested);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const info = await lookupAccessToken(token);
    if (!info) throw new InvalidTokenError('Invalid or expired access token');
    return {
      token,
      clientId: info.clientId,
      scopes: info.scopes,
      expiresAt: info.expiresAt,
      resource: info.resource ? new URL(info.resource) : undefined,
      extra: { userId: info.userId },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    // RFC 7009: only the owning client may revoke; unknown tokens are silently ignored.
    // Revoking a refresh token also revokes the grant's access tokens.
    const hash = tokenHash(request.token);
    const [row] = await db.select().from(oauthTokens).where(eq(oauthTokens.tokenHash, hash));
    if (!row || row.clientId !== client.client_id) return;
    if (row.kind === 'refresh') {
      await revokeGrant(row.clientId, row.userId);
    } else {
      await db.update(oauthTokens).set({ revokedAt: sql`coalesce(${oauthTokens.revokedAt}, now())` }).where(eq(oauthTokens.tokenHash, hash));
    }
  }
}
