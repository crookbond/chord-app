import { describe, expect, it } from 'vitest';

import {
  MARK_READ_RETRY_FIRST_MS,
  MARK_READ_RETRY_MAX_MS,
  emptyMarkReadState,
  markReadFailed,
  markReadStarted,
  markReadSucceeded,
  shouldMarkRead,
  type MarkReadState,
} from '@chord/kernel';

/** What groups/[id]/index.tsx does on each scroll event while at the bottom. */
function scrollEvent(state: MarkReadState, latest: string, now: number, ok: boolean): { state: MarkReadState; asked: boolean } {
  if (!shouldMarkRead(state, latest, now)) return { state, asked: false };
  const started = markReadStarted(state, latest);
  return { state: ok ? markReadSucceeded(started, latest) : markReadFailed(started, latest, now), asked: true };
}

describe('chat mark-read', () => {
  // Offline, every scroll event at the bottom re-sent POST .../read because a
  // failure reset the "already marked" ref.
  it('does not re-ask on every scroll event after a failure', () => {
    let state = emptyMarkReadState();
    let asks = 0;
    for (let t = 0; t < 1000; t += 50) {
      const r = scrollEvent(state, 'm1', t, false);
      state = r.state;
      if (r.asked) asks += 1;
    }
    expect(asks).toBe(1);
  });

  it('retries after a doubling back-off, capped', () => {
    let state = markReadFailed(markReadStarted(emptyMarkReadState(), 'm1'), 'm1', 0);
    expect(shouldMarkRead(state, 'm1', MARK_READ_RETRY_FIRST_MS - 1)).toBe(false);
    expect(shouldMarkRead(state, 'm1', MARK_READ_RETRY_FIRST_MS)).toBe(true);
    state = markReadFailed(state, 'm1', MARK_READ_RETRY_FIRST_MS);
    expect(shouldMarkRead(state, 'm1', MARK_READ_RETRY_FIRST_MS * 2)).toBe(false);
    expect(shouldMarkRead(state, 'm1', MARK_READ_RETRY_FIRST_MS * 3)).toBe(true);
    for (let i = 0; i < 20; i++) state = markReadFailed(state, 'm1', 0);
    expect(shouldMarkRead(state, 'm1', MARK_READ_RETRY_MAX_MS)).toBe(true);
  });

  it('asks at once for a newer message, and once per message on success', () => {
    let state = markReadFailed(markReadStarted(emptyMarkReadState(), 'm1'), 'm1', 0);
    expect(shouldMarkRead(state, 'm2', 1)).toBe(true);
    state = markReadSucceeded(markReadStarted(state, 'm2'), 'm2');
    expect(shouldMarkRead(state, 'm2', 2)).toBe(false);
  });
});
