import { Router } from 'express';
import { nanoid } from 'nanoid';
import {
  API,
  CreateSessionRequest,
  SESSION_COOKIE,
  type SessionResponse,
} from '@chord/kernel';

import { env } from '../config/env.js';
import { logger } from '../config/logging.js';
import { ensurePersonalGroup } from '../services/groups.service.js';
import { readSessionToken } from '../middleware/auth.js';
import { isSessionExpired, sessionCookieMaxAgeMs, sessionCookieOptions } from '../utils/session-expiry.js';
import { hashSessionToken, newSessionToken } from '../utils/session-token.js';

export const sessionRouter = Router();

sessionRouter.post(API.session, async (req, res, next) => {
  try {
    // ADR 0014 — username-only login is a demo/CI affordance only. Real
    // deployments set AUTH_MODE=google and use POST /auth/google instead.
    if (env.AUTH_MODE !== 'demo') {
      res.status(403).json({ error: 'demo login disabled; sign in with Google' });
      return;
    }
    const parsed = CreateSessionRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    const { username, displayName } = parsed.data;
    const now = new Date().toISOString();

    let user = await req.db
      .selectFrom('users')
      .selectAll()
      .where('username', '=', username)
      .executeTakeFirst();

    if (!user) {
      await req.db
        .insertInto('users')
        .values({
          id: `u_${nanoid(12)}`,
          username,
          display_name: displayName ?? null,
          created_at: now,
          shadow: 0,
        })
        .execute();
      user = await req.db
        .selectFrom('users')
        .selectAll()
        .where('username', '=', username)
        .executeTakeFirstOrThrow();
      await ensurePersonalGroup(req.db, user.id);
      logger.info(`created user ${username}`);
    }

    const token = newSessionToken();
    await req.db
      .insertInto('sessions')
      .values({
        token: hashSessionToken(token),
        user_id: user.id,
        created_at: now,
        last_seen_at: now,
      })
      .execute();

    res.cookie(SESSION_COOKIE, token, { ...sessionCookieOptions(), maxAge: sessionCookieMaxAgeMs() });

    const body: SessionResponse = {
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name ?? undefined,
        firstName: user.first_name ?? undefined,
        lastName: user.last_name ?? undefined,
        preferredName: user.preferred_name ?? undefined,
        email: user.email ?? undefined,
        createdAt: user.created_at,
      },
      token,
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * The web app keeps its session in the httpOnly cookie only, where page script
 * cannot read it. A browser that signed in on an older build still holds the
 * token in storage: it sends that token here once, gets the cookie for it, and
 * deletes the stored copy. Header-authenticated only - the point is to move a
 * token the page holds into a cookie it cannot, so a cookie alone proves
 * nothing new. Signs nobody out: an unknown token is a 401, nothing else.
 */
sessionRouter.post(API.sessionAdopt, async (req, res, next) => {
  try {
    const found = readSessionToken(req);
    if (!found || found.via !== 'header') {
      res.status(400).json({ error: 'send the session token in the header' });
      return;
    }
    const row = await req.db
      .selectFrom('sessions')
      .select(['user_id', 'created_at', 'last_seen_at'])
      .where('token', '=', hashSessionToken(found.token))
      .executeTakeFirst();
    if (!row || isSessionExpired(row)) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }
    res.cookie(SESSION_COOKIE, found.token, { ...sessionCookieOptions(), maxAge: sessionCookieMaxAgeMs() });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
