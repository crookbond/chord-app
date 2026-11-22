/**
 * UUID-referrer flow for soft-linking a Telegram identity to a real
 * Chord account without a pair-code paste step.
 *
 * Lifecycle:
 *   1. Bot DMs a stranger → mints a `signup_intents` row keyed by
 *      `(platform='telegram', external_user_id=<tg id>)`. Welcome URL
 *      becomes `${SIGNUP_URL}?ref=${token}`. Idempotent — reuse an
 *      existing open intent rather than minting a new one each DM, so
 *      a re-DM doesn't fork tokens.
 *   2. User taps the link, signs in with Google in the Chord app.
 *   3. Mobile sends `signupRef` alongside the OAuth code → server
 *      `consumeForTg` re-points the TG external_identity to the new
 *      real user and runs the same shadow-merge that pair-code consume
 *      runs (memberships, message attribution, FK rewrites).
 *
 * This complements `consumePairingCode` rather than replacing it: pair
 * codes still cover the "user signs up first, then pairs" case and any
 * non-TG connector. The referrer flow only fires when the bot saw the
 * TG user first.
 */
import { nanoid } from 'nanoid';
import type { Kysely } from 'kysely';

import { logger } from '../../config/logging';
import type { DB } from '../../db/schema';
import { mergeOrLinkExternalIdentity } from './pairing.service';
import { connectorRegistry } from './registry';
import type { ConnectorPlatform } from './types';

const TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Platforms whose connector DMs the user first and can therefore carry a
 * UUID referrer token in the welcome link (ADR 0031 / 0053). Slack and
 * Discord land bindings via OAuth, not a first-DM, so they don't use this.
 */
export const REFERRER_PLATFORMS: ReadonlySet<ConnectorPlatform> = new Set([
  'telegram',
  'whatsapp',
]);

export function supportsReferrerFlow(platform: ConnectorPlatform): boolean {
  return REFERRER_PLATFORMS.has(platform);
}

/**
 * Mint a referrer token for an external user the bot just DM'd, or reuse
 * the open one if it exists. The token is opaque and single-use; expiry is
 * conservative (14 days) so links posted in a chat scrollback don't
 * dangle indefinitely. Reuse semantics: same `(platform, external id)` →
 * same token until consumed or expired, so re-DMing the bot doesn't
 * produce a fresh link that obsoletes the one the user already saved.
 */
export async function mintSignupIntent(
  db: Kysely<DB>,
  platform: ConnectorPlatform,
  externalUserId: string,
): Promise<string> {
  const now = new Date();
  const cutoff = now.toISOString();
  const existing = await db
    .selectFrom('signup_intents')
    .selectAll()
    .where('platform', '=', platform)
    .where('external_user_id', '=', externalUserId)
    .where('consumed_at', 'is', null)
    .where('expires_at', '>', cutoff)
    .executeTakeFirst();
  if (existing) return existing.token;

  const token = nanoid(22);
  await db
    .insertInto('signup_intents')
    .values({
      token,
      email: null,
      platform,
      external_user_id: externalUserId,
      created_at: cutoff,
      expires_at: new Date(now.getTime() + TOKEN_TTL_MS).toISOString(),
      consumed_at: null,
    })
    .execute();
  return token;
}

/** Back-compat alias for the Telegram call sites + existing tests. */
export function mintForTg(
  db: Kysely<DB>,
  externalUserId: string,
): Promise<string> {
  return mintSignupIntent(db, 'telegram', externalUserId);
}

export type ConsumeResult =
  | { ok: true; merged: boolean; platform: ConnectorPlatform; externalUserId: string }
  | { ok: false; reason: 'unknown_token' | 'expired' | 'already_consumed' };

/**
 * Consume a referrer token in the context of a just-signed-in real
 * Chord user. Best-effort by design: a malformed/stale token returns
 * a structured failure and the auth flow proceeds — the user just
 * misses the soft-link and can still recover via pair code.
 *
 * Runs inside a single transaction with `mergeOrLinkExternalIdentity`
 * so the token state and the identity re-point can't get out of sync.
 * `email` is backfilled at consume time for an audit trail.
 */
export async function consumeSignupIntent(
  db: Kysely<DB>,
  args: {
    token: string;
    ownerUserId: string;
    /** Null for an Apple sign-in that shared no email (ADR 0156). */
    ownerEmail: string | null;
    ownerDisplay: string | null;
  },
): Promise<ConsumeResult> {
  const result = await db.transaction().execute(async (tx) => {
    const intent = await tx
      .selectFrom('signup_intents')
      .selectAll()
      .where('token', '=', args.token)
      .executeTakeFirst();
    if (!intent) return { ok: false as const, reason: 'unknown_token' as const };
    if (intent.consumed_at) {
      return { ok: false as const, reason: 'already_consumed' as const };
    }
    const now = new Date();
    if (new Date(intent.expires_at).getTime() <= now.getTime()) {
      return { ok: false as const, reason: 'expired' as const };
    }
    if (!REFERRER_PLATFORMS.has(intent.platform as ConnectorPlatform)) {
      return { ok: false as const, reason: 'unknown_token' as const };
    }

    const platform = intent.platform as ConnectorPlatform;

    await mergeOrLinkExternalIdentity(tx, {
      platform,
      externalUserId: intent.external_user_id,
      externalUserDisplay: args.ownerDisplay,
      ownerUserId: args.ownerUserId,
      now: now.toISOString(),
    });

    await tx
      .updateTable('signup_intents')
      .set({
        consumed_at: now.toISOString(),
        email: args.ownerEmail,
      })
      .where('token', '=', args.token)
      .execute();

    logger.info('signup-intent consumed (soft-link)', {
      token: args.token.slice(0, 6) + '…',
      platform,
      externalUserId: intent.external_user_id,
      ownerUserId: args.ownerUserId,
    });

    return {
      ok: true as const,
      merged: true,
      platform,
      externalUserId: intent.external_user_id,
    };
  });

  // Post-commit (best-effort): confirm on the WhatsApp side that the chat
  // is now linked. Done *after* the transaction so a connector/network
  // failure never rolls back the merge. WhatsApp-only — Telegram's welcome
  // copy already tells the user mirroring starts automatically, and a TG
  // DM here could land before the chat surfaces the change. The 24h window
  // is normally open (the user just messaged to get the signup nudge); if
  // it's closed the free-form send fails and we just log it.
  if (result.ok && result.platform === 'whatsapp') {
    const conn = connectorRegistry.getDeployWide('whatsapp');
    if (conn) {
      await conn
        .send({
          externalChannelId: result.externalUserId,
          body:
            `✅ You're connected. This WhatsApp chat is now linked to your ` +
            `Chord account — anything you send here syncs automatically.`,
          cards: [],
        })
        .catch((err) =>
          logger.warn('signup-intent: connected confirmation send failed', {
            externalUserId: result.externalUserId,
            err: (err as Error).message,
          }),
        );
    }
  }
  return result;
}

/** Back-compat alias. The consume is platform-generic now (the token
 *  carries the platform); this name is kept for the existing call site
 *  and tests. */
export const consumeForTg = consumeSignupIntent;

