/**
 * ADR 0053 — the taster's connect prompt rides along with the answers
 * instead of only appearing at the wall.
 */
import { describe, expect, it } from 'vitest';

import {
  footerDueOnTurn,
  tasterFooter,
  withFooter,
} from '@/services/connectors/whatsapp/taster.js';

const LINK = 'https://chordapp.ai/welcome/tok123';

describe('taster footer cadence', () => {
  it('fires on the first turn, every third, and the last', () => {
    // A 5-turn allowance: present on 1, 3, 5 — not on 2 or 4.
    expect([1, 2, 3, 4, 5].map((t) => footerDueOnTurn(t, 5))).toEqual([
      true,
      false,
      true,
      false,
      true,
    ]);
  });

  it('adapts to the configured allowance rather than a fixed schedule', () => {
    // The shipped default: 10 turns → 1, 3, 6, 9, 10.
    const fired = [...Array(10)].map((_, i) => i + 1).filter((t) => footerDueOnTurn(t, 10));
    expect(fired).toEqual([1, 3, 6, 9, 10]);
    // Degrades sensibly at small values — the last turn always carries one.
    expect([1, 2].filter((t) => footerDueOnTurn(t, 2))).toEqual([1, 2]);
    expect([1, 2, 3].filter((t) => footerDueOnTurn(t, 3))).toEqual([1, 3]);
  });

  it('keeps firing past the limit, where every reply is the wall', () => {
    expect(footerDueOnTurn(6, 5)).toBe(true);
    expect(footerDueOnTurn(20, 5)).toBe(true);
  });

  it('is inert for a nonsense turn or a disabled allowance', () => {
    expect(footerDueOnTurn(0, 5)).toBe(false);
    expect(footerDueOnTurn(3, 0)).toBe(false);
  });
});

describe('taster footer copy', () => {
  it('introduces Chord on the first answer — the recipient may not know what replied', () => {
    const f = tasterFooter(1, 5, LINK);
    expect(f).toContain("I'm Chord");
    expect(f).toContain(LINK);
  });

  it('speaks to someone who already has an account, not just a newcomer', () => {
    // The common case is a signed-up user writing from an unlinked number;
    // "sign up" would be the wrong instruction for them.
    expect(tasterFooter(1, 5, LINK)).toMatch(/already have one/i);
    expect(tasterFooter(5, 5, LINK)).toMatch(/or create one/i);
    for (const turn of [1, 3, 5]) {
      expect(tasterFooter(turn, 5, LINK)).not.toMatch(/sign up/i);
    }
  });

  it('warns on the last free answer so the wall is never a surprise', () => {
    expect(tasterFooter(5, 5, LINK)).toMatch(/last answer/i);
  });

  it('is a plain reminder in between', () => {
    const f = tasterFooter(3, 5, LINK);
    expect(f).toMatch(/^— Connect this chat/);
    expect(f).not.toMatch(/last answer/i);
  });

  it('returns nothing on a quiet turn, or with no signup URL configured', () => {
    expect(tasterFooter(2, 5, LINK)).toBeNull();
    expect(tasterFooter(1, 5, '')).toBeNull();
  });
});

describe('withFooter', () => {
  it('separates the answer from the ask with a blank line', () => {
    expect(withFooter('the answer', '— ask')).toBe('the answer\n\n— ask');
  });

  it('leaves the body untouched when there is no footer', () => {
    expect(withFooter('the answer', null)).toBe('the answer');
  });
});
