/**
 * Self-service connector pairing (ADR 0010 + 0025).
 *
 * Two flavors:
 *
 *   • Deploy-wide bot — operator sets `*_BOT_TOKEN` in `.env`. The user
 *     calls `generatePairingCode` with no token. The user types
 *     `/chord pair <code>` in their chat; the deploy-wide bot's existing
 *     poll loop / gateway picks it up and `consumePairingCode` creates a
 *     binding with `bot_user_id = NULL`.
 *
 *   • BYO bot (ADR 0025) — the user supplies their own bot token via
 *     the pair request. We validate it via the platform's identity
 *     endpoint (`getMe` for Telegram), capture `bot_user_id` /
 *     `bot_username`, encrypt the token at rest, ensure a connector
 *     instance is running for that bot, then mint the same shape of
 *     pending row. The user pairs via `/chord pair <code>` in *their*
 *     chat — picked up by *their* bot's connector — and the resulting
 *     binding stores the encrypted token + bot identity.
 *
 * Codes use an unambiguous alphabet (no I/O/0/1) since they're typed by
 * hand. Any-member auth — matches existing group-scope conventions.
 */
import type { Kysely } from 'kysely';
import { customAlphabet } from 'nanoid';

import { ALIAS_PATTERN } from '@chord/kernel';

import type { DB } from '../../db/schema';
import { logger } from '../../config/logging';
import { consolidatePersonalGroupInto } from '../groups.service';
import { rescheduleDailyScanForUser } from '../proactive.service';
import { connectorRegistry } from './registry';
import { makeConnector } from './init';
import { sealConnectorToken } from './secrets';
import { adoptPhoneFromWhatsapp } from '../phone/backfill';
import type { ConnectorPlatform } from './types';
import { getMe as tgGetMe } from './telegram/telegram.api';
import { getMe as discordGetMe } from './discord/discord.api';

/** Confusable-character-free alphabet. */
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
export const DEFAULT_TTL_MINUTES = 5;

export interface GeneratePairingInput {
  platform: ConnectorPlatform;
  groupId: string;
  userId: string;
  /**
   * Per-Chord-group label. Defaults to the platform name. Must satisfy
   * ALIAS_PATTERN; rejected if it collides with another binding or
   * pending pairing on the same group.
   */
  alias?: string;
  /** ADR 0025 — optional BYO bot token, validated then encrypted. */
  botToken?: string;
  ttlMinutes?: number;
  /** Test override; defaults to `Date.now`. */
  now?: () => Date;
  /** Test override; defaults to a crypto-strong picker. */
  randomCode?: () => string;
  /** Test override; defaults to `db` so the connector spin-up uses the
   *  same handle. Shouldn't usually be set. */
  registryDb?: Kysely<DB>;
}

export interface PairingCodeResult {
  code: string;
  expiresAt: string;
  alias: string;
  /** Bot's @handle when supplied (BYO) or known (deploy-wide). */
  botUsername: string | null;
  /** True iff the pairing carries a BYO token (vs. uses deploy-wide). */
  byo: boolean;
}

export class PairingError extends Error {
  constructor(
    public readonly reason:
      | 'group_not_found'
      | 'alias_already_in_use'
      | 'invalid_alias'
      | 'invalid_bot_token'
      | 'platform_no_byo'
      | 'no_bot_available',
  ) {
    super(reason);
  }
}

/**
 * Validate a BYO token by hitting the platform's "who am I" endpoint.
 * Returns the bot's identity on the platform. Throws PairingError on
 * failure so the route returns 400 instead of 500.
 */
