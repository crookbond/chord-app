import { generateKeyPairSync, verify } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import {
  appleSignInConfigured,
  buildAppleClientSecret,
  parseAppleIdToken,
} from '@/services/apple/apple-auth.service.js';

type AppleEnv = {
  AUTH_MODE: string;
  APPLE_TEAM_ID: string;
  APPLE_KEY_ID: string;
  APPLE_PRIVATE_KEY: string;
  APPLE_BUNDLE_ID: string;
};
const e = env as unknown as AppleEnv;
const saved = { ...e };

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function jwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256', kid: 'k' })}.${enc(claims)}.sig`;
}

const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);
const valid = (over: Record<string, unknown> = {}) => ({
  iss: 'https://appleid.apple.com',
  aud: 'app.chord.demo',
  exp: NOW / 1000 + 600,
  sub: '001234.abcd.0999',
  email: 'Ann@Example.com',
  email_verified: 'true',
  ...over,
});

describe('apple auth (ADR 0156)', () => {
  beforeEach(() => {
    e.AUTH_MODE = 'google';
    e.APPLE_TEAM_ID = 'TEAM123456';
    e.APPLE_KEY_ID = 'KEY1234567';
    // One-line envs carry the .p8 with literal \n sequences.
    e.APPLE_PRIVATE_KEY = PEM.replace(/\n/g, '\\n');
    e.APPLE_BUNDLE_ID = 'app.chord.demo';
  });

  afterEach(() => {
    Object.assign(e, saved);
  });

  it('signs a client secret Apple can verify, with the claims it requires', () => {
    const secret = buildAppleClientSecret(NOW);
    const [h, c, s] = secret.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());

    expect(header).toEqual({ alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' });
    expect(claims).toMatchObject({
      iss: 'TEAM123456',
      sub: 'app.chord.demo',
      aud: 'https://appleid.apple.com',
      iat: NOW / 1000,
    });
    expect(claims.exp - claims.iat).toBe(300);
    const ok = verify(
      'sha256',
      Buffer.from(`${h}.${c}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url'),
    );
    expect(ok).toBe(true);
  });

  it.each([
    ['the one-line base64 body', PEM.replace(/-----[A-Z ]+-----|\s+/g, '')],
    ['full PEM', PEM],
    ['PEM with escaped newlines', PEM.replace(/\n/g, '\\n')],
  ])('accepts the .p8 as %s', (_label, raw) => {
    e.APPLE_PRIVATE_KEY = raw;
    const [h, c, s] = buildAppleClientSecret(NOW).split('.');
    const ok = verify(
      'sha256',
      Buffer.from(`${h}.${c}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(s, 'base64url'),
    );
    expect(ok).toBe(true);
  });

  it('reads the identity from a valid id_token', () => {
    expect(parseAppleIdToken(jwt(valid()), NOW)).toEqual({
      sub: '001234.abcd.0999',
      email: 'ann@example.com',
      emailVerified: true,
      isPrivateEmail: false,
    });
  });

  it('marks a relay address private by claim or by domain', () => {
    expect(parseAppleIdToken(jwt(valid({ is_private_email: true })), NOW).isPrivateEmail).toBe(true);
    expect(
      parseAppleIdToken(jwt(valid({ email: 'x7k2@privaterelay.appleid.com' })), NOW).isPrivateEmail,
    ).toBe(true);
  });

  it('treats a missing email as absent, not as an error', () => {
    const id = parseAppleIdToken(jwt(valid({ email: undefined, email_verified: undefined })), NOW);
    expect(id.email).toBeNull();
    expect(id.emailVerified).toBe(false);
  });

  it.each([
    ['issuer', { iss: 'https://evil.example' }],
    ['audience', { aud: 'com.someone.else' }],
    ['expiry', { exp: NOW / 1000 - 1 }],
    ['subject', { sub: '' }],
  ])('rejects a wrong %s', (_label, over) => {
    expect(() => parseAppleIdToken(jwt(valid(over)), NOW)).toThrow();
  });

  it('is on only in google auth mode with all three secrets', () => {
    expect(appleSignInConfigured()).toBe(true);
    e.APPLE_PRIVATE_KEY = '';
    expect(appleSignInConfigured()).toBe(false);
    e.APPLE_PRIVATE_KEY = PEM;
    e.AUTH_MODE = 'demo';
    expect(appleSignInConfigured()).toBe(false);
  });
});
