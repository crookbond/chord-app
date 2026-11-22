import { createHash } from 'node:crypto';

import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler } from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';

import { env } from '../config/env.js';

// A no-op passthrough used when rate limiting is disabled (tests, or an
// operator who turns it off). Keeps app.ts wiring uniform.
const passthrough: RequestHandler = (_req, _res, next) => next();

function make(max: number): RequestHandler {
  if (!env.RATE_LIMIT_ENABLED) return passthrough;
  return rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too many requests, slow down' },
  }) as RateLimitRequestHandler;
}

// General throttle applied to every route except liveness/SSE.
export const generalLimiter = make(env.RATE_LIMIT_MAX);

// Stricter throttle for credential endpoints, where unlimited attempts are
// an abuse vector (brute force, token-exchange hammering).
export const authLimiter = make(env.RATE_LIMIT_AUTH_MAX);

/**
 * ADR 0335 — the connector's callers are Claude's and ChatGPT's servers, so
 * one IP carries every user of that app. Count per bearer token, else per
 * client id, and only fall back to the IP when a request names neither.
 */
export function connectorRateKey(req: Request): string {
  const auth = req.header('authorization');
  if (auth) return `auth:${createHash('sha256').update(auth).digest('hex')}`;
  const clientId = (req.body as { client_id?: unknown } | undefined)?.client_id ?? req.query.client_id;
  if (typeof clientId === 'string' && clientId) return `client:${clientId}`;
  return `ip:${ipKeyGenerator(req.ip ?? '')}`;
}

export const connectorLimiter: RequestHandler = env.RATE_LIMIT_ENABLED
  ? (rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: connectorRateKey,
      message: { error: 'too many requests, slow down' },
    }) as RateLimitRequestHandler)
  : passthrough;
