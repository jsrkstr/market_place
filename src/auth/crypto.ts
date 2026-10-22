import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/** Opaque, URL-safe random secret (256 bits by default). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Six-digit numeric one-time code. */
export function randomDigits(length = 6): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String(randomInt(0, 10));
  return s;
}

/** Keyed HMAC-SHA256 hash used for everything we store (tokens, codes). Domain-separated by `purpose`. */
export function hmac(purpose: string, value: string): string {
  return createHmac('sha256', config.APP_SECRET).update(`${purpose}\0${value}`).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Client secrets are derived (HMAC of the client id) instead of stored, because the SDK's client
 * authentication compares `client.client_secret` in plain text. Only a hash is persisted for audit.
 */
export function deriveClientSecret(clientId: string): string {
  return hmac('client-secret', clientId);
}

/** Signs a JSON payload: base64url(json).signature */
export function sign(purpose: string, payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(purpose, body)}`;
}

/** Verifies and decodes a value produced by `sign`; returns null if tampered or malformed. */
export function verifySigned<T>(purpose: string, value: string | undefined): T | null {
  if (!value || typeof value !== 'string') return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!safeEqual(sig, hmac(purpose, body))) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}
