/**
 * Twilio Verify provider — HTTP-status → typed-result mapping (no network;
 * fetch is stubbed). The real API is exercised only in production.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import type { Kysely } from 'kysely';
import { twilioOtpProvider } from '@/services/phone/otp.js';

const db = null as unknown as Kysely<DB>; // twilio path never touches the DB

function stubFetch(status: number, body: unknown = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('twilioOtpProvider', () => {
  it('start maps 429 (max sends) to too_many_attempts', async () => {
    stubFetch(429);
    expect(await twilioOtpProvider.start(db, '+15551112222')).toEqual({
      ok: false,
      reason: 'too_many_attempts',
    });
  });

  it('start succeeds on 201', async () => {
    stubFetch(201);
    expect(await twilioOtpProvider.start(db, '+15551112222')).toEqual({ ok: true });
  });

  it('start throws on other failures (server fault, not user-fixable)', async () => {
    stubFetch(500, { message: 'boom' });
    await expect(twilioOtpProvider.start(db, '+15551112222')).rejects.toThrow(
      /twilio verify start failed \(500\)/,
    );
  });

  it('check maps approved to ok', async () => {
    stubFetch(200, { status: 'approved' });
    expect(await twilioOtpProvider.check(db, '+15551112222', '123456')).toEqual({ ok: true });
  });

  it('check maps pending (wrong code) to invalid_code', async () => {
    stubFetch(200, { status: 'pending' });
    expect(await twilioOtpProvider.check(db, '+15551112222', '000000')).toEqual({
      ok: false,
      reason: 'invalid_code',
    });
  });

  it('check maps 404 (expired / never started) to not_found', async () => {
    stubFetch(404);
    expect(await twilioOtpProvider.check(db, '+15551112222', '123456')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('check maps 429 (max checks) to too_many_attempts', async () => {
    stubFetch(429);
    expect(await twilioOtpProvider.check(db, '+15551112222', '123456')).toEqual({
      ok: false,
      reason: 'too_many_attempts',
    });
  });
});
