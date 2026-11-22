/**
 * Key providers (ADR 0201). The provider is the only thing standing between a
 * database dump and every user's data, so what matters here is that it refuses:
 * the wrong key, altered input, an unknown configuration. The Cloud KMS
 * provider is exercised against a fake transport; the wire shapes below are
 * the documented REST calls, and nothing here talks to Google.
 */
import { randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  GcpKmsKeyProvider,
  KeyProviderError,
  LocalKeyProvider,
  providerFromConfig,
} from '../key-provider.js';

const KEY_NAME = 'projects/p/locations/global/keyRings/r/cryptoKeys/k';

describe('LocalKeyProvider', () => {
  const kek = randomBytes(32);

  it('wraps and unwraps a data key', async () => {
    const p = new LocalKeyProvider(kek);
    const dek = randomBytes(32);
    expect((await p.unwrap(await p.wrap(dek))).equals(dek)).toBe(true);
  });

  it('never wraps the same key to the same bytes, and never contains the key', async () => {
    const p = new LocalKeyProvider(kek);
    const dek = randomBytes(32);
    const a = await p.wrap(dek);
    const b = await p.wrap(dek);
    expect(a.equals(b)).toBe(false);
    expect(a.includes(dek)).toBe(false);
  });

  it('cannot unwrap under a different KEK', async () => {
    const wrapped = await new LocalKeyProvider(kek).wrap(randomBytes(32));
    await expect(new LocalKeyProvider(randomBytes(32)).unwrap(wrapped)).rejects.toThrow(KeyProviderError);
  });

  it('rejects an altered or truncated wrapped key', async () => {
    const p = new LocalKeyProvider(kek);
    const wrapped = await p.wrap(randomBytes(32));
    const bad = Buffer.from(wrapped);
    bad[20] = bad[20]! ^ 1;
    await expect(p.unwrap(bad)).rejects.toThrow(KeyProviderError);
    await expect(p.unwrap(wrapped.subarray(0, 10))).rejects.toThrow(KeyProviderError);
    await expect(p.unwrap(Buffer.alloc(0))).rejects.toThrow(KeyProviderError);
  });

  it('refuses a KEK that is not exactly 32 bytes', () => {
    expect(() => new LocalKeyProvider(Buffer.alloc(16))).toThrow(KeyProviderError);
    expect(() => new LocalKeyProvider(Buffer.alloc(33))).toThrow(KeyProviderError);
    expect(() => LocalKeyProvider.fromBase64('')).toThrow(KeyProviderError);
  });

  it('error messages never contain the key material', async () => {
    const wrapped = await new LocalKeyProvider(kek).wrap(randomBytes(32));
    const other = new LocalKeyProvider(randomBytes(32));
    const err = await other.unwrap(wrapped).catch((e: Error) => e);
    expect((err as Error).message).not.toContain(kek.toString('base64'));
    expect((err as Error).message).not.toContain(kek.toString('hex'));
  });
});

describe('providerFromConfig', () => {
  const base = { provider: 'local', kek: '', gcpKeyName: '', nodeEnv: 'development' };

  it('uses the configured KEK', async () => {
    const kek = randomBytes(32);
    const p = providerFromConfig({ ...base, kek: kek.toString('base64') });
    const dek = randomBytes(32);
    const w = await p.wrap(dek);
    expect((await new LocalKeyProvider(kek).unwrap(w)).equals(dek)).toBe(true);
  });

  it('starts in development with no KEK, and refuses to in production', () => {
    expect(providerFromConfig(base).id).toBe('local');
    expect(() => providerFromConfig({ ...base, nodeEnv: 'production' })).toThrow(/CONTENT_KEK is required/);
  });

  it('refuses an unknown provider instead of falling back to a weaker one', () => {
    expect(() => providerFromConfig({ ...base, provider: 'aws-kms' })).toThrow(/must be "local" or "gcp-kms"/);
    expect(() => providerFromConfig({ ...base, provider: '' })).toThrow(KeyProviderError);
  });

  it('requires a key name for Cloud KMS', () => {
    expect(() => providerFromConfig({ ...base, provider: 'gcp-kms' })).toThrow(/GCP_KMS_KEY_NAME/);
    expect(providerFromConfig({ ...base, provider: 'gcp-kms', gcpKeyName: KEY_NAME }).id).toBe('gcp-kms');
  });
});

