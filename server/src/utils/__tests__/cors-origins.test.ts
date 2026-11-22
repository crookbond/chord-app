/**
 * CASA 6.3.1 scan (2026-10-21): `cors({ origin: true, credentials: true })`
 * echoed any Origin back with credentials, so the scanner's random origins
 * (https://nqpbkzmlxibs.com on /health, https://aeuwdtuamkvx.com on /me,
 * https://adytcnjclcfp.com on POST /waitlist) were allowed to read responses
 * with the user's cookie.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '@/app.js';
import type { DB } from '@/db/schema.js';
import { buildCorsOriginCheck } from '@/utils/cors-origins.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

describe('buildCorsOriginCheck', () => {
  const prod = buildCorsOriginCheck({
    production: true,
    extra: 'https://staging.chordapp.ai, not a url',
    webOrigin: '',
    signupUrl: 'https://chordapp.ai/signup',
  });

  it('refuses the origins the scan used', () => {
    expect(prod('https://nqpbkzmlxibs.com')).toBe(false);
    expect(prod('https://aeuwdtuamkvx.com')).toBe(false);
    expect(prod('https://adytcnjclcfp.com')).toBe(false);
  });

  it("allows Chord's own websites and listed extras", () => {
    expect(prod('https://chordapp.ai')).toBe(true);
    expect(prod('https://www.chordapp.ai')).toBe(true);
    expect(prod('https://staging.chordapp.ai')).toBe(true);
  });

  it('refuses look-alikes and null', () => {
    expect(prod('https://chordapp.ai.evil.com')).toBe(false);
    expect(prod('https://evilchordapp.ai')).toBe(false);
    expect(prod('http://chordapp.ai')).toBe(false);
    expect(prod('null')).toBe(false);
  });

  it('allows a request with no Origin (native app, server to server)', () => {
    expect(prod(undefined)).toBe(true);
  });

  it('allows localhost and LAN only outside production', () => {
    const dev = buildCorsOriginCheck({ production: false, extra: '', webOrigin: '', signupUrl: '' });
    expect(dev('http://localhost:8081')).toBe(true);
    expect(dev('http://192.168.1.20:8081')).toBe(true);
    expect(prod('http://localhost:8081')).toBe(false);
    expect(dev('https://nqpbkzmlxibs.com')).toBe(false);
  });
});

describe('API CORS headers', () => {
  let db: Kysely<DB>;
  let server: http.Server;
  let base: string;

  beforeEach(async () => {
    db = await openTestDb();
    server = http.createServer(buildApp(db));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await closeTestDb(db);
  });

  it('sends no allow-origin header to a foreign origin', async () => {
    for (const [path, origin] of [
      ['/api/v1/health', 'https://nqpbkzmlxibs.com'],
      ['/api/v1/me', 'https://aeuwdtuamkvx.com'],
    ]) {
      const res = await fetch(base + path, { headers: { origin } });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
    const pre = await fetch(base + '/api/v1/waitlist', {
      method: 'OPTIONS',
      headers: { origin: 'https://adytcnjclcfp.com', 'access-control-request-method': 'POST' },
    });
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows chordapp.ai with credentials', async () => {
    const res = await fetch(base + '/api/v1/health', { headers: { origin: 'https://www.chordapp.ai' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('https://www.chordapp.ai');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });
});
