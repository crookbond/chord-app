/**
 * Sign in with Apple (ADR 0156) — server half, without an SDK.
 *
 * The app sends Apple's single-use authorization code; we exchange it at
 * Apple's token endpoint with a client secret we sign ourselves (ES256 JWT
 * from the team's .p8 key). The id_token in that response came straight from
 * Apple over TLS, so — per OpenID Connect Core §3.1.3.7 — we validate its
 * claims rather than its signature, and never trust the token the client holds.
 */
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import type { Kysely } from 'kysely';

import { API } from '@chord/kernel';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { openToken, sealToken } from '../../utils/crypto-tokens.js';

const APPLE_ISSUER = 'https://appleid.apple.com';
const TOKEN_ENDPOINT = 'https://appleid.apple.com/auth/token';
const REVOKE_ENDPOINT = 'https://appleid.apple.com/auth/revoke';
/** The display name of an account Apple shared no name for (relay address). */
export const APPLE_FALLBACK_NAME = 'Chord user';
/** Apple accepts a client secret valid for up to six months; we mint one per call. */
const CLIENT_SECRET_TTL_S = 5 * 60;

export interface AppleIdentity {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  /** An @privaterelay.appleid.com forwarding address, not the user's own. */
  isPrivateEmail: boolean;
}

export interface AppleExchangeResult {
  identity: AppleIdentity;
  refreshToken: string | null;
}

/** On only when the flow can also be undone: revocation needs the same key. */
export function appleSignInConfigured(): boolean {
  return (
    env.AUTH_MODE === 'google' &&
    env.APPLE_TEAM_ID !== '' &&
    env.APPLE_KEY_ID !== '' &&
    env.APPLE_PRIVATE_KEY !== ''
  );
}

/**
 * Which Apple client a sign-in came through. Apple issues a code (and the
 * refresh token behind it) to ONE client id: the app's bundle id on iOS, the
 * Services ID on the web. The exchange, the audience check and the revoke all
 * have to name the same one.
 */
export type AppleClient = 'ios' | 'web';

export function appleClientId(client: AppleClient): string {
  return client === 'web' ? env.APPLE_SERVICES_ID : env.APPLE_BUNDLE_ID;
}

/** The web flow needs everything the iOS one does, plus a Services ID and a
 *  public address Apple can send the browser back to. */
export function appleWebSignInConfigured(): boolean {
  return appleSignInConfigured() && env.APPLE_SERVICES_ID !== '' && appleWebRedirectUri() !== '';
}

/** Where Apple posts the browser back to. Must match, character for character,
 *  a Return URL registered on the Services ID. */