interface Call {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function fakeKms(opts: { tokenTtl?: number; failOp?: 'encrypt' | 'decrypt'; failToken?: boolean } = {}) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: Omit<Call, 'url'>) => {
    calls.push({ url, ...init });
    if (url.includes('metadata.google.internal')) {
      return {
        ok: !opts.failToken,
        status: opts.failToken ? 500 : 200,
        json: async () => ({ access_token: `tok-${calls.length}`, expires_in: opts.tokenTtl ?? 3600 }),
        text: async () => '',
      };
    }
    const op = url.endsWith(':encrypt') ? 'encrypt' : 'decrypt';
    if (opts.failOp === op) {
      return { ok: false, status: 403, json: async () => ({}), text: async () => `denied for ${KEY_NAME}` };
    }
    const body = JSON.parse(init?.body ?? '{}') as Record<string, string>;
    return {
      ok: true,
      status: 200,
      // A stand-in for KMS: reversible, and different from the input.
      json: async () =>
        op === 'encrypt'
          ? { ciphertext: Buffer.from(`kms:${body.plaintext}`).toString('base64') }
          : { plaintext: Buffer.from(body.ciphertext!, 'base64').toString().replace(/^kms:/, '') },
      text: async () => '',
    };
  });
  return { calls, fetchImpl };
}

describe('GcpKmsKeyProvider', () => {
  it('wraps and unwraps through the documented REST calls', async () => {
    const kms = fakeKms();
    const p = new GcpKmsKeyProvider(KEY_NAME, kms.fetchImpl);
    const dek = randomBytes(32);

    const wrapped = await p.wrap(dek);
    expect((await p.unwrap(wrapped)).equals(dek)).toBe(true);

    const enc = kms.calls.find((c) => c.url.endsWith(':encrypt'))!;
    expect(enc.url).toBe(`https://cloudkms.googleapis.com/v1/${KEY_NAME}:encrypt`);
    expect(enc.method).toBe('POST');
    expect(enc.headers?.authorization).toMatch(/^Bearer tok-/);
    const body = JSON.parse(enc.body!) as Record<string, string>;
    expect(body.plaintext).toBe(dek.toString('base64'));
    // The key name is bound as AAD so a wrapped key cannot be replayed elsewhere.
    expect(Buffer.from(body.additionalAuthenticatedData!, 'base64').toString()).toBe(KEY_NAME);
  });

  it('asks the metadata server for a token once and reuses it', async () => {
    const kms = fakeKms();
    const p = new GcpKmsKeyProvider(KEY_NAME, kms.fetchImpl);
    for (let i = 0; i < 5; i++) await p.wrap(randomBytes(32));
    expect(kms.calls.filter((c) => c.url.includes('metadata.google.internal'))).toHaveLength(1);
    const meta = kms.calls.find((c) => c.url.includes('metadata.google.internal'))!;
    expect(meta.headers?.['Metadata-Flavor']).toBe('Google');
  });

  it('refreshes the token shortly before it expires', async () => {
    const kms = fakeKms({ tokenTtl: 120 });
    let now = 1_000_000;
    const p = new GcpKmsKeyProvider(KEY_NAME, kms.fetchImpl, () => now);
    await p.wrap(randomBytes(32));
    now += 30_000; // still inside the margin
    await p.wrap(randomBytes(32));
    expect(kms.calls.filter((c) => c.url.includes('metadata.google.internal'))).toHaveLength(1);
    now += 60_000; // within 60s of expiry: refresh
    await p.wrap(randomBytes(32));
    expect(kms.calls.filter((c) => c.url.includes('metadata.google.internal'))).toHaveLength(2);
  });

  it('fails closed when KMS refuses, without echoing the response body', async () => {
    const p = new GcpKmsKeyProvider(KEY_NAME, fakeKms({ failOp: 'decrypt' }).fetchImpl);
    const wrapped = await p.wrap(randomBytes(32));
    const err = (await p.unwrap(wrapped).catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(KeyProviderError);
    expect(err.message).toContain('403');
    expect(err.message).not.toContain(KEY_NAME);
  });

  it('fails closed when it cannot get a token', async () => {
    const p = new GcpKmsKeyProvider(KEY_NAME, fakeKms({ failToken: true }).fetchImpl);
    await expect(p.wrap(randomBytes(32))).rejects.toThrow(/metadata token/);
  });

  it('fails closed on a response with no ciphertext or plaintext', async () => {
    const empty = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.includes('metadata') ? { access_token: 't', expires_in: 3600 } : {}),
      text: async () => '',
    }));
    const p = new GcpKmsKeyProvider(KEY_NAME, empty);
    await expect(p.wrap(randomBytes(32))).rejects.toThrow(/no ciphertext/);
    await expect(p.unwrap(Buffer.from('x'))).rejects.toThrow(/no plaintext/);
  });
});
