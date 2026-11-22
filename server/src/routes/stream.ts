import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { SESSION_HEADER } from '@chord/kernel';

import { loadSession, requireSession } from '../middleware/auth';
import { isMember } from '../services/groups.service';
import { sseHub } from '../services/sse.hub';

export const streamRouter = Router();

/**
 * Browser EventSource cannot set custom headers, and the session cookie is
 * cross-site relative to the Expo dev server so `SameSite=Lax` drops it.
 * Accept `?token=…` as a stream-only fallback and promote it to the shared
 * `x-chord-token` header before `loadSession` runs.
 */
function streamQueryTokenFallback(req: Request, _res: Response, next: NextFunction): void {
  if (!req.header(SESSION_HEADER) && typeof req.query.token === 'string' && req.query.token) {
    req.headers[SESSION_HEADER.toLowerCase()] = req.query.token;
  }
  next();
}

// Only the stream routes take `?token=`: this router is mounted ahead of every
// other one and `loadSession` runs once per request, so a pathless fallback
// here used to accept a query-string session on EVERY route (ADR 0269). A URL
// token ends up in browser history, proxy logs and Referer headers.
export const STREAM_PATHS = ['/api/v1/me/stream', '/api/v1/groups/:id/stream'];
streamRouter.use(STREAM_PATHS, streamQueryTokenFallback);
streamRouter.use(loadSession);

streamRouter.get('/api/v1/me/stream', requireSession, async (req, res, next) => {
  try {
    const channel = `user:${req.userId!}`;
    const unsubscribe = sseHub.subscribe(channel, res, req.userId!);
    req.on('close', () => {
      unsubscribe();
      try {
        res.end();
      } catch {
        // already closed
      }
    });
  } catch (err) {
    next(err);
  }
});

streamRouter.get(
  '/api/v1/groups/:id/stream',
  requireSession,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!(await isMember(req.db, id, req.userId!))) {
        res.status(403).end();
        return;
      }
      const unsubscribe = sseHub.subscribe(id, res, req.userId!);
      req.on('close', () => {
        unsubscribe();
        try {
          res.end();
        } catch {
          // already closed
        }
      });
    } catch (err) {
      next(err);
    }
  },
);
