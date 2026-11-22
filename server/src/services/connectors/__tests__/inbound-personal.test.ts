/**
 * Inbound-pipeline drop policy for personal vs shared groups.
 *
 * Regression coverage for the fix where personal groups must NOT
 * drop messages just because mirror_inbound=0 and the user didn't
 * @-mention the bot. In a personal group the user is the only human
 * in the loop; every message should reach the bot.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { bindChannel } from '@/services/connectors/channel-resolver.js';
import { MockConnector } from '@/services/connectors/mock/mock.connector.js';
import { connectorRegistry } from '@/services/connectors/registry.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

async function seedGroup(
  db: Kysely<DB>,
  kind: 'personal' | 'group',
  mirrorInbound: 0 | 1,
): Promise<{ groupId: string; userId: string }> {
  const userId = newId('u');
  const groupId = newId('g');
  const now = new Date().toISOString();
  await db
    .insertInto('users')
    .values({
      id: userId,
      username: `u_${userId.slice(2, 8)}`,
      display_name: 'Owner',
      created_at: now,
      shadow: 0,
    })
    .execute();
  await db
    .insertInto('groups')
    .values({
      id: groupId,
      name: kind === 'personal' ? 'Personal' : 'Family',
      kind,
      invite_code: groupId.slice(2, 8).toUpperCase(),
      ingest_email: `${groupId.slice(2)}@chord.app`,
      created_by: userId,
      adults_only: 0,
      mirror_inbound: mirrorInbound,
      created_at: now,
    })
    .execute();
  await db
    .insertInto('group_members')
    .values({
      group_id: groupId,
      user_id: userId,
      role: 'owner',
      tier: 'verified',
      joined_at: now,
    })
    .execute();
  return { groupId, userId };
}

describe('inbound-pipeline drop policy', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
    for (const c of connectorRegistry.list()) {
      await c.shutdown().catch(() => {});
    }
  });

  it('personal group: plain message (no bot mention) is NOT dropped', async () => {
    const { groupId } = await seedGroup(db, 'personal', 0);
    await bindChannel(db, 'telegram', '-p1', groupId, 'telegram');

    const conn = new MockConnector(db, 'telegram');
    connectorRegistry.register(conn);
    try {
      await conn.injectInbound({
        externalChannelId: '-p1',
        externalUserId: 'tg_self',
        text: 'hello self',
        mentionsBot: false,
      });

      const msgs = await db.selectFrom('messages').selectAll().execute();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].body).toBe('hello self');
      // Personal-group messages always surface in Chord.
      expect(msgs[0].chord_visible).toBe(1);
    } finally {
      await conn.shutdown();
    }
  });

  it('shared group + mirror_inbound=0 + no bot mention → dropped', async () => {
    const { groupId } = await seedGroup(db, 'group', 0);
    await bindChannel(db, 'telegram', '-s1', groupId, 'telegram');

    const conn = new MockConnector(db, 'telegram');
    connectorRegistry.register(conn);
    try {
      await conn.injectInbound({
        externalChannelId: '-s1',
        externalUserId: 'tg_alex',
        text: 'random chatter',
        mentionsBot: false,
      });

      const msgs = await db.selectFrom('messages').selectAll().execute();
      expect(msgs).toHaveLength(0);
    } finally {
      await conn.shutdown();
    }
  });

  it('shared group + bot @-mention → kept (chord_visible=0, bot-only)', async () => {
    const { groupId } = await seedGroup(db, 'group', 0);
    await bindChannel(db, 'telegram', '-s2', groupId, 'telegram');

    const conn = new MockConnector(db, 'telegram');
    connectorRegistry.register(conn);
    try {
      await conn.injectInbound({
        externalChannelId: '-s2',
        externalUserId: 'tg_alex',
        text: '@chord help',
        mentionsBot: true,
        mentionsOthers: false,
      });

      const msgs = await db.selectFrom('messages').selectAll().execute();
      expect(msgs).toHaveLength(1);
      // Bot-only mention in a clean-mirror shared group → chord_visible=0.
      expect(msgs[0].chord_visible).toBe(0);
    } finally {
      await conn.shutdown();
    }
  });

  it('shared group + mirror_inbound=1 + bot-only mention → chord_visible=1', async () => {
    // A bot-only message was still sent in the shared connector channel,
    // so every member there already saw the exchange. A group that opted
    // into mirroring should see the bot thread on the Chord surface too,
    // rather than have it silently hidden.
    const { groupId } = await seedGroup(db, 'group', 1);
    await bindChannel(db, 'telegram', '-s4', groupId, 'telegram');

    const conn = new MockConnector(db, 'telegram');
    connectorRegistry.register(conn);
    try {
      await conn.injectInbound({
        externalChannelId: '-s4',
        externalUserId: 'tg_alex',
        text: '@chord add milk to the list',
        mentionsBot: true,
        mentionsOthers: false,
      });

      const msgs = await db.selectFrom('messages').selectAll().execute();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].chord_visible).toBe(1);
    } finally {
      await conn.shutdown();
    }
  });

  it('auto-bind: a stale (group, alias=telegram) row from an old DM channel is replaced, not collided', async () => {
    // Regression: under AUTH_MODE=google, a paired DM sender hitting
    // an unbound channel triggers `maybeAutoBindForPairedSender`. If
    // their personal group already has a `(group_id, alias='telegram')`
    // row pointing at a stale channel id (different bot, deleted chat,
    // prior test fixture), the new bind used to fail on the unique
    // index and the message got dropped. The auto-bind path now wipes
    // the stale row before inserting.
    const { groupId, userId } = await seedGroup(db, 'personal', 0);
    // Pre-existing stale binding on the canonical alias.
    await bindChannel(db, 'telegram', 'OLD_CHANNEL', groupId, 'telegram');
    // Paired-real external identity for the new DM.
    await db
      .insertInto('external_identities')
      .values({
        platform: 'telegram',
        external_id: 'tg_self',
        external_display: 'Self',
        user_id: userId,
        created_at: new Date().toISOString(),
      })
      .execute();

    const conn = new MockConnector(db, 'telegram');
    connectorRegistry.register(conn);
    try {
      await conn.injectInbound({
        externalChannelId: 'NEW_CHANNEL',
        externalUserId: 'tg_self',
        text: 'hi from the new dm',
        isPrivate: true,
        mentionsBot: false,
      });

      // The stale row should have been wiped; only the new one remains.
      const bindings = await db
        .selectFrom('group_external_channels')
        .selectAll()
        .where('group_id', '=', groupId)
        .where('platform', '=', 'telegram')
        .execute();
      expect(bindings).toHaveLength(1);
      expect(bindings[0].external_channel_id).toBe('NEW_CHANNEL');

      // And the inbound message landed in the personal group.
      const msgs = await db
        .selectFrom('messages')
        .selectAll()
        .where('group_id', '=', groupId)
        .execute();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].body).toBe('hi from the new dm');
    } finally {
      await conn.shutdown();
    }
  });

  it('shared group + mirror_inbound=1 → kept regardless of bot mention', async () => {
    const { groupId } = await seedGroup(db, 'group', 1);
    await bindChannel(db, 'telegram', '-s3', groupId, 'telegram');

    const conn = new MockConnector(db, 'telegram');
    connectorRegistry.register(conn);
    try {
      await conn.injectInbound({
        externalChannelId: '-s3',
        externalUserId: 'tg_alex',
        text: 'arbitrary chat',
        mentionsBot: false,
      });

      const msgs = await db.selectFrom('messages').selectAll().execute();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].chord_visible).toBe(1);
    } finally {
      await conn.shutdown();
    }
  });
});
