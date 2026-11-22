/**
 * Bot-add to a TG chat:
 *
 * - Adder is unknown (no paired identity): post a signup nudge. No
 *   binding, no Chord group created.
 * - Adder is paired-real (or auto-provisioned under demo): create a
 *   fresh Chord group named after the TG chat, owned by the adder,
 *   bind the channel, mirror=on, and post a welcome that tells them
 *   they can rename or merge it in the app. We can't reuse an
 *   existing group by name (any heuristic match would be a guess),
 *   and we can't ask them to paste a pair code (they may not have a
 *   Chord group yet to pair from). Creating a new one is the only
 *   reliable starting point.
 *
 * Idempotent on re-add to an already-bound chat: no duplicate welcome.
 */
import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { bindChannel, lookupGroupForChannel } from './channel-resolver.js';
import { autoProvisionDemoUser, lookupIdentity } from './identity-resolver.js';
import { connectorRegistry } from './registry.js';
import type { ConnectorPlatform } from './types.js';
import { createGroup } from '../groups.service.js';

export interface GroupAddEvent {
  platform: ConnectorPlatform;
  externalChannelId: string;
  /** Telegram chat title / Slack channel name. Falls back to the id. */
  chatTitle: string | null;
  /** User who added the bot. Always Telegram-numeric. */
  addedByExternalUserId: string;
  addedByExternalDisplay: string | null;
  /** Bot user id for BYO routing; null for the deploy-wide bot. */
  receivedByBotUserId: string | null;
}

export type GroupAddResult =
  | { bound: false; reason: 'already_bound'; groupId: string }
  | { bound: false; reason: 'unknown_adder' }
  | { bound: true; groupId: string; created: true };

export async function handleGroupAdd(
  db: Kysely<DB>,
  ev: GroupAddEvent,
): Promise<GroupAddResult> {
  const existing = await lookupGroupForChannel(
    db,
    ev.platform,
    ev.externalChannelId,
  );
  if (existing) {
    logger.info('group-add: channel already bound, skipping', {
      platform: ev.platform,
      channel: ev.externalChannelId,
      groupId: existing,
    });
    return { bound: false, reason: 'already_bound', groupId: existing };
  }

  const adder = await lookupIdentity(
    db,
    ev.platform,
    ev.addedByExternalUserId,
  );
  let adderUserId: string;
  if (!adder || adder.shadow) {
    // Demo-mode escape hatch: no Google OAuth, so auto-provision a real
    // user for the adder and treat them as paired. Gated to
    // AUTH_MODE=demo — never under google.
    if (env.AUTH_MODE !== 'demo') {
      await sendUnknownAdderNudge(ev);
      logger.info('group-add: unpaired adder, no binding created', {
        platform: ev.platform,
        channel: ev.externalChannelId,
        addedBy: ev.addedByExternalUserId,
      });
      return { bound: false, reason: 'unknown_adder' };
    }
    adderUserId = await autoProvisionDemoUser(
      db,
      ev.platform,
      ev.addedByExternalUserId,
      ev.addedByExternalDisplay,
    );
    logger.info('group-add: provisioned demo adder', {
      platform: ev.platform,
      addedBy: ev.addedByExternalUserId,
      userId: adderUserId,
    });
  } else {
    adderUserId = adder.userId;
  }
  const title =
    ev.chatTitle && ev.chatTitle.trim().length > 0
      ? ev.chatTitle.trim()
      : `${ev.platform} chat`;

  const group = await createGroup(db, {
    name: title,
    kind: 'group',
    createdBy: adderUserId,
  });
  await db
    .updateTable('groups')
    .set({ mirror_inbound: 1 })
    .where('id', '=', group.id)
    .execute();
  await bindChannel(
    db,
    ev.platform,
    ev.externalChannelId,
    group.id,
    ev.platform,
  );

  await sendBoundGroupWelcome(ev, title);
  logger.info('group-add: paired adder — new Chord group created and bound', {
    platform: ev.platform,
    channel: ev.externalChannelId,
    adder: adderUserId,
    groupId: group.id,
    title,
  });
  return { bound: true, groupId: group.id, created: true };
}

async function sendBoundGroupWelcome(
  ev: GroupAddEvent,
  title: string,
): Promise<void> {
  const conn = connectorRegistry.getForBinding(
    ev.platform,
    ev.receivedByBotUserId,
  );
  if (!conn) return;
  const body = [
    `Hi — I'm Chord. I created a new Chord group "${title}" and I'm mirroring this chat into it.`,
    `Open the Chord app to rename it, add members, or merge with an existing group. To stop mirroring, run /chord unpair here.`,
  ].join('\n');
  try {
    await conn.send({
      externalChannelId: ev.externalChannelId,
      body,
      cards: [],
    });
  } catch (err) {
    logger.warn('group-add: bound-group welcome send failed', {
      platform: ev.platform,
      channel: ev.externalChannelId,
      err: (err as Error).message,
    });
  }
}

async function sendUnknownAdderNudge(ev: GroupAddEvent): Promise<void> {
  const conn = connectorRegistry.getForBinding(
    ev.platform,
    ev.receivedByBotUserId,
  );
  if (!conn) return;
  const link = env.SIGNUP_URL.trim();
  const body = [
    `Hi — I'm Chord. To mirror this chat into Chord, one of you needs an account:`,
    link ? `1. Sign up at ${link}` : `1. Sign up on the Chord app (URL coming soon)`,
    `2. In the app, open Settings → Connectors → Telegram and DM me the pair code.`,
    `Once any paired user posts here, this chat will start mirroring to their Chord group automatically.`,
  ].join('\n');
  try {
    await conn.send({
      externalChannelId: ev.externalChannelId,
      body,
      cards: [],
    });
  } catch (err) {
    logger.warn('group-add: unknown-adder nudge send failed', {
      platform: ev.platform,
      channel: ev.externalChannelId,
      err: (err as Error).message,
    });
  }
}
