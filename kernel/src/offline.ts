/**
 * ADR 0311 - what the app does with no network. Pure so it can be tested;
 * `mobile/` has no harness.
 */

/**
 * A request that never reached the server, as opposed to one the server
 * answered with an error. Each runtime words it differently: React Native
 * ("Network request failed"), Chrome ("Failed to fetch"), Safari ("Load
 * failed"), Firefox ("NetworkError when attempting to fetch resource").
 */
export function isNetworkFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { name, message } = err as { name?: unknown; message?: unknown };
  if (name !== 'TypeError' || typeof message !== 'string') return false;
  return /network request (failed|timed out)|failed to fetch|load failed|networkerror/i.test(
    message,
  );
}

export const OFFLINE_PROBE_FIRST_MS = 5_000;
export const OFFLINE_PROBE_MAX_MS = 60_000;

/** While offline, the next check of the server waits this long: 5s, doubling to a minute. */
export function offlineProbeDelay(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt));
  return Math.min(OFFLINE_PROBE_FIRST_MS * 2 ** Math.min(n, 10), OFFLINE_PROBE_MAX_MS);
}

/**
 * How the launch's "who is this?" (`/me`) went. Only a 401/403 says the
 * session is gone; anything else (no network, a server error) says nothing
 * about the session.
 */
export type MeOutcome = 'signed-in' | 'rejected' | 'unreachable';

export function meOutcomeForStatus(status: number): Exclude<MeOutcome, 'signed-in'> {
  return status === 401 || status === 403 ? 'rejected' : 'unreachable';
}

/**
 * A launch that cannot reach the server opens the app as the person last
 * signed in on this device, from what was saved, instead of the sign-in page.
 * Never when the server said the session is over, and never without a session
 * on the device (sign-out removes both).
 */
export function enterWithSavedUser(a: {
  hasToken: boolean;
  outcome: MeOutcome;
  hasSavedUser: boolean;
  /** Web: the session is a cookie the page cannot read; the saved user is the only local sign. */
  web?: boolean;
}): boolean {
  return (a.web || a.hasToken) && a.outcome === 'unreachable' && a.hasSavedUser;
}

/**
 * The first screen comes from what this device saved, not from the server: a
 * launch with a session and a saved user opens the app at once, before
 * `/health` or `/me` answer, and asks who this is in the background (a
 * rejected session then goes back to the sign-in page). Waiting for the server
 * first is what left a spinner up after the app had been away a while.
 */
export function openFromSavedUserAtLaunch(a: {
  hasToken: boolean;
  hasSavedUser: boolean;
  /** Web: the session is a cookie the page cannot read; the saved user is the only local sign. */
  web?: boolean;
}): boolean {
  return (!!a.web || a.hasToken) && a.hasSavedUser;
}

/**
 * ADR 0283's question needs no server round trip on a launch when this device
 * already saw this user answer it: the stored id is the user who agreed last.
 * Anyone else (or nothing stored) waits for the server's answer as before.
 */
export function aiConsentKnownAtLaunch(a: { userId: string; agreedUserId: string | null }): boolean {
  return a.agreedUserId !== null && a.agreedUserId === a.userId;
}

/**
 * How long a request may wait for the server's answer before the app gives up
 * on it. Android's HTTP client has no read timeout of its own, so a connection
 * that stalls (a captive portal, a dying cell) would otherwise hang the send
 * queue and every screen waiting on it while the app still thinks it is online.
 * A read 25s, a write 60s, and the slow ones (a mailbox sync, an upload or
 * download, a model drafting a reply) two minutes.
 */
export const REQUEST_TIMEOUT_MS = 25_000;
export const WRITE_REQUEST_TIMEOUT_MS = 60_000;
export const LONG_REQUEST_TIMEOUT_MS = 120_000;

export function requestTimeoutMs(a: { method?: string; long?: boolean }): number {
  if (a.long) return LONG_REQUEST_TIMEOUT_MS;
  const m = (a.method ?? 'GET').toUpperCase();
  return m === 'GET' || m === 'HEAD' ? REQUEST_TIMEOUT_MS : WRITE_REQUEST_TIMEOUT_MS;
}

/**
 * A request the app's own timeout gave up on is treated like one that never
 * reached the server (a check of the server follows, and the send queue waits);
 * one the caller cancelled is not.
 */
export function fetchFailedOffline(a: { error: unknown; timedOut: boolean }): boolean {
  return a.timedOut || isNetworkFailure(a.error);
}

/**
 * The app opened from the saved user re-asks `/me` when the server is next
 * reachable. Only an answer about the session ends that: signed in (the fresh
 * user replaces the saved copy) or rejected (back to sign-in). No answer - the
 * check itself found no network, or a server error - says nothing, so it asks
 * again next time.
 */
export function meCheckSettled(outcome: MeOutcome): boolean {
  return outcome !== 'unreachable';
}
