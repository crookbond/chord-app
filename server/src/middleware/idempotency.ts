import type { NextFunction, Request, Response } from 'express';

import { logger } from '../config/logging.js';
import { runInBackground } from '../utils/background.js';

/**
 * ADR 0311 addendum - a write the app queued while offline is sent with an
 * `Idempotency-Key` (the queue's own id for it). When the connection drops
 * after the server did the work but before the app heard back, the app sends
 * it again; the repeat gets the first answer instead of a second message,
 * email or to-do. Keyed per user, so one user's key never answers another's.
 *
 * A repeat that arrives while the first is still running gets 503, which the
 * app's queue treats as "try again later". A first attempt that failed with a
 * 5xx is forgotten, so its retry runs for real.
 */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
const MAX_KEY_LENGTH = 100;

export async function idempotent(req: Request, res: Response, next: NextFunction): Promise<void> {
  const key = req.get(IDEMPOTENCY_HEADER)?.trim();
  if (!key || !req.userId) return next();
  if (key.length > MAX_KEY_LENGTH) {
    res.status(400).json({ error: 'idempotency key too long' });
    return;
  }
  const db = req.db;
  const userId = req.userId;
  try {
    const claimed = await db
      .insertInto('client_requests')
      .values({ user_id: userId, key, status: null, body: null, created_at: new Date().toISOString() })
      .onConflict((oc) => oc.doNothing())
      .returning('key')
      .executeTakeFirst();
    if (!claimed) {
      const prior = await db
        .selectFrom('client_requests')
        .select(['status', 'body'])
        .where('user_id', '=', userId)
        .where('key', '=', key)
        .executeTakeFirst();
      if (!prior || prior.status === null) {
        res.status(503).json({ error: 'the first attempt is still running' });
        return;
      }
      if (prior.body === null) {
        res.status(prior.status).end();
        return;
      }
      res.status(prior.status).type('application/json').send(prior.body);
      return;
    }
  } catch (err) {
    next(err);
    return;
  }

  let body: string | null = null;
  const json = res.json.bind(res);
  res.json = (value: unknown) => {
    body = JSON.stringify(value);
    return json(value);
  };
  res.on('finish', () => {
    const status = res.statusCode;
    const write =
      status >= 500
        ? db.deleteFrom('client_requests').where('user_id', '=', userId).where('key', '=', key)
        : db
            .updateTable('client_requests')
            .set({ status, body })
            .where('user_id', '=', userId)
            .where('key', '=', key);
    runInBackground(
      write.execute().catch((err: unknown) => {
        logger.error('idempotency record failed', { err: (err as Error).message });
      }),
    );
  });
  next();
}
