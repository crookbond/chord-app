/**
 * Google OAuth code-exchange + token-refresh helpers (ADR 0014).
 *
 * No SDK dependency: we hit Google's public OAuth endpoints directly with
 * fetch. The flow is small enough that a library would obscure more than it
 * helps, and the surface is stable.
 *
 * Token storage shape:
 *   - Refresh token is encrypted via `utils/crypto-tokens.ts` and stored on
 *     the users row (refresh_token_ciphertext / iv / tag + scopes).
 *   - Access tokens are short-lived; we never persist them. Each call to
 *     `getAccessToken(db, userId)` exchanges the stored refresh token for a
 *     fresh access token via Google's `/token` endpoint.
 */
import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { cachedAccessToken, type MintedAccessToken } from '../../utils/access-token-cache.js';
import { openToken, sealToken } from '../../utils/crypto-tokens.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const TOKENINFO_ENDPOINT = 'https://oauth2.googleapis.com/tokeninfo';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/**
 * Raised when a Google token operation fails in a way the user must resolve by
 * re-authenticating. `needsReconnect` marks the "stored refresh token is gone
 * or dead" case (as opposed to a transient network / 5xx). `oauthError` carries
 * Google's machine-readable code (e.g. `invalid_grant`) when the body had one.
 */
export class GoogleAuthError extends Error {
  readonly needsReconnect: boolean;
  readonly oauthError?: string;
  constructor(message: string, opts: { needsReconnect?: boolean; oauthError?: string } = {}) {
    super(message);
    this.name = 'GoogleAuthError';
    this.needsReconnect = opts.needsReconnect ?? false;
    this.oauthError = opts.oauthError;
  }
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  givenName?: string;
  familyName?: string;
  picture?: string;
}

export interface ExchangeResult {
  identity: GoogleIdentity;
  /** Plaintext refresh token. May be absent if Google chose not to issue one
   *  (e.g. the user had previously consented and the request didn't include
   *  `prompt=consent`). Caller should handle the absent case. */
  refreshToken: string | null;
  /** Space-separated scopes Google actually granted. */
  grantedScopes: string;
  /** Client id the tokens were issued to. Refresh tokens are bound to it, so
   *  it's persisted alongside the refresh token and reused on every refresh. */
  clientId: string;
}

interface TokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
  token_type?: string;
}

interface TokenInfoResponse {
  sub?: string;
  email?: string;
  email_verified?: string | boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  aud?: string;
  exp?: string;
}

function assertConfigured(): void {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error(
      'Google OAuth not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET',
    );
  }
}

/** Reversed-client-id custom scheme Google mandates for native iOS clients,
 *  e.g. `com.googleusercontent.apps.123-abc:/oauthredirect`. The native app's
 *  redirect_uri starts with this; the web flow uses an https redirect. */
const IOS_REDIRECT_PREFIX = 'com.googleusercontent.apps.';

interface OAuthClient {
  clientId: string;
  /** Confidential (web) clients send a secret; public (iOS) clients must not. */
  clientSecret?: string;
}

/**
 * Pick the OAuth client a code exchange must use, from the redirect_uri the
 * client ran the authorization with. Google binds the issued refresh token to
 * this client, so {@link getAccessToken} must later refresh with the same one.
 */
export function clientForRedirect(redirectUri: string): OAuthClient {
  if (redirectUri.startsWith(IOS_REDIRECT_PREFIX)) {
    if (!env.GOOGLE_CLIENT_ID_IOS) {
      throw new Error('Google iOS OAuth not configured: set GOOGLE_CLIENT_ID_IOS');
    }
    return { clientId: env.GOOGLE_CLIENT_ID_IOS };
  }
  return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
}

/**
 * Resolve the client for a stored refresh token by the client id it was issued
 * to. Only the web client carries a secret; any other id is treated as a public
 * (native) client. A null/legacy stored id is passed as the web id by callers.
 */
function clientById(clientId: string): OAuthClient {
  if (clientId === env.GOOGLE_CLIENT_ID) {
    return { clientId, clientSecret: env.GOOGLE_CLIENT_SECRET };
  }
  return { clientId };
}

