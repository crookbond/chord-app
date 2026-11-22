/**
 * Inbound-pipeline persists an attached file (set by the connector
 * after downloading from the platform CDN) and creates a `kind: 'file'`
 * message that points at it. Without an attachment field, the existing
 * `kind: 'text'` path runs unchanged.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { bindChannel } from '@/services/connectors/channel-resolver.js';
import { MockConnector } from '@/services/connectors/mock/mock.connector.js';
import { connectorRegistry } from '@/services/connectors/registry.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

async function seedPersonal(db: Kysely<DB>): Promise<{ groupId: string; userId: string }> {
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
      name: 'Personal',
      kind: 'personal',
      invite_code: groupId.slice(2, 8).toUpperCase(),
      ingest_email: `${groupId.slice(2)}@chord.app`,
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

describe('inbound-pipeline — attachment handling', () => {
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

  it('persists an attached file and posts a kind="file" message', async () => {
    const { groupId } = await seedPersonal(db);
    await bindChannel(db, 'telegram', '-att1', groupId, 'telegram');

    const conn = new MockConnector(db, 'telegram');
    connectorRegistry.register(conn);
    try {
      await conn.injectInbound({
        externalChannelId: '-att1',
        externalUserId: 'tg_user',
        text: 'check this out',
        attachment: {
          filename: 'photo.jpg',
          mimeType: 'image/jpeg',
          bytes: Buffer.from('fake-jpeg-bytes'),
        },
      });

      const msgs = await db.selectFrom('messages').selectAll().execute();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].kind).toBe('file');
      expect(msgs[0].body).toBe('check this out');
      expect(msgs[0].attachment_id).toBeTruthy();

      const att = await db
        .selectFrom('attachments')
        .selectAll()
        .where('id', '=', msgs[0].attachment_id!)
        .executeTakeFirstOrThrow();
      expect(att.filename).toBe('photo.jpg');
      expect(att.mime_type).toBe('image/jpeg');
      expect(att.scope_kind).toBe('group');
      expect(att.scope_id).toBe(groupId);
    } finally {
      await conn.shutdown();
    }
  });

  it('text-only inbound still produces a kind="text" row (no regression)', async () => {
    const { groupId } = await seedPersonal(db);
    await bindChannel(db, 'telegram', '-noatt', groupId, 'telegram');

    const conn = new MockConnector(db, 'telegram');
    connectorRegistry.register(conn);
    try {
      await conn.injectInbound({
        externalChannelId: '-noatt',
        externalUserId: 'tg_user',
        text: 'plain text',
      });

      const msgs = await db.selectFrom('messages').selectAll().execute();
      expect(msgs).toHaveLength(1);
      expect(msgs[0].kind).toBe('text');
      expect(msgs[0].attachment_id).toBeNull();
    } finally {
      await conn.shutdown();
    }
  });
});
