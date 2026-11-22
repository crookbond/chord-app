import type { Kysely } from 'kysely';

import { env } from '../config/env.js';
import { logger } from '../config/logging.js';
import { buildApp } from '../app.js';
import type { DB } from '../db/schema.js';
import { requeuePendingExtractions } from '../services/attachments.service.js';
import { hashSessionTokens } from '../db/session-token-hash.js';
import { initBotPersonas } from '../services/bot-personas.service.js';
import { setBotTurnEnqueuer } from '../services/bot/bot.service.js';
import { startBotTurnQueue } from '../services/bot/bot-turn.queue.js';
import { startSkillRegistry } from '../services/bot/skills/store.js';
import { claimDuty, startLeadership } from '../services/cluster/leadership.js';
import { loadByoConnectors, registerEnabledConnectors } from '../services/connectors/init.js';
import { connectorRegistry } from '../services/connectors/registry.js';
import { seedTgEmailPairs } from '../services/connectors/seed-tg-email-pairs.js';
import { sseHub } from '../services/sse.hub.js';

export interface WebRoleHandle {
  stop: () => Promise<void>;
}

/**
 * The web role (ADR 0172): the HTTP API — every route, including the
 * message POST that fire-and-forgets a bot turn — plus the SSE subscribe
 * endpoints. Safe to run as several copies (ADR 0280).
 *
 * Owns the connector registry, not split out to the worker role: inbound
 * webhooks (WhatsApp Cloud API, Slack events) need an HTTP endpoint only
 * this role serves, and the registry's two onBroadcast consumers
 * (outbound-publisher, proposal-resolution-notifier) are wired inside
 * `ConnectorRegistry` itself (`registry.ts`) using the registry as their
 * binding resolver. Every copy has the registry; only the copy holding the
 * `im` leadership lock forwards, notifies and polls (ADR 0280).
 *
 * The bot-turn queue (ADR 0178) lives here for the same reason: a silent
 * IM-bridge reply sends via `connectorRegistry.getForBinding(...)`, so its
 * BullMQ worker has to run wherever the registry does.
 */
export async function startWebRole(db: Kysely<DB>): Promise<WebRoleHandle> {
  // ADR 0027 — load the configured bot persona (seeding from env on first
  // boot). Runs before connectors so inbound mention-detection can resolve
  // aliases.
  await initBotPersonas(db);
  // Testing helper: pre-link Telegram identities to known emails so a
  // dev's TG account is adopted on first Google sign-in. No-op under
  // AUTH_MODE=demo or when SEED_TG_EMAIL_PAIRS is unset.
  await seedTgEmailPairs(db);
  // ADR 0269 — migration 112 hashed every stored session token, but a deploy
  // migrates before it restarts, so the old process can still write a raw
  // token in between. Re-run the (idempotent) rewrite before serving so those
  // sign-ins stay valid too.
  await hashSessionTokens(db);

  // Retry extraction for any upload interrupted by a previous crash/restart.
  // Background — never blocks the server coming up.
  void requeuePendingExtractions(db).catch((err) =>
    logger.error('extraction recovery sweep failed', { err }),
  );

  const app = buildApp(db);
  // ADR 0280 — every web copy can send through a connector; the one holding
  // `im` also receives (Telegram poll, Discord gateway) and forwards replies.
  startLeadership(env.DATABASE_URL);
  const releaseImDuty = claimDuty('im');
  registerEnabledConnectors(db);
  await connectorRegistry.initializeAll(db);
  // ADR 0025 — bring up one connector instance per distinct BYO bot
  // already in the database (resilience: the user shouldn't lose their
  // bridge across server restarts).
  await loadByoConnectors(db);

  // ADR 0300 — skills stored as data, re-read every 30 s so a new one is
  // offered without a restart.
  const stopSkillRegistry = startSkillRegistry(db);

  const botTurnQueue = env.REDIS_URL ? await startBotTurnQueue(db, env.REDIS_URL) : undefined;
  if (botTurnQueue) setBotTurnEnqueuer(botTurnQueue.enqueue);

  const server = app.listen(env.SERVER_PORT, env.SERVER_HOST, () => {
    logger.info(`chord web listening on http://${env.SERVER_HOST}:${env.SERVER_PORT}`);
  });

  return {
    stop: async () => {
      setBotTurnEnqueuer(null);
      stopSkillRegistry();
      await botTurnQueue?.stop();
      await connectorRegistry.shutdownAll();
      await releaseImDuty();
      sseHub.closeAll('shutdown');
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
