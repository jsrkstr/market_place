import { config } from '../config.js';

const base = config.PUBLIC_BASE_URL.replace(/\/+$/, '');

export const ISSUER = base;
/** RFC 8707 resource identifier of the MCP endpoint. */
export const RESOURCE = `${base}/mcp`;
export const PROTECTED_RESOURCE_METADATA_URL = `${base}/.well-known/oauth-protected-resource`;

export const SUPPORTED_SCOPES = ['marketplace'];
export const DEFAULT_SCOPES = ['marketplace'];

export const ACCESS_TOKEN_TTL_S = 60 * 60;
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60;
export const AUTH_CODE_TTL_S = 10 * 60;
export const LOGIN_CODE_TTL_S = 10 * 60;
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
/** Max login codes sent to one email address per LOGIN_CODE_TTL_S window. */
export const LOGIN_CODE_MAX_SENDS = 5;
/** Lifetime of the signed pending-authorization blob carried through the login forms. */
export const PENDING_AUTH_TTL_S = 30 * 60;

export const isSecureBase = base.startsWith('https://');

/**
 * Normalises a requested RFC 8707 resource. We accept the MCP URL (with/without trailing slash) and the
 * bare origin, since this server hosts a single protected resource. Returns the canonical RESOURCE or null.
 */
export function canonicalResource(resource: string | URL | undefined): string | null | undefined {
  if (resource === undefined) return undefined;
  let u: URL;
  try {
    u = new URL(String(resource));
  } catch {
    return null;
  }
  const ours = new URL(RESOURCE);
  if (u.origin !== ours.origin || u.search) return null;
  const path = u.pathname.replace(/\/+$/, '');
  return path === '' || path === '/mcp' ? RESOURCE : null;
}

/** Redirect URI policy: https anywhere, or http on loopback (dev / MCP Inspector). */
export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}