async function postForm(url: string, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    // Google's OAuth error body is `{ "error": "invalid_grant", ... }`. Surface
    // that code so callers can distinguish a dead refresh token from a transient
    // failure without string-matching the message.
    let oauthError: string | undefined;
    try {
      oauthError = (JSON.parse(text) as { error?: string }).error;
    } catch {
      /* non-JSON error body — leave oauthError undefined */
    }
    throw new GoogleAuthError(`google token endpoint ${res.status}: ${text.slice(0, 300)}`, {
      oauthError,
    });
  }
  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(`google token endpoint returned non-JSON: ${text.slice(0, 200)}`);
  }
}

/**
 * Verify a Google id_token via the public tokeninfo endpoint. Validates
 * signature, expiry, and audience server-side so we don't have to do JWKS
 * locally. Network call; in PR2/PR3 we may want to cache certs and verify
 * locally, but for login it's fine.
 */
async function verifyIdToken(idToken: string): Promise<GoogleIdentity> {
  const url = `${TOKENINFO_ENDPOINT}?id_token=${encodeURIComponent(idToken)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`tokeninfo ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const info = (await res.json()) as TokenInfoResponse;
  // The id_token's audience is whichever client requested it — web or iOS.
  const allowedAud = [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_ID_IOS].filter(Boolean);
  if (!info.aud || !allowedAud.includes(info.aud)) {
    throw new Error('id_token audience mismatch');
  }
  if (!info.sub || !info.email) {
    throw new Error('id_token missing sub/email');
  }
  return {
    sub: info.sub,
    email: info.email,
    emailVerified: info.email_verified === true || info.email_verified === 'true',
    name: info.name,
    givenName: info.given_name,
    familyName: info.family_name,
    picture: info.picture,
  };
}

/**
 * Exchange an OAuth authorization code for tokens + identity. The mobile
 * client runs PKCE and posts the code + verifier here; we forward to Google.
 */
