/**
 * ADR 0311 addendum - sends made offline go out in order once the server
 * answers. Kernel has no harness of its own, so the rules are tested here.
 */
import { describe, expect, it } from 'vitest';

import {
  afterServerError,
  nextRetryAt,
  nextToSend,
  SEND_MAX_ATTEMPTS,
  SEND_RETRY_FIRST_MS,
  sendOutcome,
  sendRetryDelay,
  shouldQueueSend,
  type QueuedSend,
  type QueuedSendKind,
} from '@chord/kernel';

const q = (
  localId: string,
  queuedAt: number,
  status: 'queued' | 'failed' = 'queued',
  kind: QueuedSendKind = 'chat',
): QueuedSend => ({ localId, kind, payload: {}, queuedAt, status });

describe('shouldQueueSend', () => {
  it('offline, a chat message waits instead of failing', () => {
    // The reported shape: the send failed and the text went back in the box.
    expect(shouldQueueSend({ online: false, kind: 'chat', items: [] })).toBe(true);
  });

  it('online with an earlier chat message still waiting, the new one queues behind it', () => {
    expect(shouldQueueSend({ online: true, kind: 'chat', items: [q('a', 1)] })).toBe(true);
  });

  it('online with nothing waiting, it goes straight out', () => {
    expect(shouldQueueSend({ online: true, kind: 'chat', items: [] })).toBe(false);
  });

  it('a waiting email does not hold up a chat message, nor the other way', () => {
    expect(
      shouldQueueSend({ online: true, kind: 'chat', items: [q('e', 1, 'queued', 'email')] }),
    ).toBe(false);
    expect(shouldQueueSend({ online: true, kind: 'email', items: [q('c', 1)] })).toBe(false);
  });

  it('a send the server refused does not hold the line', () => {
    expect(shouldQueueSend({ online: true, kind: 'chat', items: [q('a', 1, 'failed')] })).toBe(
      false,
    );
  });
});

describe('nextToSend', () => {
  it('sends the oldest first, whatever order the list is in', () => {
    expect(nextToSend([q('b', 2), q('a', 1), q('c', 3)])?.localId).toBe('a');
  });

  it('skips refused sends and returns null when nothing waits', () => {
    expect(nextToSend([q('a', 1, 'failed'), q('b', 2)])?.localId).toBe('b');
    expect(nextToSend([q('a', 1, 'failed')])).toBeNull();
    expect(nextToSend([])).toBeNull();
  });
});

describe('sendOutcome', () => {
  it('no network or a server error stops the flush and keeps the order', () => {
    expect(sendOutcome({ offline: true })).toBe('stop');
    expect(sendOutcome({ offline: false })).toBe('stop');
    expect(sendOutcome({ offline: false, status: 500 })).toBe('stop');
    expect(sendOutcome({ offline: false, status: 503 })).toBe('stop');
  });

  it('a timeout or rate limit is worth retrying', () => {
    expect(sendOutcome({ offline: false, status: 408 })).toBe('stop');
    expect(sendOutcome({ offline: false, status: 429 })).toBe('stop');
  });

  it('a refusal will not change on retry: that send fails, the rest go on', () => {
    expect(sendOutcome({ offline: false, status: 400 })).toBe('failed');
    expect(sendOutcome({ offline: false, status: 403 })).toBe('failed');
    expect(sendOutcome({ offline: false, status: 404 })).toBe('failed');
  });
});

describe('one line per kind, and server errors back off then give up', () => {
  const NOW = 1_000_000;

  it('an email the server keeps answering with a 5xx does not hold up a chat message', () => {
    // The reported shape: one email stuck on a 503 stopped every chat message
    // and to-do change behind it, retried every 30s for ever.
    const stuck = afterServerError(q('e', 1, 'queued', 'email'), NOW, '503');
    expect(nextToSend([stuck, q('c', 2)], { now: NOW })?.localId).toBe('c');
  });

  it('within a kind the order holds: a waiting head keeps the later ones of its kind back', () => {
    const stuck = afterServerError(q('c1', 1), NOW, '503');
    expect(nextToSend([stuck, q('c2', 2)], { now: NOW })).toBeNull();
    expect(nextRetryAt([stuck, q('c2', 2)])).toBe(NOW + SEND_RETRY_FIRST_MS);
    expect(nextToSend([stuck, q('c2', 2)], { now: NOW + SEND_RETRY_FIRST_MS })?.localId).toBe(
      'c1',
    );
  });

  it('a kind with no sender loaded yet is passed over', () => {
    expect(
      nextToSend([q('e', 1, 'queued', 'email'), q('c', 2)], { skipKinds: new Set(['email']) })
        ?.localId,
    ).toBe('c');
  });

  it('waits longer each time, then marks it failed with the reason', () => {
    let m = q('e', 1, 'queued', 'email');
    const delays: number[] = [];
    for (let i = 1; i < SEND_MAX_ATTEMPTS; i++) {
      m = afterServerError(m, NOW, '503 Service Unavailable');
      expect(m.status).toBe('queued');
      delays.push((m.nextAttemptAt ?? 0) - NOW);
    }
    expect(delays[1]).toBe(delays[0] * 2);
    expect(Math.max(...delays)).toBeLessThanOrEqual(sendRetryDelay(99));
    m = afterServerError(m, NOW, '503 Service Unavailable');
    expect(m.status).toBe('failed');
    expect(m.error).toContain('503 Service Unavailable');
    expect(nextToSend([m], { now: NOW + 10 ** 9 })).toBeNull();
  });
});
