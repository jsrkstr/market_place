import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../src/db/client.js';
import { setMailerForTesting, type Mail } from '../../src/infra/mailer.js';
import {
  authenticateBearer,
  bearerMiddleware,
  mountAuth,
  setCimdFetcherForTesting,
  wwwAuthenticateHeader,
} from '../../src/auth/index.js';
import { resetDb, setupTestDb } from '../helpers/db.js';

const PUBLIC = 'http://localhost:3999';
const RESOURCE = `${PUBLIC}/mcp`;
const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';

let server: Server;
let base: string;
const sent: Mail[] = [];

const b64url = (b: Buffer) => b.toString('base64url');
function pkce() {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function decodeEntities(s: string): string {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
function txnOf(html: string): string {
  const m = html.match(/name="txn" value="([^"]+)"/);
  if (!m) throw new Error(`no txn in page: ${html.slice(0, 300)}`);
  return decodeEntities(m[1]);
}
function cookieOf(res: Response): string {
  const c = res.headers.getSetCookie().find((s) => s.startsWith('mp_oauth_csrf='));
  if (!c) throw new Error('no csrf cookie');
  return c.split(';')[0];
}

async function post(path: string, form: Record<string, string>, headers: Record<string, string> = {}) {
  return fetch(base + path, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(form).toString(),
  });
}

