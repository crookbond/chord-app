import { env } from '../config/env.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Timestamps are written with `toISOString()`, so a missing or unparseable one counts as expired. */
export function isSessionExpired(
  row: { created_at: string; last_seen_at: string },
  now: Date = new Date(),
): boolean {
  const nowMs = now.getTime();
  if (env.SESSION_IDLE_DAYS > 0) {
    const lastSeen = Date.parse(row.last_seen_at);
    if (!Number.isFinite(lastSeen) || nowMs - lastSeen > env.SESSION_IDLE_DAYS * DAY_MS) return true;
  }
  if (env.SESSION_MAX_DAYS > 0) {
    const created = Date.parse(row.created_at);
    if (!Number.isFinite(created) || nowMs - created > env.SESSION_MAX_DAYS * DAY_MS) return true;
  }
  return false;
}

/** How long the browser should keep the session cookie: no longer than the server will honour it. */
export function sessionCookieMaxAgeMs(): number {
  const days = env.SESSION_MAX_DAYS > 0 ? env.SESSION_MAX_DAYS : 400;
  return days * DAY_MS;
}

/** Cutoffs for deleting expired rows in bulk; `null` when that limit is off. */
export function sessionExpiryCutoffs(now: Date = new Date()): { idleBefore: string | null; createdBefore: string | null } {
  const at = (days: number) => new Date(now.getTime() - days * DAY_MS).toISOString();
  return {
    idleBefore: env.SESSION_IDLE_DAYS > 0 ? at(env.SESSION_IDLE_DAYS) : null,
    createdBefore: env.SESSION_MAX_DAYS > 0 ? at(env.SESSION_MAX_DAYS) : null,
  };
}

/**
 * Options for the `chord.sid` cookie, shared by every place that sets or
 * clears it. `secure` is on in production: the site is only served over
 * HTTPS there (nginx + Cloudflare), and without it a browser would also send
 * the session over any plain-HTTP request to the domain. Local dev runs over
 * http://127.0.0.1, where a Secure cookie would never be sent back.
 */
export function sessionCookieOptions(): { httpOnly: true; sameSite: 'lax'; secure: boolean; path: '/' } {
  return { httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production', path: '/' };
}
