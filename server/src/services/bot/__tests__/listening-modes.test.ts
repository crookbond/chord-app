/**
 * PR-D.2 / ADR 0018 — listening-mode gating in `decideReaction`.
 *
 * The reply path (react) is unchanged for existing modes. The new
 * passiveExtract output is what the bot loop reads to decide whether
 * to fire memory extraction without replying.
 */
import { describe, expect, it } from 'vitest';

import { decideReaction } from '@/services/bot/bot.service.js';

describe('decideReaction — listening modes', () => {
  it('invocation mode: no @-mention → no react, no passive extract', () => {
    const d = decideReaction({
      kind: 'text',
      senderId: 'u1',
      groupKind: 'group',
      body: 'hey what is up',
      listeningMode: 'invocation',
    });
    expect(d.react).toBe(false);
    expect(d.passiveExtract).toBe(false);
  });

  it('invocation mode: @-mention → react, no passive extract', () => {
    const d = decideReaction({
      kind: 'text',
      senderId: 'u1',
      groupKind: 'group',
      body: '@chord help me',
      listeningMode: 'invocation',
    });
    expect(d.react).toBe(true);
    expect(d.passiveExtract).toBe(false);
  });

  it('passive mode: no @-mention → no react BUT passive extract fires', () => {
    const d = decideReaction({
      kind: 'text',
      senderId: 'u1',
      groupKind: 'group',
      body: 'I am allergic to peanuts',
      listeningMode: 'passive',
    });
    expect(d.react).toBe(false);
    expect(d.passiveExtract).toBe(true);
  });

  it('passive mode: @-mention still reacts (no parallel passive extraction needed — reply path runs extractor itself)', () => {
    const d = decideReaction({
      kind: 'text',
      senderId: 'u1',
      groupKind: 'group',
      body: '@chord remember I like jazz',
      listeningMode: 'passive',
    });
    expect(d.react).toBe(true);
    expect(d.passiveExtract).toBe(false);
  });

  it('personal chat: always react, never passive (reply path covers it)', () => {
    const d = decideReaction({
      kind: 'text',
      senderId: 'u1',
      groupKind: 'personal',
      body: 'hi',
      listeningMode: 'passive',
    });
    expect(d.react).toBe(true);
    expect(d.passiveExtract).toBe(false);
  });

  it('default (no listeningMode passed) behaves like invocation', () => {
    const d = decideReaction({
      kind: 'text',
      senderId: 'u1',
      groupKind: 'group',
      body: 'random chatter',
    });
    expect(d.react).toBe(false);
    expect(d.passiveExtract).toBe(false);
  });

  it('bot/system messages: never react, never extract', () => {
    for (const kind of ['bot', 'system'] as const) {
      const d = decideReaction({
        kind,
        senderId: 'u1',
        groupKind: 'group',
        body: 'anything',
        listeningMode: 'passive',
      });
      expect(d.react).toBe(false);
      expect(d.passiveExtract).toBe(false);
    }
  });
});
