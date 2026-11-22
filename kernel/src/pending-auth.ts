/**
 * Reading an OAuth redirect that arrived as a deep link, and deciding whether a
 * parked PKCE record may answer it.
 *
 * ADR 0081 sends the Android build back through a verified App Link. When that
 * verification has not taken, /nativeauth hands the app
 * `chord://oauthredirect?code=...` instead - and Android may cold-start the
 * process to deliver it, taking the in-memory AuthRequest (and its code
 * verifier) with it. The record outlives that, so the code is still spendable.
 *
 * Here rather than beside the screen because mobile/ has no test harness
 * (ADR 0120/0121) and a wrong answer signs the wrong person in.
 */

/** A sign-in that left for the browser and has not come back yet. */
export type PendingAuthRecord = {
  /** CSRF state the authorization request was made with. */
  state: string;
  /** PKCE verifier - useless to anyone who cannot also present the code. */
  codeVerifier: string;
  /** Echoed to the token endpoint, which checks it against the grant. */
  redirectUri: string;
  /** Whether the mailbox scope rode along, so the first sync can start. */
  gmail: boolean;
  /** When the browser was opened, epoch ms. */
  at: number;
};

export type AuthRedirectParams = {
  code: string | null;
  state: string | null;
  error: string | null;
};

/** Google's codes are short-lived; an older record is litter, not a sign-in. */
export const PENDING_AUTH_MAX_AGE_MS = 10 * 60 * 1000;

/** A record stamped slightly in the future is a clock nudge, not an attack. */
const CLOCK_SKEW_MS = 60 * 1000;

/**
 * Pull `code` / `state` / `error` out of a redirect URL.
 *
 * Deliberately not `new URL()`: custom schemes parse inconsistently across
 * Hermes and the web, and all this needs is the query string. Returns null when
 * the URL carries no authorization outcome at all - an ordinary deep link, a
 * share link, the launch URL of a normal start.
 */
export function parseAuthRedirect(url: string | null | undefined): AuthRedirectParams | null {
  if (!url) return null;
  const q = url.indexOf('?');
  if (q === -1) return null;
  const query = (url.slice(q + 1).split('#')[0] ?? '').trim();
  if (!query) return null;

  const params = new URLSearchParams(query);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');
  // No outcome means this is not a redirect we are waiting on.
  if (!code && !error) return null;
  return { code, state, error };
}

/**
 * May this record be spent on a redirect carrying `state`?
 *
 * The state match is what stops a link someone else crafted from spending a
 * verifier we are holding; the age bound stops a record left by an abandoned
 * sign-in days ago from answering an unrelated deep link.
 */
export function pendingAuthUsable(
  record: PendingAuthRecord | null | undefined,
  state: string | null | undefined,
  nowMs: number,
  maxAgeMs: number = PENDING_AUTH_MAX_AGE_MS,
): boolean {
  if (!record) return false;
  if (!record.codeVerifier || !record.state) return false;
  if (!state || record.state !== state) return false;
  if (!Number.isFinite(record.at) || !Number.isFinite(nowMs)) return false;
  const age = nowMs - record.at;
  return age <= maxAgeMs && age >= -CLOCK_SKEW_MS;
}

/** Everything the token endpoint needs for one exchange. */
export type AuthGrant = {
  code: string;
  codeVerifier: string;
  /**
   * The redirect the AUTHORIZATION request was made with, not the URL the code
   * came back on. Google checks the two match, and on the fallback path they
   * differ: the grant was issued against `https://.../nativeauth` while the
   * code is delivered over `chord://oauthredirect`.
   */
  redirectUri: string;
  gmail: boolean;
};

export type AuthRedirectOutcome =
  | { kind: 'ignore' }
  | { kind: 'error'; error: string }
  | { kind: 'grant'; grant: AuthGrant };

/**
 * What an incoming URL plus whatever sign-in is parked should produce.
 *
 * One decision for both ways a redirect reaches the app, so the deep-link path
 * and the auth-session path cannot drift (ADR 0085's lesson). `ignore` is the
 * common answer: most deep links are not sign-ins, and a redirect with no live
 * record behind it is not ours to answer.
 */
export function authRedirectOutcome(
  url: string | null | undefined,
  record: PendingAuthRecord | null | undefined,
  nowMs: number,
  maxAgeMs: number = PENDING_AUTH_MAX_AGE_MS,
): AuthRedirectOutcome {
  const parsed = parseAuthRedirect(url);
  if (!parsed) return { kind: 'ignore' };
  if (!pendingAuthUsable(record, parsed.state, nowMs, maxAgeMs)) return { kind: 'ignore' };
  const held = record as PendingAuthRecord;

  if (parsed.error) return { kind: 'error', error: parsed.error };
  if (!parsed.code) return { kind: 'error', error: 'no code' };
  return {
    kind: 'grant',
    grant: {
      code: parsed.code,
      codeVerifier: held.codeVerifier,
      redirectUri: held.redirectUri,
      gmail: held.gmail,
    },
  };
}
