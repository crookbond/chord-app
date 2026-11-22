/**
 * ADR 0311 addendum - replay one to-do or list change the app made while it
 * could not reach the server. The field rule is kernel `mergeTodoFields`: a
 * field is written only if it still holds what the phone saw, and one someone
 * else has changed since comes back as a conflict instead of being
 * overwritten. The writes themselves go through the same service functions
 * the routes and the bot use.
 *
 * The row is locked for the compare-and-write, so a change arriving at the
 * same moment from another device is either seen or waits.
 */
import {
  SSE,
  deleteConflicts,
  mergeTodoFields,
  taskFieldsOf,
  type TodoConflict,
  type TodoOp,
  type TodoSyncResult,
} from '@chord/kernel';
import type { Kysely } from 'kysely';

import type { DB } from '../db/schema.js';
import { isMember } from './groups.service.js';
import {
  addItem,
  deleteItem,
  getItem,
  getList,
  setItemChecked,
  setItemText,
} from './lists.service.js';
import { enqueueFromTask } from './proactive.service.js';
import { sseHub } from './sse.hub.js';
import { createTask, deleteTask, getTask, updateTask } from './tasks.service.js';

type Broadcast = () => void;

const gone = (): TodoSyncResult => ({ outcome: 'gone', conflicts: [] });

function outcomeOf(applied: boolean, conflicts: TodoConflict[]): TodoSyncResult['outcome'] {
  if (conflicts.length === 0) return 'applied';
  return applied ? 'partial' : 'conflict';
}

export async function applyTodoOp(
  db: Kysely<DB>,
  userId: string,
  op: TodoOp,
  force = false,
): Promise<TodoSyncResult> {
  const after: Broadcast[] = [];
  const result = await db.transaction().execute(async (trx): Promise<TodoSyncResult> => {
    switch (op.type) {
      case 'task.create': {
        if (!(await isMember(trx, op.groupId, userId))) return gone();
        const task = await createTask(trx, { groupId: op.groupId, title: op.title, createdBy: userId });
        after.push(() => sseHub.broadcast(task.groupId, SSE.taskCreated, task));
        return { outcome: 'applied', id: task.id, task, conflicts: [] } satisfies TodoSyncResult;
      }
      case 'task.update':
      case 'task.delete': {
        const locked = await trx
          .selectFrom('tasks')
          .select('id')
          .where('id', '=', op.taskId)
          .forUpdate()
          .executeTakeFirst();
        const current = locked ? await getTask(trx, op.taskId) : null;
        if (!current || !(await isMember(trx, current.groupId, userId))) {
          // Deleting something already gone is done; changing it cannot be.
          return op.type === 'task.delete' ? ({ outcome: 'applied', conflicts: [] } as TodoSyncResult) : gone();
        }
        if (op.type === 'task.delete') {
          const conflicts = force ? [] : deleteConflicts({ current: taskFieldsOf(current), expected: op.expected });
          if (conflicts.length > 0) {
            return { outcome: 'conflict', task: current, conflicts: [{ field: 'deleted', mine: true, theirs: false }, ...conflicts] };
          }
          await deleteTask(trx, current.id);
          return { outcome: 'applied', conflicts: [] };
        }
        const { apply, conflicts } = mergeTodoFields({
          current: taskFieldsOf(current),
          set: op.set,
          expected: op.expected,
          force,
        });
        const applied = Object.keys(apply).length > 0;
        const task = applied ? ((await updateTask(trx, current.id, apply)) ?? current) : current;
        if (applied) after.push(() => sseHub.broadcast(task.groupId, SSE.taskUpdated, task));
        return { outcome: outcomeOf(applied, conflicts), task, conflicts };
      }
      case 'item.add': {
        const list = await getList(trx, op.listId);
        if (!list || !(await isMember(trx, list.groupId, userId))) return gone();
        const { item, created } = await addItem(trx, list.id, op.text);
        if (created) after.push(() => sseHub.broadcast(list.groupId, SSE.listUpdated, { listId: list.id, item }));
        return { outcome: 'applied', id: item.id, item, conflicts: [] } satisfies TodoSyncResult;
      }
      case 'item.update':
      case 'item.delete': {
        const locked = await trx
          .selectFrom('list_items')
          .select('id')
          .where('id', '=', op.itemId)
          .forUpdate()
          .executeTakeFirst();
        const current = locked ? await getItem(trx, op.itemId) : null;
        const list = current ? await getList(trx, current.listId) : null;
        if (!current || !list || !(await isMember(trx, list.groupId, userId))) {
          return op.type === 'item.delete' ? ({ outcome: 'applied', conflicts: [] } as TodoSyncResult) : gone();
        }
        const fields = { text: current.text, checked: current.checked };
        if (op.type === 'item.delete') {
          const conflicts = force ? [] : deleteConflicts({ current: fields, expected: op.expected });
          if (conflicts.length > 0) {
            return { outcome: 'conflict', item: current, conflicts: [{ field: 'deleted', mine: true, theirs: false }, ...conflicts] };
          }
          await deleteItem(trx, current.id);
          after.push(() => sseHub.broadcast(list.groupId, SSE.listUpdated, { listId: list.id }));
          return { outcome: 'applied', conflicts: [] };
        }
        const { apply, conflicts } = mergeTodoFields({ current: fields, set: op.set, expected: op.expected, force });
        let item = current;
        if (apply.text !== undefined) item = (await setItemText(trx, item.id, apply.text)) ?? item;
        if (apply.checked !== undefined) item = (await setItemChecked(trx, item.id, apply.checked)) ?? item;
        const applied = Object.keys(apply).length > 0;
        if (applied) after.push(() => sseHub.broadcast(list.groupId, SSE.listUpdated, { listId: list.id, item }));
        return { outcome: outcomeOf(applied, conflicts), item, conflicts };
      }
    }
  });
  for (const send of after) send();
  if (op.type === 'task.create' && result.task) await enqueueFromTask(db, result.task);
  return result;
}
