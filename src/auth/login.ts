/**
 * Interactive part of /authorize: a server-rendered email + one-time-code login.
 *
 * The validated authorization request is carried between the two form posts as an HMAC-signed blob
 * ("txn"). The blob embeds a random nonce that must equal an HttpOnly SameSite=Lax cookie set when the
 * page was first rendered (double-submit CSRF protection, also binding the flow to this browser).
 */
import express, { type Request, type Response, type Router } from 'express';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import * as z from 'zod';
import { db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { loginCodes } from '../db/schema.js';
import { findOrCreateUserByEmail } from '../domain/users.service.js';
import { getMailer } from '../infra/mailer.js';
import {
  ISSUER,
  LOGIN_CODE_MAX_ATTEMPTS,
  LOGIN_CODE_MAX_SENDS,
  LOGIN_CODE_TTL_S,
  PENDING_AUTH_TTL_S,
  isSecureBase,
} from './constants.js';
import { hmac, randomDigits, randomToken, safeEqual, sign, verifySigned } from './crypto.js';
import { issueAuthorizationCode } from './provider.js';

export const LOGIN_PATH = '/oauth/login';
const CSRF_COOKIE = 'mp_oauth_csrf';
const TXN_PURPOSE = 'oauth-pending-auth';

export interface PendingAuth {
  clientId: string;
  clientName?: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource: string | null;
}

interface Txn {
  p: PendingAuth;
  /** CSRF nonce; must equal the cookie. */
  x: string;
  /** Expiry, unix ms. */
  exp: number;
  /** Set after the email step. */
  em?: string;
  lc?: string;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------
export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"'`=]/g, (c) => `&#${c.charCodeAt(0)};`);
}

const CSS = `
*{box-sizing:border-box}body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#f5f5f4;color:#1c1917;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
.card{background:#fff;width:100%;max-width:400px;border-radius:14px;box-shadow:0 1px 3px rgba(0,0,0,.08),0 8px 24px rgba(0,0,0,.06);padding:28px 24px}
h1{font-size:20px;margin:0 0 8px}p{margin:0 0 16px;color:#57534e;font-size:15px}
label{display:block;font-weight:600;font-size:14px;margin-bottom:6px}
input{width:100%;padding:12px;font-size:16px;border:1px solid #d6d3d1;border-radius:8px;margin-bottom:14px}
input:focus{outline:2px solid #2563eb;border-color:transparent}
input.code{letter-spacing:.4em;text-align:center;font-size:22px;font-variant-numeric:tabular-nums}
button{width:100%;padding:12px;font-size:16px;font-weight:600;border:0;border-radius:8px;background:#1c1917;color:#fff;cursor:pointer}
button.link{background:none;color:#57534e;font-weight:400;font-size:14px;padding:8px;text-decoration:underline}
.err{background:#fef2f2;color:#991b1b;border-radius:8px;padding:10px 12px;font-size:14px;margin-bottom:14px}
.muted{font-size:13px;color:#78716c;margin-top:16px}.row{display:flex;gap:8px}.row form{flex:1}
`;

function page(res: Response, status: number, title: string, body: string): void {
  res
    .status(status)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    })
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>${escapeHtml(title)}</title><style>${CSS}</style></head><body><main class="card">${body}</main></body></html>`,
    );
}

function appName(p: PendingAuth): string {
  return p.clientName?.trim() || 'ChatGPT';
}

function redirectHost(p: PendingAuth): string {
  try {
    return new URL(p.redirectUri).host;
  } catch {
    return '';
  }
}

function cancelForm(txn: string): string {
  return `<form method="post" action="${LOGIN_PATH}/cancel"><input type="hidden" name="txn" value="${escapeHtml(txn)}"><button class="link" type="submit">Cancel</button></form>`;
}

function emailPage(res: Response, txn: Txn, opts: { error?: string; email?: string; status?: number } = {}): void {
  const signed = sign(TXN_PURPOSE, txn);
  const name = escapeHtml(appName(txn.p));
  page(
    res,
    opts.status ?? 200,
    'Sign in to Marketplace',
    `<h1>Sign in to Marketplace</h1>
