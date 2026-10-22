import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../../src/db/client.js';
import { listingImages, listings, uploadTokens } from '../../src/db/schema.js';
import { attachPhotosFromFiles, createUploadLink } from '../../src/domain/photos.service.js';
import type { UserContext } from '../../src/domain/types.js';
import { mountImageRoutes } from '../../src/http/images.js';
import { mountUploadRoutes } from '../../src/http/uploads.js';
import { getBlobStore, signedImageUrl } from '../../src/infra/storage.js';
import { makeUser, resetDb, setupTestDb } from '../helpers/db.js';
import { insertListing, PNG_1PX } from './fixtures.js';

let app: Server;
let base: string;
/** A fake "ChatGPT file" host serving temporary download URLs. */
let files: Server;
let filesBase: string;

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const local = (url: string) => url.replace('http://localhost:3999', base);

describe('photos, upload link and signed images', () => {
  let seller: UserContext, other: UserContext;

  beforeAll(async () => {
    await setupTestDb();
    const e = express();
    mountUploadRoutes(e);
    mountImageRoutes(e);
    app = createServer(e);
    base = await listen(app);
    files = createServer((req, res) => {
      if (req.url === '/cat.png') res.writeHead(200, { 'content-type': 'image/png' }).end(PNG_1PX);
      else if (req.url === '/doc.txt') res.writeHead(200, { 'content-type': 'text/plain' }).end('hello');
      else if (req.url === '/huge.jpg') {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        res.end(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(11 * 1024 * 1024)]));
      } else res.writeHead(404).end();
    });
    filesBase = await listen(files);
  });
  beforeEach(async () => {
    await resetDb();
    seller = await makeUser('seller@test.dev');
    other = await makeUser('other@test.dev');
  });
  afterAll(async () => {
    app.close();
    files.close();
    await pool.end();
  });

  it('attaches ChatGPT files: stores valid images, reports invalid/oversized ones; owner only', async () => {
    const l = await insertListing(seller);
    await expect(attachPhotosFromFiles(other, l.id, [{ downloadUrl: `${filesBase}/cat.png` }])).rejects.toMatchObject({ code: 'forbidden' });
    const r = await attachPhotosFromFiles(
      seller,
      l.id,
      [
        { downloadUrl: `${filesBase}/cat.png`, fileName: 'cat.png' },
        { downloadUrl: `${filesBase}/doc.txt`, fileName: 'doc.txt' },
        { downloadUrl: `${filesBase}/huge.jpg`, fileName: 'huge.jpg' },
        { downloadUrl: `${filesBase}/missing.png`, fileName: 'missing.png' },
        { downloadUrl: `${filesBase}/cat.png` },
      ],
      ['A white chair', '', '', '', 'Side view'],
    );
    expect(r.added).toHaveLength(2);
    expect(r.failed.map((f) => f.fileName)).toEqual(['doc.txt', 'huge.jpg', 'missing.png']);
    expect(r.failed[1].error).toMatch(/10 MB/);
    const rows = await db.select().from(listingImages).where(eq(listingImages.listingId, l.id)).orderBy(listingImages.position);
    expect(rows.map((x) => [x.position, x.aiCaption, x.mimeType, x.source])).toEqual([
      [0, 'A white chair', 'image/png', 'chatgpt_file'],
      [1, 'Side view', 'image/png', 'chatgpt_file'],
    ]);
    expect(rows[0].storageKey).toBe(`listings/${l.id}/${rows[0].id}.png`);
    expect((await getBlobStore().get(rows[0].storageKey))?.data.equals(PNG_1PX)).toBe(true);
    const [after] = await db.select().from(listings).where(eq(listings.id, l.id));
    expect(after.missingFields.map((f) => f.field)).not.toContain('photos');

    // The returned URL is a working signed image URL.
    const img = await fetch(local(r.added[0].url));
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    expect(img.headers.get('cache-control')).toMatch(/max-age=\d+/);
    expect(Buffer.from(await img.arrayBuffer()).equals(PNG_1PX)).toBe(true);
  });

  it('rejects bad or expired image signatures', async () => {
    const l = await insertListing(seller);
    const { added } = await attachPhotosFromFiles(seller, l.id, [{ downloadUrl: `${filesBase}/cat.png` }]);
    const url = new URL(local(added[0].url));
    const tampered = new URL(url);
    tampered.searchParams.set('sig', 'x' + url.searchParams.get('sig')!.slice(1));
    expect((await fetch(tampered)).status).toBe(403);
    const otherKey = new URL(url);
    otherKey.pathname = `/img/${encodeURIComponent(`listings/${l.id}/img_other.png`)}`;
    expect((await fetch(otherKey)).status).toBe(403);
    const [row] = await db.select().from(listingImages);
    expect((await fetch(local(signedImageUrl(row.storageKey, -10)))).status).toBe(403);
    expect((await fetch(local(signedImageUrl('listings/nope/none.png')))).status).toBe(404);
  });

  it('upload link: serves an escaped page and accepts several raw image POSTs within the TTL', async () => {
    const l = await insertListing(seller, { title: '<script>alert(1)</script> chair' });
    await expect(createUploadLink(other, l.id)).rejects.toMatchObject({ code: 'forbidden' });
    const link = await createUploadLink(seller, l.id);
    expect(link.url).toMatch(/^http:\/\/localhost:3999\/upload\/[\w-]{20,}$/);
    expect(new Date(link.expiresAt).getTime() - Date.now()).toBeGreaterThan(23 * 3600_000);
    const [tok] = await db.select().from(uploadTokens);
    expect(link.url).not.toContain(tok.tokenHash); // only a hash is stored

    const page = await fetch(local(link.url));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; chair');
    expect(html).not.toContain('<script>alert(1)');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");

    for (let i = 0; i < 2; i++) {
      const res = await fetch(local(link.url), { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG_1PX });
      expect(res.status).toBe(201);
    }
    const rows = await db.select().from(listingImages).where(eq(listingImages.listingId, l.id));
    expect(rows.map((r) => r.source)).toEqual(['upload_link', 'upload_link']);
    expect((await db.select().from(uploadTokens))[0].usedAt).not.toBeNull();

    const notImage = await fetch(local(link.url), { method: 'POST', headers: { 'content-type': 'image/png' }, body: 'not really a png' });
    expect(notImage.status).toBe(400);
    const wrongType = await fetch(local(link.url), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hi' });
    expect(wrongType.status).toBe(415);
    const big = await fetch(local(link.url), {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg' },
      body: Buffer.alloc(10 * 1024 * 1024 + 10),
    });
    expect(big.status).toBe(413);
  });

  it('upload link: unknown or expired tokens are rejected', async () => {
    const l = await insertListing(seller);
    const link = await createUploadLink(seller, l.id);
    expect((await fetch(`${base}/upload/bogus-token`)).status).toBe(404);
    await db.update(uploadTokens).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await fetch(local(link.url))).status).toBe(404);
    const res = await fetch(local(link.url), { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG_1PX });
    expect(res.status).toBe(404);
    expect(await db.select().from(listingImages)).toHaveLength(0);
  });
});
