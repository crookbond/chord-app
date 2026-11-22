/**
 * ADR 0151 — a managed persona (a kid, a grandparent) can be the assignee of a
 * task or the subject of a calendar item.
 *
 * Trust is indirected through `personas.managed_by`: the assigner passes when
 * they ARE the manager, or when the manager has trusted them. A persona event
 * is owned by the managing adult (their calendar), stored title-prefixed, and
 * never fans out. Deleting the persona SET NULLs its assignments.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { createGroup } from '@/services/groups.service.js';
import { createPersona } from '@/services/personas.service.js';
import {
  createTask,
  createTaskWithDedup,
  listTasks,
  updateTask,
} from '@/services/tasks.service.js';
import { createEvent } from '@/services/events.service.js';
import { setGrant, TrustError } from '@/services/trust.service.js';
import { addMember, closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('ADR 0151 — managed persona as assignee', () => {
  let db: Kysely<DB>;
  let parent: string; // manages the kid
  let coparent: string; // another member, not trusted by default
  let group: string;
  let kid: string; // persona id

  beforeEach(async () => {
    db = await openTestDb();
    parent = await createUser(db, 'parent');
    coparent = await createUser(db, 'coparent');
    const g = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: parent });
    group = g.id;
    await addMember(db, group, coparent);
    const persona = await createPersona(db, {
      groupId: group,
      name: 'Ben',
      householdRole: 'child',
      managedBy: parent,
    });
    kid = persona.id;
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('the manager can put a task on the persona', async () => {
    const t = await createTask(db, {
      groupId: group,
      createdBy: parent,
      title: 'pack for camp',
      assigneePersonaId: kid,
    });
    expect(t.assigneePersonaId).toBe(kid);
    expect(t.assigneeId).toBeUndefined();
  });

  it('a sender the manager trusts can too', async () => {
    await setGrant(db, parent, coparent, ['task']);
    const t = await createTask(db, {
      groupId: group,
      createdBy: coparent,
      title: 'pack for camp',
      assigneePersonaId: kid,
    });
    expect(t.assigneePersonaId).toBe(kid);
  });

  it('an untrusted member is refused, naming the managing adult', async () => {
    await expect(
      createTask(db, {
        groupId: group,
        createdBy: coparent,
        title: 'pack for camp',
        assigneePersonaId: kid,
      }),
    ).rejects.toMatchObject({ code: 'TRUST_DENIED', recipientUserId: parent });
  });

  it('rejects a persona from another group', async () => {
    const other = await createGroup(db, { name: 'Other', kind: 'group', createdBy: parent });
    const stranger = await createPersona(db, {
      groupId: other.id,
      name: 'Nobody',
      householdRole: 'child',
      managedBy: parent,
    });
    await expect(
      createTask(db, {
        groupId: group,
        createdBy: parent,
        title: 'x',
        assigneePersonaId: stranger.id,
      }),
    ).rejects.toThrow(/not a persona in this group/);
  });

  it('a task to a user and a task to a persona with the same title do not fold', async () => {
    await createTaskWithDedup(db, {
      groupId: group,
      createdBy: parent,
      title: 'sign the form',
      assigneeId: parent,
    });
    const second = await createTaskWithDedup(db, {
      groupId: group,
      createdBy: parent,
      title: 'sign the form',
      assigneePersonaId: kid,
    });
    expect(second.created).toBe(true);
    const rows = await listTasks(db, group);
    expect(rows.filter((r) => r.title === 'sign the form')).toHaveLength(2);
  });

  it('updateTask can move a task onto a persona, clearing a user assignee', async () => {
    const t = await createTask(db, {
      groupId: group,
      createdBy: parent,
      title: 'library books',
      assigneeId: parent,
    });
    const after = await updateTask(db, t.id, { assigneePersonaId: kid });
    expect(after?.assigneePersonaId).toBe(kid);
    expect(after?.assigneeId).toBeUndefined();
  });

  it('a persona event is owned by the managing adult, single-copy, title-prefixed', async () => {
    const ev = await createEvent(db, {
      groupId: group,
      createdBy: parent,
      title: 'dentist',
      startsAt: '2099-03-04T16:00:00-05:00',
      assigneePersonaId: kid,
    });
    expect(ev.title).toBe('Ben — dentist');
    expect(ev.assigneePersonaId).toBe(kid);

    const rows = await db
      .selectFrom('events')
      .select(['owner_user_id', 'assignee_id', 'assignee_persona_id', 'role', 'title'])
      .where('group_id', '=', group)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].owner_user_id).toBe(parent);
    expect(rows[0].assignee_id).toBeNull();
    expect(rows[0].assignee_persona_id).toBe(kid);
    expect(rows[0].role).toBe('organizer');
  });

  it('an untrusted member cannot put an event on the persona', async () => {
    await expect(
      createEvent(db, {
        groupId: group,
        createdBy: coparent,
        title: 'dentist',
        startsAt: '2099-03-04T16:00:00-05:00',
        assigneePersonaId: kid,
      }),
    ).rejects.toBeInstanceOf(TrustError);
  });

  it('deleting the persona unassigns its task and event, leaving them intact', async () => {
    const t = await createTask(db, {
      groupId: group,
      createdBy: parent,
      title: 'pack for camp',
      assigneePersonaId: kid,
    });
    const ev = await createEvent(db, {
      groupId: group,
      createdBy: parent,
      title: 'dentist',
      startsAt: '2099-03-04T16:00:00-05:00',
      assigneePersonaId: kid,
    });
    await db.deleteFrom('personas').where('id', '=', kid).execute();

    const taskRow = await db
      .selectFrom('tasks')
      .select(['id', 'assignee_persona_id'])
      .where('id', '=', t.id)
      .executeTakeFirst();
    expect(taskRow?.assignee_persona_id).toBeNull();

    const evRow = await db
      .selectFrom('events')
      .select(['id', 'assignee_persona_id', 'title'])
      .where('id', '=', ev.id)
      .executeTakeFirst();
    expect(evRow?.assignee_persona_id).toBeNull();
    expect(evRow?.title).toBe('Ben — dentist');
  });
});
