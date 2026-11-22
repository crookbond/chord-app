/**
 * Coverage for the chat-list metadata returned by listGroupsForUser:
 * last_message_at + last_message_preview drive the Chats tab row
 * (timestamp + one-line preview). The preview must be the body of the
 * most recent *visible* message, ignoring chord_visible=0 bot-only rows,
 * and null when the group has no visible messages.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { UNREAD_COUNT_CAP, createGroup, listGroupsForUser } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { newId } from '@/utils/ids.js';

async function insertMessageAt(
  db: Kysely<DB>,
  opts: { groupId: string; senderId: string; body: string; createdAt: string; chordVisible?: 0 | 1 },
): Promise<void> {
  await db
    .insertInto('messages')
    .values({
      id: newId('m'),
      group_id: opts.groupId,
      sender_id: opts.senderId,
      kind: 'text',
      body: opts.body,
      attachment_id: null,
      reply_to_id: null,
      mentions_bot: 0,
      created_at: opts.createdAt,
      source: null,
      external_message_id: null,
      chord_visible: opts.chordVisible ?? 1,
      mentions_others: 0,
      auto_mirror: 1,
      bot_persona_id: null,
      is_proactive: 0,
    })
    .execute();
}

describe('listGroupsForUser — chat-list preview metadata', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('returns the most recent visible message body as the preview', async () => {
    const john = await createUser(db, 'john', 'John');
    const group = await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john });

    await insertMessageAt(db, {
      groupId: group.id,
      senderId: john,
      body: 'first message',
      createdAt: '2026-05-01T10:00:00.000Z',
    });
    await insertMessageAt(db, {
      groupId: group.id,
      senderId: john,
      body: 'latest message',
      createdAt: '2026-05-01T12:00:00.000Z',
    });

    const [row] = await listGroupsForUser(db, john);
    expect(row.last_message_preview).toBe('latest message');
    expect(row.last_message_at).toBe('2026-05-01T12:00:00.000Z');
  });

  it('ignores chord_visible=0 rows when picking the preview', async () => {
    const john = await createUser(db, 'john', 'John');
    const group = await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john });

    await insertMessageAt(db, {
      groupId: group.id,
      senderId: john,
      body: 'visible message',
      createdAt: '2026-05-01T10:00:00.000Z',
    });
    await insertMessageAt(db, {
      groupId: group.id,
      senderId: john,
      body: 'hidden bot-only message',
      createdAt: '2026-05-01T11:00:00.000Z',
      chordVisible: 0,
    });

    const [row] = await listGroupsForUser(db, john);
    expect(row.last_message_preview).toBe('visible message');
  });

  it('returns null preview for a group with no visible messages', async () => {
    const john = await createUser(db, 'john', 'John');
    await createGroup(db, { name: 'Empty', kind: 'group', createdBy: john });

    const [row] = await listGroupsForUser(db, john);
    expect(row.last_message_preview).toBeNull();
    expect(row.last_message_at).toBeNull();
  });

  it('counts a never-read chat only up to the cap the badge shows', async () => {
    // A chat this member never opened: last_read_at is NULL, so every visible
    // message from someone else is unread. 150 of them must not be counted
    // one by one on each app open; the badge shows 99+ past 99.
    const john = await createUser(db, 'john', 'John');
    const ada = await createUser(db, 'ada', 'Ada');
    const group = await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john });
    await db
      .insertInto('group_members')
      .values({ group_id: group.id, user_id: ada, role: 'member', tier: 'verified', joined_at: new Date().toISOString(), last_read_at: null })
      .execute();
    const base = Date.parse('2026-01-01T00:00:00Z');
    for (let i = 0; i < 150; i++) {
      await insertMessageAt(db, {
        groupId: group.id,
        senderId: john,
        body: `msg ${i}`,
        createdAt: new Date(base + i * 60_000).toISOString(),
      });
    }
    const [row] = await listGroupsForUser(db, ada);
    expect(Number(row.unread_count)).toBe(UNREAD_COUNT_CAP);
    expect(UNREAD_COUNT_CAP).toBeGreaterThan(99);
  });
});
