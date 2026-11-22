import { describe, expect, it } from 'vitest';

import { nextGroupSelection } from '@chord/kernel';

describe('nextGroupSelection (ADR 0247)', () => {
  it('phone taps add each group, so Alice and Ben can both be picked', () => {
    let sel = nextGroupSelection([], 'alice', true);
    sel = nextGroupSelection(sel, 'ben', true);
    expect(sel).toEqual(['alice', 'ben']);
  });

  it('an additive tap on a picked group takes it back out', () => {
    expect(nextGroupSelection(['alice', 'ben'], 'alice', true)).toEqual(['ben']);
  });

  it('a plain web click replaces the selection with that one group', () => {
    expect(nextGroupSelection(['alice', 'ben'], 'family', false)).toEqual(['family']);
  });

  it('Just me clears every group', () => {
    expect(nextGroupSelection(['alice', 'ben'], null, true)).toEqual([]);
    expect(nextGroupSelection(['alice'], null, false)).toEqual([]);
  });
});