<p>Sign in to Marketplace to let ${name} manage your listings and requests. We'll email you a 6-digit code.</p>
${opts.error ? `<div class="err" role="alert">${escapeHtml(opts.error)}</div>` : ''}
<form method="post" action="${LOGIN_PATH}/email">
<input type="hidden" name="txn" value="${escapeHtml(signed)}">
<label for="email">Email address</label>
<input id="email" name="email" type="email" autocomplete="email" inputmode="email" required autofocus value="${escapeHtml(opts.email ?? '')}">
<button type="submit">Email me a code</button>
</form>
${cancelForm(signed)}
<p class="muted">After signing in you'll be returned to ${escapeHtml(redirectHost(txn.p))}.</p>`,
  );
}

function codePage(res: Response, txn: Txn, opts: { error?: string; status?: number } = {}): void {
  const signed = sign(TXN_PURPOSE, txn);
  page(
    res,
    opts.status ?? 200,
    'Enter your code',
    `<h1>Check your email</h1>
<p>We sent a 6-digit code to <strong>${escapeHtml(txn.em)}</strong>. It expires in ${LOGIN_CODE_TTL_S / 60} minutes.</p>
${opts.error ? `<div class="err" role="alert">${escapeHtml(opts.error)}</div>` : ''}
<form method="post" action="${LOGIN_PATH}/verify">
<input type="hidden" name="txn" value="${escapeHtml(signed)}">
<label for="code">Sign-in code</label>
<input id="code" class="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="8" required autofocus>
<button type="submit">Sign in</button>
</form>
<div class="row">
<form method="post" action="${LOGIN_PATH}/email"><input type="hidden" name="txn" value="${escapeHtml(signed)}"><input type="hidden" name="email" value="${escapeHtml(txn.em)}"><button class="link" type="submit">Send a new code</button></form>
<form method="post" action="${LOGIN_PATH}/restart"><input type="hidden" name="txn" value="${escapeHtml(signed)}"><button class="link" type="submit">Use a different email</button></form>
</div>
${cancelForm(signed)}`,
  );
}

function expiredPage(res: Response): void {
  page(
    res,
    400,
    'Sign-in expired',
    `<h1>This sign-in session has expired</h1><p>Please go back to ChatGPT and connect Marketplace again.</p>`,
  );
}

// ---------------------------------------------------------------------------
// CSRF cookie
// ---------------------------------------------------------------------------
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

function ensureCsrfCookie(req: Request, res: Response): string {
  const existing = readCookie(req, CSRF_COOKIE);
  const value = existing && /^[A-Za-z0-9_-]{32,64}$/.test(existing) ? existing : randomToken(24);
  res.append(
    'Set-Cookie',
    `${CSRF_COOKIE}=${value}; Path=${LOGIN_PATH}; HttpOnly; SameSite=Lax; Max-Age=${PENDING_AUTH_TTL_S}${isSecureBase ? '; Secure' : ''}`,
  );
  return value;
}

/** Called by the provider once the SDK has validated client, redirect_uri, PKCE and resource. */
export function renderLoginStart(res: Response, p: PendingAuth): void {
  const x = ensureCsrfCookie(res.req, res);
  emailPage(res, { p, x, exp: Date.now() + PENDING_AUTH_TTL_S * 1000 });
}

function readTxn(req: Request): Txn | null {
  const txn = verifySigned<Txn>(TXN_PURPOSE, typeof req.body?.txn === 'string' ? req.body.txn : undefined);
  if (!txn || typeof txn.exp !== 'number' || txn.exp < Date.now()) return null;
  const cookie = readCookie(req, CSRF_COOKIE);
  if (!cookie || !safeEqual(cookie, txn.x)) return null;
  return txn;
}

function redirectWith(res: Response, p: PendingAuth, params: Record<string, string>): void {
  const url = new URL(p.redirectUri);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (p.state !== undefined) url.searchParams.set('state', p.state);
  url.searchParams.set('iss', ISSUER);
  res.set('Cache-Control', 'no-store').redirect(302, url.href);
}