export async function exchangeCode(opts: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<ExchangeResult> {
  assertConfigured();
  const client = clientForRedirect(opts.redirectUri);
  const body: Record<string, string> = {
    client_id: client.clientId,
    code: opts.code,
    code_verifier: opts.codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: opts.redirectUri,
  };
  if (client.clientSecret) body.client_secret = client.clientSecret;
  const tokens = await postForm(TOKEN_ENDPOINT, body);
  if (!tokens.id_token) {
    throw new Error('google response missing id_token');
  }
  const identity = await verifyIdToken(tokens.id_token);
  return {
    identity,
    refreshToken: tokens.refresh_token ?? null,
    grantedScopes: tokens.scope ?? '',
    clientId: client.clientId,
  };
}

/**
 * Persist a freshly-issued refresh token onto the user row. Caller controls
 * `scopes` so incremental-consent flows (PR2: calendar) can union-merge the
 * new scope with whatever was previously granted.
 */
export async function persistRefreshToken(
  db: Kysely<DB>,
  userId: string,
  refreshToken: string,
  scopes: string,
  clientId: string = env.GOOGLE_CLIENT_ID,
): Promise<void> {
  const sealed = sealToken(refreshToken);
  const patch = {
    refresh_token_ciphertext: sealed.ciphertext,
    refresh_token_iv: sealed.iv,
    refresh_token_tag: sealed.tag,
    refresh_token_scopes: scopes,
    refresh_token_client_id: clientId,
    google_connected_at: new Date().toISOString(),
    // Reconnected — let a future disconnect warn again.
    calendar_reconnect_nudged_at: null as null,
    ...( /https:\/\/www\.googleapis\.com\/auth\/gmail\.modify/.test(scopes)
      ? { gmail_reconnect_nudged_at: null as null }
      : {}),
  };
  await db.updateTable('users').set(patch).where('id', '=', userId).execute();
  forgetAccessToken(userId);
}

/**
 * Access tokens live an hour, and the calendar sync exchanged the refresh token
 * for a NEW one on every push, pull and foreground refresh: in the load test
 * 4,554 exchanges in 75 s, each a round trip to Google (and each counted
 * against its token endpoint) before the real call even started. A token is
 * reused for a few minutes instead. The cap is deliberately far below the hour:
 * a token Google revoked keeps working until it lapses, and the sooner it
 * lapses the sooner the next exchange reports `invalid_grant` and the user is
 * asked to reconnect.
 */
const ACCESS_TOKEN_MAX_REUSE_MS = 10 * 60_000;
const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 60_000;
const ACCESS_TOKEN_CACHE_MAX = 20_000;
const accessTokens = new Map<string, { token: string; expiresAt: number }>();

/**
 * Drop a user's cached access token. Called wherever the refresh token or its
 * granted scopes change: an access token carries the scopes it was minted with,
 * so one cached before an incremental consent would keep failing after it.
 */
export function forgetAccessToken(userId: string): void {
  accessTokens.delete(userId);
}

/** Test seam: forget every cached access token. */
export function _resetAccessTokenCacheForTests(): void {
  accessTokens.clear();
}

/**
 * Exchange the stored refresh token for a short-lived access token. Throws
 * if the user has no refresh token on file. PR2/PR3 callers (calendar) use
 * this on every request — Google's token endpoint is fine with that.
 */
export async function getAccessToken(
  db: Kysely<DB>,
  userId: string,
): Promise<string> {
  assertConfigured();
  const cached = accessTokens.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const row = await db
    .selectFrom('users')
    .select([
      'refresh_token_ciphertext',
      'refresh_token_iv',
      'refresh_token_tag',
      'refresh_token_client_id',
    ])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!row || !row.refresh_token_ciphertext || !row.refresh_token_iv || !row.refresh_token_tag) {
    throw new GoogleAuthError(`user ${userId} has no Google refresh token on file`, {
      needsReconnect: true,
    });
  }
  const refreshToken = openToken({
    ciphertext: row.refresh_token_ciphertext as Buffer,
    iv: row.refresh_token_iv as Buffer,
    tag: row.refresh_token_tag as Buffer,
  });
  // Refresh with the client that issued the token. Legacy rows predating the
  // client-id column are null → web client (the only one that existed then).
  const client = clientById(row.refresh_token_client_id ?? env.GOOGLE_CLIENT_ID);
  let tokens: TokenResponse;
  try {
    const body: Record<string, string> = {
      client_id: client.clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    };
    if (client.clientSecret) body.client_secret = client.clientSecret;
    tokens = await postForm(TOKEN_ENDPOINT, body);
  } catch (err) {
    // `invalid_grant` means the refresh token is dead: revoked by the user,
    // expired (Google expires them after 7 days while the OAuth app is in
    // "Testing" publishing status), invalidated by a password change, or
    // evicted past the ~50-token-per-user cap. Clear it so the connection state
    // stops lying — `hasCalendarScope` / `/me/calendar/status` read the now-null
    // scopes and report connected:false — and the user is prompted to reconnect,
    // instead of every calendar call silently failing forever.
    if (err instanceof GoogleAuthError && err.oauthError === 'invalid_grant') {
      await clearRefreshToken(db, userId);
      throw new GoogleAuthError(
        `google refresh token rejected (invalid_grant) for user ${userId} — reconnect required`,
        { needsReconnect: true, oauthError: 'invalid_grant' },
      );
    }
    throw err;
  }
  if (!tokens.access_token) {
    throw new Error('google refresh response missing access_token');
  }
  const lifetimeMs = (tokens.expires_in ?? 0) * 1000 - ACCESS_TOKEN_EXPIRY_MARGIN_MS;
  if (lifetimeMs > 0) {
    if (accessTokens.size >= ACCESS_TOKEN_CACHE_MAX) accessTokens.clear();
    accessTokens.set(userId, {
      token: tokens.access_token,
      expiresAt: Date.now() + Math.min(lifetimeMs, ACCESS_TOKEN_MAX_REUSE_MS),
    });
  }
  return tokens.access_token;
}

