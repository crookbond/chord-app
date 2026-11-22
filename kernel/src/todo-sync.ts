/**
 * ADR 0311 addendum - a to-do or list change made while the server cannot be
 * reached waits in the app's send queue and is replayed later. Each change
 * carries the value of every field it touches as the phone last saw it, and
 * the server applies a field only if it still holds that value (or already
 * holds the new one). A field someone else changed in the meantime is not
 * overwritten: it comes back as a conflict for the person to settle.
 *
 * Pure so both sides share one rule and it can be tested; `mobile/` has no
 * harness.
 */
import { z } from 'zod';

import { LIST_ITEM_TEXT_MAX, type List, type ListItem } from './types/list';
import type { Task } from './types/task';

const taskStatus = z.enum(['open', 'active', 'done', 'superseded', 'archived']);

/** The to-do fields an offline change may set, and the values it expected. */
export const TodoTaskFields = z
  .object({
    title: z.string().trim().min(1).max(200),
    details: z.string().max(2000).nullable(),
    dueAt: z.string().datetime({ offset: true }).nullable(),
    status: taskStatus,
    assigneeId: z.string().nullable(),
  })
  .partial();
export type TodoTaskFields = z.infer<typeof TodoTaskFields>;

export const TodoItemFields = z
  .object({
    text: z.string().trim().min(1).max(LIST_ITEM_TEXT_MAX),
    checked: z.boolean(),
  })
  .partial();
export type TodoItemFields = z.infer<typeof TodoItemFields>;

/** Ids made on the phone for something not yet on the server start with this. */
export const TEMP_TODO_ID_PREFIX = 'tmp_';

export const TodoOp = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('task.create'),
    tempId: z.string().min(1).max(100),
    groupId: z.string().min(1),
    title: z.string().trim().min(1).max(200),
  }),
  z.object({
    type: z.literal('task.update'),
    taskId: z.string().min(1),
    set: TodoTaskFields,
    expected: TodoTaskFields,
  }),
  z.object({
    type: z.literal('task.delete'),
    taskId: z.string().min(1),
    expected: TodoTaskFields,
  }),
  z.object({
    type: z.literal('item.add'),
    tempId: z.string().min(1).max(100),
    listId: z.string().min(1),
    text: z.string().trim().min(1).max(LIST_ITEM_TEXT_MAX),
  }),
  z.object({
    type: z.literal('item.update'),
    itemId: z.string().min(1),
    set: TodoItemFields,
    expected: TodoItemFields,
  }),
  z.object({
    type: z.literal('item.delete'),
    itemId: z.string().min(1),
    expected: TodoItemFields,
  }),
]);
export type TodoOp = z.infer<typeof TodoOp>;

export const TodoSyncRequest = z.object({
  op: TodoOp,
  /** "Keep mine": apply every field, whatever the server holds now. */
  force: z.boolean().optional(),
});
export type TodoSyncRequest = z.infer<typeof TodoSyncRequest>;

export type TodoField = keyof TodoTaskFields | keyof TodoItemFields;

export interface TodoConflict {
  field: TodoField | 'deleted';
  /** What this change wanted (for a delete: the value it last saw). */
  mine: string | boolean | null;
  /** What the server holds now. */
  theirs: string | boolean | null;
}

export interface TodoSyncResult {
  /**
   * applied: everything landed (or was already so). partial: some fields
   * landed, the rest are in `conflicts`. conflict: nothing landed. gone: the
   * to-do or item no longer exists (or is no longer the user's to change).
   */
  outcome: 'applied' | 'partial' | 'conflict' | 'gone';
  /** The real id of something created from a temporary one. */
  id?: string;
  task?: Task;
  item?: ListItem;
  conflicts: TodoConflict[];
}

type FieldValue = string | boolean | null | undefined;

const DATE_FIELDS = new Set<string>(['dueAt']);

