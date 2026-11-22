/**
 * An event created from chat carries "From chat: …" in its description
 * (ADR 0162). Moving it from chat used to leave that line alone, so the
 * calendar said "lunch at 12pm" on an event that had moved to 2pm. A chat
 * edit now adds its own "Changed from chat: …" line.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { createGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let userId: string;
let groupId: string;

function tomorrowAt(hour: number): string {
  const d = new Date(Date.now() + 86_400_000);
  return `${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00:00+00:00`;
}

async function say(body: string): Promise<string> {
  return (await insertMessage(db, { groupId, senderId: userId, body })).id;
}

function call(name: string, args: Record<string, unknown>, messageId: string | null) {
  return applyToolCall(db, {
    groupId,
    actorUserId: userId,
    provenance: messageId ? `chat:${messageId}` : null,
    turnId: messageId ? `turn-${messageId}` : null,
    triggeringMessageId: messageId ?? undefined,
    tzOffset: '+00:00',
    call: { name, args } as Parameters<typeof applyToolCall>[1]['call'],
  });
}

async function onlyEventId(): Promise<string> {
  const row = await db.selectFrom('events').select('id').where('group_id', '=', groupId).executeTakeFirstOrThrow();
  return row.id;
}

async function descriptionOf(id: string): Promise<string | null> {
  const row = await db.selectFrom('events').select('description').where('id', '=', id).executeTakeFirstOrThrow();
  return row.description;
}

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'edit-note-user');
  groupId = (await createGroup(db, { name: 'Fam', kind: 'group', createdBy: userId })).id;
});
afterEach(async () => {
  await closeTestDb(db);
});

describe('update_event from chat records the edit in the description', () => {
  it('a move keeps the creation line and adds the change', async () => {
    await call(
      'create_event',
      { title: 'Lunch with Sam', startsAt: tomorrowAt(12) },
      await say('add lunch with Sam tomorrow at 12 pm'),
    );
    const id = await onlyEventId();
    expect(await descriptionOf(id)).toContain('add lunch with Sam tomorrow at 12 pm');

    const moved = await call('update_event', { eventId: id, startsAt: tomorrowAt(14) }, await say('move lunch to 2pm'));
    expect((moved.data as { updated: boolean }).updated).toBe(true);

    const description = await descriptionOf(id);
    expect(description).toContain('From chat: "add lunch with Sam tomorrow at 12 pm"');
    expect(description).toContain('Changed from chat: "move lunch to 2pm"');
  });

  it('two edits from the same message add one line', async () => {
    await call('create_event', { title: 'Dentist', startsAt: tomorrowAt(9) }, await say('dentist tomorrow 9am'));
    const id = await onlyEventId();
    const msg = await say('make the dentist 10am at the new office');
    await call('update_event', { eventId: id, startsAt: tomorrowAt(10) }, msg);
    await call('update_event', { eventId: id, location: 'New office' }, msg);
    const description = (await descriptionOf(id)) ?? '';
    expect(description.split('Changed from chat:').length - 1).toBe(1);
  });

  it('moving a whole weekly series records the change on its occurrences', async () => {
    await call(
      'create_event',
      { title: 'Yoga', startsAt: tomorrowAt(7), repeat: { frequency: 'weekly' } },
      await say('yoga every week at 7am starting tomorrow'),
    );
    const first = await db
      .selectFrom('events')
      .select('id')
      .where('group_id', '=', groupId)
      .orderBy('starts_at')
      .executeTakeFirstOrThrow();
    const res = await call(
      'update_event',
      { eventId: first.id, startsAt: tomorrowAt(8), scope: 'all' },
      await say('move yoga to 8am every week'),
    );
    expect((res.data as { updated: boolean }).updated).toBe(true);
    const rows = await db.selectFrom('events').select('description').where('group_id', '=', groupId).execute();
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(r.description).toContain('Changed from chat: "move yoga to 8am every week"');
  });

  it('an edit with no chat message behind it leaves the description alone', async () => {
    await call('create_event', { title: 'Swim', startsAt: tomorrowAt(16) }, await say('swim tomorrow at 4'));
    const id = await onlyEventId();
    const before = await descriptionOf(id);
    await call('update_event', { eventId: id, startsAt: tomorrowAt(17) }, null);
    expect(await descriptionOf(id)).toBe(before);
  });
});
