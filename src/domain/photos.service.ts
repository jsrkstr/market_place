/**
 * Listing photos: ingestion of ChatGPT file params (temporary download URLs) and the one-time browser
 * upload link fallback. Images live in the BlobStore and are served through signed /img URLs.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { listingImages, listings, uploadTokens } from '../db/schema.js';
import { dispatch } from '../infra/jobs.js';
import { assertPublicHost } from '../infra/netguard.js';
import { getBlobStore, signedImageUrl } from '../infra/storage.js';
import { forbidden, invalid, notFound } from './errors.js';
import { logEvent } from './events.js';
import { refreshListingCompleteness } from './listings.service.js';
import type { UserContext } from './types.js';

export interface IncomingFile {
  /** ChatGPT file param: temporary download URL. */
  downloadUrl: string;
  fileId?: string;
  mimeType?: string;
  fileName?: string;
}

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES_PER_LISTING = 12;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const UPLOAD_TOKEN_TTL_MS = 24 * 3600 * 1000;

export const IMAGE_MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heic',
};

/** Detects the image type from magic bytes; returns null when it is not a supported image. */
export function sniffImageMime(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
  }
  return null;
}

/** Resolve the effective mime type: the bytes win; a declared type must at least be a supported image. */
export function resolveImageMime(buf: Buffer, declared?: string | null): string {
  const sniffed = sniffImageMime(buf);
  const decl = declared?.split(';')[0].trim().toLowerCase();
  if (sniffed) return sniffed;
  // HEIC brands vary; trust a declared HEIC type only if the container looks like ISO-BMFF.
  if ((decl === 'image/heic' || decl === 'image/heif') && buf.toString('latin1', 4, 8) === 'ftyp') return 'image/heic';
  throw invalid('Unsupported image type (use JPEG, PNG, WebP or HEIC)');
}

async function loadOwnedListing(ctx: UserContext, listingId: string) {
  const [listing] = await db.select().from(listings).where(eq(listings.id, listingId));
  if (!listing) throw notFound('Listing');
  if (listing.sellerId !== ctx.userId) throw forbidden('Only the seller can add photos to this listing');
  if (['sold', 'withdrawn'].includes(listing.status)) throw invalid(`This listing is ${listing.status}`);
  return listing;
}

async function imageCount(listingId: string): Promise<{ count: number; maxPosition: number }> {
  const [r] = await db
    .select({ count: sql<number>`count(*)::int`, maxPosition: sql<number>`coalesce(max(${listingImages.position}), -1)::int` })
    .from(listingImages)
    .where(eq(listingImages.listingId, listingId));
  return { count: r?.count ?? 0, maxPosition: r?.maxPosition ?? -1 };
}

/** Store image bytes and insert a listing_images row. Shared by file-param ingestion and the upload route. */
export async function storeListingImage(input: {
  listingId: string;
  data: Buffer;
  declaredMime?: string | null;
  source: 'chatgpt_file' | 'upload_link' | 'url';
  aiCaption?: string | null;
}): Promise<{ id: string; url: string }> {
  if (input.data.length === 0) throw invalid('Empty file');
  if (input.data.length > MAX_IMAGE_BYTES) throw invalid('Image is larger than 10 MB');
  const mimeType = resolveImageMime(input.data, input.declaredMime);
  const { count, maxPosition } = await imageCount(input.listingId);
  if (count >= MAX_IMAGES_PER_LISTING) throw invalid(`A listing can have at most ${MAX_IMAGES_PER_LISTING} photos`);

  const id = newId('img');
  const storageKey = `listings/${input.listingId}/${id}.${IMAGE_MIME_EXT[mimeType]}`;
  await getBlobStore().put(storageKey, input.data, mimeType);
  await db.insert(listingImages).values({
    id,
    listingId: input.listingId,
    storageKey,
    mimeType,
    source: input.source,
    aiCaption: input.aiCaption?.trim() || null,
    position: maxPosition + 1,
  });
  return { id, url: signedImageUrl(storageKey) };
}

