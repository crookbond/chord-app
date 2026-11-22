import type { NextFunction, Request, Response } from 'express';
import { CSRF_HEADER, SESSION_COOKIE, SESSION_HEADER } from '@chord/kernel';

import { logger } from '../config/logging.js';
import { isSessionExpired } from '../utils/session-expiry.js';
import { hashSessionToken } from '../utils/session-token.js';

/** The session token and where it came from: a header the client set, or the browser's cookie. */
export function readSessionToken(req: Request): { token: string; via: 'header' | 'cookie' } | undefined {
  const header = req.header(SESSION_HEADER);
  if (header) return { token: header, via: 'header' };
  const auth = req.header('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) {
    const bearer = auth.slice(7).trim();
    if (bearer) return { token: bearer, via: 'header' };
  }
  const cookie = req.cookies?.[SESSION_COOKIE];
  if (typeof cookie === 'string' && cookie.length > 0) return { token: cookie, via: 'cookie' };
  return undefined;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A cookie rides along on any request the browser sends, including one a page
 * on another site starts; a header token does not. So a write signed in only
 * by the cookie must also carry the CSRF header, which another site cannot
 * add without a preflight the server refuses.
 */
export function cookieWriteLacksCsrf(req: Request, via: 'header' | 'cookie'): boolean {
  return via === 'cookie' && !SAFE_METHODS.has(req.method.toUpperCase()) && !req.header(CSRF_HEADER);
}

// Below this, `last_seen_at` is refreshed in the background rather than on
// every request — it's a coarse "still active" signal, not something any
// caller reads synchronously.
const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000;

/**
 * Loads the session's user_id onto req.userId if a valid token is present.
 *
 * Nearly every router does `router.use(loadSession)`, and a router-level `use`
 * runs for every request that reaches the router, matching route or not. So a
 * request handled by the Nth router used to pay N session lookups first. The
 * lookup is done once per request; later mounts see the flag and pass through.
 */
export async function loadSession(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (req.sessionLoaded) return next();
  req.sessionLoaded = true;
  const found = readSessionToken(req);
  if (!found) return next();
  const { token } = found;
  const stored = hashSessionToken(token);
  let row;
  try {
    row = await req.db
      .selectFrom('sessions')
      .select(['user_id', 'created_at', 'last_seen_at'])
      .where('token', '=', stored)
      .executeTakeFirst();
    if (row && isSessionExpired(row)) {
      await req.db.deleteFrom('sessions').where('token', '=', stored).execute();
      row = undefined;
    }
  } catch (err) {
    // Express 4 does not catch a rejected async middleware: without this the
    // request hangs and the rejection goes unhandled.
    return next(err);
  }
  if (row && cookieWriteLacksCsrf(req, found.via)) {
    // Runs as signed out: a public route (a webhook, an OAuth callback) still
    // answers, and every route that needs the session refuses it.
    req.csrfRefused = true;
    return next();
  }
  if (row) {
    req.userId = row.user_id;
    const lastSeenMs = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
    if (Date.now() - lastSeenMs > LAST_SEEN_REFRESH_MS) {
      // Not awaited: refreshing this timestamp must never add a round trip
      // to every authenticated request.
      req.db
        .updateTable('sessions')
        .set({ last_seen_at: new Date().toISOString() })
        .where('token', '=', stored)
        .execute()
        .catch((err) => logger.warn('failed to refresh session last_seen_at', { err }));
    }
  }
  next();
}

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  if (!req.userId && req.csrfRefused) {
    res.status(403).json({ error: 'missing CSRF header' });
    return;
  }
  if (!req.userId) {
    res.status(401).json({ error: 'not signed in' });
    return;
  }
  next();
}
