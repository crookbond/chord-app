/**
 * The image proxy's two jobs (ADR 0136): let only our readers in, and refuse to
 * become a general-purpose fetcher for whoever mailed them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `cdn.example` is not a real name, and the SSRF guard resolves before it
// fetches — so without this every case below would pass for the wrong reason
// (refused as unreachable) and prove nothing about the rest of the path.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

import { _resetCryptoCacheForTests } from '../../../utils/crypto-tokens.js';
import { fetchRemoteImage, parseImageUrl } from '../image-proxy.js';
import { mintImageToken, readImageToken, tryMintImageToken } from '../image-token.js';

const KEY = Buffer.alloc(32, 7).toString('base64');

beforeEach(() => {
  process.env.MASTER_KEY = KEY;
  _resetCryptoCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetCryptoCacheForTests();
});

describe('image token', () => {
  it('round-trips the user it was minted for', () => {
    expect(readImageToken(mintImageToken('u1'))).toBe('u1');
  });

  it('does not put the user id where the URL shows it', () => {
    // The blob is encrypted rather than signed, so a token in an access log
    // names nobody.
    expect(mintImageToken('user-abc-123')).not.toContain('user-abc-123');
  });

  it('expires', () => {
    const tok = mintImageToken('u1', 0);

    expect(readImageToken(tok, 1)).toBe('u1');
    expect(readImageToken(tok, 13 * 60 * 60 * 1000)).toBeNull();
  });

  it('refuses a tampered, malformed, or absent token', () => {
    const tok = mintImageToken('u1');
    const [iv, tag, ct] = tok.split('.');

    expect(readImageToken(`${iv}.${tag}.${Buffer.from('forged').toString('base64url')}`)).toBeNull();
    expect(readImageToken(`${iv}.${ct}`)).toBeNull();
    expect(readImageToken('nonsense')).toBeNull();
    expect(readImageToken(undefined)).toBeNull();
  });

  it('refuses a token sealed under a different key', () => {
    const tok = mintImageToken('u1');
    process.env.MASTER_KEY = Buffer.alloc(32, 9).toString('base64');
    _resetCryptoCacheForTests();

    expect(readImageToken(tok)).toBeNull();
  });
});

describe('tryMintImageToken', () => {
  it('returns null rather than throwing when there is no key', () => {
    // MASTER_KEY is only asserted at boot under AUTH_MODE=google, so this is a
    // reachable deployment. Reading your mail must not 500 because images
    // cannot be proxied — the reader falls back to ADR 0120's blocking.
    delete process.env.MASTER_KEY;
    _resetCryptoCacheForTests();

    expect(tryMintImageToken('u1')).toBeNull();
  });
});

describe('parseImageUrl', () => {
  it('takes http and https', () => {
    expect(parseImageUrl('https://cdn.example/a.png')?.hostname).toBe('cdn.example');
    expect(parseImageUrl('http://cdn.example/a.png')?.hostname).toBe('cdn.example');
  });

  it('refuses schemes that are not a fetch over the network', () => {
    for (const raw of ['file:///etc/passwd', 'data:image/gif;base64,R0lGOD', 'ftp://x/a.png']) {
      expect(parseImageUrl(raw)).toBeNull();
    }
  });

  it('refuses credentials in the URL', () => {
    // Otherwise a mailed URL hands a basic-auth header to a host we then fetch.
    expect(parseImageUrl('https://user:pass@cdn.example/a.png')).toBeNull();
  });

  it('refuses nothing and nonsense', () => {
    expect(parseImageUrl(undefined)).toBeNull();
    expect(parseImageUrl('not a url')).toBeNull();
  });
});

function imageResponse(body: Buffer, contentType = 'image/png'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

describe('fetchRemoteImage', () => {
  it('returns the bytes and the type for an ordinary image', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(imageResponse(Buffer.from('PNGDATA')));

    const out = await fetchRemoteImage(new URL('https://cdn.example/logo.png'));

    expect(out?.contentType).toBe('image/png');
    expect(out?.body.toString()).toBe('PNGDATA');
    // Nothing about the reader rides along.
    const init = fetchSpy.mock.calls[0][1];
    expect(init?.credentials).toBe('omit');
    expect(init?.referrerPolicy).toBe('no-referrer');
  });

  it('never reaches a private address, and never calls fetch to find out', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    expect(await fetchRemoteImage(new URL('http://169.254.169.254/latest/meta-data'))).toBeNull();
    expect(await fetchRemoteImage(new URL('http://127.0.0.1:5432/'))).toBeNull();
    expect(await fetchRemoteImage(new URL('http://10.0.0.5/x.png'))).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a response that is not an image', async () => {
    // Without this the route returns anything on the internet to a token holder.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"secret":1}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );

    expect(await fetchRemoteImage(new URL('https://cdn.example/a.png'))).toBeNull();
  });

  it('refuses an oversize body even when content-length lies about it', async () => {
    const huge = Buffer.alloc(11 * 1024 * 1024, 1);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(huge, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '10' },
      }),
    );

    expect(await fetchRemoteImage(new URL('https://cdn.example/big.png'))).toBeNull();
  });

  it('re-screens each redirect hop rather than letting fetch follow', async () => {
    // A tracker that 302s into the metadata service must not be followed there.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
    );

    expect(await fetchRemoteImage(new URL('https://cdn.example/a.png'))).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][1]?.redirect).toBe('manual');
  });

  it('gives up rather than looping on a redirect chain', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://cdn.example/next.png' } }),
    );

    expect(await fetchRemoteImage(new URL('https://cdn.example/a.png'))).toBeNull();
  });

  it('returns null rather than throwing when the host is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));

    expect(await fetchRemoteImage(new URL('https://cdn.example/a.png'))).toBeNull();
  });

  it('refuses a non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 404 }));

    expect(await fetchRemoteImage(new URL('https://cdn.example/a.png'))).toBeNull();
  });
});
