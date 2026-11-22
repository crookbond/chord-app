/**
 * ADR 0311 addendum - to-do and list changes go through the shared send queue
 * (kind `todo`), so one made offline waits and is replayed in order when the
 * server answers. Each carries the values it expected (kernel `TodoOp`); the
 * server writes only what nobody else changed and returns the rest as
 * conflicts, kept here for the "Couldn't sync" list until the person picks
 * Keep mine or Keep theirs.
 *
 * Something created offline has a temporary id (`tmp_…`); once the server
 * gives it a real one, later queued changes to it are sent under that.
 *
 * Kept sealed in the device folder like the queue itself; memory only where
 * there is no key store, and gone at sign-out.
 */
import { useSyncExternalStore } from 'react';
import {
  TEMP_TODO_ID_PREFIX,
  keepMineOp,
  resolveTodoOpIds,
  taskFieldsOf,
  todoOpTargetId,
  type ListItem,
  type PendingTodoOp,
  type QueuedSend,
  type Task,
  type TodoConflict,
  type TodoOp,
  type TodoSyncResult,
  type TodoTaskFields,
} from '@chord/kernel';

import { ApiError, syncTodoChange } from './api';
import { readDeviceJson, writeDeviceJson } from './email-device-store';
import { registerSender, sendOrQueue, useSendQueue } from './send-queue';
import { onSignOut } from './sign-out';
import { useApp } from './store';

const STATE_FILE = 'todo-sync';

export interface TodoSyncPayload {
  op: TodoOp;
  force?: boolean;
  /** The to-do title or item text, for the "Couldn't sync" list. */
  label: string;
}

/** A change the server did not fully take, waiting for the person. */
export interface TodoSyncNotice {
  id: string;
  label: string;
  op: TodoOp;
  outcome: Exclude<TodoSyncResult['outcome'], 'applied'>;
  conflicts: TodoConflict[];
  at: number;
}

interface State {
  realIds: Record<string, string>;
  notices: TodoSyncNotice[];
}

let state: State = { realIds: {}, notices: [] };
/** Whose changes `state` holds: never merged into, or shown to, another account. */
let stateOwner: string | null = null;
let loadedFor: string | null = null;
let loading: Promise<void> | null = null;
let loadingFor: string | null = null;
/** Bumped by sign-out, so a read still in flight cannot bring the old account's state back. */
let loadEpoch = 0;

function currentUid(): string | null {
  return useApp.getState().user?.id ?? null;
}
const listeners = new Set<() => void>();
const syncedListeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

async function ensureLoaded(): Promise<void> {
  const uid = currentUid();
  if (!uid || loadedFor === uid) return;
  if (!loading || loadingFor !== uid) {
    const epoch = ++loadEpoch;
    loadingFor = uid;
    const run = (async () => {
      const stored = await readDeviceJson<State>(STATE_FILE);
      if (epoch !== loadEpoch || currentUid() !== uid) return;
      const held = stateOwner === uid ? state : { realIds: {}, notices: [] };
      state = {
        realIds: { ...(stored?.realIds ?? {}), ...held.realIds },
        notices: [...(stored?.notices ?? []), ...held.notices],
      };
      stateOwner = uid;
      loadedFor = uid;
      emit();
    })().finally(() => {
      if (loading === run) {
        loading = null;
        loadingFor = null;
      }
    });
    loading = run;
  }
  await loading;
}

function setState(next: State): void {
  const uid = currentUid();
  // An answer that arrives after the account changed belongs to nobody here.
  if (!uid || (stateOwner !== null && stateOwner !== uid)) return;
  state = next;
  stateOwner = uid;
  if (loadedFor === uid) void writeDeviceJson(STATE_FILE, next);
  emit();
}

async function sendTodo(p: TodoSyncPayload, sendId: string): Promise<void> {
  await ensureLoaded();
  const op = resolveTodoOpIds(p.op, state.realIds);
  const target = todoOpTargetId(op);
  const isCreate = op.type === 'task.create' || op.type === 'item.add';
  if (!isCreate && target.startsWith(TEMP_TODO_ID_PREFIX)) {
    // What it changes never reached the server (its create was refused).
    throw new ApiError('Its to-do was never saved', 409);
  }
  const res = await syncTodoChange({ op, ...(p.force ? { force: true } : {}) }, sendId);
  const realIds = isCreate && res.id ? { ...state.realIds, [target]: res.id } : state.realIds;
  const notices =
    res.outcome === 'applied'
      ? state.notices
      : [
          ...state.notices,
          { id: sendId, label: p.label, op, outcome: res.outcome, conflicts: res.conflicts, at: Date.now() },
        ];
  setState({ realIds, notices });
  for (const fn of syncedListeners) fn();
}

