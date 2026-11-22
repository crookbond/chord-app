/**
 * ADR 0136 — the image proxy over HTTP: what it takes, what it refuses, and
 * what a failure looks like to an <img> that is already on screen.
 */
import type { AddressInfo } from 'node:net';
import http from 'node:http';

import { API } from '@chord/kernel';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '@/app.js';
import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { mintImageToken } from '@/services/email/image-token.js';
import { _resetCryptoCacheForTests } from '@/utils/crypto-tokens.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

/** ADR 0136's failure shape: a 1x1 GIF, so the reader gets a gap rather than a
 *  broken-image glyph they can do nothing about. */
async function expectPixel(res: Response): Promise<void> {
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/gif');
  expect((await res.arrayBuffer()).byteLength).toBeLessThan(100);
}

describe('GET /me/email/image (ADR 0136)', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;
  let userId: string;

  beforeEach(async () => {
    process.env.MASTER_KEY = Buffer.alloc(32, 3).toString('base64');
    _resetCryptoCacheForTests();
    // The proxy lives under /api/v1/me/email/*, which the emailRouter 404s
    // wholesale when GMAIL_ENABLED is off — and example.env ships it off.
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = true;
    (env as { EMAIL_IMAGE_PROXY: boolean }).EMAIL_IMAGE_PROXY = true;
    db = await openTestDb();
    server = http.createServer(buildApp(db));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    userId = await createUser(db, 'image-reader');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    _resetCryptoCacheForTests();
    (env as { GMAIL_ENABLED: boolean }).GMAIL_ENABLED = false;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeTestDb(db);
  });

  // The server under test runs in this process, so a spy on global fetch would
  // also intercept the request we make TO it. Hold the real one for our side.
  const realFetch = globalThis.fetch.bind(globalThis);

  const proxy = (query: string): Promise<Response> =>
    realFetch(`${base}${API.meEmailImageProxy}?${query}`);

  const validToken = (): string => mintImageToken(userId);

  it('fetches the image and serves it back, cached and privately', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(Buffer.from('PNGDATA'), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );

    const res = await proxy(
      `k=${encodeURIComponent(validToken())}&u=${encodeURIComponent('https://cdn.example/logo.png')}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    // Private: the URL is per-recipient and must not sit in a shared cache.
    expect(res.headers.get('cache-control')).toContain('private');
    expect(await res.text()).toBe('PNGDATA');
  });

  it('needs a token — the route is not behind requireSession', async () => {
    // An <img> cannot send the session header; the token is what replaces it,
    // so a missing or forged one must not simply fall through to a fetch.
    const forged = await proxy(`k=nonsense&u=${encodeURIComponent('https://cdn.example/a.png')}`);
    expect(forged.status).toBe(403);

    const absent = await proxy(`u=${encodeURIComponent('https://cdn.example/a.png')}`);
    expect(absent.status).toBe(403);
  });

  it('answers a private address with a pixel, having never fetched it', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const res = await proxy(
      `k=${encodeURIComponent(validToken())}&u=${encodeURIComponent('http://169.254.169.254/')}`,
    );

    await expectPixel(res);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('answers an unusable target with a pixel rather than an error', async () => {
    for (const u of ['file:///etc/passwd', 'not-a-url', '']) {
      await expectPixel(
        await proxy(`k=${encodeURIComponent(validToken())}&u=${encodeURIComponent(u)}`),
      );
    }
  });

  it('serves a pixel for everything once the route is turned off', async () => {
    (env as { EMAIL_IMAGE_PROXY: boolean }).EMAIL_IMAGE_PROXY = false;

    await expectPixel(
      await proxy(
        `k=${encodeURIComponent(validToken())}&u=${encodeURIComponent('https://cdn.example/a.png')}`,
      ),
    );
  });
});