/**
 * ADR 0080 addendum — refresh a SECONDARY account's Google access token from
 * a raw refresh token (not the users-row token). The caller owns storage and
 * dead-token handling; `invalid_grant` surfaces as GoogleAuthError with
 * `needsReconnect` so the account can be flagged, never the users row.
 */
export async function refreshAccessTokenWith(
  refreshToken: string,
  clientId: string,
  /** ADR 0313 — told the scopes Google says this token carries, on each
   *  real exchange (not on a cache hit). */
  onGrantedScopes?: (scopes: string) => void,
): Promise<string> {
  assertConfigured();
  const client = clientById(clientId || env.GOOGLE_CLIENT_ID);
  // Reused like the primary token above: every open of a secondary mailbox's
  // email and every sync of it otherwise starts with a round trip to Google.
  return cachedAccessToken(`google:${client.clientId}`, refreshToken, async () => {
    const minted = await mintAccessTokenWith(refreshToken, client);
    if (minted.grantedScopes !== undefined) onGrantedScopes?.(minted.grantedScopes);
    return minted;
  });
}

async function mintAccessTokenWith(
  refreshToken: string,
  client: OAuthClient,
): Promise<MintedAccessToken> {
  const body: Record<string, string> = {
    client_id: client.clientId,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  };
  if (client.clientSecret) body.client_secret = client.clientSecret;
  let tokens: TokenResponse;
  try {
    tokens = await postForm(TOKEN_ENDPOINT, body);
  } catch (err) {
    if (err instanceof GoogleAuthError && err.oauthError === 'invalid_grant') {
      throw new GoogleAuthError('google refresh token rejected (invalid_grant)', {
        needsReconnect: true,
        oauthError: 'invalid_grant',
      });
    }
    throw err;
  }
  if (!tokens.access_token) {
    throw new Error('google refresh response missing access_token');
  }
  return {
    accessToken: tokens.access_token,
    expiresIn: tokens.expires_in,
    ...(typeof tokens.scope === 'string' ? { grantedScopes: tokens.scope } : {}),
  };
}

/**
 * Best-effort revocation of the user's Google authorization at Google itself
 * (account deletion). Revoking the refresh token invalidates every access
 * token derived from it, so Chord's grant disappears from the user's Google
 * account "Third-party access" list — not just locally. Network/credential
 * failures are swallowed: the caller deletes the stored token regardless, so
 * a failed revoke must never block account deletion. Returns whether Google
 * acknowledged the revoke (useful for logs/tests).
 */
export async function revokeGoogleTokens(db: Kysely<DB>, userId: string): Promise<boolean> {
  const row = await db
    .selectFrom('users')
    .select(['refresh_token_ciphertext', 'refresh_token_iv', 'refresh_token_tag'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!row || !row.refresh_token_ciphertext || !row.refresh_token_iv || !row.refresh_token_tag) {
    return false;
  }
  let refreshToken: string;
  try {
    refreshToken = openToken({
      ciphertext: row.refresh_token_ciphertext as Buffer,
      iv: row.refresh_token_iv as Buffer,
      tag: row.refresh_token_tag as Buffer,
    });
  } catch (err) {
    logger.warn('google revoke: could not decrypt stored token', { err, userId });
    return false;
  }
  try {
    const res = await fetch(REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    });
    // 200 = revoked; 400 = already invalid/expired (effectively revoked).
    if (!res.ok && res.status !== 400) {
      logger.warn('google revoke: unexpected status', { status: res.status, userId });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn('google revoke: request failed', { err, userId });
    return false;
  }
}

/** Test/admin helper — wipe the stored refresh token (e.g. on signout-everywhere). */
export async function clearRefreshToken(db: Kysely<DB>, userId: string): Promise<void> {
  await db
    .updateTable('users')
    .set({
      refresh_token_ciphertext: null,
      refresh_token_iv: null,
      refresh_token_tag: null,
      refresh_token_scopes: null,
      refresh_token_client_id: null,
    })
    .where('id', '=', userId)
    .execute();
  forgetAccessToken(userId);
  logger.info(`cleared google refresh token for user ${userId}`);
}
