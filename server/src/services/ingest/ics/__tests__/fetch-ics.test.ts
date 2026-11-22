import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Resolve every hostname to a benign public IP so the SSRF screen passes for
// the success/content tests; the blocked-host tests use IP literals that never
// hit DNS, so this mock doesn't affect them.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

import { CalendarFetchError, fetchIcsBuffer, normalizeCalendarUrl } from '../fetch-ics.js';

const ICS = 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:a@x\nSUMMARY:Hi\nDTSTART:20260101T090000Z\nEND:VEVENT\nEND:VCALENDAR';

async function reasonOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'NO_THROW';
  } catch (err) {
    return err instanceof CalendarFetchError ? err.reason : `OTHER:${(err as Error).message}`;
  }
}

describe('normalizeCalendarUrl', () => {
  it('rewrites webcal:// to https://', () => {
    expect(normalizeCalendarUrl('webcal://host.example/feed.ics').protocol).toBe('https:');
  });
  it('rejects http://', () => {
    expect(() => normalizeCalendarUrl('http://host.example/feed.ics')).toThrow(CalendarFetchError);
  });
  it('rejects a non-URL', () => {
    expect(() => normalizeCalendarUrl('not a url')).toThrow(CalendarFetchError);
  });
});

describe('fetchIcsBuffer — SSRF guard (no network)', () => {
  it('refuses http://', async () => {
    expect(await reasonOf(fetchIcsBuffer('http://host.example/feed.ics'))).toBe('not_https');
  });
  it('refuses a loopback IP literal', async () => {
    expect(await reasonOf(fetchIcsBuffer('https://127.0.0.1/feed.ics'))).toBe('blocked_host');
  });
  it('refuses a private IP literal', async () => {
    expect(await reasonOf(fetchIcsBuffer('https://10.0.0.5/feed.ics'))).toBe('blocked_host');
    expect(await reasonOf(fetchIcsBuffer('https://192.168.1.20/feed.ics'))).toBe('blocked_host');
  });
  it('refuses the cloud-metadata link-local address', async () => {
    expect(await reasonOf(fetchIcsBuffer('https://169.254.169.254/latest/meta-data'))).toBe('blocked_host');
  });
});

describe('fetchIcsBuffer — network (mocked fetch + dns)', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('returns the body for a text/calendar response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(ICS, { status: 200, headers: { 'content-type': 'text/calendar' } }),
    ) as typeof fetch;
    const buf = await fetchIcsBuffer('https://schools.example/feed.ics');
    expect(buf.toString('utf8')).toContain('BEGIN:VCALENDAR');
  });

  it('accepts a VCALENDAR body served as text/plain', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(ICS, { status: 200, headers: { 'content-type': 'text/plain' } }),
    ) as typeof fetch;
    const buf = await fetchIcsBuffer('https://schools.example/feed');
    expect(buf.toString('utf8')).toContain('VEVENT');
  });

  it('rejects a non-calendar body (bad_content)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('<html>nope</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ) as typeof fetch;
    expect(await reasonOf(fetchIcsBuffer('https://schools.example/page'))).toBe('bad_content');
  });

  it('maps an HTTP error to http_error', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 404 })) as typeof fetch;
    expect(await reasonOf(fetchIcsBuffer('https://schools.example/missing.ics'))).toBe('http_error');
  });

  it('caps the body size (too_large)', async () => {
    const huge = 'BEGIN:VCALENDAR\n' + 'X'.repeat(5 * 1024 * 1024 + 16);
    globalThis.fetch = vi.fn(async () =>
      new Response(huge, { status: 200, headers: { 'content-type': 'text/calendar' } }),
    ) as typeof fetch;
    expect(await reasonOf(fetchIcsBuffer('https://schools.example/big.ics'))).toBe('too_large');
  });
});
