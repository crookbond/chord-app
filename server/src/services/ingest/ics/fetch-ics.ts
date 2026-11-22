/**
 * Fetches a remote calendar feed (ICS) into a Buffer for the .ics ingest
 * pipeline (ADR 0050). This is the server's first user-directed outbound
 * fetch, so it is deliberately defensive:
 *
 *  - https only (webcal:// is rewritten to https://)
 *  - every candidate IP is range-checked before connecting — private,
 *    loopback, link-local, ULA, and cloud-metadata ranges are refused
 *    (the shared SSRF guard in utils/ssrf.ts); redirects are followed
 *    manually and re-validated per hop
 *  - hard caps on time and body size
 *
 */
import { BlockedHostError, assertPublicHost } from '../../../utils/ssrf.js';

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — parse layer caps at 10k events
const MAX_REDIRECTS = 3;

export type CalendarFetchReason =
  | 'not_https'
  | 'blocked_host'
  | 'unreachable'
  | 'http_error'
  | 'too_large'
  | 'timeout'
  | 'bad_content';

export class CalendarFetchError extends Error {
  constructor(
    readonly reason: CalendarFetchReason,
    message: string,
  ) {
    super(message);
    this.name = 'CalendarFetchError';
  }
}

/** Normalize to an https URL, rewriting webcal:// (the common calendar scheme). */
export function normalizeCalendarUrl(raw: string): URL {
  const trimmed = raw.trim();
  const rewritten = /^webcal:\/\//i.test(trimmed)
    ? trimmed.replace(/^webcal:\/\//i, 'https://')
    : trimmed;
  let url: URL;
  try {
    url = new URL(rewritten);
  } catch {
    throw new CalendarFetchError('not_https', `That doesn't look like a valid URL.`);
  }
  if (url.protocol !== 'https:') {
    throw new CalendarFetchError('not_https', `Calendar feeds must be https (got ${url.protocol}).`);
  }
  return url;
}

async function readCappedBody(res: Response): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new CalendarFetchError('too_large', `Calendar feed exceeds ${MAX_BYTES / 1024 / 1024} MB.`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/**
 * Fetch an ICS feed and return its raw bytes. Throws CalendarFetchError with
 * a typed `reason` so the caller can give the user an honest, specific message.
 */
export async function fetchIcsBuffer(rawUrl: string): Promise<Buffer> {
  let url = normalizeCalendarUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      try {
        await assertPublicHost(url.hostname);
      } catch (err) {
        if (err instanceof BlockedHostError) {
          throw new CalendarFetchError(err.reason, err.message);
        }
        throw err;
      }
      let res: Response;
      try {
        res = await fetch(url, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5' },
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new CalendarFetchError('timeout', `Calendar feed timed out after ${TIMEOUT_MS / 1000}s.`);
        }
        throw new CalendarFetchError('unreachable', `Couldn't reach ${url.hostname}.`);
      }

      // Manual redirect handling so each hop's destination is re-screened.
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location || hop === MAX_REDIRECTS) {
          throw new CalendarFetchError('http_error', 'Too many redirects fetching the calendar.');
        }
        url = normalizeCalendarUrl(new URL(location, url).toString());
        continue;
      }
      if (!res.ok) {
        throw new CalendarFetchError('http_error', `Calendar host returned HTTP ${res.status}.`);
      }

      const buf = await readCappedBody(res);
      const contentType = res.headers.get('content-type') ?? '';
      const looksLikeIcs =
        /text\/calendar/i.test(contentType) ||
        buf.toString('utf8', 0, 256).toUpperCase().includes('BEGIN:VCALENDAR');
      if (!looksLikeIcs) {
        throw new CalendarFetchError(
          'bad_content',
          `That URL didn't return a calendar feed (got ${contentType || 'unknown content'}).`,
        );
      }
      return buf;
    }
    throw new CalendarFetchError('http_error', 'Too many redirects fetching the calendar.');
  } finally {
    clearTimeout(timer);
  }
}
