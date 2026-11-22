import type { NextFunction, Request, Response } from 'express';

import { logger } from '../config/logging.js';

/**
 * The last middleware in the app. An unhandled 5xx message is internal detail
 * ("Cloud KMS decrypt failed (503)", a SQL error), so it goes to the log and
 * the client gets a fixed sentence (ADR 0269). A deliberate 4xx — `status`
 * set by whoever threw it — keeps its message: that text is written for the
 * user.
 */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const e = err as { status?: number; message?: string };
  // A route that answered and then kept working (the message post starts the
  // bot after its 201) can still throw. Answering again throws inside this
  // handler, and Express then destroys the socket the first answer is on.
  if (res.headersSent) {
    logger.error('error after the response was sent', { err });
    return;
  }
  const status = typeof e.status === 'number' ? e.status : 500;
  if (status >= 500) {
    logger.error('unhandled error', { err });
    res.status(status).json({ error: 'internal error' });
    return;
  }
  res.status(status).json({ error: e.message ?? 'request failed' });
}
