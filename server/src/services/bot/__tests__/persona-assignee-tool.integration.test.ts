/**
 * ADR 0151 — the bot tools (`create_task`, `create_event`, `update_task`) can
 * name a managed persona as the assignee. Trust runs through the persona's
 * managing adult; a refusal opens a permission request against that adult.
 * A group member wins a name collision with a persona.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { createGroup } from '@/services/groups.service.js';
import { createPersona } from '@/services/personas.service.js';
import { listTasks } from '@/services/tasks.service.js';
import { listIncomingRequests, setGrant } from '@/services/trust.service.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});
afterEach(async () => {
  await closeTestDb(db);
});

async function seed() {
  const parent = await createUser(db, 'parent', 'Parent');
  const coparent = await createUser(db, 'coparent', 'Coparent');
  const group = await createGroup(db, { name: 'Family', kind: 'group', createdBy: parent });
  await addMember(db, group.id, coparent);
  const kid = await createPersona(db, {
    groupId: group.id,
    name: 'Ben',
    householdRole: 'child',
    managedBy: parent,
  });
  return { parent, coparent, group, kid };
}

describe('ADR 0151 — persona assignee via bot tools', () => {
  it('the managing adult assigns a task to the persona by name', async () => {
    const { parent, group, kid } = await seed();
    const res = await applyToolCall(db, {
      groupId: group.id,
      call: { name: 'create_task', args: { title: 'pack for camp', assigneeName: 'Ben' } },
      actorUserId: parent,
      provenance: null,
    });
    expect(res.card?.kind).toBe('task');
    const tasks = await listTasks(db, group.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.assigneePersonaId).toBe(kid.id);
    expect(tasks[0]!.assigneeId).toBeUndefined();
  });

  it('an untrusted member gets a permission request against the managing adult', async () => {
    const { parent, coparent, group } = await seed();
    const res = await applyToolCall(db, {
      groupId: group.id,
      call: { name: 'create_task', args: { title: 'pack for camp', assigneeName: 'Ben' } },
      actorUserId: coparent,
      provenance: null,
    });
    expect(res.summary).toMatch(/permission requested/);
    expect(await listTasks(db, group.id)).toHaveLength(0);
    const reqs = await listIncomingRequests(db, parent);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.senderUserId).toBe(coparent);
  });

  it('a trusted member can assign the persona a task', async () => {
    const { parent, coparent, group, kid } = await seed();
    await setGrant(db, parent, coparent, ['task']);
    await applyToolCall(db, {
      groupId: group.id,
      call: { name: 'create_task', args: { title: 'pack for camp', assigneeName: 'Ben' } },
      actorUserId: coparent,
      provenance: null,
    });
    const tasks = await listTasks(db, group.id);
    expect(tasks[0]!.assigneePersonaId).toBe(kid.id);
  });

  it('a member wins a name collision with a persona', async () => {
    const { parent, group } = await seed();
    const sam = await createUser(db, 'sam', 'Sam');
    await addMember(db, group.id, sam);
    await createPersona(db, {
      groupId: group.id,
      name: 'Sam',
      householdRole: 'child',
      managedBy: parent,
    });
    await setGrant(db, sam, parent, ['task']);
    await applyToolCall(db, {
      groupId: group.id,
      call: { name: 'create_task', args: { title: 'x', assigneeName: 'Sam' } },
      actorUserId: parent,
      provenance: null,
    });
    const tasks = await listTasks(db, group.id);
    expect(tasks[0]!.assigneeId).toBe(sam);
    expect(tasks[0]!.assigneePersonaId).toBeUndefined();
  });

  it('create_event names the persona → title prefixed, owned by the managing adult', async () => {
    const { parent, group, kid } = await seed();
    await applyToolCall(db, {
      groupId: group.id,
      call: {
        name: 'create_event',
        args: {
          title: 'dentist',
          startsAt: '2099-03-04T16:00:00-05:00',
          assigneeName: 'Ben',
        },
      },
      actorUserId: parent,
      provenance: null,
    });
    const rows = await db
      .selectFrom('events')
      .select(['title', 'owner_user_id', 'assignee_persona_id', 'assignee_id'])
      .where('group_id', '=', group.id)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe('Ben — dentist');
    expect(rows[0]!.owner_user_id).toBe(parent);
    expect(rows[0]!.assignee_persona_id).toBe(kid.id);
    expect(rows[0]!.assignee_id).toBeNull();
  });
});
