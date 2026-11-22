/**
 * Coverage for the server-authoritative read cursor that drives the
 * "open at first unread" + cross-device sync work:
 *   - listGroupsForUser exposes each member's own last_read_at, and
 *     unread_count is computed relative to it.
 *   - markGroupRead advances the cursor and returns the new timestamp
 *     (broadcast to the member's other devices by the route layer).
 *   - The cursor is per-member: one member reading doesn't clear another's
 *     unread.
 *   - Chats with unread sort above read chats, then by recency.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import {
  createGroup,
  joinGroupByCode,
  listGroupsForUser,
  markGroupRead,
} from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { newId } from '@/utils/ids.js';

async function insertMessageAt(
  db: Kysely<DB>,
  opts: {
    groupId: string;
    senderId: string | null;
    body: string;
    createdAt: string;
    chordVisible?: 0 | 1;
  },
): Promise<void> {
  await db
    .insertInto('messages')
    .values({
      id: newId('m'),
      group_id: opts.groupId,
      sender_id: opts.senderId,
      kind: opts.senderId === null ? 'bot' : 'text',
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

describe('read cursor — last_read_at + unread_count', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('starts with null cursor and counts unread from others; markGroupRead clears it', async () => {
    const john = await createUser(db, 'john', 'John');
    const group = await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john });

    // A bot message (null sender) counts toward unread for john.
    await insertMessageAt(db, {
      groupId: group.id,
      senderId: null,
      body: 'heads up: practice moved',
      createdAt: '2026-05-01T10:00:00.000Z',
    });

    let [row] = await listGroupsForUser(db, john);
    expect(row.last_read_at).toBeNull();
    expect(Number(row.unread_count)).toBe(1);

    const ts = await markGroupRead(db, group.id, john);
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    [row] = await listGroupsForUser(db, john);
    expect(row.last_read_at).toBe(ts);
    expect(Number(row.unread_count)).toBe(0);
  });

  it('keeps the cursor per-member: one member reading does not clear another', async () => {
    const john = await createUser(db, 'john', 'John');
    const maya = await createUser(db, 'maya', 'Maya');
    const group = await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john });
    await joinGroupByCode(db, maya, group.invite_code);

    // john posts — unread for maya, not for john (own message).
    await insertMessageAt(db, {
      groupId: group.id,
      senderId: john,
      body: 'dinner at 7?',
      createdAt: '2026-05-01T10:00:00.000Z',
    });

    expect(Number((await listGroupsForUser(db, maya))[0].unread_count)).toBe(1);
    expect(Number((await listGroupsForUser(db, john))[0].unread_count)).toBe(0);

    await markGroupRead(db, group.id, maya);

    // maya is now clear; john's (already-zero) cursor is untouched and still null.
    const mayaRow = (await listGroupsForUser(db, maya))[0];
    const johnRow = (await listGroupsForUser(db, john))[0];
    expect(Number(mayaRow.unread_count)).toBe(0);
    expect(mayaRow.last_read_at).not.toBeNull();
    expect(johnRow.last_read_at).toBeNull();
  });

  it('sorts chats with unread above read chats, then by recency', async () => {
    const john = await createUser(db, 'john', 'John');
    const readNewer = await createGroup(db, { name: 'Read+Newer', kind: 'group', createdBy: john });
    const unreadOlder = await createGroup(db, { name: 'Unread+Older', kind: 'group', createdBy: john });

    // Read group has the more recent message…
    await insertMessageAt(db, {
      groupId: readNewer.id,
      senderId: null,
      body: 'newer',
      createdAt: '2026-05-02T10:00:00.000Z',
    });
    // …but the unread group (older message) should still float to the top.
    await insertMessageAt(db, {
      groupId: unreadOlder.id,
      senderId: null,
      body: 'older',
      createdAt: '2026-05-01T10:00:00.000Z',
    });

    await markGroupRead(db, readNewer.id, john);

    const rows = await listGroupsForUser(db, john);
    expect(rows.map((r) => r.id)).toEqual([unreadOlder.id, readNewer.id]);
  });
});
