import { createHash } from 'node:crypto';

/**
 * Reuse of short-lived OAuth access tokens minted from a stored refresh token.
 * Keyed on the refresh token ITSELF (hashed), not just the mailbox: a reconnect
 * stores a new refresh token and so misses, with no invalidation hook to
 * forget, and a provider that rotates the refresh token on every exchange
 * (Microsoft) files the new access token under the new refresh token.
 *
 * Same caps as the primary Google cache (ADR 0204): at most 10 minutes, and a
 * minute short of the provider's own expiry. Callers that miss at the same
 * moment (opening an email while the reader prefetches the next one) share
 * one exchange.
 */
const MAX_REUSE_MS = 10 * 60_000;
const EXPIRY_MARGIN_MS = 60_000;
const CACHE_MAX = 20_000;

const tokens = new Map<string, { token: string; expiresAt: number }>();
const inFlight = new Map<string, Promise<string>>();

export interface MintedAccessToken {
  accessToken: string;
  /** Seconds, as the token endpoint reports it. Absent = do not reuse. */
  expiresIn?: number;
  /** A rotated refresh token, when the provider returned a different one. */
  rotatedRefreshToken?: string;
  /** The scopes the provider says the token carries, when it says. */
  grantedScopes?: string;
}

function keyFor(scope: string, refreshToken: string): string {
  return `${scope}:${createHash('sha256').update(refreshToken).digest('base64url')}`;
}

function remember(key: string, minted: MintedAccessToken): void {
  const lifetimeMs = (minted.expiresIn ?? 0) * 1000 - EXPIRY_MARGIN_MS;
  if (lifetimeMs <= 0) return;
  if (tokens.size >= CACHE_MAX) tokens.clear();
  tokens.set(key, {
    token: minted.accessToken,
    expiresAt: Date.now() + Math.min(lifetimeMs, MAX_REUSE_MS),
  });
}

/**
 * A cached access token for (scope, refreshToken), else `mint()` once. `scope`
 * separates providers/clients that could in principle share a refresh string.
 */
export async function cachedAccessToken(
  scope: string,
  refreshToken: string,
  mint: () => Promise<MintedAccessToken>,
): Promise<string> {
  const key = keyFor(scope, refreshToken);
  const hit = tokens.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.token;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const run = (async () => {
    const minted = await mint();
    remember(key, minted);
    if (minted.rotatedRefreshToken && minted.rotatedRefreshToken !== refreshToken) {
      remember(keyFor(scope, minted.rotatedRefreshToken), minted);
    }
    return minted.accessToken;
  })();
  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    inFlight.delete(key);
  }
}

/** Test seam: forget every cached token. */
export function _resetAccessTokenReuseForTests(): void {
  tokens.clear();
  inFlight.clear();
}