export function appleWebRedirectUri(): string {
  let origin = env.WEB_ORIGIN.replace(/\/$/, '');
  if (!origin) {
    try {
      origin = new URL(env.SIGNUP_URL).origin;
    } catch {
      return '';
    }
  }
  // Apple refuses anything but https (and has no localhost exception).
  return origin.startsWith('https://') ? `${origin}${API.authAppleCallback}` : '';
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * The .p8 as full PEM (real or `\n`-escaped newlines), or as just the base64
 * between its BEGIN/END lines. The one-line body is the form that survives
 * every env-file parser — systemd's EnvironmentFile included — so it is the
 * one example.env recommends.
 */
export function loadApplePrivateKey(raw: string): KeyObject {
  const value = raw.trim().replace(/^["']|["']$/g, '');
  if (value.includes('-----BEGIN')) return createPrivateKey(value.replace(/\\n/g, '\n'));
  return createPrivateKey({
    key: Buffer.from(value.replace(/\\n|\s+/g, ''), 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
}

/** ES256 JWT Apple requires as `client_secret` on both token and revoke calls. */
export function buildAppleClientSecret(
  nowMs: number = Date.now(),
  client: AppleClient = 'ios',
): string {
  const iat = Math.floor(nowMs / 1000);
  const header = { alg: 'ES256', kid: env.APPLE_KEY_ID, typ: 'JWT' };
  const claims = {
    iss: env.APPLE_TEAM_ID,
    iat,
    exp: iat + CLIENT_SECRET_TTL_S,
    aud: APPLE_ISSUER,
    sub: appleClientId(client),
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const key = loadApplePrivateKey(env.APPLE_PRIVATE_KEY);
  // JWS wants the raw r||s signature, not the DER encoding node defaults to.
  const signature = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `${signingInput}.${base64url(signature)}`;
}

function truthy(v: unknown): boolean {
  return v === true || v === 'true';
}

/** Validate the claims of an id_token received directly from Apple's token endpoint. */
export function parseAppleIdToken(
  idToken: string,
  nowMs: number = Date.now(),
  client: AppleClient = 'ios',
): AppleIdentity {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('apple id_token is not a JWT');
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('apple id_token payload is not JSON');
  }
  if (claims.iss !== APPLE_ISSUER) throw new Error('apple id_token issuer mismatch');
  const aud = claims.aud;
  const expected = appleClientId(client);
  const audOk = Array.isArray(aud) ? aud.includes(expected) : aud === expected;
  if (!audOk) throw new Error('apple id_token audience mismatch');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= nowMs) {
    throw new Error('apple id_token expired');
  }
  if (typeof claims.sub !== 'string' || claims.sub === '') throw new Error('apple id_token missing sub');
  const email = typeof claims.email === 'string' && claims.email !== '' ? claims.email.toLowerCase() : null;
  return {
    sub: claims.sub,
    email,
    emailVerified: truthy(claims.email_verified),
    isPrivateEmail: truthy(claims.is_private_email) || /@privaterelay\.appleid\.com$/.test(email ?? ''),
  };
}

export class AppleAuthError extends Error {}

/** Exchange the app's authorization code for Apple's tokens + the user's identity. */
export async function exchangeAppleCode(
  code: string,
  client: AppleClient = 'ios',
): Promise<AppleExchangeResult> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: appleClientId(client),
      client_secret: buildAppleClientSecret(Date.now(), client),
      code,
      grant_type: 'authorization_code',
      // Required whenever the authorization request carried one - the web's did.
      ...(client === 'web' ? { redirect_uri: appleWebRedirectUri() } : {}),
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new AppleAuthError(`apple token endpoint ${res.status}: ${text.slice(0, 300)}`);
  }
  let body: { id_token?: string; refresh_token?: string };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new AppleAuthError(`apple token endpoint returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (!body.id_token) throw new AppleAuthError('apple token response missing id_token');
  return {
    identity: parseAppleIdToken(body.id_token, Date.now(), client),
    refreshToken: body.refresh_token ?? null,
  };
}

export async function persistAppleRefreshToken(
  db: Kysely<DB>,
  userId: string,
  refreshToken: string,
): Promise<void> {
  const sealed = sealToken(refreshToken);
  await db
    .updateTable('users')
    .set({
      apple_refresh_token_ciphertext: sealed.ciphertext,
      apple_refresh_token_iv: sealed.iv,
      apple_refresh_token_tag: sealed.tag,
    })
    .where('id', '=', userId)
    .execute();
}

/**
 * Best-effort revoke at Apple before account deletion (Apple requires it for
 * apps offering Sign in with Apple). Never throws: deletion must not block on
 * Apple, and the stored token goes with the user row regardless.
 */
export async function revokeAppleTokens(db: Kysely<DB>, userId: string): Promise<boolean> {
  const row = await db
    .selectFrom('users')
    .select(['apple_refresh_token_ciphertext', 'apple_refresh_token_iv', 'apple_refresh_token_tag'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!row?.apple_refresh_token_ciphertext || !row.apple_refresh_token_iv || !row.apple_refresh_token_tag) {
    return false;
  }
  if (!appleSignInConfigured()) {
    logger.warn('apple revoke skipped: APPLE_* keys not configured', { userId });
    return false;
  }
  try {
    const token = openToken({
      ciphertext: row.apple_refresh_token_ciphertext as Buffer,
      iv: row.apple_refresh_token_iv as Buffer,
      tag: row.apple_refresh_token_tag as Buffer,
    });
    // The stored token is the newest sign-in's, and we do not record which
    // client that was. Apple revokes a token only for the client it was issued
    // to, so ask as each client we are configured for; one of them owns it.
    const clients: AppleClient[] = appleWebSignInConfigured() ? ['ios', 'web'] : ['ios'];
    let revoked = false;
    for (const client of clients) {
      const res = await fetch(REVOKE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: appleClientId(client),
          client_secret: buildAppleClientSecret(Date.now(), client),
          token,
          token_type_hint: 'refresh_token',
        }).toString(),
      });
      if (res.ok) revoked = true;
      else logger.warn('apple revoke: unexpected status', { status: res.status, userId, client });
    }
    return revoked;
  } catch (err) {
    logger.warn('apple revoke failed', { err, userId });
    return false;
  }
}

/**
 * ADR 0156 §5 — an Apple-only account that connects a Google account already
 * belonging to another user is re-pointed there; carry the Apple identity
 * along so the next Apple sign-in lands in the same account. No-op when the
 * source has no Apple identity or the target already has one.
 */
export async function moveAppleIdentity(
  db: Kysely<DB>,
  fromUserId: string,
  toUserId: string,
): Promise<boolean> {
  if (fromUserId === toUserId) return false;
  return db.transaction().execute((trx) => moveAppleIdentityIn(trx, fromUserId, toUserId));
}

export async function moveAppleIdentityIn(
  trx: Kysely<DB>,
  fromUserId: string,
  toUserId: string,
): Promise<boolean> {
  const [from, to] = await Promise.all([
    trx
      .selectFrom('users')
      .select(['apple_sub', 'apple_refresh_token_ciphertext', 'apple_refresh_token_iv', 'apple_refresh_token_tag'])
      .where('id', '=', fromUserId)
      .executeTakeFirst(),
    trx.selectFrom('users').select('apple_sub').where('id', '=', toUserId).executeTakeFirst(),
  ]);
  if (!from?.apple_sub || !to || to.apple_sub) return false;
  // Clear first: apple_sub is unique.
  await trx
    .updateTable('users')
    .set({
      apple_sub: null,
      apple_refresh_token_ciphertext: null,
      apple_refresh_token_iv: null,
      apple_refresh_token_tag: null,
    })
    .where('id', '=', fromUserId)
    .execute();
  await trx
    .updateTable('users')
    .set({
      apple_sub: from.apple_sub,
      apple_refresh_token_ciphertext: from.apple_refresh_token_ciphertext,
      apple_refresh_token_iv: from.apple_refresh_token_iv,
      apple_refresh_token_tag: from.apple_refresh_token_tag,
    })
    .where('id', '=', toUserId)
    .execute();
  return true;
}
