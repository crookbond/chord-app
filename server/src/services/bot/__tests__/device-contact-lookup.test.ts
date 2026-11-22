/**
 * ADR 0212 / 0280 — the phone's answer reaches the turn waiting for it even
 * when the POST lands on a different web copy. The hub is faked so one module
 * can play both copies: the copy holding the request, and the copy that
 * received the POST and forwards it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const peer = vi.hoisted(() => ({
  handler: null as ((data: unknown) => void) | null,
  sent: [] as unknown[],
  hasRedis: true,
}));

vi.mock('@/services/sse.hub.js', () => ({
  sseHub: {
    onPeerMessage: (_topic: string, h: (data: unknown) => void) => {
      peer.handler = h;
    },
    sendToPeers: (_topic: string, data: unknown) => {
      if (!peer.hasRedis) return false;
      peer.sent.push(data);
      return true;
    },
  },
}));

const { answerDeviceContactLookup, requestDeviceContact } = await import(
  '@/services/bot/device-contact-lookup.js'
);

const answer = { status: 'found' as const, matches: [{ name: 'Ben Doe', emails: ['a@x.com'], phones: [] }] };

async function waitingTurn(userId: string): Promise<{ requestId: string; result: Promise<unknown> }> {
  let requestId = '';
  const result = requestDeviceContact({
    emit: (_g, _e, data) => {
      requestId = (data as { requestId: string }).requestId;
    },
    groupId: 'g',
    userId,
    query: 'Ben',
    timeoutMs: 5_000,
  });
  return { requestId, result };
}

describe('device contact lookup across web copies', () => {
  beforeEach(() => {
    peer.sent = [];
    peer.hasRedis = true;
  });

  it('answers a turn waiting in this process directly', async () => {
    const { requestId, result } = await waitingTurn('u1');
    expect(answerDeviceContactLookup('u1', requestId, answer)).toBe(true);
    await expect(result).resolves.toEqual(answer);
    expect(peer.sent).toEqual([]);
  });

  it('forwards an answer it is not holding, and the holder resolves the turn', async () => {
    const { requestId, result } = await waitingTurn('u1');
    // The copy that received the POST has no such request…
    expect(answerDeviceContactLookup('u1', 'cl_elsewhere', answer)).toBe(true);
    expect(peer.sent).toHaveLength(1);
    // …and the copy holding the turn gets it through the peer channel.
    peer.handler!({ userId: 'u1', requestId, response: answer });
    await expect(result).resolves.toEqual(answer);
  });

  it('refuses a forwarded answer from someone other than the asker', async () => {
    const { requestId, result } = await waitingTurn('u1');
    peer.handler!({ userId: 'intruder', requestId, response: answer });
    expect(answerDeviceContactLookup('u1', requestId, answer)).toBe(true);
    await expect(result).resolves.toEqual(answer);
  });

  it('reports nothing waiting when there is no other copy to forward to', () => {
    peer.hasRedis = false;
    expect(answerDeviceContactLookup('u1', 'cl_unknown', answer)).toBe(false);
  });
});
