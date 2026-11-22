import { describe, expect, it } from 'vitest';

import { parseConfirmCommand } from '../confirm-verb.js';

describe('parseConfirmCommand', () => {
  it('recognizes bare confirm', () => {
    expect(parseConfirmCommand('@Chord confirm')).toEqual({ verb: 'confirm', ref: null });
    expect(parseConfirmCommand('@chord  Confirm.  ')).toEqual({ verb: 'confirm', ref: null });
  });

  it('recognizes approve alias', () => {
    expect(parseConfirmCommand('@Chord approve')).toEqual({ verb: 'confirm', ref: null });
  });

  it('recognizes reject aliases', () => {
    expect(parseConfirmCommand('@Chord drop')).toEqual({ verb: 'reject', ref: null });
    expect(parseConfirmCommand('@Chord reject')).toEqual({ verb: 'reject', ref: null });
  });

  it('captures "all"', () => {
    expect(parseConfirmCommand('@Chord confirm all')).toEqual({ verb: 'confirm', ref: 'all' });
    expect(parseConfirmCommand('@Chord drop all')).toEqual({ verb: 'reject', ref: 'all' });
  });

  it('captures a ref', () => {
    expect(parseConfirmCommand('@Chord confirm p_abc123')).toEqual({
      verb: 'confirm',
      ref: 'p_abc123',
    });
    expect(parseConfirmCommand('@Chord drop abc')).toEqual({
      verb: 'reject',
      ref: 'abc',
    });
  });

  it('rejects non-verb messages', () => {
    expect(parseConfirmCommand('@Chord add milk to Costco')).toBeNull();
    expect(parseConfirmCommand('confirm the order')).toBeNull();
    expect(parseConfirmCommand('@Chord')).toBeNull();
    expect(parseConfirmCommand('@Chord confirm this with the team')).toBeNull();
  });
});
