/**
 * Fetching an image out of someone else's email on the reader's behalf
 * (ADR 0136).
 *
 * This is the one place in the product that follows a URL chosen by whoever
 * mailed you, rendered automatically, with no tap in between — so it is fenced
 * on every axis rather than trusting any of them: the host is screened at every
 * redirect hop, only image responses are returned, the cap is applied while
 * streaming rather than after, and nothing about the reader (cookies, session,
 * referrer) goes out with the request.
 */
import { BlockedHostError, assertPublicHost } from '../../utils/ssrf.js';

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;

export interface FetchedImage {
  body: Buffer;
  contentType: string;
}

/** A 1x1 transparent GIF, returned in place of every failure.
 *
 *  Deliberately not a 502: a broken-image glyph in the middle of an email is
 *  indistinguishable from the blocking ADR 0136 exists to remove, and there is
 *  nothing a reader could do about either. */
export const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64',
);

/** http(s) only, and no credentials in the URL — `https://user:pass@host` would
 *  hand a third party's basic-auth header to a host we then fetch. */
export function parseImageUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url;
}

async function readCapped(res: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    // Checked as it arrives: a sender who lies in content-length, or omits it,
    // must not be able to stream us out of memory.
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Returns the image, or null for every kind of failure — unreachable, private
 * address, too large, too slow, not an image. The caller renders the same
 * transparent pixel for all of them.
 */
export async function fetchRemoteImage(
  target: URL,
  maxBytes: number = MAX_BYTES,
): Promise<FetchedImage | null> {
  let url = target;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      try {
        await assertPublicHost(url.hostname);
      } catch (err) {
        if (err instanceof BlockedHostError) return null;
        throw err;
      }

      let res: Response;
      try {
        res = await fetch(url, {
          // Manual so each hop is screened; a tracker that redirects into
          // 169.254.169.254 must not be followed there by `redirect: 'follow'`.
          redirect: 'manual',
          signal: controller.signal,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          headers: { accept: 'image/*' },
        });
      } catch {
        return null;
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location || hop === MAX_REDIRECTS) return null;
        const next = parseImageUrl(new URL(location, url).toString());
        if (!next) return null;
        url = next;
        continue;
      }
      if (!res.ok) return null;

      const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      // Only images. Without this the route is a general-purpose fetcher that
      // will return anything on the internet to whoever holds a token.
      if (!contentType.startsWith('image/')) return null;

      const body = await readCapped(res, Math.min(maxBytes, MAX_BYTES));
      if (!body || body.length === 0) return null;
      return { body, contentType };
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
