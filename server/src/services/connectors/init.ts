/**
 * Env-driven wiring of *deploy-wide* platform connectors into the registry
 * (ADR 0010). BYO connectors (ADR 0025) are loaded separately by
 * `loadByoConnectors` after migrations apply and the DB is reachable.
 *
 * Each platform is enabled only when its required env vars are present.
 * Missing creds → one-line `info` log, no crash. Telegram needs `db` at
 * construction time because its long-poll loop drives inbound messages
 * without going through an HTTP route.
 */
import type { Kysely } from 'kysely';

import { env } from '../../config/env';
import { logger } from '../../config/logging';
import type { DB } from '../../db/schema';
import { connectorRegistry } from './registry';
import { DiscordConnector } from './discord/discord.connector';
import { TelegramConnector } from './telegram/telegram.connector';
import { WhatsAppConnector } from './whatsapp/whatsapp.connector';
import { WhatsAppCloudConnector } from './whatsapp/cloud.connector';
import type { ConnectorPlatform } from './types';
import { openConnectorToken } from './secrets';

function whatsappQuickReplySids(): Record<number, string> {
  const r: Record<number, string> = {};
  if (env.TWILIO_QUICK_REPLY_SID_2) r[2] = env.TWILIO_QUICK_REPLY_SID_2;
  if (env.TWILIO_QUICK_REPLY_SID_3) r[3] = env.TWILIO_QUICK_REPLY_SID_3;
  return r;
}

export function registerEnabledConnectors(db: Kysely<DB>): void {
  if (env.TELEGRAM_BOT_TOKEN) {
    connectorRegistry.register(
      new TelegramConnector({
        token: env.TELEGRAM_BOT_TOKEN,
        db,
      }),
    );
  } else {
    logger.info('connectors: telegram (deploy-wide) disabled (missing TELEGRAM_BOT_TOKEN)');
  }

  // ADR 0090 — one WhatsApp connector, chosen by provider. Meta's Cloud API
  // talks to the WABA the number already lives on; Twilio needs it migrated.
  if (env.WHATSAPP_PROVIDER === 'cloud') {
    if (
      env.META_WHATSAPP_TOKEN &&
      env.META_WHATSAPP_PHONE_NUMBER_ID &&
      env.META_APP_SECRET &&
      env.META_WEBHOOK_VERIFY_TOKEN
    ) {
      connectorRegistry.register(
        new WhatsAppCloudConnector({
          token: env.META_WHATSAPP_TOKEN,
          phoneNumberId: env.META_WHATSAPP_PHONE_NUMBER_ID,
          appSecret: env.META_APP_SECRET,
          verifyToken: env.META_WEBHOOK_VERIFY_TOKEN,
          graphVersion: env.META_GRAPH_VERSION,
          nudgeTemplateName: env.META_NUDGE_TEMPLATE_NAME,
          nudgeTemplateLanguage: env.META_NUDGE_TEMPLATE_LANG,
        }),
      );
    } else {
      // Loud, because the alternative is a silently WhatsApp-less deployment
      // that looks configured — exactly how the 63007s went unnoticed.
      logger.warn(
        'WHATSAPP_PROVIDER=cloud but Meta credentials are incomplete — WhatsApp disabled. ' +
          'Need META_WHATSAPP_TOKEN, META_WHATSAPP_PHONE_NUMBER_ID, META_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN.',
      );
    }
  } else if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_FROM) {
    connectorRegistry.register(
      new WhatsAppConnector({
        accountSid: env.TWILIO_ACCOUNT_SID,
        authToken: env.TWILIO_AUTH_TOKEN,
        from: env.TWILIO_WHATSAPP_FROM,
        publicBaseUrl: env.TWILIO_PUBLIC_URL,
        validateSignature: env.TWILIO_VALIDATE_SIGNATURE,
        quickReplySids: whatsappQuickReplySids(),
      }),
    );
  } else {
    logger.info(
      'connectors: whatsapp disabled (missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_WHATSAPP_FROM)',
    );
  }
}

/**
 * Scan `group_external_channels` and `pending_connector_pairings` for
 * distinct BYO `(platform, bot_user_id)` pairs and register one connector
 * per pair. Called after `registerEnabledConnectors` so deploy-wide bots
 * win when both exist (a BYO binding using the same bot would never be
 * created — the deploy-wide bot already covers it).
 *
 * Token decryption uses the AES-GCM helper. A binding whose token can't
 * be decrypted (e.g. MASTER_KEY rotated) is logged and skipped; messages
 * for it stop flowing until the user re-pairs.
 */
export async function loadByoConnectors(db: Kysely<DB>): Promise<void> {
  const bindings = await db
    .selectFrom('group_external_channels')
    .select([
      'platform',
      'bot_user_id',
      'bot_token_ciphertext',
      'bot_token_iv',
      'bot_token_tag',
    ])
    .where('bot_user_id', 'is not', null)
    .execute();

  const pendings = await db
    .selectFrom('pending_connector_pairings')
    .select([
      'platform',
      'bot_user_id',
      'bot_token_ciphertext',
      'bot_token_iv',
      'bot_token_tag',
    ])
    .where('bot_user_id', 'is not', null)
    .execute();

  const seen = new Set<string>();
  for (const row of [...bindings, ...pendings]) {
    if (!row.bot_user_id || !row.bot_token_ciphertext || !row.bot_token_iv || !row.bot_token_tag) {
      continue;
    }
    const key = `${row.platform}:${row.bot_user_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (connectorRegistry.has(row.platform, row.bot_user_id)) continue;

    let token: string;
    try {
      token = openConnectorToken({
        ciphertext: row.bot_token_ciphertext,
        iv: row.bot_token_iv,
        tag: row.bot_token_tag,
      });
    } catch (err) {
      logger.warn(`connectors: failed to decrypt BYO token for ${key} — skipping`, { err });
      continue;
    }

    const connector = makeConnector(row.platform, token, db);
    if (!connector) {
      logger.warn(`connectors: ${row.platform} BYO not yet supported`, { key });
      continue;
    }
    try {
      await connectorRegistry.addAndInitialize(connector, row.bot_user_id);
    } catch (err) {
      logger.warn(`connectors: BYO ${key} init failed — leaving disabled`, { err });
    }
  }
}

/**
 * Factory: spin up a per-binding connector instance from a decrypted
 * token. Returns null for platforms that don't yet support BYO via
 * polling/WS (Slack lands later via Socket Mode).
 */
export function makeConnector(
  platform: ConnectorPlatform,
  token: string,
  db: Kysely<DB>,
): TelegramConnector | DiscordConnector | null {
  if (platform === 'telegram') return new TelegramConnector({ token, db });
  if (platform === 'discord') return new DiscordConnector({ token, db });
  // Slack (Socket Mode pending) and WhatsApp (deploy-wide webhook only,
  // no BYO) have no per-token poll/WS connector.
  return null;
}
