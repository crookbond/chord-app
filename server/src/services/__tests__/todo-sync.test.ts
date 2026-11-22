import {
  applyPendingTodoOps,
  deleteConflicts,
  keepMineOp,
  mergeTodoFields,
  todoConflictLine,
  resolveTodoOpIds,
  type List,
  type ListItem,
  type Task,
} from '@chord/kernel';
import { describe, expect, it } from 'vitest';

const task = (over: Partial<Task> = {}): Task =>
  ({ id: 't1', groupId: 'g1', title: 'Pay water bill', status: 'open', createdBy: 'u1', createdAt: '2026-10-30T00:00:00.000Z', ...over }) as Task;

const list = (items: ListItem[]): List & { items: ListItem[] } => ({
  id: 'l1',
  groupId: 'g1',
  name: 'Costco',
  createdBy: 'u1',
  createdAt: '2026-10-30T00:00:00.000Z',
  items,
});

const item = (over: Partial<ListItem> = {}): ListItem => ({
  id: 'i1',
  listId: 'l1',
  text: 'milk',
  checked: false,
  createdAt: '2026-10-30T00:00:00.000Z',
  ...over,
});

describe('mergeTodoFields', () => {
  it('writes unchanged fields and reports changed ones', () => {
    const r = mergeTodoFields({
      current: { title: 'Pay water bill', dueAt: '2026-11-11T17:00:00.000Z' },
      set: { title: 'Water bill', dueAt: '2026-11-09T17:00:00.000Z' },
      expected: { title: 'Pay water bill', dueAt: '2026-11-06T17:00:00.000Z' },
    });
    expect(r.apply).toEqual({ title: 'Water bill' });
    expect(r.conflicts).toEqual([
      { field: 'dueAt', mine: '2026-11-09T17:00:00.000Z', theirs: '2026-11-11T17:00:00.000Z' },
    ]);
  });

  it('skips a field already holding the new value', () => {
    const r = mergeTodoFields({ current: { status: 'done' }, set: { status: 'done' }, expected: { status: 'open' } });
    expect(r).toEqual({ apply: {}, conflicts: [] });
  });

  it('treats null, absent and empty as the same', () => {
    const r = mergeTodoFields({
      current: { details: '' as string | null },
      set: { details: 'bring the receipt' },
      expected: { details: null },
    });
    expect(r.apply).toEqual({ details: 'bring the receipt' });
  });

  it('force writes over a change', () => {
    const r = mergeTodoFields({ current: { title: 'B' }, set: { title: 'C' }, expected: { title: 'A' }, force: true });
    expect(r).toEqual({ apply: { title: 'C' }, conflicts: [] });
  });
});

describe('deleteConflicts', () => {
  it('ignores a tick but not an edit', () => {
    const ticked: { text: string; checked: boolean } = { text: 'milk', checked: true };
    expect(deleteConflicts({ current: ticked, expected: { text: 'milk', checked: false } })).toEqual([]);
    expect(deleteConflicts({ current: { text: 'oat milk', checked: false }, expected: { text: 'milk' } })).toEqual([
      { field: 'text', mine: 'milk', theirs: 'oat milk' },
    ]);
  });
});

describe('applyPendingTodoOps', () => {
  it('lays waiting changes over the saved copy, oldest first', () => {
    const out = applyPendingTodoOps(
      [task(), task({ id: 't2', title: 'Old' })],
      [list([item(), item({ id: 'i2', text: 'eggs' })])],
      [
        { localId: 'a', op: { type: 'task.create', tempId: 'tmp_1', groupId: 'g1', title: 'Book flights' } },
        { localId: 'b', op: { type: 'task.update', taskId: 'tmp_1', set: { status: 'done' }, expected: {} } },
        { localId: 'c', op: { type: 'task.update', taskId: 't1', set: { dueAt: null, title: 'Water' }, expected: {} } },
        { localId: 'd', op: { type: 'task.delete', taskId: 't2', expected: {} } },
        { localId: 'e', op: { type: 'item.update', itemId: 'i1', set: { checked: true }, expected: { checked: false } } },
        { localId: 'f', op: { type: 'item.delete', itemId: 'i2', expected: { text: 'eggs' } } },
        { localId: 'g', op: { type: 'item.add', tempId: 'tmp_2', listId: 'l1', text: 'bread' } },
      ],
      '2026-10-31T12:00:00.000Z',
      'u1',
    );
    expect(out.tasks.map((t) => [t.id, t.title, t.status])).toEqual([
      ['tmp_1', 'Book flights', 'done'],
      ['t1', 'Water', 'open'],
    ]);
    expect(out.lists[0]!.items.map((i) => [i.id, i.text, i.checked])).toEqual([
      ['i1', 'milk', true],
      ['tmp_2', 'bread', false],
    ]);
  });
});

describe('conflict lines and Keep mine', () => {
  const fmt = (iso: string) => iso.slice(0, 10);
  it('words each kind of conflict', () => {
    expect(todoConflictLine({ field: 'dueAt', mine: '2026-11-09T17:00:00.000Z', theirs: '2026-11-11T17:00:00.000Z' }, fmt)).toBe(
      'Due date: yours 2026-11-09, now 2026-11-11',
    );
    expect(todoConflictLine({ field: 'details', mine: 'bring receipt', theirs: null }, fmt)).toBe(
      'Notes: yours bring receipt, now none',
    );
    expect(todoConflictLine({ field: 'status', mine: 'open', theirs: 'archived' }, fmt)).toBe(
      'Status: yours to do, now dropped',
    );
  });

  it('resends only the fields that lost', () => {
    const op = {
      type: 'task.update' as const,
      taskId: 't1',
      set: { title: 'Water', dueAt: '2026-11-09T17:00:00.000Z' },
      expected: { title: 'Pay water bill', dueAt: '2026-11-06T17:00:00.000Z' },
    };
    expect(keepMineOp(op, [{ field: 'dueAt', mine: '2026-11-09T17:00:00.000Z', theirs: 'x' }])).toEqual({
      ...op,
      set: { dueAt: '2026-11-09T17:00:00.000Z' },
      expected: {},
    });
    expect(keepMineOp(op, [])).toBeNull();
  });
});

describe('resolveTodoOpIds', () => {
  it('swaps a temporary id for the real one', () => {
    expect(
      resolveTodoOpIds({ type: 'task.update', taskId: 'tmp_1', set: { status: 'done' }, expected: {} }, { tmp_1: 't9' }),
    ).toMatchObject({ taskId: 't9' });
    expect(resolveTodoOpIds({ type: 'item.add', tempId: 'tmp_3', listId: 'l1', text: 'x' }, {})).toMatchObject({ listId: 'l1' });
  });
});