/** Two stored values say the same thing: absent, null and '' are all "none"; dates compare as instants. */
export function sameTodoValue(field: string, a: FieldValue, b: FieldValue): boolean {
  const na = a === undefined || a === '' ? null : a;
  const nb = b === undefined || b === '' ? null : b;
  if (na === nb) return true;
  if (DATE_FIELDS.has(field) && typeof na === 'string' && typeof nb === 'string') {
    const ta = Date.parse(na);
    const tb = Date.parse(nb);
    return !Number.isNaN(ta) && ta === tb;
  }
  return false;
}

/**
 * Which of `set` to write, and which fields someone else changed since the
 * phone read them. A field already holding the new value is neither (nothing
 * to do). A field with no expected value is written as given.
 */
export function mergeTodoFields<F extends Record<string, FieldValue>>(a: {
  current: F;
  set: Partial<F>;
  expected: Partial<F>;
  force?: boolean;
}): { apply: Partial<F>; conflicts: TodoConflict[] } {
  const apply: Partial<F> = {};
  const conflicts: TodoConflict[] = [];
  for (const field of Object.keys(a.set) as (keyof F & string)[]) {
    const mine = a.set[field];
    if (mine === undefined) continue;
    const now = a.current[field];
    if (sameTodoValue(field, now, mine)) continue;
    const unchanged = !(field in a.expected) || sameTodoValue(field, now, a.expected[field]);
    if (a.force || unchanged) {
      apply[field] = mine;
    } else {
      conflicts.push({ field: field as TodoField, mine: mine ?? null, theirs: now ?? null });
    }
  }
  return { apply, conflicts };
}

/**
 * The fields a delete saw that someone else has since changed. A change to
 * whether an item is ticked does not stop deleting it; any other change asks.
 */
export function deleteConflicts<F extends Record<string, FieldValue>>(a: {
  current: F;
  expected: Partial<F>;
}): TodoConflict[] {
  const out: TodoConflict[] = [];
  for (const field of Object.keys(a.expected) as (keyof F & string)[]) {
    if (field === 'checked') continue;
    const saw = a.expected[field];
    const now = a.current[field];
    if (!sameTodoValue(field, now, saw)) {
      out.push({ field: field as TodoField, mine: saw ?? null, theirs: now ?? null });
    }
  }
  return out;
}

/** The fields of a to-do an offline change compares against. */
export function taskFieldsOf(t: Task): Required<TodoTaskFields> {
  return {
    title: t.title,
    details: t.details ?? null,
    dueAt: t.dueAt ?? null,
    status: t.status,
    assigneeId: t.assigneeId ?? null,
  };
}

/** A change still waiting to sync, with the queue id it waits under. */
export interface PendingTodoOp {
  localId: string;
  op: TodoOp;
}

/** The id an op is about (a temporary one for something created offline). */
export function todoOpTargetId(op: TodoOp): string {
  switch (op.type) {
    case 'task.create':
    case 'item.add':
      return op.tempId;
    case 'task.update':
    case 'task.delete':
      return op.taskId;
    case 'item.update':
    case 'item.delete':
      return op.itemId;
  }
}

/** Swap temporary ids the server has since given real ones for. */
export function resolveTodoOpIds(op: TodoOp, realIds: Readonly<Record<string, string>>): TodoOp {
  const real = (id: string) => realIds[id] ?? id;
  switch (op.type) {
    case 'task.create':
      return op;
    case 'item.add':
      return { ...op, listId: real(op.listId) };
    case 'task.update':
    case 'task.delete':
      return { ...op, taskId: real(op.taskId) };
    case 'item.update':
    case 'item.delete':
      return { ...op, itemId: real(op.itemId) };
  }
}

/**
 * What the To Do's screen shows: the last copy from the server with every
 * change still waiting laid on top, oldest first, so a change made offline
 * survives closing the app and a reload from the saved copy.
 */
