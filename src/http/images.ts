import type { Express, Request, Response } from 'express';
import { getBlobStore, verifyImageSignature } from '../infra/storage.js';

/** GET /img/:key?exp=&sig= serves a listing image if the HMAC signature is valid and unexpired. */
export function mountImageRoutes(app: Express): void {
  app.get('/img/:key', async (req: Request, res: Response) => {
    const key = String(req.params.key);
    const exp = typeof req.query.exp === 'string' ? req.query.exp : '';
    const sig = typeof req.query.sig === 'string' ? req.query.sig : '';
    if (!exp || !sig || !verifyImageSignature(key, exp, sig)) {
      res.status(403).type('text/plain').send('Invalid or expired image link');
      return;
    }
    let blob: Awaited<ReturnType<ReturnType<typeof getBlobStore>['get']>>;
    try {
      blob = await getBlobStore().get(key);
    } catch {
      blob = null;
    }
    if (!blob) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    // Cache until the signature expires (capped at a day); content under a key never changes.
    const maxAge = Math.max(0, Math.min(86400, Number(exp) - Math.floor(Date.now() / 1000)));
    res.set({
      'Content-Type': blob.mimeType,
      'Content-Length': String(blob.data.length),
      'Cache-Control': `private, max-age=${maxAge}, immutable`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    });
    res.end(blob.data);
  });
}