async function register(body: Record<string, unknown>) {
  return fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function registerPublic(): Promise<string> {
  const res = await register({
    client_name: 'ChatGPT',
    redirect_uris: [CHATGPT_REDIRECT],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CHATGPT_REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-123',
    scope: 'marketplace',
    resource: RESOURCE,
    ...extra,
  });
  return `${base}/authorize?${q}`;
}

/** Runs authorize → email → code and returns the auth code from the redirect. */
async function obtainCode(clientId: string, challenge: string, email = 'alice@example.com'): Promise<string> {
  const page = await fetch(authorizeUrl(clientId, challenge), { redirect: 'manual' });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toMatch(/Sign in to Marketplace to let .+ manage your listings and requests/);
  const cookie = cookieOf(page);

  const before = sent.length;
  const codePage = await post('/oauth/login/email', { txn: txnOf(html), email }, { cookie });
  expect(codePage.status).toBe(200);
  const codeHtml = await codePage.text();
  expect(sent.length).toBe(before + 1);
  const otp = sent.at(-1)!.text.match(/\b(\d{6})\b/)![1];

  const done = await post('/oauth/login/verify', { txn: txnOf(codeHtml), code: otp }, { cookie });
  expect(done.status).toBe(302);
  const loc = new URL(done.headers.get('location')!);
  expect(`${loc.origin}${loc.pathname}`).toBe(CHATGPT_REDIRECT);
  expect(loc.searchParams.get('state')).toBe('st-123');
  expect(loc.searchParams.get('iss')).toBe(PUBLIC);
  return loc.searchParams.get('code')!;
}

async function token(form: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await post('/token', form, headers);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

beforeAll(async () => {
  await setupTestDb();
  setMailerForTesting({ send: async (m) => void sent.push(m) });
  const app = express();
  mountAuth(app);
  app.get('/mcp-probe', bearerMiddleware(), (req, res) => res.json({ auth: req.auth }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  setMailerForTesting(null);
  setCimdFetcherForTesting(null);
  await new Promise((r) => server.close(r));
  await pool.end();
});

beforeEach(async () => {
  await resetDb();
});

describe('discovery', () => {
  it('serves protected resource and authorization server metadata', async () => {
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const prm = (await (await fetch(base + p)).json()) as any;
      expect(prm.resource).toBe(RESOURCE);
      expect(prm.authorization_servers).toEqual([PUBLIC]);
      expect(prm.scopes_supported).toEqual(['marketplace']);
    }
    for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
      const as = (await (await fetch(base + p)).json()) as any;
      expect(as.issuer).toBe(PUBLIC);
      expect(as.authorization_endpoint).toBe(`${PUBLIC}/authorize`);
      expect(as.token_endpoint).toBe(`${PUBLIC}/token`);
      expect(as.registration_endpoint).toBe(`${PUBLIC}/register`);
      expect(as.revocation_endpoint).toBe(`${PUBLIC}/revoke`);
      expect(as.code_challenge_methods_supported).toEqual(['S256']);
      expect(as.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
      expect(as.token_endpoint_auth_methods_supported).toEqual(expect.arrayContaining(['none', 'client_secret_post']));
      expect(as.client_id_metadata_document_supported).toBe(true);
    }
    expect(wwwAuthenticateHeader()).toBe(`Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource"`);
  });

  it('bearer middleware 401s with resource_metadata', async () => {
    const res = await fetch(`${base}/mcp-probe`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource"`);
  });
});

describe('registration', () => {
  it('rejects non-https, non-loopback redirect URIs', async () => {
    const res = await register({ redirect_uris: ['http://evil.example/cb'], token_endpoint_auth_method: 'none' });
    expect(res.status).toBe(400);
  });

  it('allows http://localhost for dev tools', async () => {
    const res = await register({ redirect_uris: ['http://localhost:6274/oauth/callback'], token_endpoint_auth_method: 'none' });
    expect(res.status).toBe(201);
  });
});

describe('full ChatGPT-style flow', () => {
  it('register → authorize → login → token → bearer → refresh rotation → reuse detection', async () => {
    const clientId = await registerPublic();
    const { verifier, challenge } = pkce();
    const code = await obtainCode(clientId, challenge);

    const t1 = await token({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: CHATGPT_REDIRECT,
      resource: RESOURCE,
    });
    expect(t1.status).toBe(200);
    expect(t1.body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'marketplace' });

    const principal = await authenticateBearer(t1.body.access_token);
    expect(principal).toMatchObject({ clientId, scopes: ['marketplace'] });
    expect(principal!.userId).toMatch(/^usr_/);
    expect(principal!.expiresAt).toBeGreaterThan(Date.now() / 1000 + 3500);

    // Middleware exposes the SDK AuthInfo with extra.userId.
    const probe = (await (await fetch(`${base}/mcp-probe`, { headers: { authorization: `Bearer ${t1.body.access_token}` } })).json()) as any;
    expect(probe.auth.extra.userId).toBe(principal!.userId);
    expect(probe.auth.clientId).toBe(clientId);

    // Raw tokens are never stored.
    const { rows } = await pool.query('SELECT token_hash FROM oauth_tokens');
    expect(rows.map((r) => r.token_hash)).not.toContain(t1.body.access_token);

    // Code is single-use; replay also revokes what it issued.
    const replay = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
    expect(await authenticateBearer(t1.body.access_token)).toBeNull();

    // Fresh grant for the refresh tests.
    const p2 = pkce();
    const code2 = await obtainCode(clientId, p2.challenge);
    const t2 = await token({ grant_type: 'authorization_code', code: code2, code_verifier: p2.verifier, client_id: clientId });
    expect(t2.status).toBe(200);

    const r1 = await token({ grant_type: 'refresh_token', refresh_token: t2.body.refresh_token, client_id: clientId });
    expect(r1.status).toBe(200);
    expect(r1.body.refresh_token).not.toBe(t2.body.refresh_token);
    expect(await authenticateBearer(r1.body.access_token)).not.toBeNull();

    // Old refresh token fails, and reuse revokes the family.
    const reuse = await token({ grant_type: 'refresh_token', refresh_token: t2.body.refresh_token, client_id: clientId });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe('invalid_grant');
    expect(await authenticateBearer(r1.body.access_token)).toBeNull();
    const after = await token({ grant_type: 'refresh_token', refresh_token: r1.body.refresh_token, client_id: clientId });
    expect(after.status).toBe(400);
  });

  it('rejects a wrong PKCE verifier, wrong client, and wrong redirect_uri', async () => {
    const clientId = await registerPublic();
    const other = await registerPublic();
    const { verifier, challenge } = pkce();
    const code = await obtainCode(clientId, challenge);

    const wrong = await token({ grant_type: 'authorization_code', code, code_verifier: pkce().verifier, client_id: clientId });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('invalid_grant');

    const wrongClient = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: other });
    expect(wrongClient.body.error).toBe('invalid_grant');

    const wrongRedirect = await token({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: 'https://chatgpt.com/other',
    });
    expect(wrongRedirect.body.error).toBe('invalid_grant');

    // Correct exchange still works (failed attempts didn't consume it).
    const ok = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId });
    expect(ok.status).toBe(200);
  });

  it('supports confidential clients via client_secret_basic and client_secret_post, and /revoke', async () => {
    const reg = await register({ redirect_uris: [CHATGPT_REDIRECT], token_endpoint_auth_method: 'client_secret_basic' });
    expect(reg.status).toBe(201);
    const client = (await reg.json()) as { client_id: string; client_secret: string; client_secret_expires_at: number };
    expect(client.client_secret).toBeTruthy();
    expect(client.client_secret_expires_at).toBe(0);
    const { verifier, challenge } = pkce();
    const code = await obtainCode(client.client_id, challenge);

    const noSecret = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id });
    expect(noSecret.body.error).toBe('invalid_client');

    const basic = Buffer.from(`${client.client_id}:${client.client_secret}`).toString('base64');
    const t = await token({ grant_type: 'authorization_code', code, code_verifier: verifier }, { authorization: `Basic ${basic}` });
    expect(t.status).toBe(200);

    const r = await token({
      grant_type: 'refresh_token',
      refresh_token: t.body.refresh_token,
      client_id: client.client_id,
      client_secret: client.client_secret,
    });
    expect(r.status).toBe(200);

    const rev = await post('/revoke', { token: r.body.access_token, client_id: client.client_id, client_secret: client.client_secret });
    expect(rev.status).toBe(200);
    expect(await authenticateBearer(r.body.access_token)).toBeNull();
  });
});