export function applyPendingTodoOps(
  tasks: readonly Task[],
  lists: readonly (List & { items: ListItem[] })[],
  pending: readonly PendingTodoOp[],
  now: string,
  createdBy: string | null,
): { tasks: Task[]; lists: (List & { items: ListItem[] })[] } {
  let ts = [...tasks];
  let ls = lists.map((l) => ({ ...l, items: [...l.items] }));
  for (const { op } of pending) {
    switch (op.type) {
      case 'task.create':
        if (!ts.some((t) => t.id === op.tempId)) {
          ts = [
            {
              id: op.tempId,
              groupId: op.groupId,
              title: op.title,
              status: 'open',
              createdBy,
              createdAt: now,
            } as Task,
            ...ts,
          ];
        }
        break;
      case 'task.update':
        ts = ts.map((t) => (t.id === op.taskId ? withTaskFields(t, op.set) : t));
        break;
      case 'task.delete':
        ts = ts.filter((t) => t.id !== op.taskId);
        break;
      case 'item.add':
        ls = ls.map((l) =>
          l.id === op.listId && !l.items.some((it) => it.id === op.tempId)
            ? {
                ...l,
                items: [
                  ...l.items,
                  { id: op.tempId, listId: op.listId, text: op.text, checked: false, createdAt: now },
                ],
              }
            : l,
        );
        break;
      case 'item.update':
        ls = ls.map((l) => ({
          ...l,
          items: l.items.map((it) =>
            it.id === op.itemId
              ? {
                  ...it,
                  ...(op.set.text !== undefined ? { text: op.set.text } : {}),
                  ...(op.set.checked !== undefined ? { checked: op.set.checked } : {}),
                }
              : it,
          ),
        }));
        break;
      case 'item.delete':
        ls = ls.map((l) => ({ ...l, items: l.items.filter((it) => it.id !== op.itemId) }));
        break;
    }
  }
  return { tasks: ts, lists: ls };
}

const FIELD_NAMES: Record<TodoConflict['field'], string> = {
  title: 'Title',
  details: 'Notes',
  dueAt: 'Due date',
  status: 'Status',
  assigneeId: "Who it's for",
  text: 'Item',
  checked: 'Ticked',
  deleted: 'Deleted',
};

const STATUS_WORDS: Record<string, string> = {
  open: 'to do',
  active: 'in progress',
  done: 'done',
  archived: 'dropped',
  superseded: 'replaced',
};

/**
 * One line of the "Couldn't sync" list: what this change wanted against what
 * the server now holds. `formatDate` renders a due date in the reader's zone.
 */
export function todoConflictLine(c: TodoConflict, formatDate: (iso: string) => string): string {
  const name = FIELD_NAMES[c.field];
  if (c.field === 'assigneeId') return `${name}: changed by someone else`;
  const show = (v: string | boolean | null): string => {
    if (v === null || v === '') return 'none';
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (c.field === 'status') return STATUS_WORDS[v] ?? v;
    return c.field === 'dueAt' ? formatDate(v) : v;
  };
  return `${name}: yours ${show(c.mine)}, now ${show(c.theirs)}`;
}

/**
 * "Keep mine" for a change that came back with conflicts: the same change,
 * cut to the fields it lost, sent without the check. Null when there is
 * nothing left to send (nothing conflicted, or the thing is gone).
 */
export function keepMineOp(op: TodoOp, conflicts: readonly TodoConflict[]): TodoOp | null {
  if (op.type === 'task.delete' || op.type === 'item.delete') return conflicts.length ? op : null;
  if (op.type !== 'task.update' && op.type !== 'item.update') return null;
  const lost = new Set(conflicts.map((c) => c.field));
  const set = Object.fromEntries(Object.entries(op.set).filter(([k]) => lost.has(k as TodoField)));
  if (Object.keys(set).length === 0) return null;
  return { ...op, set, expected: {} } as TodoOp;
}

function withTaskFields(t: Task, set: TodoTaskFields): Task {
  const next: Task = { ...t };
  if (set.title !== undefined) next.title = set.title;
  if (set.status !== undefined) next.status = set.status;
  if (set.details !== undefined) next.details = set.details ?? undefined;
  if (set.dueAt !== undefined) next.dueAt = set.dueAt ?? undefined;
  if (set.assigneeId !== undefined) next.assigneeId = set.assigneeId ?? undefined;
  return next;
}
