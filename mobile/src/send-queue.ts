/**
 * ADR 0311 addendum - one queue for everything sent while the server cannot be
 * reached (chat messages, emails). Each kind registers how it is sent
 * (`registerSender`); this module only keeps the line and works through it,
 * oldest first, whenever the server answers.
 *
 * Kept sealed in the signed-in user's device folder (ADR 0302's key and
 * folder, via `readDeviceJson`/`writeDeviceJson`), never in plain storage
 * (owner decision). A build without the key store keeps the queue in memory
 * only: it still works while the app is open, and is lost if the app is closed
 * before the server answers. On web it lives as long as the page.
 *
 * A send the server refuses (a 4xx) is marked failed with its reason and stays
 * until the person retries or deletes it; nothing disappears silently. No
 * network or a server error stops the pass and keeps the order.
 */
import { useSyncExternalStore } from 'react';
import {
  afterServerError,
  mergeForUser,
  nextRetryAt,
  nextToSend,
  onlyForUser,
  sendOutcome,
  shouldQueueSend,
  type QueuedSend,
  type QueuedSendKind,
} from '@chord/kernel';

import { ApiError } from './api';
import { readDeviceJson, writeDeviceJson } from './email-device-store';
import { OfflineError, isOnline, onNetworkChange } from './network';
import { onSignOut } from './sign-out';
import { useApp } from './store';

const QUEUE_FILE = 'send-queue';

/** Sends one payload; `sendId` is the queue's id for it, sent so a repeat is done once. */
type Sender = (payload: unknown, sendId: string) => Promise<void>;
const senders = new Map<QueuedSendKind, Sender>();

let items: QueuedSend[] = [];
let loadedFor: string | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** How a kind is sent. Throw `OfflineError`/`ApiError` as `api.ts` does; return when the server has it. */
export function registerSender<P>(
  kind: QueuedSendKind,
  send: (payload: P, sendId: string) => Promise<void>,
): void {
  senders.set(kind, send as Sender);
  void flushSendQueue();
}

function currentUid(): string | null {
  return useApp.getState().user?.id ?? null;
}

/**
 * Read this user's queue. Anything held in memory for someone else (an
 * account switch without a sign-out) stays behind: it is theirs, and would be
 * sent with this user's session. Bumped by sign-out, so a read still in flight
 * then cannot bring the old account's queue back.
 */
let loadEpoch = 0;
let loadingFor: string | null = null;