describe('authorize validation', () => {
  it('requires S256 PKCE and our resource', async () => {
    const clientId = await registerPublic();
    const plain = await fetch(authorizeUrl(clientId, 'abc', { code_challenge_method: 'plain' }), { redirect: 'manual' });
    expect(plain.status).toBe(302);
    expect(new URL(plain.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');

    const badRes = await fetch(authorizeUrl(clientId, pkce().challenge, { resource: 'https://other.example/mcp' }), { redirect: 'manual' });
    expect(badRes.status).toBe(302);
    expect(new URL(badRes.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');

    const badRedirect = await fetch(authorizeUrl(clientId, pkce().challenge, { redirect_uri: 'https://evil.example/cb' }), { redirect: 'manual' });
    expect(badRedirect.status).toBe(400);

    const unknown = await fetch(authorizeUrl('cli_nope', pkce().challenge), { redirect: 'manual' });
    expect(unknown.status).toBe(400);
  });

  it('rejects form posts without the CSRF cookie or with a tampered txn', async () => {
    const clientId = await registerPublic();
    const page = await fetch(authorizeUrl(clientId, pkce().challenge), { redirect: 'manual' });
    const html = await page.text();
    const txn = txnOf(html);
    const mailsBefore = sent.length;
    const noCookie = await post('/oauth/login/email', { txn, email: 'a@example.com' });
    expect(noCookie.status).toBe(400);
    expect(await noCookie.text()).toContain('expired');
    const tampered = await post('/oauth/login/email', { txn: txn.replace(/^./, 'x'), email: 'a@example.com' }, { cookie: cookieOf(page) });
    expect(tampered.status).toBe(400);
    expect(sent.length).toBe(mailsBefore); // no mail sent for rejected posts
  });

  it('escapes HTML in client-controlled values', async () => {
    const res = await register({
      client_name: '<script>alert(1)</script>',
      redirect_uris: [CHATGPT_REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const { client_id } = (await res.json()) as { client_id: string };
    const html = await (await fetch(authorizeUrl(client_id, pkce().challenge))).text();
    expect(html).toContain('let &#60;script&#62;alert(1)&#60;/script&#62; manage your listings');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&#60;script&#62;');
  });

  it('locks a login code after 5 wrong attempts', async () => {
    const clientId = await registerPublic();
    const page = await fetch(authorizeUrl(clientId, pkce().challenge), { redirect: 'manual' });
    const cookie = cookieOf(page);
    const codePage = await post('/oauth/login/email', { txn: txnOf(await page.text()), email: 'bob@example.com' }, { cookie });
    const txn = txnOf(await codePage.text());
    const otp = sent.at(-1)!.text.match(/\b(\d{6})\b/)![1];
    const wrongCode = otp === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const r = await post('/oauth/login/verify', { txn, code: wrongCode }, { cookie });
      expect(r.status).toBe(400);
    }
    const r = await post('/oauth/login/verify', { txn, code: otp }, { cookie });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain('too many attempts');
  });

  it('cancel redirects back with access_denied', async () => {
    const clientId = await registerPublic();
    const page = await fetch(authorizeUrl(clientId, pkce().challenge), { redirect: 'manual' });
    const r = await post('/oauth/login/cancel', { txn: txnOf(await page.text()) }, { cookie: cookieOf(page) });
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('st-123');
  });
});

describe('client ID metadata documents', () => {
  it('accepts a valid https client_id document and rejects a mismatched one', async () => {
    const good = 'https://client.example/oauth/metadata.json';
    const bad = 'https://client.example/oauth/bad.json';
    setCimdFetcherForTesting(async (url) => ({
      client_id: url.href === good ? good : 'https://attacker.example/x.json',
      client_name: 'CIMD Client',
      redirect_uris: [CHATGPT_REDIRECT],
      token_endpoint_auth_method: 'none',
    }));
    const { verifier, challenge } = pkce();
    const code = await obtainCode(good, challenge);
    const t = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: good });
    expect(t.status).toBe(200);
    expect((await authenticateBearer(t.body.access_token))?.clientId).toBe(good);

    const rejected = await fetch(authorizeUrl(bad, challenge), { redirect: 'manual' });
    expect(rejected.status).toBe(400);
    setCimdFetcherForTesting(null);
  });
});

describe('dev tokens', () => {
  it('authenticates DEV_AUTH_TOKENS as users', async () => {
    const p = await authenticateBearer('tok-seller');
    expect(p).toMatchObject({ clientId: 'dev', scopes: ['marketplace'] });
    expect(p!.userId).toMatch(/^usr_/);
    expect(await authenticateBearer('tok-seller')).toMatchObject({ userId: p!.userId });
    expect(await authenticateBearer('nope')).toBeNull();
    const probe = (await (await fetch(`${base}/mcp-probe`, { headers: { authorization: 'Bearer tok-buyer' } })).json()) as any;
    expect(probe.auth.extra.userId).toMatch(/^usr_/);
  });
});
