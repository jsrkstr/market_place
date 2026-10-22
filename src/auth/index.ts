/**
 * OAuth 2.1 authorization server + resource-server token validation for the Marketplace MCP endpoint.
 *
 * Endpoints mounted by `mountAuth(app)` (call it BEFORE mounting /mcp and before any global error/404 handler):
 *   GET  /.well-known/oauth-protected-resource[/mcp]    RFC 9728 (resource = PUBLIC_BASE_URL/mcp)
 *   GET  /.well-known/oauth-authorization-server[/mcp]  RFC 8414
 *   GET  /.well-known/openid-configuration[/mcp]        same document (some clients probe it)
 *   POST /register                                      RFC 7591 dynamic client registration
 *   GET  /authorize                                     PKCE S256 required; renders email/OTP login page
 *   POST /oauth/login/{email,verify,restart,cancel}     login form posts (signed txn + CSRF cookie)
 *   POST /token                                         authorization_code + refresh_token (rotation)
 *   POST /revoke                                        RFC 7009
 * Client ID Metadata Documents are supported: a client_id that is an https URL is fetched and validated.
 *
 * Wiring /mcp — pick ONE of:
 *
 *   // (a) SDK-style middleware: sets req.auth (SDK AuthInfo) and answers 401 with WWW-Authenticate.
 *   //     The SDK transport forwards req.auth to tool handlers as `extra.authInfo`;
 *   //     read the user with `extra.authInfo?.extra?.userId as string`.
 *   import { bearerMiddleware, mountAuth } from './auth/index.js';
 *   mountAuth(app);
 *   app.post('/mcp', bearerMiddleware(), (req, res) => transport.handleRequest(req, res, req.body));
 *
 *   // (b) Manual:
 *   const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
 *   const principal = token ? await authenticateBearer(token) : null;
 *   if (!principal) return res.status(401).set('WWW-Authenticate', wwwAuthenticateHeader()).json({ error: 'invalid_token' });
 *
 * Note: express-rate-limit (used by the SDK handlers) keys on req.ip; behind a reverse proxy set
 * `app.set('trust proxy', 1)` so limits are per client rather than per proxy.
 */
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { metadataHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/metadata.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthMetadata, OAuthProtectedResourceMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { config } from '../config.js';
import { findOrCreateUserByEmail } from '../domain/users.service.js';
import { ISSUER, PROTECTED_RESOURCE_METADATA_URL, RESOURCE, SUPPORTED_SCOPES, DEFAULT_SCOPES } from './constants.js';
import { LOGIN_PATH, loginRouter } from './login.js';
import { PgOAuthProvider, lookupAccessToken } from './provider.js';

export interface AuthenticatedPrincipal {
  userId: string;
  clientId: string;
  scopes: string[];
  /** Unix seconds. */
  expiresAt: number;
}

export { setCimdFetcherForTesting } from './clients.js';

const provider = new PgOAuthProvider();
const AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'];

export const authorizationServerMetadata: OAuthMetadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  registration_endpoint: `${ISSUER}/register`,
  revocation_endpoint: `${ISSUER}/revoke`,
  response_types_supported: ['code'],
  response_modes_supported: ['query'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: AUTH_METHODS,
  revocation_endpoint_auth_methods_supported: AUTH_METHODS,
  scopes_supported: SUPPORTED_SCOPES,
  authorization_response_iss_parameter_supported: true,
  client_id_metadata_document_supported: true,
};

export const protectedResourceMetadata: OAuthProtectedResourceMetadata = {
  resource: RESOURCE,
  authorization_servers: [ISSUER],
  scopes_supported: SUPPORTED_SCOPES,
  bearer_methods_supported: ['header'],
  resource_name: 'Marketplace',
};

/** Accept client_secret_basic by copying HTTP Basic credentials into the body (the SDK reads the body only). */
const basicClientAuth: RequestHandler[] = [
  express.urlencoded({ extended: false, limit: '16kb' }),
  (req: Request, _res: Response, next: NextFunction) => {
    const m = req.headers.authorization?.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
    if (m) {
      const decoded = Buffer.from(m[1], 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i > 0) {
        const body = (req.body ??= {}) as Record<string, unknown>;
        try {
          body.client_id ??= decodeURIComponent(decoded.slice(0, i));
          body.client_secret ??= decodeURIComponent(decoded.slice(i + 1));
        } catch {
          /* malformed escapes: let client auth fail normally */
        }
      }
    }
    next();
  },
];

/** Mounts OAuth 2.1 discovery, registration, authorize/login, token and revoke routes on the app. */
export function mountAuth(app: Express): void {
  if (config.NODE_ENV === 'production' && config.devTokens.size) {
    console.warn('[auth] DEV_AUTH_TOKENS is set in production; they are ignored.');
  }

  const prm = metadataHandler(protectedResourceMetadata);
  app.use('/.well-known/oauth-protected-resource/mcp', prm);
  app.use('/.well-known/oauth-protected-resource', prm);
  const asm = metadataHandler(authorizationServerMetadata);
  for (const p of [
    '/.well-known/oauth-authorization-server/mcp',
    '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration/mcp',
    '/.well-known/openid-configuration',
  ]) {
    app.use(p, asm);
  }

  app.use('/register', clientRegistrationHandler({
    clientsStore: provider.clientsStore,
    clientSecretExpirySeconds: 0,
    // ChatGPT registers from a shared pool of egress IPs; keep the per-IP limit generous.
    rateLimit: { windowMs: 60 * 60 * 1000, max: 500 },
  }));
  app.use('/authorize', authorizationHandler({ provider, rateLimit: { max: 300 } }));
  app.use(LOGIN_PATH, loginRouter());
  app.use('/token', ...basicClientAuth, tokenHandler({ provider, rateLimit: { max: 600 } }));
  app.use('/revoke', ...basicClientAuth, revocationHandler({ provider, rateLimit: { max: 300 } }));
}

/** Validates an access token (OAuth-issued or DEV_AUTH_TOKENS). Returns null if invalid/expired. */
export async function authenticateBearer(token: string): Promise<AuthenticatedPrincipal | null> {
  if (!token) return null;
  // Static dev tokens are a local-testing convenience only; never honoured in production.
  const devEmail = config.NODE_ENV === 'production' ? undefined : config.devTokens.get(token);
  if (devEmail) {
    const user = await findOrCreateUserByEmail(devEmail);
    return { userId: user.id, clientId: 'dev', scopes: DEFAULT_SCOPES, expiresAt: Math.floor(Date.now() / 1000) + 365 * 24 * 3600 };
  }
  const info = await lookupAccessToken(token);
  if (!info) return null;
  if (info.resource && info.resource !== RESOURCE) return null;
  return { userId: info.userId, clientId: info.clientId, scopes: info.scopes, expiresAt: info.expiresAt };
}

/** Value for the WWW-Authenticate header on 401s from /mcp (points at protected-resource metadata). */
export function wwwAuthenticateHeader(): string {
  return `Bearer resource_metadata="${PROTECTED_RESOURCE_METADATA_URL}"`;
}

/** Converts a validated token into the SDK's AuthInfo shape (`extra.userId` carries our user id). */
export async function verifyAccessToken(token: string): Promise<AuthInfo> {
  const p = await authenticateBearer(token);
  if (!p) throw new InvalidTokenError('Invalid or expired access token');
  return { token, clientId: p.clientId, scopes: p.scopes, expiresAt: p.expiresAt, extra: { userId: p.userId } };
}

/**
 * Express middleware for /mcp built on the SDK's requireBearerAuth: sets `req.auth` (AuthInfo with
 * `extra.userId`) or responds 401 with `WWW-Authenticate: Bearer error=..., resource_metadata="..."`.
 */
export function bearerMiddleware(): RequestHandler {
  return requireBearerAuth({ verifier: { verifyAccessToken }, resourceMetadataUrl: PROTECTED_RESOURCE_METADATA_URL });
}
