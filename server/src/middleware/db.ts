import type { NextFunction, Request, Response } from 'express';
import type { Kysely } from 'kysely';

import type { DB } from '../db/schema.js';

declare module 'express-serve-static-core' {
  interface Request {
    db: Kysely<DB>;
    userId?: string;
    /** Set by `loadSession` so the session is looked up once per request, however many routers use it. */
    sessionLoaded?: boolean;
    /**
     * A valid session cookie came on a write without the CSRF header: the
     * request runs as signed out, and `requireSession` answers 403.
     */
    csrfRefused?: boolean;
    /**
     * Raw request body bytes captured by the JSON parser's `verify` hook
     * in `app.ts`. Used by IM connector signature verification (Slack
     * HMAC, Discord Ed25519) which sign the literal payload, not the
     * JSON.stringify of the parsed object.
     */
    rawBody?: string;
  }
}

export function attachDb(db: Kysely<DB>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.db = db;
    next();
  };
}
