import { describe, expect, it } from 'vitest';

import { CARD_STACK_SHOWN, cardStack } from '@chord/kernel';

const n = (count: number) => Array.from({ length: count }, (_, i) => i);

describe('cardStack', () => {
  it('shows the first five and stacks the rest', () => {
    const s = cardStack(n(12), false);
    expect(CARD_STACK_SHOWN).toBe(5);
    expect(s.shown).toEqual([0, 1, 2, 3, 4]);
    expect(s.stacked).toEqual([5, 6, 7, 8, 9, 10, 11]);
  });

  it('shows everything once the stack is opened', () => {
    expect(cardStack(n(12), true)).toEqual({ shown: n(12), stacked: [] });
  });

  it('stacks nothing at or under the limit', () => {
    expect(cardStack(n(5), false).stacked).toEqual([]);
    expect(cardStack(n(0), false)).toEqual({ shown: [], stacked: [] });
  });

  it('shows a single extra card rather than stacking it', () => {
    expect(cardStack(n(6), false)).toEqual({ shown: n(6), stacked: [] });
    expect(cardStack(n(7), false).stacked).toEqual([5, 6]);
  });

  it('stacks the rest of one email behind its first card, even a single one', () => {
    expect(cardStack(n(2), false, 1, 1)).toEqual({ shown: [0], stacked: [1] });
    expect(cardStack(n(8), false, 1, 1).stacked).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(cardStack(n(1), false, 1, 1)).toEqual({ shown: [0], stacked: [] });
    expect(cardStack(n(8), true, 1, 1)).toEqual({ shown: n(8), stacked: [] });
  });
});
