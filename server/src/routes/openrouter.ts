/**
 * ADR 0235 — connect OpenRouter as the user's own AI key.
 *
 * `start` is an ordinary session route. `callback` is the browser coming back
 * from openrouter.ai: it carries no session, so it is trusted only through the
 * single-use `state` minted at `start`, and it always ends in a redirect to
 * the app (or a plain page when the attempt is unknown or expired).
 */
import { Router } from 'express';

import { API, StartOpenRouterConnectRequest, type StartOpenRouterConnectResult } from '@chord/kernel';

import { loadSession, requireSession } from '../middleware/auth.js';
import { describeSystemLlm } from '../services/llm/system-llm.js';
import { completeOpenRouterConnect, startOpenRouterConnect } from '../services/openrouter-connect.service.js';

export const openRouterRouter = Router();

openRouterRouter.use(loadSession);

openRouterRouter.post(API.meOpenRouterStart, requireSession, async (req, res, next) => {
  try {
    const parsed = StartOpenRouterConnectRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const out = await startOpenRouterConnect(req.db, req.userId!, parsed.data, describeSystemLlm());
    if (!out.ok) {
      res.status(503).json({ error: out.reason });
      return;
    }
    const body: StartOpenRouterConnectResult = { url: out.url, model: out.model };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

const EXPIRED_PAGE =
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Chord</title><body style="font-family:system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem">' +
  '<h1>This link has expired</h1><p>Go back to Chord and choose Connect OpenRouter again.</p></body>';

openRouterRouter.get(API.openRouterCallback(':state'), async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const code = typeof req.query.code === 'string' && req.query.code ? req.query.code : null;
    const out = await completeOpenRouterConnect(req.db, req.params.state, code);
    if (!out.found) {
      res.status(400).type('html').send(EXPIRED_PAGE);
      return;
    }
    res.redirect(302, out.returnTo);
  } catch (err) {
    next(err);
  }
});
