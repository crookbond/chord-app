import { describe, expect, it } from 'vitest';

import {
  PENDING_AUTH_MAX_AGE_MS,
  authRedirectOutcome,
  parseAuthRedirect,
  pendingAuthUsable,
  type PendingAuthRecord,
} from '@chord/kernel';

const NOW = Date.UTC(2026, 9, 29, 14, 4, 0);

function record(over: Partial<PendingAuthRecord> = {}): PendingAuthRecord {
  return {
    state: 'st-abc',
    codeVerifier: 'verifier-xyz',
    redirectUri: 'https://chordapp.ai/nativeauth',
    gmail: true,
    at: NOW - 30_000,
    ...over,
  };
}

describe('parseAuthRedirect', () => {
  it('reads the code and state out of the fallback deep link', () => {
    // The exact shape mobile/app/nativeauth.tsx builds when the App Link did
    // not verify - the 2026-10-29 Android failure.
    const parsed = parseAuthRedirect('chord://oauthredirect?code=4%2F0AX4&state=st-abc&scope=email');
    expect(parsed).toEqual({ code: '4/0AX4', state: 'st-abc', error: null });
  });

  it('reads an https App Link redirect the same way', () => {
    const parsed = parseAuthRedirect('https://chordapp.ai/nativeauth?code=abc&state=st-abc');
    expect(parsed?.code).toBe('abc');
    expect(parsed?.state).toBe('st-abc');
  });

  it('reports a denial rather than pretending nothing arrived', () => {
    const parsed = parseAuthRedirect('chord://oauthredirect?error=access_denied&state=st-abc');
    expect(parsed).toEqual({ code: null, state: 'st-abc', error: 'access_denied' });
  });

  it('ignores a deep link that carries no authorization outcome', () => {
    expect(parseAuthRedirect('chord://groups/123')).toBeNull();
    expect(parseAuthRedirect('https://chordapp.ai/join/ABC?utm=x')).toBeNull();
    expect(parseAuthRedirect('')).toBeNull();
    expect(parseAuthRedirect(null)).toBeNull();
  });

  it('stops at the fragment so a trailing hash cannot smuggle a code', () => {
    expect(parseAuthRedirect('chord://oauthredirect?state=st-abc#code=evil')).toBeNull();
  });
});

describe('pendingAuthUsable', () => {
  it('spends a fresh record on a redirect carrying its own state', () => {
    expect(pendingAuthUsable(record(), 'st-abc', NOW)).toBe(true);
  });

  it('refuses a state that does not match', () => {
    // Without this, a link anyone could craft spends a verifier we are holding.
    expect(pendingAuthUsable(record(), 'st-other', NOW)).toBe(false);
    expect(pendingAuthUsable(record(), null, NOW)).toBe(false);
  });

  it('refuses a record older than the window', () => {
    const stale = record({ at: NOW - PENDING_AUTH_MAX_AGE_MS - 1 });
    expect(pendingAuthUsable(stale, 'st-abc', NOW)).toBe(false);
  });

  it('keeps a record right at the edge of the window', () => {
    const edge = record({ at: NOW - PENDING_AUTH_MAX_AGE_MS });
    expect(pendingAuthUsable(edge, 'st-abc', NOW)).toBe(true);
  });

  it('tolerates a small clock nudge but not a far-future stamp', () => {
    expect(pendingAuthUsable(record({ at: NOW + 30_000 }), 'st-abc', NOW)).toBe(true);
    expect(pendingAuthUsable(record({ at: NOW + 10 * 60_000 }), 'st-abc', NOW)).toBe(false);
  });

  it('refuses a record with nothing to spend', () => {
    expect(pendingAuthUsable(null, 'st-abc', NOW)).toBe(false);
    expect(pendingAuthUsable(record({ codeVerifier: '' }), 'st-abc', NOW)).toBe(false);
    expect(pendingAuthUsable(record({ at: Number.NaN }), 'st-abc', NOW)).toBe(false);
  });
});

describe('authRedirectOutcome — the 2026-10-29 Android sign-in', () => {
  // The failure: Google consent succeeded, App Link verification had not taken,
  // /nativeauth handed the app `chord://oauthredirect?code=…`, Android
  // cold-started to deliver it, and the code was dropped. Prod saw no
  // POST /api/v1/auth/google at all.
  const FALLBACK_URL = 'chord://oauthredirect?code=4%2F0AVMBsJ&state=st-abc&scope=email+profile';

  it('turns the dropped fallback redirect into a spendable grant', () => {
    const outcome = authRedirectOutcome(FALLBACK_URL, record(), NOW);
    expect(outcome.kind).toBe('grant');
    if (outcome.kind !== 'grant') return;
    expect(outcome.grant.code).toBe('4/0AVMBsJ');
    expect(outcome.grant.codeVerifier).toBe('verifier-xyz');
    expect(outcome.grant.gmail).toBe(true);
  });

  it('exchanges against the authorization redirect, not the delivery URL', () => {
    // The grant was issued against https://chordapp.ai/nativeauth; sending
    // chord://oauthredirect to the token endpoint gets redirect_uri_mismatch.
    // This is the half that looks redundant and is not.
    const outcome = authRedirectOutcome(FALLBACK_URL, record(), NOW);
    if (outcome.kind !== 'grant') throw new Error('expected a grant');
    expect(outcome.grant.redirectUri).toBe('https://chordapp.ai/nativeauth');
    expect(outcome.grant.redirectUri).not.toContain('chord://');
  });

  it('answers the verified App Link path identically', () => {
    // Same record, the happy path's own URL - one decision serves both.
    const outcome = authRedirectOutcome(
      'https://chordapp.ai/nativeauth?code=4%2F0AVMBsJ&state=st-abc',
      record(),
      NOW,
    );
    expect(outcome).toEqual(authRedirectOutcome(FALLBACK_URL, record(), NOW));
  });

  it('ignores an ordinary deep link so a share link cannot spend a verifier', () => {
    expect(authRedirectOutcome('chord://groups/42', record(), NOW)).toEqual({ kind: 'ignore' });
    expect(authRedirectOutcome('https://chordapp.ai/join/ABC', record(), NOW)).toEqual({
      kind: 'ignore',
    });
  });

  it('ignores a redirect with no sign-in parked behind it', () => {
    expect(authRedirectOutcome(FALLBACK_URL, null, NOW)).toEqual({ kind: 'ignore' });
    // Already claimed once, or belonging to a different attempt.
    expect(authRedirectOutcome(FALLBACK_URL, record({ state: 'st-other' }), NOW)).toEqual({
      kind: 'ignore',
    });
  });

  it('reports a refusal instead of silently returning to the sign-in page', () => {
    const outcome = authRedirectOutcome(
      'chord://oauthredirect?error=access_denied&state=st-abc',
      record(),
      NOW,
    );
    expect(outcome).toEqual({ kind: 'error', error: 'access_denied' });
  });
});
