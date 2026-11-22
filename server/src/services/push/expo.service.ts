/**
 * Sends Expo push notifications and prunes dead device tokens.
 *
 * Gated by `env.PUSH_ENABLED` — off by default, so tests/CI/local dev never
 * reach Expo. The Expo client is constructed lazily inside `sendPush` (after
 * the gate) so importing this module is inert.
 *
 * Token cleanup: a token that Expo rejects with `DeviceNotRegistered` (or that
 * fails `Expo.isExpoPushToken`) is deleted here. We act on the *ticket* (which
 * still carries the token), not the delayed receipts API — receipts are keyed
 * by receiptId, not token, and a device that slips through gets the same
 * DeviceNotRegistered ticket on the next send. See ADR 0054.
 */
import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';
import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';

let client: Expo | null = null;
function expo(): Expo {
  if (!client) {
    client = new Expo(
      env.EXPO_ACCESS_TOKEN ? { accessToken: env.EXPO_ACCESS_TOKEN } : {},
    );
  }
  return client;
}

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/** The Android notification channel the app creates (mobile/src/push.ts). */
export const ANDROID_PUSH_CHANNEL = 'default';

/**
 * ADR 0263 - `channelId` names the channel the app made at high importance,
 * so Android shows a banner the way an iPhone does; `priority: 'high'` keeps
 * a dozing Android phone from holding the message back. iOS was already sent
 * at Apple's immediate priority, so nothing changes there.
 */
export function buildPushMessages(tokens: string[], payload: PushPayload): ExpoPushMessage[] {
  return tokens.map((to) => ({
    to,
    sound: 'default',
    priority: 'high',
    channelId: ANDROID_PUSH_CHANNEL,
    title: payload.title,
    body: payload.body,
    data: payload.data ?? {},
  }));
}

async function pruneTokens(db: Kysely<DB>, tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  await db
    .deleteFrom('push_tokens')
    .where('token', 'in', tokens)
    .execute()
    .catch((err) => logger.warn('push: prune failed', { err }));
}

export async function sendPush(
  db: Kysely<DB>,
  tokens: string[],
  payload: PushPayload,
): Promise<void> {
  if (!env.PUSH_ENABLED) return;

  const valid = tokens.filter((t) => Expo.isExpoPushToken(t));
  const invalid = tokens.filter((t) => !Expo.isExpoPushToken(t));
  await pruneTokens(db, invalid);
  if (valid.length === 0) return;

  const messages = buildPushMessages(valid, payload);

  const chunks = expo().chunkPushNotifications(messages);
  const tickets: ExpoPushTicket[] = [];
  const ticketTokens: string[] = []; // ticket index → token, for pruning

  // Chunk count is already bounded by Expo's own chunking, so no extra
  // concurrency cap is needed. allSettled (not all) so one bad chunk doesn't
  // stop the others from sending, matching the previous per-chunk try/catch.
  const settled = await Promise.allSettled(
    chunks.map((chunk) => expo().sendPushNotificationsAsync(chunk)),
  );
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status === 'fulfilled') {
      tickets.push(...outcome.value);
      ticketTokens.push(...chunks[i].map((m) => m.to as string));
    } else {
      logger.warn('push: send chunk failed', { err: outcome.reason });
    }
  }

  const dead: string[] = [];
  for (let i = 0; i < tickets.length; i++) {
    const t = tickets[i];
    if (t.status === 'error') {
      if (t.details?.error === 'DeviceNotRegistered') {
        dead.push(ticketTokens[i]);
      } else {
        logger.warn('push: ticket error', { error: t.details?.error });
      }
    }
  }
  await pruneTokens(db, dead);
}