export async function validateByoToken(
  platform: ConnectorPlatform,
  botToken: string,
): Promise<{ botUserId: string; botUsername: string | null }> {
  if (platform === 'telegram') {
    try {
      const me = await tgGetMe(botToken);
      if (!me.is_bot) throw new PairingError('invalid_bot_token');
      return { botUserId: String(me.id), botUsername: me.username ?? null };
    } catch (err) {
      if (err instanceof PairingError) throw err;
      logger.info('byo telegram token validation failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      throw new PairingError('invalid_bot_token');
    }
  }
  if (platform === 'discord') {
    try {
      const me = await discordGetMe(botToken);
      // Discord's /users/@me on a bot token returns the bot user; no
      // explicit is_bot field needed.
      return { botUserId: me.id, botUsername: me.username ?? null };
    } catch (err) {
      logger.info('byo discord token validation failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      throw new PairingError('invalid_bot_token');
    }
  }
  // Slack BYO requires Socket Mode (future ADR). Until then, pairing for
  // Slack only works via deploy-wide configuration.
  throw new PairingError('platform_no_byo');
}

export async function generatePairingCode(
  db: Kysely<DB>,
  input: GeneratePairingInput,
): Promise<PairingCodeResult> {
  const group = await db
    .selectFrom('groups')
    .select(['id', 'kind'])
    .where('id', '=', input.groupId)
    .executeTakeFirst();
  if (!group) throw new PairingError('group_not_found');

  const alias = input.alias ?? input.platform;
  if (!ALIAS_PATTERN.test(alias)) {
    throw new PairingError('invalid_alias');
  }

  // Resolve BYO token (if any) before any DB writes — failing fast on a
  // bad token avoids leaving an orphan pending row. The route layer
  // gates the deploy-wide-required-but-missing case so we don't repeat
  // it here.
  let byo: { botUserId: string; botUsername: string | null } | null = null;
  if (input.botToken) {
    byo = await validateByoToken(input.platform, input.botToken);
  }

  const now = (input.now ?? (() => new Date()))();
  const conflictBinding = await db
    .selectFrom('group_external_channels')
    .select('alias')
    .where('group_id', '=', input.groupId)
    .where('alias', '=', alias)
    .executeTakeFirst();
  if (conflictBinding) throw new PairingError('alias_already_in_use');

  const conflictPending = await db
    .selectFrom('pending_connector_pairings')
    .select(['code', 'expires_at'])
    .where('group_id', '=', input.groupId)
    .where('alias', '=', alias)
    .where('expires_at', '>', now.toISOString())
    .executeTakeFirst();
  if (conflictPending) throw new PairingError('alias_already_in_use');

  const sealed = byo && input.botToken
    ? sealConnectorToken(input.botToken)
    : null;

  const ttlMin = input.ttlMinutes ?? DEFAULT_TTL_MINUTES;
  const expiresAt = new Date(now.getTime() + ttlMin * 60_000);

  let storedCode: string | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = (input.randomCode ?? makeRandomCode)();
    try {
      await db
        .insertInto('pending_connector_pairings')
        .values({
          code,
          platform: input.platform,
          group_id: input.groupId,
          created_by_user_id: input.userId,
          alias,
          created_at: now.toISOString(),
          expires_at: expiresAt.toISOString(),
          bot_user_id: byo?.botUserId ?? null,
          bot_username: byo?.botUsername ?? null,
          bot_token_ciphertext: sealed?.ciphertext ?? null,
          bot_token_iv: sealed?.iv ?? null,
          bot_token_tag: sealed?.tag ?? null,
        })
        .execute();
      storedCode = code;
      break;
    } catch (err) {
      // 23505 = unique_violation; retry with a fresh code.
      if ((err as { code?: string })?.code === '23505') {
        continue;
      }
      throw err;
    }
  }
  if (!storedCode) {
    throw new Error('pairing: unable to allocate a unique code after 5 tries');
  }

  // ADR 0025 — for BYO, the user's own bot must be running so it can
  // pick up the `/chord pair <code>` message in their chat. Spin up a
  // connector for this bot identity if one isn't already registered.
  if (byo && input.botToken) {
    if (!connectorRegistry.has(input.platform, byo.botUserId)) {
      const conn = makeConnector(input.platform, input.botToken, db);
      if (!conn) throw new PairingError('platform_no_byo');
      try {
        await connectorRegistry.addAndInitialize(conn, byo.botUserId);
      } catch (err) {
        // Roll the pending row back so the user can retry.
        await db
          .deleteFrom('pending_connector_pairings')
          .where('code', '=', storedCode)
          .execute();
        logger.warn('byo connector failed to start — rolling back pending pairing', {
          platform: input.platform,
          botUserId: byo.botUserId,
          err: err instanceof Error ? err.message : String(err),
        });
        throw new PairingError('invalid_bot_token');
      }
    }
  }

  return {
    code: storedCode,
    expiresAt: expiresAt.toISOString(),
    alias,
    botUsername: byo?.botUsername ?? null,
    byo: !!byo,
  };
}

export interface ConsumePairingInput {
  code: string;
  platform: ConnectorPlatform;
  externalChannelId: string;
  /**
   * Telegram (or other connector) user id of the user who typed the
   * pair message. When set, the consume step links/merges their
   * external identity to the pending pair's owner — this is the
   * "pair-once" link from external account → Chord user.
   */
  externalUserId?: string;
  /** Display name to record on the identity row when creating it. */
  externalUserDisplay?: string | null;
  /** Optional human-readable description (e.g. Telegram chat title). */
  externalDisplay?: string | null;
  /**
   * ADR 0025 — the bot identity that picked up the pair message. The
   * pending row's `bot_user_id` must match this for BYO pairings;
   * otherwise it's a code that was minted for a different bot.
   */
  receivedByBotUserId?: string | null;
  /**
   * When true, an existing binding on this channel is discarded
   * (unbound) before the new binding is created. Set by the user
   * appending `replace`/`force` to the pair command — explicit opt-in,
   * not a default, because the silent rebind would otherwise surprise
   * whoever owns the old binding.
   */
  force?: boolean;
  /** Test override; defaults to `Date.now`. */
  now?: () => Date;
}

export type ConsumePairingResult =
  | { ok: true; groupId: string }
  | {
      ok: false;
      reason:
        | 'unknown_code'
        | 'expired_code'
        | 'alias_taken'
        | 'wrong_bot';
    }
  | {
      ok: false;
      reason: 'channel_already_bound';
      /** Group the channel is currently bound to. */
      existingGroupId: string;
    };

/**
 * Atomically: look up code, verify not expired + not already bound on
 * that platform, insert binding (carrying BYO token + identity if any),
 * delete pending row.
 */
export async function consumePairingCode(
  db: Kysely<DB>,
  input: ConsumePairingInput,
): Promise<ConsumePairingResult> {
  const now = (input.now ?? (() => new Date()))();
  const code = input.code.toUpperCase();
  return db.transaction().execute(async (tx): Promise<ConsumePairingResult> => {
    const pending = await tx
      .selectFrom('pending_connector_pairings')
      .selectAll()
      .where('code', '=', code)
      .where('platform', '=', input.platform)
      .executeTakeFirst();
    if (!pending) return { ok: false, reason: 'unknown_code' };
    if (new Date(pending.expires_at).getTime() < now.getTime()) {
      await tx
        .deleteFrom('pending_connector_pairings')
        .where('code', '=', code)
        .execute();
      return { ok: false, reason: 'expired_code' };
    }

    // ADR 0025 — BYO pairings must be consumed by the bot they were
    // minted for. Otherwise a deploy-wide bot in the same chat could
    // accidentally swallow a BYO pair code.
    //
    // Deploy-wide pairings (pending.bot_user_id IS NULL) accept any bot
    // — the inbound side still tags `receivedByBotUserId` with the
    // bot's Telegram user id, but that's identity bookkeeping, not a
    // routing constraint.
    const expectedBotUserId = pending.bot_user_id ?? null;
    const receivedByBotUserId = input.receivedByBotUserId ?? null;
    if (expectedBotUserId !== null && expectedBotUserId !== receivedByBotUserId) {
      // Don't delete the pending row — the user may still pair with the
      // correct bot before expiry.
      return { ok: false, reason: 'wrong_bot' };
    }

    const channelBound = await tx
      .selectFrom('group_external_channels')
      .select('group_id')
      .where('platform', '=', input.platform)
      .where('external_channel_id', '=', input.externalChannelId)
      .executeTakeFirst();
    if (channelBound) {
      if (!input.force) {
        // Don't delete the pending row — the user can re-run the pair
        // command with `replace` to confirm the swap.
        return {
          ok: false,
          reason: 'channel_already_bound',
          existingGroupId: channelBound.group_id,
        };
      }
      // Force: drop the existing binding so the new INSERT below can
      // claim the channel. The old Chord group keeps its other
      // bindings (if any) and its own data — only this bridge is cut.
      await tx
        .deleteFrom('group_external_channels')
        .where('platform', '=', input.platform)
        .where('external_channel_id', '=', input.externalChannelId)
        .execute();
      logger.info('pair: discarded existing binding on force-replace', {
        platform: input.platform,
        channel: input.externalChannelId,
        previousGroupId: channelBound.group_id,
        newGroupId: pending.group_id,
      });
    }

    const aliasConflict = await tx
      .selectFrom('group_external_channels')
      .select('alias')
      .where('group_id', '=', pending.group_id)
      .where('alias', '=', pending.alias)
      .executeTakeFirst();
    if (aliasConflict) {
      await tx
        .deleteFrom('pending_connector_pairings')
        .where('code', '=', code)
        .execute();
      return { ok: false, reason: 'alias_taken' };
    }

    await tx
      .insertInto('group_external_channels')
      .values({
        platform: input.platform,
        external_channel_id: input.externalChannelId,
        group_id: pending.group_id,
        config_json: input.externalDisplay
          ? JSON.stringify({ display: input.externalDisplay })
          : null,
        alias: pending.alias,
        created_at: now.toISOString(),
        bot_user_id: pending.bot_user_id,
        bot_token_ciphertext: pending.bot_token_ciphertext,
        bot_token_iv: pending.bot_token_iv,
        bot_token_tag: pending.bot_token_tag,
      })
      .onConflict((oc) =>
        oc.columns(['platform', 'external_channel_id']).doNothing(),
      )
      .execute();

    await tx
      .deleteFrom('pending_connector_pairings')
      .where('code', '=', code)
      .execute();

    // Pair-once identity link: when the inbound pipeline tells us
    // *who* typed the code, attach that external identity to the pair
    // owner (`pending.created_by_user_id`). If a prior shadow user
    // existed for the same (platform, external_user_id), migrate its
    // memberships + messages onto the real owner and delete it.
    if (input.externalUserId) {
      await mergeOrLinkExternalIdentity(tx, {
        platform: input.platform,
        externalUserId: input.externalUserId,
        externalUserDisplay: input.externalUserDisplay ?? null,
        ownerUserId: pending.created_by_user_id,
        now: now.toISOString(),
      });
    }

    return { ok: true, groupId: pending.group_id };
  });
}

export interface MergeArgs {
  platform: ConnectorPlatform;
  externalUserId: string;
  externalUserDisplay: string | null;
  ownerUserId: string;
  now: string;
}

export async function mergeOrLinkExternalIdentity(
  tx: Kysely<DB>,
  args: MergeArgs,
): Promise<void> {
  const existing = await tx
    .selectFrom('external_identities')
    .innerJoin('users', 'users.id', 'external_identities.user_id')
    .select(['external_identities.user_id as user_id', 'users.shadow as shadow'])
    .where('external_identities.platform', '=', args.platform)
    .where('external_identities.external_id', '=', args.externalUserId)
    .executeTakeFirst();

  if (!existing) {
    await tx
      .insertInto('external_identities')
      .values({
        platform: args.platform,
        external_id: args.externalUserId,
        external_display: args.externalUserDisplay,
        user_id: args.ownerUserId,
        created_at: args.now,
      })
      .execute();
    await adoptWhatsappPhone(tx, args);
    return;
  }

  if (existing.user_id === args.ownerUserId) return; // already linked
  if (existing.shadow !== 1) {
    // Identity already linked to a *different* real user. Don't
    // silently overwrite — log and leave as-is. (Real-world hit only
    // if two paired Chord accounts share a TG identity, which is a
    // misuse.)
    logger.warn('pair: external identity already linked to a different real user', {
      platform: args.platform,
      externalUserId: args.externalUserId,
      existing: existing.user_id,
      attemptedOwner: args.ownerUserId,
    });
    return;
  }

  const shadowId = existing.user_id;
  // Capture both personal groups BEFORE re-attribution. Step 3b rewrites
  // groups.created_by shadow→owner, after which the two are
  // indistinguishable. If the owner already had a personal group, the
  // shadow's personal group must fold into it (ADR 0053 addendum) — else
  // the owner ends up with two personal groups and their connector
  // binding + calendar + data split across them.
  const ownerPersonalBefore = await tx
    .selectFrom('groups')
    .select('id')
    .where('kind', '=', 'personal')
    .where('created_by', '=', args.ownerUserId)
    .orderBy('created_at', 'asc')
    .executeTakeFirst();
  const shadowPersonal = await tx
    .selectFrom('groups')
    .select('id')
    .where('kind', '=', 'personal')
    .where('created_by', '=', shadowId)
    .executeTakeFirst();
  // 1. Re-point the identity row.
  await tx
    .updateTable('external_identities')
    .set({
      user_id: args.ownerUserId,
      external_display: args.externalUserDisplay ?? null,
    })
    .where('platform', '=', args.platform)
    .where('external_id', '=', args.externalUserId)
    .execute();
  // 2. Copy shadow's memberships to owner, dedup, then drop shadow's.
  const memberships = await tx
    .selectFrom('group_members')
    .selectAll()
    .where('user_id', '=', shadowId)
    .execute();
  for (const m of memberships) {
    const dupe = await tx
      .selectFrom('group_members')
      .select('user_id')
      .where('group_id', '=', m.group_id)
      .where('user_id', '=', args.ownerUserId)
      .executeTakeFirst();
    if (!dupe) {
      await tx
        .insertInto('group_members')
        .values({
          group_id: m.group_id,
          user_id: args.ownerUserId,
          role: m.role,
          tier: m.tier,
          joined_at: m.joined_at,
          last_read_at: m.last_read_at,
        })
        .execute();
    }
  }
  await tx
    .deleteFrom('group_members')
    .where('user_id', '=', shadowId)
    .execute();
  // 3. Rewrite message sender_ids.
  await tx
    .updateTable('messages')
    .set({ sender_id: args.ownerUserId })
    .where('sender_id', '=', shadowId)
    .execute();
  // 3b. Re-attribute any groups the shadow owns (e.g. a shadow-created
  // mirror group from a connector group-add). Without this, the FK
  // from groups.created_by → users.id blocks the shadow delete below.
  await tx
    .updateTable('groups')
    .set({ created_by: args.ownerUserId })
    .where('created_by', '=', shadowId)
    .execute();
  // 3c. Re-attribute every per-user / authored row the shadow accumulated
  // while unsigned. Group access flows from `group_members` (already
  // migrated in step 2), so the new owner sees these rows automatically
  // — but the FK on `created_by` etc. → users(id) would block the
  // shadow delete below if any of these rows still point at the shadow.
  //
  // Keep this list exhaustive over all user-FK columns the bot can
  // populate on the shadow's behalf. New tables with a user FK should
  // be added here too.
  await reattributeUserFkColumns(tx, shadowId, args.ownerUserId);
  // 4. Delete the shadow user.
  await tx
    .deleteFrom('users')
    .where('id', '=', shadowId)
    .execute();
  // 5. If the owner already had a personal group, the shadow's personal
  // group (re-attributed to the owner in step 3b) is now a duplicate.
  // Fold it into the owner's original so data + bindings live in one place.
  if (
    ownerPersonalBefore &&
    shadowPersonal &&
    ownerPersonalBefore.id !== shadowPersonal.id
  ) {
    await consolidatePersonalGroupInto(tx, shadowPersonal.id, ownerPersonalBefore.id);
    logger.info('pair: consolidated taster personal group into owner', {
      from: shadowPersonal.id,
      to: ownerPersonalBefore.id,
      realUserId: args.ownerUserId,
    });
  }
  // Collapse the daily briefing to exactly one. The shadow had its own
  // daily_morning_scan (it owned a personal group), re-attributed to the
  // owner above — leaving the owner with a duplicate scan whose payload
  // still names the now-deleted shadow user, which renders an empty
  // briefing. Reschedule deletes the owner's unfired scans and re-queues a
  // single correctly-attributed one (no-op when nudges are disabled).
  if (shadowPersonal) {
    await rescheduleDailyScanForUser(tx, args.ownerUserId);
  }
  await adoptWhatsappPhone(tx, args);
  logger.info('pair: merged shadow into real user', {
    platform: args.platform,
    externalUserId: args.externalUserId,
    shadowId,
    realUserId: args.ownerUserId,
    memberships: memberships.length,
  });
}

/**
 * Signing up through WhatsApp verifies the number as surely as an SMS code
 * does — registering a WhatsApp account requires an OTP to that same line —
 * so a linked WhatsApp identity grants `phone_verified` without making the
 * user go and repeat the proof (ADR 0064). No-op for other platforms, and
 * for WhatsApp when the user already has a number.
 *
 * Best-effort: this is a convenience on top of a completed link, and must
 * never be the thing that fails the merge.
 */
async function adoptWhatsappPhone(tx: Kysely<DB>, args: MergeArgs): Promise<void> {
  if (args.platform !== 'whatsapp') return;
  try {
    await adoptPhoneFromWhatsapp(tx, args.ownerUserId, args.externalUserId);
  } catch (err) {
    logger.warn('pair: adopting phone from whatsapp identity failed', {
      userId: args.ownerUserId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Re-point every user-FK column on per-user / authored content from the
 * shadow to the real owner. Group-scoped access (visibility, edit
 * rights) flows from `group_members`, which step 2 already migrates —
 * but the FKs on `created_by` / `assignee_id` / `uploaded_by` etc.
 * → users(id) would block the shadow `DELETE FROM users` below if any
 * row still references the shadow.
 *
 * Scalar-FK tables get a plain UPDATE. Composite-PK tables where a row
 * could collide on the new owner (today: `trip_participants` keyed by
 * `(trip_id, persona_id)`) get an INSERT-OR-IGNORE + DELETE dedup, same
 * pattern as `group_members` above. Catchup, trusted-senders, and
 * permission_requests are skipped — a shadow can't reach those code
 * paths, so the columns are empty for shadow rows in practice.
 *
 * Also the authored-content half of the ADR 0156 Apple-account fold, so
 * the two merges cannot disagree about what "authored" covers.
 */
export async function reattributeUserFkColumns(
  tx: Kysely<DB>,
  shadowId: string,
  ownerUserId: string,
): Promise<void> {
  // Plain UPDATEs: scalar FK, no composite-PK collision possible.
  const scalarMigrations: Array<{
    table: keyof DB;
    column: string;
  }> = [
    { table: 'attachments', column: 'uploaded_by' },
    { table: 'tasks', column: 'created_by' },
    { table: 'tasks', column: 'assignee_id' },
    { table: 'lists', column: 'created_by' },
    { table: 'saves', column: 'created_by' },
    { table: 'events', column: 'created_by' },
    { table: 'events', column: 'assignee_id' },
    // ADR 0040 — user-owned event copies. These NO-ACTION FKs block the
    // shadow `DELETE FROM users` if a taster-created event still points at
    // the shadow; missing them rolled back the whole merge in prod.
    { table: 'events', column: 'owner_user_id' },
    { table: 'events', column: 'organizer_user_id' },
    // event_attendees (rsvps successor) — user_id is NO-ACTION and not part
    // of a unique constraint (UNIQUE is on ical_uid,email), so a plain
    // re-point is safe.
    { table: 'event_attendees', column: 'user_id' },
    { table: 'places', column: 'created_by' },
    { table: 'contacts', column: 'created_by' },
    { table: 'media_items', column: 'created_by' },
    { table: 'trips', column: 'created_by' },
    { table: 'forms', column: 'created_by' },
    { table: 'memories', column: 'persona_id' },
    { table: 'rsvps', column: 'user_id' },
    { table: 'document_permissions', column: 'user_id' },
    { table: 'document_permissions', column: 'granted_by' },
    { table: 'proposals', column: 'proposed_by_user_id' },
    { table: 'proposals', column: 'resolved_by_user_id' },
    { table: 'proactive_messages', column: 'persona_id' },
    { table: 'travel_legs', column: 'persona_id' },
    { table: 'people', column: 'owner_user_id' },
    // docs/notes/0189 — the same identity graph as `people`, same reattribution.
    { table: 'person_relationships', column: 'owner_user_id' },
    // docs/notes/0191 — an unconfirmed person still belongs to whoever it was staged for.
    { table: 'provisional_people', column: 'owner_user_id' },
  ];
  for (const m of scalarMigrations) {
    await tx
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .updateTable(m.table as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .set({ [m.column]: ownerUserId } as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .where(m.column as any, '=', shadowId)
      .execute();
  }

  // Composite-PK: dedup before re-pointing so we don't violate
  // `(trip_id, persona_id)` PK if the owner is already a participant.
  const tripRows = await tx
    .selectFrom('trip_participants')
    .selectAll()
    .where('persona_id', '=', shadowId)
    .execute();
  for (const r of tripRows) {
    const dupe = await tx
      .selectFrom('trip_participants')
      .select('trip_id')
      .where('trip_id', '=', r.trip_id)
      .where('persona_id', '=', ownerUserId)
      .executeTakeFirst();
    if (!dupe) {
      await tx
        .insertInto('trip_participants')
        .values({ trip_id: r.trip_id, persona_id: ownerUserId })
        .execute();
    }
  }
  await tx
    .deleteFrom('trip_participants')
    .where('persona_id', '=', shadowId)
    .execute();

  // docs/notes/0189 — person_relationships.subject_id/related_id are
  // polymorphic: when their type is 'user' they hold a users.id that must
  // also move, independent of the owner_user_id reattribution above (a fold
  // moves what a row POINTS AT, not just who owns it). Dedup like
  // trip_participants above — the unique index is (owner_user_id,
  // subject_type, subject_id, related_type, related_id, relation), so
  // re-pointing could in principle collide with an edge the real account
  // already recorded.
  const subjectRows = await tx
    .selectFrom('person_relationships')
    .selectAll()
    .where('subject_type', '=', 'user')
    .where('subject_id', '=', shadowId)
    .execute();
  for (const r of subjectRows) {
    const dupe = await tx
      .selectFrom('person_relationships')
      .select('id')
      .where('owner_user_id', '=', ownerUserId)
      .where('subject_type', '=', 'user')
      .where('subject_id', '=', ownerUserId)
      .where('related_type', '=', r.related_type)
      .where('related_id', '=', r.related_id)
      .where('relation', '=', r.relation)
      .executeTakeFirst();
    if (dupe) {
      await tx.deleteFrom('person_relationships').where('id', '=', r.id).execute();
    } else {
      await tx.updateTable('person_relationships').set({ subject_id: ownerUserId }).where('id', '=', r.id).execute();
    }
  }
  const relatedRows = await tx
    .selectFrom('person_relationships')
    .selectAll()
    .where('related_type', '=', 'user')
    .where('related_id', '=', shadowId)
    .execute();
  for (const r of relatedRows) {
    const dupe = await tx
      .selectFrom('person_relationships')
      .select('id')
      .where('owner_user_id', '=', r.owner_user_id)
      .where('subject_type', '=', r.subject_type)
      .where('subject_id', '=', r.subject_id)
      .where('related_type', '=', 'user')
      .where('related_id', '=', ownerUserId)
      .where('relation', '=', r.relation)
      .executeTakeFirst();
    if (dupe) {
      await tx.deleteFrom('person_relationships').where('id', '=', r.id).execute();
    } else {
      await tx.updateTable('person_relationships').set({ related_id: ownerUserId }).where('id', '=', r.id).execute();
    }
  }
}

export interface PairingStatus {
  status: 'pending' | 'expired' | 'unknown';
  expiresAt?: string;
}

export async function getPairingStatus(
  db: Kysely<DB>,
  code: string,
  platform: ConnectorPlatform,
  opts: { groupId?: string; now?: Date } = {},
): Promise<PairingStatus> {
  const now = opts.now ?? new Date();
  let q = db
    .selectFrom('pending_connector_pairings')
    .select(['expires_at'])
    .where('code', '=', code.toUpperCase())
    .where('platform', '=', platform);
  // A code belongs to the group that minted it; asking from another group
  // must read as "unknown", not leak that the code exists elsewhere.
  if (opts.groupId) q = q.where('group_id', '=', opts.groupId);
  const row = await q.executeTakeFirst();
  if (!row) return { status: 'unknown' };
  if (new Date(row.expires_at).getTime() < now.getTime()) {
    return { status: 'expired', expiresAt: row.expires_at };
  }
  return { status: 'pending', expiresAt: row.expires_at };
}

/**
 * Cancel a pending pair code before it's consumed or expires. Used by
 * the mobile UI's "X" affordance on pending rows so a stuck/stale pair
 * doesn't block re-minting the alias for 15 minutes. Also tears down
 * the BYO connector if this was the last reference to its bot.
 */
export async function cancelPendingPairing(
  db: Kysely<DB>,
  opts: { groupId: string; code: string },
): Promise<{ canceled: boolean }> {
  const row = await db
    .selectFrom('pending_connector_pairings')
    .select(['platform', 'bot_user_id'])
    .where('group_id', '=', opts.groupId)
    .where('code', '=', opts.code.toUpperCase())
    .executeTakeFirst();
  if (!row) return { canceled: false };
  await db
    .deleteFrom('pending_connector_pairings')
    .where('group_id', '=', opts.groupId)
    .where('code', '=', opts.code.toUpperCase())
    .execute();
  if (row.bot_user_id) {
    await maybeShutdownByoConnector(db, row.platform, row.bot_user_id);
  }
  return { canceled: true };
}

/** Lazy expiry sweep — call from the list/status endpoints. */
export async function sweepExpiredPairings(
  db: Kysely<DB>,
  now = new Date(),
): Promise<number> {
  // Sweep expired pending rows AND tear down any BYO connectors that
  // they were the last reference to.
  const expired = await db
    .selectFrom('pending_connector_pairings')
    .select(['platform', 'bot_user_id'])
    .where('expires_at', '<', now.toISOString())
    .where('bot_user_id', 'is not', null)
    .execute();

  const result = await db
    .deleteFrom('pending_connector_pairings')
    .where('expires_at', '<', now.toISOString())
    .executeTakeFirst();

  for (const row of expired) {
    if (!row.bot_user_id) continue;
    await maybeShutdownByoConnector(db, row.platform, row.bot_user_id);
  }

  return Number(result.numDeletedRows ?? 0);
}

/**
 * Refcount check: tear down a BYO connector when no remaining bindings
 * or pending pairings reference it. Called after binding deletion and
 * pending-pairing expiry.
 */
export async function maybeShutdownByoConnector(
  db: Kysely<DB>,
  platform: ConnectorPlatform,
  botUserId: string,
): Promise<void> {
  const stillUsedBinding = await db
    .selectFrom('group_external_channels')
    .select('external_channel_id')
    .where('platform', '=', platform)
    .where('bot_user_id', '=', botUserId)
    .executeTakeFirst();
  if (stillUsedBinding) return;

  const stillUsedPending = await db
    .selectFrom('pending_connector_pairings')
    .select('code')
    .where('platform', '=', platform)
    .where('bot_user_id', '=', botUserId)
    .executeTakeFirst();
  if (stillUsedPending) return;

  await connectorRegistry.remove(platform, botUserId);
}

// A pairing code binds an outside chat to a Chord group, so it is drawn from
// a CSPRNG (nanoid uses crypto.getRandomValues), never Math.random.
const randomPairCode = customAlphabet(PAIR_ALPHABET, CODE_LENGTH);

function makeRandomCode(): string {
  return randomPairCode();
}
