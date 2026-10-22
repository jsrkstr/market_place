import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { config } from '../config.js';

export interface BlobStore {
  put(key: string, data: Buffer, mimeType: string): Promise<void>;
  get(key: string): Promise<{ data: Buffer; mimeType: string } | null>;
}

/** Local-disk store for development. Swap for an S3-compatible implementation in production. */
class DiskBlobStore implements BlobStore {
  constructor(private root: string) {}

  private path(key: string): string {
    const p = normalize(join(this.root, key));
    if (!p.startsWith(normalize(this.root))) throw new Error('invalid key');
    return p;
  }

  async put(key: string, data: Buffer, mimeType: string): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
    await writeFile(`${p}.mime`, mimeType);
  }

  async get(key: string): Promise<{ data: Buffer; mimeType: string } | null> {
    try {
      const p = this.path(key);
      const [data, mimeType] = await Promise.all([readFile(p), readFile(`${p}.mime`, 'utf8')]);
      return { data, mimeType };
    } catch {
      return null;
    }
  }
}

let store: BlobStore | null = null;

export function getBlobStore(): BlobStore {
  if (!store) store = new DiskBlobStore(config.STORAGE_DIR);
  return store;
}

const sign = (payload: string) => createHmac('sha256', config.APP_SECRET).update(payload).digest('base64url');

/** Time-limited public URL for an image, served by GET /img/:key. */
export function signedImageUrl(storageKey: string, ttlSeconds = 7 * 24 * 3600): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = sign(`${storageKey}.${exp}`);
  return `${config.PUBLIC_BASE_URL}/img/${encodeURIComponent(storageKey)}?exp=${exp}&sig=${sig}`;
}

export function verifyImageSignature(storageKey: string, exp: string, sig: string): boolean {
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  const expected = Buffer.from(sign(`${storageKey}.${exp}`));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
