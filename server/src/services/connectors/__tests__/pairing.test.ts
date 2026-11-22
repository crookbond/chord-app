/**
 * Pairing service unit tests + the inbound-pipeline interceptor.
 * Drives MockConnector through `injectInbound` since the connector is
 * what actually pushes /chord pair text into the pipeline at runtime.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import {
  bindChannel,
  listBindingsForGroup,
} from '@/services/connectors/channel-resolver.js';
import { MockConnector } from '@/services/connectors/mock/mock.connector.js';
import {
  consumePairingCode,
  generatePairingCode,
  getPairingStatus,
  sweepExpiredPairings,
} from '@/services/connectors/pairing.service.js';
import { connectorRegistry } from '@/services/connectors/registry.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

async function seedShared(db: Kysely<DB>): Promise<{ groupId: string; userId: string }> {
  const userId = newId('u');
  const groupId = newId('g');
  const now = new Date().toISOString();
  await db
    .insertInto('users')
    .values({
      id: userId,
      username: `owner_${userId.slice(2)}`,
      display_name: 'Owner',
      created_at: now,
      shadow: 0,
    })
    .execute();
  await db
    .insertInto('groups')
    .values({
      id: groupId,
      name: 'Family Trip',
      kind: 'group',
      invite_code: groupId.slice(2, 8).toUpperCase(),
      ingest_email: `pair-${groupId.slice(2)}@chord.app`,
      created_by: userId,
      adults_only: 0,
      mirror_inbound: 1,
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

async function seedPersonal(db: Kysely<DB>): Promise<{ groupId: string; userId: string }> {
  const userId = newId('u');
  const groupId = newId('g');
  const now = new Date().toISOString();
  await db
    .insertInto('users')
    .values({
      id: userId,
      username: `solo_${userId.slice(2)}`,
      display_name: 'Solo',
      created_at: now,
      shadow: 0,
    })
    .execute();
  await db
    .insertInto('groups')
    .values({
      id: groupId,
      name: 'Personal',
      kind: 'personal',
      invite_code: groupId.slice(2, 8).toUpperCase(),
      ingest_email: `personal-${groupId.slice(2)}@chord.app`,
      created_by: userId,
      adults_only: 0,
      mirror_inbound: 1,
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

describe('pairing service — generate', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('produces a code in the documented alphabet + length', async () => {
    const { groupId, userId } = await seedShared(db);
    const { code, expiresAt } = await generatePairingCode(db, {
      platform: 'telegram',
      groupId,
      userId,
    });
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('accepts personal groups (two-way bridge into private chat)', async () => {
    const { groupId, userId } = await seedPersonal(db);
    const { code } = await generatePairingCode(db, {
      platform: 'telegram',
      groupId,
      userId,
    });
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  });

  it('rejects when an existing binding already covers the platform', async () => {
    const { groupId, userId } = await seedShared(db);
    await bindChannel(db, 'telegram', '-1001', groupId, 'telegram');
    await expect(
      generatePairingCode(db, { platform: 'telegram', groupId, userId }),
    ).rejects.toMatchObject({ reason: 'alias_already_in_use' });
  });

  it('rejects unknown groups', async () => {
    await expect(
      generatePairingCode(db, {
        platform: 'telegram',
        groupId: 'g_missing',
        userId: 'u_x',
      }),
    ).rejects.toMatchObject({ reason: 'group_not_found' });
  });

  it('retries on rare alphabet collisions', async () => {
    const { groupId, userId } = await seedShared(db);
    const codes = ['XXXXXX', 'XXXXXX', 'YYYYYY']; // first two collide
    let i = 0;
    const { code } = await generatePairingCode(db, {
      platform: 'telegram',
      groupId,
      userId,
      randomCode: () => codes[i++] ?? 'ZZZZZZ',
    });
    expect(code).toBe('XXXXXX');

    // Generate another with the same first code → collision → retry → 'YYYYYY'.
    const { groupId: g2, userId: u2 } = await seedShared(db);
    let j = 0;
    const { code: code2 } = await generatePairingCode(db, {
      platform: 'telegram',
      groupId: g2,
      userId: u2,
      randomCode: () => codes[j++] ?? 'ZZZZZZ',
    });
    expect(code2).toBe('YYYYYY');
  });
});

describe('pairing service — consume', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('binds the channel and removes the pending row', async () => {
    const { groupId, userId } = await seedShared(db);
    const { code } = await generatePairingCode(db, {
      platform: 'telegram',
      groupId,
      userId,
    });
    const result = await consumePairingCode(db, {
      code,
      platform: 'telegram',
      externalChannelId: '-1001234567890',
      externalDisplay: 'Family Trip TG',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.groupId).toBe(groupId);

    const bindings = await listBindingsForGroup(db, groupId);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      platform: 'telegram',
      externalChannelId: '-1001234567890',
    });
    const remaining = await db
      .selectFrom('pending_connector_pairings')
      .select('code')
      .execute();
    expect(remaining).toHaveLength(0);
  });

  it('returns ok=false reason=unknown_code on unknown codes', async () => {
    const result = await consumePairingCode(db, {
      code: 'NOPE12',
      platform: 'telegram',
      externalChannelId: '-1',
    });
    expect(result).toEqual({ ok: false, reason: 'unknown_code' });
  });

  it('returns ok=false reason=expired_code and cleans up on expired codes', async () => {
    const { groupId, userId } = await seedShared(db);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { code } = await generatePairingCode(db, {
      platform: 'telegram',
      groupId,
      userId,
      now: () => yesterday,
      ttlMinutes: 15,
    });
    const result = await consumePairingCode(db, {
      code,
      platform: 'telegram',
      externalChannelId: '-1',
    });
    expect(result).toEqual({ ok: false, reason: 'expired_code' });
    const remaining = await db
      .selectFrom('pending_connector_pairings')
      .select('code')
      .execute();
    expect(remaining).toHaveLength(0);
  });

  it('returns ok=false reason=alias_taken when alias collides', async () => {
    const { groupId, userId } = await seedShared(db);
    const { code } = await generatePairingCode(db, {
      platform: 'telegram',
      groupId,
      userId,
    });
    // Race: another bind sneaks in with the same alias before consume runs.
    await bindChannel(db, 'telegram', '-1_other', groupId, 'telegram');
    const result = await consumePairingCode(db, {
      code,
      platform: 'telegram',
      externalChannelId: '-1234',
    });
    expect(result).toEqual({ ok: false, reason: 'alias_taken' });
  });

  it('returns ok=false reason=channel_already_bound when the chat is already attached to a Chord group', async () => {
    const { groupId, userId } = await seedShared(db);
    // Pre-existing binding owns this channel id (different alias to avoid
    // confusing this test with the alias-collision case).
    await bindChannel(db, 'telegram', '-CHAT_X', groupId, 'family');
    const { code } = await generatePairingCode(db, {
      platform: 'telegram',
      groupId,
      userId,
      alias: 'office',
    });
    // The user types /chord pair CODE in the SAME chat that's already paired.
    const result = await consumePairingCode(db, {
      code,
      platform: 'telegram',
      externalChannelId: '-CHAT_X',
    });
    expect(result).toEqual({
      ok: false,
      reason: 'channel_already_bound',
      existingGroupId: groupId,
    });
    // Pending row PERSISTS so the user can retry with `replace` within
    // the TTL window.
    const remaining = await db
      .selectFrom('pending_connector_pairings')
      .select('code')
      .execute();
    expect(remaining).toHaveLength(1);
  });

  it('force=true on an already-bound channel discards the old binding and rebinds', async () => {
    const { groupId: oldGroupId, userId } = await seedShared(db);
    const { groupId: newGroupId } = await seedShared(db);
    await bindChannel(db, 'telegram', '-CHAT_SWAP', oldGroupId, 'family');
    const { code } = await generatePairingCode(db, {
      platform: 'telegram',
      groupId: newGroupId,
      userId,
      alias: 'team',
    });
    const result = await consumePairingCode(db, {
      code,
      platform: 'telegram',
      externalChannelId: '-CHAT_SWAP',
      force: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.groupId).toBe(newGroupId);
    // Only one binding row should remain — the new one.
    const bindings = await db
      .selectFrom('group_external_channels')
      .selectAll()
      .where('external_channel_id', '=', '-CHAT_SWAP')
      .execute();
    expect(bindings).toHaveLength(1);
    expect(bindings[0].group_id).toBe(newGroupId);
  });

  // ADR 0025 — BYO bot id must match between pending row and the
  // connector that delivered the pair message; otherwise a deploy-wide
  // bot in the same chat could swallow a code minted for a BYO bot.
  it('returns wrong_bot when a BYO pending row is consumed by a different bot', async () => {
    const { groupId, userId } = await seedShared(db);

    // Manually insert a pending row with bot_user_id='999' to simulate a
    // BYO pairing started earlier (bypasses generatePairingCode's
    // network call to the platform).
    await db
      .insertInto('pending_connector_pairings')
      .values({
        code: 'ABC123',
        platform: 'telegram',
        group_id: groupId,
        created_by_user_id: userId,
        alias: 'mybot',
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        bot_user_id: '999',
        bot_username: 'my_bot',
        bot_token_ciphertext: Buffer.from('sealed'),
        bot_token_iv: Buffer.from('iv'),
        bot_token_tag: Buffer.from('tag'),
      })
      .execute();

    // Deploy-wide bot (bot_user_id=null) tries to consume — should fail.
    const result = await consumePairingCode(db, {
      code: 'ABC123',
      platform: 'telegram',
      externalChannelId: '-1001',
      receivedByBotUserId: null,
    });
    expect(result).toEqual({ ok: false, reason: 'wrong_bot' });

    // Pending row remains so the correct bot can still consume it.
    const remaining = await db
      .selectFrom('pending_connector_pairings')
      .select('code')
      .execute();
    expect(remaining).toHaveLength(1);
  });

  // ADR 0025 + ADR 0027 regression: the deploy-wide bot's connector
  // reports its actual bot user-id in `receivedByBotUserId`, but a
  // deploy-wide pairing leaves pending.bot_user_id NULL. Mismatched
  // strings vs NULL must NOT trip wrong_bot — otherwise the second (or
  // later) binding through one deploy-wide bot can never be consumed.
  it('deploy-wide pairing succeeds even when the connector reports its bot user-id', async () => {
    const { groupId, userId } = await seedShared(db);
    const { code } = await generatePairingCode(db, {
      platform: 'telegram',
      groupId,
      userId,
      alias: 'second-tg-group',
    });
    const result = await consumePairingCode(db, {
      code,
      platform: 'telegram',
      externalChannelId: '-1002',
      receivedByBotUserId: '12345', // the deploy-wide bot's actual id
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.groupId).toBe(groupId);

    const binding = await db
      .selectFrom('group_external_channels')
      .selectAll()
      .where('platform', '=', 'telegram')
      .where('external_channel_id', '=', '-1002')
      .executeTakeFirstOrThrow();
    // Binding stays bot_user_id=NULL — it's a deploy-wide bind, lookups
    // fall back to the deploy-wide entry in the connector registry.
    expect(binding.bot_user_id).toBeNull();
  });

  it('BYO consume copies bot_user_id + encrypted token onto the binding', async () => {
    const { groupId, userId } = await seedShared(db);
    await db
      .insertInto('pending_connector_pairings')
      .values({
        code: 'DEF456',
        platform: 'telegram',
        group_id: groupId,
        created_by_user_id: userId,
        alias: 'mybot',
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        bot_user_id: '777',
        bot_username: 'my_bot',
        bot_token_ciphertext: Buffer.from('sealed'),
        bot_token_iv: Buffer.from('iv'),
        bot_token_tag: Buffer.from('tag'),
      })
      .execute();

    const result = await consumePairingCode(db, {
      code: 'DEF456',
      platform: 'telegram',
      externalChannelId: '-2002',
      receivedByBotUserId: '777',
    });
    expect(result).toEqual({ ok: true, groupId });

    const binding = await db
      .selectFrom('group_external_channels')
      .selectAll()
      .where('platform', '=', 'telegram')
      .where('external_channel_id', '=', '-2002')
      .executeTakeFirstOrThrow();
    expect(binding.bot_user_id).toBe('777');
    expect(binding.bot_token_ciphertext?.toString()).toBe('sealed');
  });
});

describe('pairing service — status + sweep', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('reports unknown / pending / expired', async () => {
    const { groupId, userId } = await seedShared(db);
    expect((await getPairingStatus(db, 'NOTHING', 'telegram')).status).toBe(
      'unknown',
    );

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { code } = await generatePairingCode(db, {
      platform: 'telegram',
      groupId,
      userId,
      now: () => yesterday,
    });
    expect((await getPairingStatus(db, code, 'telegram')).status).toBe(
      'expired',
    );
  });

  it('sweepExpiredPairings deletes only expired rows', async () => {
    const { groupId, userId } = await seedShared(db);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const past = new Date(Date.now() - 60 * 1000);

    await db
      .insertInto('pending_connector_pairings')
      .values({
        code: 'FRESH1',
        platform: 'telegram',
        group_id: groupId,
        created_by_user_id: userId,
        alias: 'telegram',
        created_at: new Date().toISOString(),
        expires_at: future.toISOString(),
      })
      .execute();
    await db
      .insertInto('pending_connector_pairings')
      .values({
        code: 'STALE1',
        platform: 'telegram',
        group_id: groupId,
        created_by_user_id: userId,
        alias: 'telegram-stale',
        created_at: new Date().toISOString(),
        expires_at: past.toISOString(),
      })
      .execute();

    const removed = await sweepExpiredPairings(db);
    expect(removed).toBe(1);
    const remaining = await db
      .selectFrom('pending_connector_pairings')
      .select('code')
      .execute();
    expect(remaining.map((r) => r.code)).toEqual(['FRESH1']);
  });
});

describe('inbound-pipeline — /chord pair interceptor', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
    // Clean up the global singleton between tests.
    for (const c of connectorRegistry.list()) {
      await c.shutdown().catch(() => {});
    }
    // Crude reset — connectorRegistry is a singleton; tests register
    // their own MockConnector and we leave it.
  });

  it('binds the channel and posts a confirmation back via the connector', async () => {
    const { groupId, userId } = await seedShared(db);
    const { code } = await generatePairingCode(db, {
      platform: 'telegram',
      groupId,
      userId,
    });

    const conn = new MockConnector(db, 'telegram');
    connectorRegistry.register(conn);
    try {
      await conn.injectInbound({
        externalChannelId: '-1001234567890',
        externalUserId: 'u_alex',
        externalUserDisplay: 'Alex',
        text: `/chord pair ${code}`,
      });

      const bindings = await listBindingsForGroup(db, groupId);
      expect(bindings).toHaveLength(1);
      expect(bindings[0].externalChannelId).toBe('-1001234567890');

      // The /chord pair text is NOT inserted into messages — it's a
      // meta-command, not a real chat utterance.
      const msgs = await db.selectFrom('messages').selectAll().execute();
      expect(msgs).toHaveLength(0);

      // The connector got a friendly confirmation.
      expect(conn.sent).toHaveLength(1);
      expect(conn.sent[0].text).toMatch(/connected to chord group/i);
    } finally {
      await conn.shutdown();
    }
  });

  // An `unknown_code` outcome means "this pair command is not for me."
  // When multiple bots share a chat — two app instances, or a
  // deploy-wide bot alongside a BYO bot — only the bot that owns the
  // code should reply. Bots that don't recognise the code stay silent
  // so the user doesn't see spurious errors from the wrong bot.
  it('stays silent when the code is unknown to this bot', async () => {
    await seedShared(db);
    const conn = new MockConnector(db, 'telegram');
    connectorRegistry.register(conn);
    try {
      await conn.injectInbound({
        externalChannelId: '-1',
        externalUserId: 'u_alex',
        text: `/chord pair NOTREAL`,
      });
      expect(conn.sent).toHaveLength(0);
    } finally {
      await conn.shutdown();
    }
  });

  it('/chord unpair removes the binding and acks', async () => {
    const { groupId } = await seedShared(db);
    await bindChannel(db, 'telegram', '-9001', groupId, 'telegram');
    const conn = new MockConnector(db, 'telegram');
    connectorRegistry.register(conn);
    try {
      await conn.injectInbound({
        externalChannelId: '-9001',
        externalUserId: 'u_alex',
        text: '/chord unpair',
      });
      const binding = await db
        .selectFrom('group_external_channels')
        .selectAll()
        .where('external_channel_id', '=', '-9001')
        .executeTakeFirst();
      expect(binding).toBeUndefined();
      expect(conn.sent).toHaveLength(1);
      expect(conn.sent[0].text).toMatch(/Disconnected/i);
    } finally {
      await conn.shutdown();
    }
  });

  it('/chord unpair on an unbound chat replies "not paired"', async () => {
    const conn = new MockConnector(db, 'telegram');
    connectorRegistry.register(conn);
    try {
      await conn.injectInbound({
        externalChannelId: '-9999',
        externalUserId: 'u_alex',
        text: '/chord unpair',
      });
      expect(conn.sent).toHaveLength(1);
      expect(conn.sent[0].text).toMatch(/isn't paired/i);
    } finally {
      await conn.shutdown();
    }
  });

  it('does NOT short-circuit non-pair messages', async () => {
    const { groupId } = await seedShared(db);
    await bindChannel(db, 'telegram', '-1001', groupId, 'telegram');

    const conn = new MockConnector(db, 'telegram');
    connectorRegistry.register(conn);
    try {
      await conn.injectInbound({
        externalChannelId: '-1001',
        externalUserId: 'u_alex',
        text: 'just a normal message',
      });

      // The normal pipeline ran: a row is inserted in messages.
      const msgs = await db.selectFrom('messages').selectAll().execute();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].body).toBe('just a normal message');
      // Ambient (non-bot-mention) shadow messages produce no signup
      // notice anywhere — the in-group nudge is gated on the user
      // actually invoking the bot.
      expect(conn.sent).toHaveLength(0);
    } finally {
      await conn.shutdown();
    }
  });

  it('shadow user invoking bot in bound group → in-group signup notice (one-time)', async () => {
    const { groupId } = await seedShared(db);
    await bindChannel(db, 'telegram', '-1002', groupId, 'telegram');

    const conn = new MockConnector(db, 'telegram');
    connectorRegistry.register(conn);
    try {
      await conn.injectInbound({
        externalChannelId: '-1002',
        externalUserId: 'u_shadow_x',
        text: '@chord remind me to buy milk',
        mentionsBot: true,
      });

      // Notice lands in the group, not in a DM.
      const inGroup = conn.sent.filter(
        (s) => s.externalChannelId === '-1002',
      );
      expect(inGroup.length).toBeGreaterThanOrEqual(1);
      expect(inGroup[0].text).toMatch(/sign in, or create an account/i);
      expect(inGroup[0].text).toMatch(/personal chat/i);

      // Second invocation: no second notice (cooldown).
      const sentBefore = conn.sent.length;
      await conn.injectInbound({
        externalChannelId: '-1002',
        externalUserId: 'u_shadow_x',
        text: '@chord and bread',
        mentionsBot: true,
      });
      const noticeAfter = conn.sent
        .slice(sentBefore)
        .filter((s) => /sign in, or create an account/i.test(s.text));
      expect(noticeAfter).toHaveLength(0);
    } finally {
      await conn.shutdown();
    }
  });
});

describe('pairing — shadow merge on DM pair', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('links external identity to the pair owner when none exists', async () => {
    const { groupId, userId } = await seedShared(db);
    const { code } = await generatePairingCode(db, {
      platform: 'telegram',
      groupId,
      userId,
    });
    const result = await consumePairingCode(db, {
      code,
      platform: 'telegram',
      externalChannelId: '555',
      externalUserId: '555',
      externalUserDisplay: 'Alice',
    });
    expect(result.ok).toBe(true);
    const link = await db
      .selectFrom('external_identities')
      .selectAll()
      .where('external_id', '=', '555')
      .executeTakeFirstOrThrow();
    expect(link.user_id).toBe(userId);
  });

  it('merges an existing shadow user into the pair owner', async () => {
    const { groupId, userId } = await seedShared(db);
    const now = new Date().toISOString();
    // Pre-existing shadow for the same TG identity, with one message
    // and a membership in a different Chord group.
    const shadowId = 'u_shadow';
    const otherGroupId = newId('g');
    await db
      .insertInto('users')
      .values({
        id: shadowId,
        username: 'tg_777',
        display_name: 'Old Shadow',
        created_at: now,
        shadow: 1,
      })
      .execute();
    await db
      .insertInto('groups')
      .values({
        id: otherGroupId,
        name: 'Other',
        kind: 'group',
        invite_code: otherGroupId.slice(2, 8).toUpperCase(),
        ingest_email: `other-${otherGroupId.slice(2)}@chord.app`,
        created_by: shadowId,
        adults_only: 0,
        mirror_inbound: 1,
        created_at: now,
      })
      .execute();
    await db
      .insertInto('group_members')
      .values({
        group_id: otherGroupId,
        user_id: shadowId,
        role: 'member',
        tier: 'guest',
        joined_at: now,
      })
      .execute();
    await db
      .insertInto('external_identities')
      .values({
        platform: 'telegram',
        external_id: '777',
        external_display: 'Old Shadow',
        user_id: shadowId,
        created_at: now,
      })
      .execute();
    await db
      .insertInto('messages')
      .values({
        id: 'm_shadow_1',
        group_id: otherGroupId,
        sender_id: shadowId,
        kind: 'text',
        body: 'hi from shadow',
        attachment_id: null,
        reply_to_id: null,
        mentions_bot: 0,
        mentions_others: 0,
        chord_visible: 1,
        auto_mirror: 1,
        source: 'telegram',
        external_message_id: 'ext_1',
        bot_persona_id: null,
        is_proactive: 0,
        created_at: now,
      })
      .execute();

    const { code } = await generatePairingCode(db, {
      platform: 'telegram',
      groupId,
      userId,
    });
    const result = await consumePairingCode(db, {
      code,
      platform: 'telegram',
      externalChannelId: '777',
      externalUserId: '777',
      externalUserDisplay: 'Alice',
    });
    expect(result.ok).toBe(true);

    // External identity now points at the real user.
    const link = await db
      .selectFrom('external_identities')
      .select('user_id')
      .where('external_id', '=', '777')
      .executeTakeFirstOrThrow();
    expect(link.user_id).toBe(userId);

    // Shadow's message sender_id rewritten.
    const msg = await db
      .selectFrom('messages')
      .select('sender_id')
      .where('id', '=', 'm_shadow_1')
      .executeTakeFirstOrThrow();
    expect(msg.sender_id).toBe(userId);

    // Shadow's membership migrated.
    const memberships = await db
      .selectFrom('group_members')
      .select(['user_id', 'group_id'])
      .where('group_id', '=', otherGroupId)
      .execute();
    expect(memberships.some((m) => m.user_id === userId)).toBe(true);
    expect(memberships.some((m) => m.user_id === shadowId)).toBe(false);

    // Shadow row deleted.
    const stillShadow = await db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', shadowId)
      .executeTakeFirst();
    expect(stillShadow).toBeUndefined();
  });

  it('re-attributes every per-user FK column the shadow accumulated', async () => {
    // Shadow has been used by the bot to create tasks / lists / events /
    // saves / places / contacts / media / trips / forms / proposals /
    // RSVPs / attachments / memories / people / etc. across one or two
    // groups. After pair, the FK on each of those tables must point at
    // the real user — otherwise the shadow DELETE FROM users would
    // blow up on a FK constraint. We verify the no-blow-up *plus*
    // representative samples land on the owner.
    const { groupId, userId } = await seedShared(db);
    const now = new Date().toISOString();
    const shadowId = 'u_shadow_full';
    await db
      .insertInto('users')
      .values({
        id: shadowId,
        username: 'tg_999',
        display_name: 'Shadow Nine',
        created_at: now,
        shadow: 1,
      })
      .execute();
    await db
      .insertInto('external_identities')
      .values({
        platform: 'telegram',
        external_id: '999',
        external_display: 'Shadow Nine',
        user_id: shadowId,
        created_at: now,
      })
      .execute();
    await db
      .insertInto('group_members')
      .values({
        group_id: groupId,
        user_id: shadowId,
        role: 'member',
        tier: 'guest',
        joined_at: now,
      })
      .execute();
    // Bot-created content authored under the shadow.
    await db
      .insertInto('tasks')
      .values({
        id: 't_1',
        group_id: groupId,
        title: 'pack passport',
        details: null,
        assignee_id: shadowId,
        status: 'open',
        due_at: null,
        remind_at: null,
        remind_cue: null,
        live_until: null,
        archived_at: null,
        created_by: shadowId,
        created_at: now,
        source_raw_context: null,
      })
      .execute();
    await db
      .insertInto('lists')
      .values({
        id: 'l_1',
        group_id: groupId,
        name: 'Costco',
        created_by: shadowId,
        created_at: now,
      })
      .execute();
    await db
      .insertInto('events')
      .values({
        id: 'e_1',
        group_id: groupId,
        title: 'doctor',
        location: null,
        starts_at: now,
        ends_at: null,
        created_by: shadowId,
        assignee_id: shadowId,
        created_at: now,
        source_raw_context: null,
        external_uid: null,
      })
      .execute();
    await db
      .insertInto('saves')
      .values({
        id: 's_1',
        group_id: groupId,
        kind: 'link',
        title: 'recipe',
        url: 'https://example.test',
        note: null,
        tags: '[]',
        trip_label: null,
        created_by: shadowId,
        created_at: now,
        source_raw_context: null,
      })
      .execute();
    await db
      .insertInto('places')
      .values({
        id: 'p_1',
        group_id: groupId,
        name: 'cafe',
        area: null,
        city: null,
        tags: '[]',
        note: null,
        created_by: shadowId,
        created_at: now,
      })
      .execute();
    await db
      .insertInto('contacts')
      .values({
        id: 'c_1',
        group_id: groupId,
        name: 'doctor',
        org: null,
        education: null,
        family: null,
        tags: '[]',
        note: null,
        created_by: shadowId,
        created_at: now,
      })
      .execute();
    await db
      .insertInto('media_items')
      .values({
        id: 'mi_1',
        group_id: groupId,
        kind: 'book',
        title: 'novel',
        note: null,
        done: 0,
        created_by: shadowId,
        created_at: now,
      })
      .execute();
    await db
      .insertInto('trips')
      .values({
        id: 'tr_1',
        group_id: groupId,
        name: 'beach',
        destination: 'OBX',
        start_date: '2026-06-01',
        end_date: '2026-06-05',
        created_by: shadowId,
        created_at: now,
        source_raw_context: null,
      })
      .execute();
    await db
      .insertInto('trip_participants')
      .values({ trip_id: 'tr_1', persona_id: shadowId })
      .execute();
    await db
      .insertInto('people')
      .values({
        id: 'pe_1',
        owner_user_id: shadowId,
        display_name: 'Mom',
        notes: null,
        created_at: now,
        updated_at: now,
      })
      .execute();

    const { code } = await generatePairingCode(db, {
      platform: 'telegram',
      groupId,
      userId,
    });
    const result = await consumePairingCode(db, {
      code,
      platform: 'telegram',
      externalChannelId: '999',
      externalUserId: '999',
      externalUserDisplay: 'Alice',
    });
    expect(result.ok).toBe(true);

    // Shadow row gone — proves no FK blocked the delete.
    const stillShadow = await db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', shadowId)
      .executeTakeFirst();
    expect(stillShadow).toBeUndefined();

    // Representative spot-checks: per-user-FK columns now point at owner.
    const task = await db
      .selectFrom('tasks')
      .select(['created_by', 'assignee_id'])
      .where('id', '=', 't_1')
      .executeTakeFirstOrThrow();
    expect(task.created_by).toBe(userId);
    expect(task.assignee_id).toBe(userId);

    const list = await db
      .selectFrom('lists')
      .select('created_by')
      .where('id', '=', 'l_1')
      .executeTakeFirstOrThrow();
    expect(list.created_by).toBe(userId);

    const event = await db
      .selectFrom('events')
      .select(['created_by', 'assignee_id'])
      .where('id', '=', 'e_1')
      .executeTakeFirstOrThrow();
    expect(event.created_by).toBe(userId);
    expect(event.assignee_id).toBe(userId);

    const save = await db
      .selectFrom('saves')
      .select('created_by')
      .where('id', '=', 's_1')
      .executeTakeFirstOrThrow();
    expect(save.created_by).toBe(userId);

    const place = await db
      .selectFrom('places')
      .select('created_by')
      .where('id', '=', 'p_1')
      .executeTakeFirstOrThrow();
    expect(place.created_by).toBe(userId);

    const contact = await db
      .selectFrom('contacts')
      .select('created_by')
      .where('id', '=', 'c_1')
      .executeTakeFirstOrThrow();
    expect(contact.created_by).toBe(userId);

    const media = await db
      .selectFrom('media_items')
      .select('created_by')
      .where('id', '=', 'mi_1')
      .executeTakeFirstOrThrow();
    expect(media.created_by).toBe(userId);

    const trip = await db
      .selectFrom('trips')
      .select('created_by')
      .where('id', '=', 'tr_1')
      .executeTakeFirstOrThrow();
    expect(trip.created_by).toBe(userId);

    const tripPart = await db
      .selectFrom('trip_participants')
      .selectAll()
      .where('trip_id', '=', 'tr_1')
      .execute();
    expect(tripPart.some((p) => p.persona_id === userId)).toBe(true);
    expect(tripPart.some((p) => p.persona_id === shadowId)).toBe(false);

    const person = await db
      .selectFrom('people')
      .select('owner_user_id')
      .where('id', '=', 'pe_1')
      .executeTakeFirstOrThrow();
    expect(person.owner_user_id).toBe(userId);
  });

  it('end-to-end via handleInbound: shadow built up in bound group → user signs up + pairs from DM → bound group surfaces under the new user', async () => {
    // The earlier tests call consumePairingCode directly. This one walks
    // the realistic path: every step goes through `handleInbound` via
    // MockConnector.injectInbound, the same entry point Telegram's
    // long-poll loop uses. The point is to catch wiring regressions
    // (slash-rewrite, bare-code DM detection, externalUserId threading)
    // that the unit tests bypass.
    const conn = new MockConnector(db, 'telegram');
    connectorRegistry.register(conn);
    try {
      // 1. Bob already owns a Chord group bound to a Telegram chat.
      const { groupId: bobGroupId, userId: bobId } = await seedShared(db);
      await bindChannel(db, 'telegram', '-7001', bobGroupId, 'telegram');

      // 2. Alice (TG id 42) messages in Bob's bound group. Inbound
      //    pipeline creates a shadow user for her, adds her as a guest
      //    member, and (because she @-mentioned the bot) posts a
      //    one-time in-group signup notice.
      await conn.injectInbound({
        externalChannelId: '-7001',
        externalUserId: '42',
        externalUserDisplay: 'Alice',
        text: '@chord add eggs to costco list',
        mentionsBot: true,
      });

      const shadow = await db
        .selectFrom('users')
        .innerJoin('external_identities', 'external_identities.user_id', 'users.id')
        .select(['users.id as id', 'users.shadow as shadow'])
        .where('external_identities.platform', '=', 'telegram')
        .where('external_identities.external_id', '=', '42')
        .executeTakeFirstOrThrow();
      expect(shadow.shadow).toBe(1);
      const shadowId = shadow.id;

      const guestMembership = await db
        .selectFrom('group_members')
        .selectAll()
        .where('group_id', '=', bobGroupId)
        .where('user_id', '=', shadowId)
        .executeTakeFirstOrThrow();
      expect(guestMembership.tier).toBe('guest');

      // 3. Alice signs up via Google (modelled as a direct insert here —
      //    auth.ts is exercised in its own suite). She gets her own
      //    Chord group that's unrelated to Bob's.
      const aliceId = newId('u');
      const aliceGroupId = newId('g');
      const now = new Date().toISOString();
      await db
        .insertInto('users')
        .values({
          id: aliceId,
          username: 'alice',
          display_name: 'Alice',
          email: 'alice@example.test',
          email_verified: 1,
          google_sub: 'sub_alice',
          shadow: 0,
          created_at: now,
        })
        .execute();
      await db
        .insertInto('groups')
        .values({
          id: aliceGroupId,
          name: 'Alice',
          kind: 'personal',
          invite_code: aliceGroupId.slice(2, 8).toUpperCase(),
          ingest_email: `alice-${aliceGroupId.slice(2)}@chord.app`,
          created_by: aliceId,
          adults_only: 0,
          mirror_inbound: 1,
          created_at: now,
        })
        .execute();
      await db
        .insertInto('group_members')
        .values({
          group_id: aliceGroupId,
          user_id: aliceId,
          role: 'owner',
          tier: 'verified',
          joined_at: now,
        })
        .execute();

      // 4. Alice mints a pair code from her app, scoped to her personal
      //    group (this is the connector-pairing flow the mobile UI runs).
      const { code } = await generatePairingCode(db, {
        platform: 'telegram',
        groupId: aliceGroupId,
        userId: aliceId,
      });

      // 5. Alice opens a DM with the bot (TG chat id == her user id 42
      //    for private chats) and types the bare code. The inbound
      //    pipeline's DM bare-code shortcut detects it, consumes the
      //    pairing, and merges the shadow into Alice.
      await conn.injectInbound({
        externalChannelId: '42',
        externalUserId: '42',
        externalUserDisplay: 'Alice',
        text: code,
        isPrivate: true,
      });

      // Shadow gone.
      const shadowAfter = await db
        .selectFrom('users')
        .selectAll()
        .where('id', '=', shadowId)
        .executeTakeFirst();
      expect(shadowAfter).toBeUndefined();

      // External identity now points at Alice.
      const link = await db
        .selectFrom('external_identities')
        .select('user_id')
        .where('platform', '=', 'telegram')
        .where('external_id', '=', '42')
        .executeTakeFirstOrThrow();
      expect(link.user_id).toBe(aliceId);

      // Alice has membership in Bob's group (the bound shared group)
      // — this is what "shows up in her Chord app".
      const aliceInBobGroup = await db
        .selectFrom('group_members')
        .selectAll()
        .where('group_id', '=', bobGroupId)
        .where('user_id', '=', aliceId)
        .executeTakeFirst();
      expect(aliceInBobGroup).toBeDefined();
      expect(aliceInBobGroup!.tier).toBe('guest');

      // The shadow's message in Bob's group is now attributed to Alice.
      const aliceMsgs = await db
        .selectFrom('messages')
        .selectAll()
        .where('group_id', '=', bobGroupId)
        .where('sender_id', '=', aliceId)
        .execute();
      expect(aliceMsgs.length).toBeGreaterThanOrEqual(1);

      // Alice's DM channel is now bound to her personal group — future
      // DMs route there, not to Bob's group.
      const dmBinding = await db
        .selectFrom('group_external_channels')
        .select('group_id')
        .where('platform', '=', 'telegram')
        .where('external_channel_id', '=', '42')
        .executeTakeFirstOrThrow();
      expect(dmBinding.group_id).toBe(aliceGroupId);

      // Reference Bob's id so the linter doesn't complain — and to
      // assert his ownership of the bound group is intact.
      const bobGroup = await db
        .selectFrom('groups')
        .select('created_by')
        .where('id', '=', bobGroupId)
        .executeTakeFirstOrThrow();
      expect(bobGroup.created_by).toBe(bobId);
    } finally {
      await conn.shutdown();
    }
  });
});