async function ensureLoaded(): Promise<void> {
  const uid = currentUid();
  if (!uid || loadedFor === uid) return;
  if (!loading || loadingFor !== uid) {
    const epoch = ++loadEpoch;
    loadingFor = uid;
    const run = (async () => {
      const stored = (await readDeviceJson<{ items?: QueuedSend[] }>(QUEUE_FILE))?.items ?? [];
      if (epoch !== loadEpoch || currentUid() !== uid) return;
      items = mergeForUser({ uid, stored, held: items, key: (m) => m.localId, prefer: 'stored' });
      loadedFor = uid;
      persist();
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

function persist(): void {
  // Written to the signed-in user's folder; never another account's items.
  if (!loadedFor || currentUid() !== loadedFor) return;
  const mine = onlyForUser(items, loadedFor);
  void writeDeviceJson(QUEUE_FILE, mine.length > 0 ? { items: mine } : null);
}

function setItems(next: QueuedSend[]): void {
  items = next;
  persist();
  emit();
}

/**
 * An id for one send, made before its first attempt. A screen that sends
 * directly and queues only when that fails passes the same id to both, so the
 * server does it once even if the first attempt landed and its answer was lost.
 */
export function newSendId(): string {
  return newLocalId();
}

function newLocalId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Send now when nothing of this kind is waiting and the server is reachable;
 * otherwise, or when the attempt finds no network, queue it. A refusal from
 * the server is thrown as before, for the screen to show.
 */
export async function sendOrQueue<P>(
  kind: QueuedSendKind,
  payload: P,
  sendNow: (payload: P, sendId: string) => Promise<void>,
  sendId?: string,
): Promise<'sent' | 'queued'> {
  await ensureLoaded();
  // Made before the first attempt, so a retry after a lost answer is
  // recognised by the server as the same send.
  const localId = sendId ?? newLocalId();
  if (!shouldQueueSend({ online: isOnline(), kind, items })) {
    try {
      await sendNow(payload, localId);
      return 'sent';
    } catch (e) {
      if (!(e instanceof OfflineError)) throw e;
    }
  }
  const uid = currentUid();
  // Nobody signed in has nowhere to keep it, and nobody to send it as.
  if (!uid || loadedFor !== uid) throw new OfflineError();
  const latest = items.reduce((max, m) => Math.max(max, m.queuedAt), 0);
  setItems([
    ...items,
    {
      localId,
      kind,
      payload,
      uid,
      // Strictly after anything already waiting, even if the clock went back.
      queuedAt: Math.max(Date.now(), latest + 1),
      status: 'queued',
    },
  ]);
  void flushSendQueue();
  return 'queued';
}

let flushing: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAt: number | null = null;

/** Come back when the earliest line waiting out a server error is due. */
function scheduleRetry(at: number | null): void {
  if (at === null || !isOnline()) return;
  if (retryTimer && retryAt !== null && retryAt <= at) return;
  if (retryTimer) clearTimeout(retryTimer);
  retryAt = at;
  retryTimer = setTimeout(
    () => {
      retryTimer = null;
      retryAt = null;
      void flushSendQueue();
    },
    Math.max(0, at - Date.now()),
  );
}

/**
 * Work through the queue, oldest first within each kind, until nothing is due.
 * No network stops the pass (the reconnect flushes). A server error holds only
 * that kind's line, for longer each time, and after a few tries marks the send
 * failed (kernel `afterServerError`); other kinds go on.
 */
export function flushSendQueue(): Promise<void> {
  flushing ??= (async () => {
    await ensureLoaded();
    // Kinds whose sender has not loaded yet; each calls back in when it registers.
    const noSender = new Set<QueuedSendKind>();
    for (;;) {
      if (!isOnline()) return;
      // Only the signed-in user's sends, and only once their queue is the one held.
      const uid = currentUid();
      if (!uid || loadedFor !== uid) return;
      const mine = onlyForUser(items, uid);
      const next = nextToSend(mine, { now: Date.now(), skipKinds: noSender });
      if (!next) {
        scheduleRetry(nextRetryAt(mine, noSender));
        return;
      }
      const send = senders.get(next.kind);
      if (!send) {
        noSender.add(next.kind);
        continue;
      }
      try {
        await send(next.payload, next.localId);
        setItems(items.filter((m) => m.localId !== next.localId));
      } catch (e) {
        const offline = e instanceof OfflineError;
        const outcome = sendOutcome({
          offline,
          status: e instanceof ApiError ? e.status : undefined,
        });
        if (offline) return;
        const error = (e as Error).message;
        setItems(
          items.map((m) => {
            if (m.localId !== next.localId) return m;
            return outcome === 'stop'
              ? afterServerError(m, Date.now(), error)
              : { ...m, status: 'failed', error };
          }),
        );
      }
    }
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

/** A refused send the person wants tried again: back in its original place in line. */
export function retryQueuedSend(localId: string): void {
  setItems(
    items.map((m) =>
      m.localId === localId
        ? { ...m, status: 'queued', error: undefined, attempts: 0, nextAttemptAt: undefined }
        : m,
    ),
  );
  void flushSendQueue();
}

export function deleteQueuedSend(localId: string): void {
  setItems(items.filter((m) => m.localId !== localId));
}

/** Everything waiting right now, for code outside a component. */
export function currentSendQueue(): readonly QueuedSend[] {
  return items;
}

/** Everything waiting (of every kind), as the list changes. Filter in the caller. */
export function useSendQueue(): readonly QueuedSend[] {
  return useSyncExternalStore(
    subscribe,
    () => items,
    () => items,
  );
}

onNetworkChange((online) => {
  if (online) void flushSendQueue();
});

useApp.subscribe((s, prev) => {
  if (s.user?.id && s.user.id !== prev.user?.id) void flushSendQueue();
});

// The device folder (and so the queue file) goes with sign-out; this forgets
// the copy in memory.
onSignOut(() => {
  items = [];
  loadedFor = null;
  loadEpoch++;
  loading = null;
  loadingFor = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  retryAt = null;
  emit();
});
