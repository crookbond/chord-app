import { describe, expect, it } from 'vitest';

import { memoryCardActions, memoryStatusAfter } from '@chord/kernel';

describe('memoryCardActions (ADR 0281)', () => {
  const card = (memoryStatus: 'proposed' | 'saved' | 'replaced' | 'removed') => ({
    memoryStatus,
    memoryForUserId: 'u_sayer',
  });

  it('offers Keep / Not right on a suggestion, Forget on a saved fact', () => {
    expect(memoryCardActions(card('proposed'), 'u_sayer')).toEqual(['keep', 'reject']);
    expect(memoryCardActions(card('saved'), 'u_sayer')).toEqual(['forget']);
  });

  it('offers nothing once the fact is replaced or removed', () => {
    expect(memoryCardActions(card('replaced'), 'u_sayer')).toEqual([]);
    expect(memoryCardActions(card('removed'), 'u_sayer')).toEqual([]);
  });

  it('offers nothing to anyone but the person who taught it', () => {
    expect(memoryCardActions(card('proposed'), 'u_other')).toEqual([]);
    expect(memoryCardActions(card('saved'), null)).toEqual([]);
  });

  it('shows the result of a tap', () => {
    expect(memoryStatusAfter('keep')).toBe('saved');
    expect(memoryStatusAfter('reject')).toBe('removed');
    expect(memoryStatusAfter('forget')).toBe('removed');
  });
});
