/**
 * When the chat screen tells the server "read up to here".
 *
 * It asks once per newest message, as the user reaches the bottom. A failed
 * ask used to forget the message, so the next scroll event (a dozen a
 * second while scrolling) asked again: a request storm while offline or
 * when the server refused. Now a failure waits, doubling from 5 s to 5 min,
 * before the same message is asked about again; a NEWER message asks at
 * once, since that is new information to report.
 */

export interface MarkReadState {
  /** The message last asked about successfully (or still in flight). */
  sentId: string | null;
  /** The message whose ask last failed, and when, and how often in a row. */
  failedId: string | null;
  failedAt: number;
  failures: number;
}

export const MARK_READ_RETRY_FIRST_MS = 5_000;
export const MARK_READ_RETRY_MAX_MS = 5 * 60_000;

export function emptyMarkReadState(): MarkReadState {
  return { sentId: null, failedId: null, failedAt: 0, failures: 0 };
}

export function markReadRetryDelay(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(MARK_READ_RETRY_MAX_MS, MARK_READ_RETRY_FIRST_MS * 2 ** (failures - 1));
}

/** Should the screen ask now, for `latestId`? */
export function shouldMarkRead(state: MarkReadState, latestId: string, now: number): boolean {
  if (state.sentId === latestId) return false;
  if (state.failedId === latestId && now - state.failedAt < markReadRetryDelay(state.failures)) return false;
  return true;
}

export function markReadStarted(state: MarkReadState, latestId: string): MarkReadState {
  return { ...state, sentId: latestId };
}

export function markReadFailed(state: MarkReadState, latestId: string, now: number): MarkReadState {
  const failures = state.failedId === latestId ? state.failures + 1 : 1;
  return {
    sentId: state.sentId === latestId ? null : state.sentId,
    failedId: latestId,
    failedAt: now,
    failures,
  };
}

export function markReadSucceeded(state: MarkReadState, latestId: string): MarkReadState {
  return state.failedId === latestId ? { ...state, failedId: null, failedAt: 0, failures: 0 } : state;
}
