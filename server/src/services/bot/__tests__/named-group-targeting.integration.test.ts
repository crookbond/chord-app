/**
 * An item is created in the chat it was asked in (ADR 0232's 2026-10-25
 * addendum). From the personal 1:1 it is personal; the model has no way to
 * send it to another group.
 *
 * 2026-10-25 probe: with the asker's groups in the prompt, gpt-4.1-mini
 * (through OpenRouter) sent `withGroupName: "Doe Family"` 3 times out of 3
 * for "add milk to the Costco list" and "add soccer practice for Ben" said
 * in the personal chat, and both landed in the family's group. The field is
 * gone from create_task / add_list_item / save_place / create_event; these
 * tests send it anyway, as a model would, and check it changes nothing.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { createGroup, ensurePairGroup, ensurePersonalGroup, joinGroupByCode } from '@/services/groups.service.js';
import { listLists } from '@/services/lists.service.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let john: string;
let alice: string;
let personalId: string;
let familyId: string;

/** A tool call as the model makes it, from a message the user sent. */
async function runFrom(groupId: string, said: string, name: string, args: Record<string, unknown>) {
  const trigger = await insertMessage(db, { groupId, senderId: john, body: said });
  return applyToolCall(db, {
    groupId,
    call: { name, args } as never,
    actorUserId: john,
    provenance: null,
    mode: 'commit',
    triggeringMessageId: trigger.id,
  });
}

async function findList(groupId: string, name: string) {
  const lists = await listLists(db, groupId);
  return lists.find((l) => l.name === name) ?? null;
}

const inDays = (days: number, time: string) =>
  `${new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)}T${time}:00-04:00`;

beforeEach(async () => {
  db = await openTestDb();
  john = await createUser(db, 'john', 'John Doe');
  alice = await createUser(db, 'alice', 'Alice');
  personalId = (await ensurePersonalGroup(db, john)).id;
  const family = await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john, nameIsCustom: true });
  await joinGroupByCode(db, alice, family.invite_code);
  familyId = family.id;
});

afterEach(async () => {
  await closeTestDb(db);
});

describe('from the personal chat', () => {
  it('the probe case: "add milk to the Costco list" stays personal', async () => {
    await runFrom(personalId, 'add milk to the Costco list', 'add_list_item', {
      listName: 'Costco',
      items: ['milk'],
      withGroupName: 'Doe Family',
    });
    expect((await findList(personalId, 'Costco'))?.items.map((i) => i.text)).toEqual(['milk']);
    expect(await findList(familyId, 'Costco')).toBeNull();
  });

  it('the probe case: "add soccer practice for Ben" stays personal, one copy', async () => {
    await runFrom(personalId, 'add soccer practice for Ben Saturday at 10am', 'create_event', {
      title: 'Soccer practice',
      startsAt: inDays(3, '10:00'),
      withGroupName: 'Doe Family',
    });
    const rows = await db.selectFrom('events').select('group_id').where('title', '=', 'Soccer practice').execute();
    expect(rows.map((r) => r.group_id)).toEqual([personalId]);
  });

  it('a to-do and a saved place stay personal too', async () => {
    await runFrom(personalId, 'remind me to renew my passport by November 15', 'create_task', {
      title: 'Renew passport',
      withGroupName: 'Doe Family',
    });
    await runFrom(personalId, 'save Veeray, that Indian place', 'save_place', {
      name: 'Veeray',
      withGroupName: 'Doe Family',
    });
    expect(await db.selectFrom('tasks').select('group_id').execute()).toEqual([{ group_id: personalId }]);
    const place = await db.selectFrom('saves').select('group_id').where('title', '=', 'Veeray').executeTakeFirst();
    expect(place?.group_id).toBe(personalId);
  });

  it('naming the group in the personal chat still keeps it personal', async () => {
    await runFrom(personalId, 'add milk to the Doe Family Costco list', 'add_list_item', {
      listName: 'Costco',
      items: ['milk'],
      withGroupName: 'Doe Family',
    });
    await runFrom(personalId, 'remind Alice and me to pack', 'create_task', {
      title: 'Pack',
      withGroupName: 'Alice',
    });
    expect((await findList(personalId, 'Costco'))?.items.map((i) => i.text)).toEqual(['milk']);
    expect(await findList(familyId, 'Costco')).toBeNull();
    expect(await db.selectFrom('tasks').select('group_id').execute()).toEqual([{ group_id: personalId }]);
  });

  it('an unnamed two-person chat is not reached by the other person\'s name either', async () => {
    const pair = await ensurePairGroup(db, john, alice);
    await runFrom(personalId, 'add bread to groceries with Alice', 'add_list_item', {
      listName: 'Groceries',
      items: ['bread'],
      withGroupName: 'Alice',
    });
    expect(await findList(pair.id, 'Groceries')).toBeNull();
    expect((await findList(personalId, 'Groceries'))?.items.map((i) => i.text)).toEqual(['bread']);
  });

  it('the reply says nothing about a group', async () => {
    const r = await runFrom(personalId, 'add eggs to my Costco list', 'add_list_item', {
      listName: 'Costco',
      items: ['eggs'],
      withGroupName: 'Nonexistent Group',
    });
    expect(r.summary).not.toMatch(/group/i);
  });
});

describe('from a shared group', () => {
  it('goes into that group, whatever group the model names', async () => {
    const other = await createGroup(db, { name: 'Other Group', kind: 'group', createdBy: john, nameIsCustom: true });
    await runFrom(familyId, '@Chord add milk to the Costco list', 'add_list_item', {
      listName: 'Costco',
      items: ['milk'],
      withGroupName: other.name,
    });
    await runFrom(familyId, '@Chord remind us to pack', 'create_task', { title: 'Pack', withGroupName: 'John Doe' });

    expect((await findList(familyId, 'Costco'))?.items.map((i) => i.text)).toEqual(['milk']);
    expect(await findList(other.id, 'Costco')).toBeNull();
    expect(await findList(personalId, 'Costco')).toBeNull();
    expect(await db.selectFrom('tasks').select('group_id').execute()).toEqual([{ group_id: familyId }]);
  });
});
