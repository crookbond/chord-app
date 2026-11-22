/**
 * The pure halves of the CASA AL1 fixes (ADR 0269).
 */
import { createHash } from 'node:crypto';

import { KEPT_ON_SIGN_OUT, storageKeysToClearOnSignOut } from '@chord/kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { generatePairingCode } from '@/services/connectors/pairing.service.js';
import { createGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { isActiveContentType, safeFileHeaders } from '@/utils/content-disposition.js';
import { redactUrl } from '@/utils/redact-url.js';
import { secretsEqual } from '@/utils/secret-compare.js';
import { hashSessionToken } from '@/utils/session-token.js';
import { assertSafeModelEndpoint, BlockedHostError, isBlockedIp, modelEndpointFetch } from '@/utils/ssrf.js';

describe('redactUrl', () => {
  it('removes the session token the web client puts on its SSE URL', () => {
    expect(redactUrl('/api/v1/me/stream?token=t_abcdefghijklmnopqrstuvwx')).toBe('/api/v1/me/stream?token=REDACTED');
  });

  it('removes every credential-shaped parameter and keeps the rest', () => {
    const out = redactUrl('/x?k=sealed&u=https%3A%2F%2Fa.example%2Fp.png&code=abc&state=s1&validationToken=v&hub.verify_token=h&m=1');
    expect(out).toBe('/x?k=REDACTED&u=https%3A%2F%2Fa.example%2Fp.png&code=REDACTED&state=REDACTED&validationToken=REDACTED&hub.verify_token=REDACTED&m=1');
  });

  it('leaves a URL without a query untouched', () => {
    expect(redactUrl('/api/v1/me')).toBe('/api/v1/me');
  });
});

describe('secretsEqual', () => {
  it('matches equal secrets and rejects different ones of any length', () => {
    expect(secretsEqual('s3cret', 's3cret')).toBe(true);
    expect(secretsEqual('s3cret', 's3cres')).toBe(false);
    expect(secretsEqual('s3', 's3cret')).toBe(false);
  });

  it('never matches an empty or missing expected value', () => {
    expect(secretsEqual('', '')).toBe(false);
    expect(secretsEqual(undefined, 'x')).toBe(false);
    expect(secretsEqual('x', undefined)).toBe(false);
  });
});

describe('hashSessionToken', () => {
  it('is h_ + the sha256 of the token, so migration 112 (SQL sha256) agrees', () => {
    const t = 't_abcdefghijklmnopqrstuvwx';
    expect(hashSessionToken(t)).toBe(`h_${createHash('sha256').update(t).digest('hex')}`);
  });
});

describe('pairing codes', () => {
  afterEach(() => vi.restoreAllMocks());

  it('are not drawn from Math.random', async () => {
    const db = await openTestDb();
    try {
      const userId = await createUser(db, 'pair-user');
      const group = await createGroup(db, { name: 'G', kind: 'group', createdBy: userId });
      const spy = vi.spyOn(Math, 'random');
      const res = await generatePairingCode(db, { platform: 'telegram', groupId: group.id, userId });
      expect(spy).not.toHaveBeenCalled();
      expect(res.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    } finally {
      await closeTestDb(db);
    }
  });
});

describe('isBlockedIp', () => {
  it.each([
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '198.18.0.1',
    '198.19.255.1',
    '192.0.0.8',
    '192.0.2.1',
    '198.51.100.7',
    '203.0.113.9',
    'ff02::1',
    '64:ff9b::a9fe:a9fe', // NAT64 of 169.254.169.254
    '64:ff9b::10.0.0.1',
    '2002:a9fe:a9fe::1', // 6to4 of 169.254.169.254
    '2002:0a00:0001::1',
  ])('blocks %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888', '64:ff9b::808:808', '2002:0808:0808::1'])(
    'allows public %s',
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );
});

describe('assertSafeModelEndpoint', () => {
  it('in production refuses plain http', async () => {
    await expect(assertSafeModelEndpoint('http://api.openai.com/v1', { production: true })).rejects.toThrow(
      BlockedHostError,
    );
  });

  it('in production refuses the metadata address and private hosts', async () => {
    for (const u of ['https://169.254.169.254/v1', 'https://10.0.0.5/v1', 'https://[::1]/v1', 'https://127.0.0.1:11434/v1']) {
      await expect(assertSafeModelEndpoint(u, { production: true })).rejects.toThrow(BlockedHostError);
    }
  });

  it('outside production lets a developer use a local Ollama', async () => {
    await expect(assertSafeModelEndpoint('http://127.0.0.1:11434/v1', { production: false })).resolves.toBeUndefined();
  });

  it('refuses a non-http scheme anywhere', async () => {
    await expect(assertSafeModelEndpoint('file:///etc/passwd', { production: false })).rejects.toThrow(BlockedHostError);
  });

  it('the client fetch screens every request, so a stored URL is checked at use too', async () => {
    const f = modelEndpointFetch({ production: true });
    await expect(f('https://169.254.169.254/v1/chat/completions', { method: 'POST' })).rejects.toThrow(BlockedHostError);
  });
});

describe('safeFileHeaders', () => {
  it('serves HTML, SVG, XML and JS as a download of bytes', () => {
    for (const m of ['text/html', 'image/svg+xml', 'application/xml', 'application/javascript', 'application/xhtml+xml']) {
      const h = safeFileHeaders(m, 'x', { inline: true });
      expect(h['content-type']).toBe('application/octet-stream');
      expect(h['content-disposition']).toMatch(/^attachment;/);
      expect(h['x-content-type-options']).toBe('nosniff');
    }
  });

  it('shows images and PDF inline when asked', () => {
    expect(safeFileHeaders('image/png', 'a.png', { inline: true })['content-disposition']).toMatch(/^inline;/);
    expect(safeFileHeaders('application/pdf', 'a.pdf', { inline: true })['content-type']).toBe('application/pdf');
  });

  it('keeps a passive type but still downloads it', () => {
    const h = safeFileHeaders('text/plain', 'a.txt', { inline: true });
    expect(h['content-type']).toBe('text/plain');
    expect(h['content-disposition']).toMatch(/^attachment;/);
  });

  it('counts a missing type as active', () => {
    expect(isActiveContentType('')).toBe(true);
    expect(isActiveContentType(null)).toBe(true);
  });
});

describe('storageKeysToClearOnSignOut', () => {
  it('clears caches, the token and id maps but keeps layout prefs', () => {
    const keys = [
      'chord.token',
      'email.threads.cache.v1',
      'calendar.cache.v1',
      'email.decisions.notNow.v1',
      'email.account',
      'chord:applesync:idmap:event',
      'chord.location.enabled',
      ...KEPT_ON_SIGN_OUT,
    ];
    const cleared = storageKeysToClearOnSignOut(keys);
    expect(cleared).toEqual(keys.slice(0, 7));
  });
});