const loginCodeHash = (id: string, code: string) => hmac('login-code', `${id}:${code}`);
const EmailSchema = z.email().max(254);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function loginRouter(): Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '16kb' }));

  router.post('/email', async (req, res) => {
    const txn = readTxn(req);
    if (!txn) return expiredPage(res);
    const base: Txn = { p: txn.p, x: txn.x, exp: txn.exp };
    const raw = typeof req.body.email === 'string' ? req.body.email.trim() : '';
    const parsed = EmailSchema.safeParse(raw);
    if (!parsed.success) return emailPage(res, base, { error: 'Please enter a valid email address.', email: raw, status: 400 });
    const email = parsed.data.toLowerCase();

    const since = new Date(Date.now() - LOGIN_CODE_TTL_S * 1000);
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(loginCodes)
      .where(and(eq(loginCodes.email, email), gt(loginCodes.createdAt, since)));
    if (n >= LOGIN_CODE_MAX_SENDS) {
      return emailPage(res, base, { error: 'Too many codes requested for this email. Please wait a few minutes and try again.', email, status: 429 });
    }

    const id = newId('lgc');
    const code = randomDigits(6);
    await db.insert(loginCodes).values({
      id,
      email,
      codeHash: loginCodeHash(id, code),
      expiresAt: new Date(Date.now() + LOGIN_CODE_TTL_S * 1000),
    });
    try {
      await getMailer().send({
        to: email,
        subject: `Your Marketplace sign-in code: ${code}`,
        text:
          `Your Marketplace sign-in code is ${code}\n\n` +
          `It expires in ${LOGIN_CODE_TTL_S / 60} minutes. If you didn't try to connect Marketplace to ${appName(txn.p)}, you can ignore this email.`,
      });
    } catch (err) {
      console.error('[auth] failed to send login code', err);
      return emailPage(res, base, { error: "We couldn't send the email. Please try again.", email, status: 502 });
    }
    codePage(res, { ...base, em: email, lc: id });
  });

  router.post('/verify', async (req, res) => {
    const txn = readTxn(req);
    if (!txn) return expiredPage(res);
    if (!txn.em || !txn.lc) return emailPage(res, { p: txn.p, x: txn.x, exp: txn.exp });
    const code = String(req.body.code ?? '').replace(/\D/g, '');

    // Count the attempt atomically before checking, so parallel guesses can't exceed the limit.
    const [row] = await db
      .update(loginCodes)
      .set({ attempts: sql`${loginCodes.attempts} + 1` })
      .where(
        and(
          eq(loginCodes.id, txn.lc),
          eq(loginCodes.email, txn.em),
          isNull(loginCodes.usedAt),
          gt(loginCodes.expiresAt, new Date()),
          lt(loginCodes.attempts, LOGIN_CODE_MAX_ATTEMPTS),
        ),
      )
      .returning();
    if (!row) {
      return codePage(res, txn, { error: 'This code has expired or had too many attempts. Request a new code.', status: 400 });
    }
    if (code.length !== 6 || !safeEqual(row.codeHash, loginCodeHash(row.id, code))) {
      const left = LOGIN_CODE_MAX_ATTEMPTS - row.attempts;
      return codePage(res, txn, {
        error: left > 0 ? `That code isn't right. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many attempts. Request a new code.',
        status: 400,
      });
    }
    const [used] = await db
      .update(loginCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(loginCodes.id, row.id), isNull(loginCodes.usedAt)))
      .returning({ id: loginCodes.id });
    if (!used) return codePage(res, txn, { error: 'This code was already used. Request a new code.', status: 400 });

    const user = await findOrCreateUserByEmail(txn.em);
    const authCode = await issueAuthorizationCode({
      clientId: txn.p.clientId,
      userId: user.id,
      redirectUri: txn.p.redirectUri,
      codeChallenge: txn.p.codeChallenge,
      scopes: txn.p.scopes,
      resource: txn.p.resource,
    });
    redirectWith(res, txn.p, { code: authCode });
  });

  router.post('/restart', (req, res) => {
    const txn = readTxn(req);
    if (!txn) return expiredPage(res);
    emailPage(res, { p: txn.p, x: txn.x, exp: txn.exp });
  });

  router.post('/cancel', (req, res) => {
    const txn = readTxn(req);
    if (!txn) return expiredPage(res);
    redirectWith(res, txn.p, { error: 'access_denied', error_description: 'The user cancelled sign-in' });
  });

  return router;
}
