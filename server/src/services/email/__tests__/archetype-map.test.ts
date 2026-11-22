import { describe, expect, it } from 'vitest';

import { pathHint, resolveArchetype, titlesPath } from '@/services/email/archetype-map.js';

describe('pathHint', () => {
  it('maps school under friends & family to timeline', () => {
    expect(pathHint(['Friends & family', 'School notes'])).toBe('timeline');
  });

  it('maps deliveries to state board and finance/receipts to ledger', () => {
    expect(pathHint(['Deliveries', 'Shipping updates'])).toBe('state_board');
    expect(pathHint(['Finance', 'Credit card statements'])).toBe('ledger');
    expect(pathHint(['Receipts'])).toBe('ledger');
  });

  it('marks travel for later resolve; newsletters stay unconverted', () => {
    expect(pathHint(['Travel', 'Flights'])).toBe('travel');
    expect(pathHint(['Newsletters'])).toBeNull();
    expect(pathHint(['Coupons'])).toBeNull();
  });
});

describe('resolveArchetype', () => {
  it('converts only when extract produced facts of that kind', () => {
    expect(resolveArchetype('ledger', false, false, false)).toBeNull();
    expect(resolveArchetype('ledger', false, false, true)).toBe('ledger');
    expect(resolveArchetype('timeline', true, false, false)).toBe('timeline');
  });

  it('resolves travel to timeline when dated, else state board', () => {
    expect(resolveArchetype('travel', true, true, false)).toBe('timeline');
    expect(resolveArchetype('travel', false, true, false)).toBe('state_board');
    expect(resolveArchetype('travel', false, false, false)).toBeNull();
  });
});

describe('titlesPath', () => {
  it('walks root to leaf', () => {
    const byId = new Map([
      ['a', { parent_id: null, title: 'Friends & family' }],
      ['b', { parent_id: 'a', title: 'School notes' }],
    ]);
    expect(titlesPath(byId, 'b')).toEqual(['Friends & family', 'School notes']);
  });
});