/** Download with a timeout and a hard size cap (streams, so a lying Content-Length cannot exceed it). */
async function download(url: string): Promise<{ data: Buffer; contentType: string | null }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalid('Invalid download URL');
  }
  const allowHttp = config.NODE_ENV !== 'production';
  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) throw invalid('Download URL must use https');

  // Follow redirects manually so every hop is checked against private addresses (SSRF guard).
  // Outside production, loopback is allowed so tests can serve fixtures locally.
  let res!: Response;
  let target = parsed;
  try {
    for (let hop = 0; ; hop++) {
      if (config.NODE_ENV === 'production') await assertPublicHost(target);
      res = await fetch(target, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: 'manual' });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) break;
      if (hop >= 3) throw new Error('too many redirects');
      target = new URL(location, target);
      if (target.protocol !== 'https:' && !(allowHttp && target.protocol === 'http:')) throw new Error('insecure redirect');
    }
  } catch (err) {
    throw invalid(err instanceof Error && err.name === 'TimeoutError' ? 'Download timed out' : 'Download failed');
  }
  if (!res.ok || !res.body) throw invalid(`Download failed (HTTP ${res.status})`);
  const declaredLength = Number(res.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_IMAGE_BYTES) {
    await res.body.cancel().catch(() => {});
    throw invalid('Image is larger than 10 MB');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => {});
      throw invalid('Image is larger than 10 MB');
    }
    chunks.push(Buffer.from(value));
  }
  return { data: Buffer.concat(chunks), contentType: res.headers.get('content-type') };
}

async function afterPhotosAdded(ctx: UserContext, listingId: string, count: number, source: string): Promise<void> {
  await refreshListingCompleteness(listingId); // completeness/missingFields (photos) + updatedAt
  await logEvent({ type: 'photo_added', actorId: ctx.userId, listingId, data: { count, source } });
  await dispatch('listing.changed', { listingId, reason: 'updated' });
}

/** Download files (ChatGPT fileParams) into the blob store and attach them to the listing. */
export async function attachPhotosFromFiles(
  ctx: UserContext,
  listingId: string,
  files: IncomingFile[],
  captions?: string[],
): Promise<{ added: { id: string; url: string }[]; failed: { fileName?: string; error: string }[] }> {
  await loadOwnedListing(ctx, listingId);
  if (!files.length) throw invalid('No files given');

  const added: { id: string; url: string }[] = [];
  const failed: { fileName?: string; error: string }[] = [];
  for (const [i, file] of files.entries()) {
    try {
      const { data, contentType } = await download(file.downloadUrl);
      // Prefer the server's content type, falling back to what the client declared; bytes decide anyway.
      const declared = contentType && contentType.startsWith('image/') ? contentType : file.mimeType;
      added.push(
        await storeListingImage({ listingId, data, declaredMime: declared, source: 'chatgpt_file', aiCaption: captions?.[i] }),
      );
    } catch (err) {
      failed.push({ fileName: file.fileName ?? file.fileId, error: err instanceof Error ? err.message : 'Failed' });
    }
  }
  if (added.length) await afterPhotosAdded(ctx, listingId, added.length, 'chatgpt_file');
  return { added, failed };
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** One-time browser upload link (fallback when the client cannot pass files). Valid 24h. */
export async function createUploadLink(ctx: UserContext, listingId: string): Promise<{ url: string; expiresAt: string }> {
  await loadOwnedListing(ctx, listingId);
  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + UPLOAD_TOKEN_TTL_MS);
  await db.insert(uploadTokens).values({ tokenHash: hashToken(token), listingId, userId: ctx.userId, expiresAt });
  return { url: `${config.PUBLIC_BASE_URL}/upload/${token}`, expiresAt: expiresAt.toISOString() };
}

/**
 * Resolve an upload token. Valid until it expires; `usedAt` records the first use but a session may
 * upload several photos within the TTL.
 */
export async function resolveUploadToken(
  token: string,
  opts: { markUsed?: boolean } = {},
): Promise<{ listingId: string; userId: string; listingTitle: string | null } | null> {
  if (!token || token.length > 200) return null;
  const tokenHash = hashToken(token);
  const [row] = await db
    .select({ listingId: uploadTokens.listingId, userId: uploadTokens.userId, usedAt: uploadTokens.usedAt, title: listings.title, sellerId: listings.sellerId })
    .from(uploadTokens)
    .innerJoin(listings, eq(listings.id, uploadTokens.listingId))
    .where(and(eq(uploadTokens.tokenHash, tokenHash), gt(uploadTokens.expiresAt, new Date())));
  if (!row || row.sellerId !== row.userId) return null;
  if (opts.markUsed && !row.usedAt) {
    await db.update(uploadTokens).set({ usedAt: new Date() }).where(eq(uploadTokens.tokenHash, tokenHash));
  }
  return { listingId: row.listingId, userId: row.userId, listingTitle: row.title };
}

/** Store one photo uploaded through the browser link. */
export async function addPhotoFromUpload(
  token: string,
  data: Buffer,
  declaredMime: string | null,
): Promise<{ id: string; url: string }> {
  const t = await resolveUploadToken(token, { markUsed: true });
  if (!t) throw notFound('Upload link (it may have expired)');
  const ctx = { userId: t.userId };
  await loadOwnedListing(ctx, t.listingId);
  const img = await storeListingImage({ listingId: t.listingId, data, declaredMime, source: 'upload_link' });
  await afterPhotosAdded(ctx, t.listingId, 1, 'upload_link');
  return img;
}
