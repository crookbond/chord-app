import { Router } from 'express';
import { sql } from 'kysely';
import { API } from '@chord/kernel';

import { env } from '../config/env.js';
import { logger } from '../config/logging.js';
import {
  appleSignInConfigured,
  appleWebRedirectUri,
  appleWebSignInConfigured,
} from '../services/apple/apple-auth.service.js';
import { getDefaultPersona } from '../services/bot-personas.service.js';
import { microsoftSignInConfigured } from '../services/microsoft/microsoft-auth.service.js';
import { calendarsOn } from '../services/outlook-calendar/enabled.js';
import { reviewSignInConfigured } from '../services/review-sign-in.service.js';
import { publicWhatsappNumber } from '../services/phone/normalize.js';

export const healthRouter = Router();

// Liveness: cheap, no dependencies — answers "is the process up?".
// `botAlias` is the deployment's primary mention alias so tooling (the load
// sim) can address the bot without hardcoding "@chord" — a renamed deployment
// (BOT_MENTION_ALIASES=chord-beta) would otherwise be silently un-mentioned.
healthRouter.get(API.health, (_req, res) => {
  res.json({
    ok: true,
    t: Date.now(),
    demoMode: env.DEMO_MODE,
    authMode: env.AUTH_MODE,
    // ADR 0156 — the app shows the Apple button only when the whole flow,
    // including revocation on account deletion, can actually run.
    appleSignIn: appleSignInConfigured(),
    // What a browser needs to start the same sign-in; null = Google only there.
    appleWeb: appleWebSignInConfigured()
      ? { clientId: env.APPLE_SERVICES_ID, redirectUri: appleWebRedirectUri() }
      : null,
    // ADR 0293 - what any client needs to start Sign in with Microsoft (no
    // session yet, so it cannot read /me/email/status); null = not offered.
    microsoftSignIn: microsoftSignInConfigured()
      ? { clientId: env.MS_CLIENT_ID, calendar: calendarsOn() }
      : null,
    // ADR 0345 - the app shows its "App review sign-in" link only when on.
    reviewSignIn: reviewSignInConfigured(),
    // ADR 0230 - Google sign-in asks for Gmail in the same consent when on.
    gmail: env.GMAIL_ENABLED,
    // ADR 0253 - where to message Chord on WhatsApp; null = not offered.
    whatsappNumber: publicWhatsappNumber(),
    botAlias: getDefaultPersona().mentionAliases[0],
  });
});

// Readiness: answers "can this node actually serve requests?" — used by
// load balancers / uptime checks. Verifies Postgres connectivity and that
// an LLM provider is configured. The LLM check is config-only (no network
// round-trip) so polling stays cheap and free.
healthRouter.get(API.healthReady, async (req, res) => {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  try {
    await sql`select 1`.execute(req.db);
    checks.postgres = { ok: true };
  } catch (err) {
    logger.error('readiness: postgres check failed', { err });
    checks.postgres = { ok: false, detail: 'query failed' };
  }

  const provider = env.LLM_PROVIDER;
  const llmConfigured =
    provider === 'mock' ||
    (provider === 'openai' && env.OPENAI_API_KEY !== '') ||
    (provider === 'gemini' && env.GEMINI_API_KEY !== '') ||
    (provider === 'anthropic' && env.ANTHROPIC_API_KEY !== '');
  checks.llm = { ok: llmConfigured, detail: provider || 'unconfigured' };

  const ok = Object.values(checks).every((c) => c.ok);
  res.status(ok ? 200 : 503).json({ ok, t: Date.now(), checks });
});
