/**
 * handleGroupAdd: bot-add to a TG chat.
 *
 *   - Unknown adder (google) → unknown_adder + signup nudge, no binding.
 *   - Unknown adder (demo)   → identity auto-provision, then create+bind
 *     a new Chord group owned by the auto-provisioned user.
 *   - Paired adder           → create a new Chord group named after the
 *     chat, owned by them, mirror=on, bind, post welcome. We never try
 *     to reuse an existing Chord group by name (heuristic match = guess).
 *   - Re-add on already-bound chat → already_bound, no duplicate work.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { MockConnector } from '@/services/connectors/mock/mock.connector.js';
import { bindChannel } from '@/services/connectors/channel-resolver.js';
import { handleGroupAdd } from '@/services/connectors/group-add.service.js';
import { createGroup } from '@/services/groups.service.js';
import { connectorRegistry } from '@/services/connectors/registry.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

async function seedPairedUser(db: Kysely<DB>, tgId: string): Promise<string> {
  const now = new Date().toISOString();
  const userId = `u_${tgId}`;
  await db
    .insertInto('users')
    .values({
      id: userId,
      username: `u${tgId}`,
      display_name: `User ${tgId}`,
      created_at: now,
      shadow: 0,
      google_sub: `sub_${tgId}`,
      email: `${tgId}@example.test`,
      email_verified: 1,
    })
    .execute();
  await db
    .insertInto('external_identities')
    .values({
      platform: 'telegram',
      external_id: tgId,
      external_display: `User ${tgId}`,
      user_id: userId,
      created_at: now,
    })
    .execute();
  return userId;
}

describe('handleGroupAdd', () => {
  let db: Kysely<DB>;
  let conn: MockConnector;
  let savedAuthMode: 'google' | 'demo';

  beforeEach(async () => {
    db = await openTestDb();
    conn = new MockConnector(db, 'telegram');
    connectorRegistry.register(conn);
    savedAuthMode = env.AUTH_MODE;
  });

  afterEach(async () => {
    (env as { AUTH_MODE: 'google' | 'demo' }).AUTH_MODE = savedAuthMode;
    await conn.shutdown();
    await closeTestDb(db);
  });

  it('unknown adder (google) → unknown_adder + signup nudge', async () => {
    (env as { AUTH_MODE: 'google' | 'demo' }).AUTH_MODE = 'google';
    const result = await handleGroupAdd(db, {
      platform: 'telegram',
      externalChannelId: '-1001',
      chatTitle: 'Cool Chat',
      addedByExternalUserId: '99',
      addedByExternalDisplay: 'Stranger',
      receivedByBotUserId: null,
    });
    expect(result).toEqual({ bound: false, reason: 'unknown_adder' });
    expect(conn.sent).toHaveLength(1);
    expect(conn.sent[0].text).toMatch(/sign up/i);
  });

  it('paired adder → creates a new Chord group named after the chat, binds, mirror=on', async () => {
    const userId = await seedPairedUser(db, '42');
    const result = await handleGroupAdd(db, {
      platform: 'telegram',
      externalChannelId: '-2002',
      chatTitle: 'New Family Chat',
      addedByExternalUserId: '42',
      addedByExternalDisplay: 'Alice',
      receivedByBotUserId: null,
    });
    expect(result.bound).toBe(true);
    if (!result.bound) throw new Error('unreachable');
    const group = await db
      .selectFrom('groups')
      .selectAll()
      .where('id', '=', result.groupId)
      .executeTakeFirstOrThrow();
    expect(group.name).toBe('New Family Chat');
    expect(group.kind).toBe('group');
    expect(group.created_by).toBe(userId);
    expect(group.mirror_inbound).toBe(1);
    const binding = await db
      .selectFrom('group_external_channels')
      .selectAll()
      .where('external_channel_id', '=', '-2002')
      .executeTakeFirstOrThrow();
    expect(binding.group_id).toBe(result.groupId);
    expect(conn.sent).toHaveLength(1);
    expect(conn.sent[0].text).toMatch(/New Family Chat/);
  });

  it('paired adder who already owns a same-name Chord group → still creates a fresh group (no name-match reuse)', async () => {
    // Two Chord groups with the same name is allowed. The user can
    // rename or merge in the app. We never reuse by name — any
    // heuristic match would be a guess and we want one TG-chat ↔
    // one-Chord-group with no surprises.
    const userId = await seedPairedUser(db, '7');
    const existing = await createGroup(db, {
      name: 'Smith Family',
      kind: 'group',
      createdBy: userId,
    });
    const result = await handleGroupAdd(db, {
      platform: 'telegram',
      externalChannelId: '-3003',
      chatTitle: 'Smith Family',
      addedByExternalUserId: '7',
      addedByExternalDisplay: null,
      receivedByBotUserId: null,
    });
    expect(result.bound).toBe(true);
    if (!result.bound) throw new Error('unreachable');
    expect(result.groupId).not.toBe(existing.id);
    const binding = await db
      .selectFrom('group_external_channels')
      .selectAll()
      .where('external_channel_id', '=', '-3003')
      .executeTakeFirstOrThrow();
    expect(binding.group_id).toBe(result.groupId);
  });

  it('demo + unknown adder → identity auto-provisioned, group created and bound', async () => {
    (env as { AUTH_MODE: 'google' | 'demo' }).AUTH_MODE = 'demo';
    const result = await handleGroupAdd(db, {
      platform: 'telegram',
      externalChannelId: '-6006',
      chatTitle: 'Demo Chat',
      addedByExternalUserId: '500',
      addedByExternalDisplay: 'Demo Dev',
      receivedByBotUserId: null,
    });
    expect(result.bound).toBe(true);
    if (!result.bound) throw new Error('unreachable');
    const ident = await db
      .selectFrom('external_identities')
      .innerJoin('users', 'users.id', 'external_identities.user_id')
      .select(['users.id as user_id', 'users.shadow as shadow'])
      .where('external_identities.platform', '=', 'telegram')
      .where('external_identities.external_id', '=', '500')
      .executeTakeFirst();
    expect(ident).toBeDefined();
    expect(ident?.shadow).toBe(0);
    const group = await db
      .selectFrom('groups')
      .selectAll()
      .where('id', '=', result.groupId)
      .executeTakeFirstOrThrow();
    expect(group.created_by).toBe(ident?.user_id);
  });

  it('re-add on already-bound chat is idempotent', async () => {
    // Establish the binding directly (a prior pair-code consume would
    // have created it). Re-adding the bot must not nudge again.
    const userId = await seedPairedUser(db, '11');
    const group = await createGroup(db, {
      name: 'Some Chord Group',
      kind: 'group',
      createdBy: userId,
    });
    await bindChannel(db, 'telegram', '-7007', group.id, 'telegram');
    const result = await handleGroupAdd(db, {
      platform: 'telegram',
      externalChannelId: '-7007',
      chatTitle: 'Some Chord Group',
      addedByExternalUserId: '11',
      addedByExternalDisplay: null,
      receivedByBotUserId: null,
    });
    expect(result).toEqual({
      bound: false,
      reason: 'already_bound',
      groupId: group.id,
    });
    expect(conn.sent).toHaveLength(0);
  });
});
