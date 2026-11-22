/**
 * Trust + assignment integration tests (ADR 0026).
 *
 * The bot's `create_task` tool refuses to land a task on someone who
 * hasn't trusted the asker. Instead it opens a `permission_request`
 * that the recipient resolves later. This file walks the four flows
 * the user wanted in simulation:
 *
 *   1. Create a task with an explicit time → task.dueAt is exactly that
 *      ISO; no early-fire reminder.
 *   2. Add a task to someone else's list without their trust → no task
 *      is created; a permission_request appears for the recipient.
 *   3. Add a task to someone else's list WITH trust → task is created
 *      with the right assignee.
 *   4. Add then remove trust (revoke = setGrant with empty scopes) →
 *      subsequent assignment falls back to the permission-request path.
 *
 * Each scenario drives the LLM-free tool layer directly (no mock LLM
 * needed) so we test the trust semantics independent of prompt drift.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { createGroup } from '@/services/groups.service.js';
import { listTasks } from '@/services/tasks.service.js';
import {
  isTrusted,
  listGrantsByRecipient,
  listIncomingRequests,
  setGrant,
} from '@/services/trust.service.js';
import {
  addMember,
  closeTestDb,
  createUser,
  openTestDb,
} from '@/__test-helpers__/db.js';

let db: Kysely<DB>;

beforeEach(async () => {
  db = await openTestDb();
});

afterEach(async () => {
  await closeTestDb(db);
});

async function seedTwoUserGroup() {
  const john = await createUser(db, 'john', 'John');
  const priya = await createUser(db, 'priya', 'Priya');
  const group = await createGroup(db, {
    name: 'Family',
    kind: 'group',
    createdBy: john,
  });
  await addMember(db, group.id, priya);
  return { john, priya, group };
}

describe('trust + task assignment flows', () => {
  it('Scenario 1: create_task with explicit dueAt stores the exact ISO timestamp', async () => {
    const { john, group } = await seedTwoUserGroup();
    const dueAt = '2026-06-07T14:00:00-07:00';

    const result = await applyToolCall(db, {
      groupId: group.id,
      call: {
        name: 'create_task',
        args: { title: 'Call vet', dueAt },
      },
      actorUserId: john,
      provenance: null,
    });
    expect(result.card?.kind).toBe('task');

    const tasks = await listTasks(db, group.id);
    expect(tasks).toHaveLength(1);
    // The service may normalize zone presentation but the absolute instant
    // must round-trip exactly. Compare via Date.parse for tz-independence.
    expect(tasks[0]!.dueAt).toBeTruthy();
    expect(Date.parse(tasks[0]!.dueAt!)).toBe(Date.parse(dueAt));
    expect(tasks[0]!.status).toBe('open');
    // Reminder was not requested — must NOT be eagerly scheduled.
    expect(tasks[0]!.remindAt ?? null).toBeNull();
  });

  it('Scenario 2: assigning a task to a non-trusting user opens a permission_request (no task created)', async () => {
    const { john, priya, group } = await seedTwoUserGroup();
    expect(await isTrusted(db, priya, john, 'task')).toBe(false);

    const result = await applyToolCall(db, {
      groupId: group.id,
      call: {
        name: 'create_task',
        args: { title: 'Book restaurant', assigneeName: 'Priya' },
      },
      actorUserId: john,
      provenance: null,
    });

    expect(result.summary).toMatch(/permission requested/);
    expect(result.card?.subtitle).toMatch(/permission requested/);

    const tasks = await listTasks(db, group.id);
    expect(tasks, 'no task should be created without trust').toHaveLength(0);

    const requests = await listIncomingRequests(db, priya);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.senderUserId).toBe(john);
    expect(requests[0]!.scopes).toContain('task');
  });

  it('Scenario 3: after a trust grant, the same assignment succeeds', async () => {
    const { john, priya, group } = await seedTwoUserGroup();
    await setGrant(db, priya, john, ['task']);
    expect(await isTrusted(db, priya, john, 'task')).toBe(true);

    const result = await applyToolCall(db, {
      groupId: group.id,
      call: {
        name: 'create_task',
        args: { title: 'Book restaurant', assigneeName: 'Priya' },
      },
      actorUserId: john,
      provenance: null,
    });

    expect(result.summary).toMatch(/^task /);
    const tasks = await listTasks(db, group.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.assigneeId).toBe(priya);
    expect(tasks[0]!.title).toBe('Book restaurant');

    // No permission_request should have been opened on this path.
    const requests = await listIncomingRequests(db, priya);
    expect(requests).toHaveLength(0);
  });

  it('Scenario 4: revoking trust (empty scopes) reverts to the permission-request flow', async () => {
    const { john, priya, group } = await seedTwoUserGroup();
    await setGrant(db, priya, john, ['task']);
    expect((await listGrantsByRecipient(db, priya))).toHaveLength(1);

    // Revoke = setGrant with an empty scope list.
    await setGrant(db, priya, john, []);
    expect(await isTrusted(db, priya, john, 'task')).toBe(false);
    expect((await listGrantsByRecipient(db, priya))).toHaveLength(0);

    const result = await applyToolCall(db, {
      groupId: group.id,
      call: {
        name: 'create_task',
        args: { title: 'Order groceries', assigneeName: 'Priya' },
      },
      actorUserId: john,
      provenance: null,
    });

    expect(result.summary).toMatch(/permission requested/);
    const tasks = await listTasks(db, group.id);
    expect(tasks).toHaveLength(0);
  });

  it('Scenario 4b: granting trust for `task` only does not allow `event` assignment', async () => {
    const { john, priya, group } = await seedTwoUserGroup();
    await setGrant(db, priya, john, ['task']);

    const result = await applyToolCall(db, {
      groupId: group.id,
      call: {
        name: 'create_event',
        args: {
          title: 'Dentist',
          startsAt: '2026-07-01T09:00:00Z',
          assigneeName: 'Priya',
        },
      },
      actorUserId: john,
      provenance: null,
    });
    // Event scope wasn't granted — must open a permission_request.
    expect(result.summary).toMatch(/permission requested/);
  });
});