registerSender<TodoSyncPayload>('todo', sendTodo);

/** Send a to-do or list change now, or queue it when the server cannot be reached. */
export function queueTodo(payload: TodoSyncPayload): Promise<'sent' | 'queued'> {
  return sendOrQueue<TodoSyncPayload>('todo', payload, sendTodo);
}

let tempSeq = 0;
/** An id for something made on the phone that the server has not seen yet. */
export function newTempTodoId(): string {
  tempSeq += 1;
  return `${TEMP_TODO_ID_PREFIX}${Date.now().toString(36)}${tempSeq}`;
}

/** A to-do change, expecting the fields it touches to be as `t` shows them. */
export function taskUpdate(t: Task, set: TodoTaskFields): TodoSyncPayload {
  const seen = taskFieldsOf(t);
  const expected = Object.fromEntries(
    Object.keys(set).map((k) => [k, seen[k as keyof TodoTaskFields]]),
  ) as TodoTaskFields;
  return { op: { type: 'task.update', taskId: t.id, set, expected }, label: t.title };
}

export function taskDelete(t: Task): TodoSyncPayload {
  return { op: { type: 'task.delete', taskId: t.id, expected: taskFieldsOf(t) }, label: t.title };
}

export function itemUpdate(it: ListItem, set: { text?: string; checked?: boolean }): TodoSyncPayload {
  const expected = {
    ...(set.text !== undefined ? { text: it.text } : {}),
    ...(set.checked !== undefined ? { checked: it.checked } : {}),
  };
  return { op: { type: 'item.update', itemId: it.id, set, expected }, label: it.text };
}

export function itemDelete(it: ListItem): TodoSyncPayload {
  return { op: { type: 'item.delete', itemId: it.id, expected: { text: it.text } }, label: it.text };
}

/** Changes still waiting, oldest first, to lay over what the screen shows. */
export function usePendingTodoOps(): PendingTodoOp[] {
  const queue = useSendQueue();
  return queue
    .filter((m): m is QueuedSend<TodoSyncPayload> => m.kind === 'todo' && m.status === 'queued')
    .sort((a, b) => a.queuedAt - b.queuedAt)
    .map((m) => ({ localId: m.localId, op: m.payload.op }));
}

/** Changes the server refused outright (a 4xx), waiting for Retry or Delete. */
export function useFailedTodoSends(): QueuedSend<TodoSyncPayload>[] {
  return useSendQueue().filter(
    (m): m is QueuedSend<TodoSyncPayload> => m.kind === 'todo' && m.status === 'failed',
  );
}

export function useTodoSyncNotices(): readonly TodoSyncNotice[] {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      void ensureLoaded();
      return () => listeners.delete(fn);
    },
    () => state.notices,
    () => state.notices,
  );
}

/** Settle one notice: Keep mine sends the lost fields again without the check. */
export async function settleTodoNotice(id: string, keep: 'mine' | 'theirs'): Promise<void> {
  const notice = state.notices.find((n) => n.id === id);
  if (!notice) return;
  setState({ ...state, notices: state.notices.filter((n) => n.id !== id) });
  if (keep === 'theirs') return;
  const op = keepMineOp(notice.op, notice.conflicts.filter((c) => c.field !== 'deleted'));
  const deleteOp = notice.op.type === 'task.delete' || notice.op.type === 'item.delete';
  if (op) await queueTodo({ op, force: true, label: notice.label });
  else if (deleteOp) await queueTodo({ op: notice.op, force: true, label: notice.label });
}

/** Called after each change the server answered, so a screen can reload what changed. */
export function onTodoSynced(fn: () => void): () => void {
  syncedListeners.add(fn);
  return () => {
    syncedListeners.delete(fn);
  };
}

onSignOut(() => {
  state = { realIds: {}, notices: [] };
  stateOwner = null;
  loadedFor = null;
  loadEpoch++;
  loading = null;
  loadingFor = null;
  emit();
});
