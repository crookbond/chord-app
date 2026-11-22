/**
 * ADR 0311 addendum - what someone sends while the server cannot be reached
 * (a chat message, an email) waits on the phone and goes out in the order it
 * was sent once the server answers. One queue for both kinds. Pure so it can
 * be tested; `mobile/` has no harness.
 */

import type { UserTagged } from './user-scoped';

export type QueuedSendKind = 'chat' | 'email' | 'todo' | 'proposal';

export interface QueuedSend<P = unknown> extends UserTagged {
  localId: string;
  kind: QueuedSendKind;
  /** Everything needed to send it later; its shape belongs to the kind. */
  payload: P;
  /** Epoch ms when Send was pressed. Orders the queue. */
  queuedAt: number;
  /** `queued` waits its turn; `failed` was refused by the server and waits for the person. */
  status: 'queued' | 'failed';
  error?: string;
  /** Server errors so far (a 5xx, a timeout, a rate limit). */
  attempts?: number;
  /** Epoch ms before which it is not tried again, after a server error. */
  nextAttemptAt?: number;
}

/**
 * A new send joins the queue (rather than going straight out) while offline,
 * and also while an earlier send of the same kind is still waiting: going
 * directly would overtake it, and a chat is read in order. A send the server
 * refused does not hold the line.
 */
export function shouldQueueSend(a: {
  online: boolean;
  kind: QueuedSendKind;
  items: readonly QueuedSend[];
}): boolean {
  return !a.online || a.items.some((m) => m.kind === a.kind && m.status === 'queued');
}

/**
 * Each kind is its own line: a chat message never waits behind an email the
 * server keeps refusing with a 5xx, while within a kind the oldest still goes
 * first. The head of each line is its oldest waiting send.
 */
function laneHeads<P>(
  items: readonly QueuedSend<P>[],
  skipKinds?: ReadonlySet<QueuedSendKind>,
): QueuedSend<P>[] {
  const heads = new Map<QueuedSendKind, QueuedSend<P>>();
  for (const m of items) {
    if (m.status !== 'queued' || skipKinds?.has(m.kind)) continue;
    const h = heads.get(m.kind);
    if (!h || m.queuedAt < h.queuedAt) heads.set(m.kind, m);
  }
  return [...heads.values()];
}

/**
 * The oldest send that may go now: the head of its kind's line, and not
 * waiting out a retry delay (a head that is waiting holds its line). `now`
 * omitted = nothing is waiting a delay.
 */
export function nextToSend<P>(
  items: readonly QueuedSend<P>[],
  opts: { now?: number; skipKinds?: ReadonlySet<QueuedSendKind> } = {},
): QueuedSend<P> | null {
  let best: QueuedSend<P> | null = null;
  for (const m of laneHeads(items, opts.skipKinds)) {
    if (opts.now !== undefined && (m.nextAttemptAt ?? 0) > opts.now) continue;
    if (!best || m.queuedAt < best.queuedAt) best = m;
  }
  return best;
}

/** When the next line's head comes due again, or null if none is waiting a delay. */
export function nextRetryAt(
  items: readonly QueuedSend[],
  skipKinds?: ReadonlySet<QueuedSendKind>,
): number | null {
  let at: number | null = null;
  for (const m of laneHeads(items, skipKinds)) {
    if (m.nextAttemptAt !== undefined && (at === null || m.nextAttemptAt < at)) {
      at = m.nextAttemptAt;
    }
  }
  return at;
}

export const SEND_RETRY_FIRST_MS = 30_000;
export const SEND_RETRY_MAX_MS = 30 * 60_000;
/** After this many server errors a send is marked failed, for the person to Retry or Delete. */
export const SEND_MAX_ATTEMPTS = 8;

/** 30s doubling to half an hour. */
export function sendRetryDelay(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(SEND_RETRY_FIRST_MS * 2 ** Math.min(n - 1, 10), SEND_RETRY_MAX_MS);
}

/**
 * A send the server answered with an error worth retrying: try again later,
 * waiting longer each time, and after `SEND_MAX_ATTEMPTS` give up and say why
 * rather than retry for ever.
 */
export function afterServerError<P>(m: QueuedSend<P>, now: number, error: string): QueuedSend<P> {
  const attempts = (m.attempts ?? 0) + 1;
  if (attempts >= SEND_MAX_ATTEMPTS) {
    return {
      ...m,
      attempts,
      nextAttemptAt: undefined,
      status: 'failed',
      error: `Could not be sent after ${attempts} tries: ${error}`,
    };
  }
  return { ...m, attempts, nextAttemptAt: now + sendRetryDelay(attempts) };
}

/**
 * What a failed send means for the queue. No network or a server error: stop,
 * keep the order, try again later. A refusal (4xx, other than a timeout or a
 * rate limit) will not change on retry: mark that one failed, tell the
 * person, carry on with the rest.
 */
export function sendOutcome(a: { offline: boolean; status?: number }): 'stop' | 'failed' {
  if (a.offline || a.status === undefined) return 'stop';
  if (a.status >= 400 && a.status < 500 && a.status !== 408 && a.status !== 429) return 'failed';
  return 'stop';
}

/** The id a queued chat message is shown under in the chat list. */
export const QUEUED_CHAT_ID_PREFIX = 'local:';
