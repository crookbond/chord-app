/**
 * Reading a person out of a plain mail question (ADR 0270). The prod failure:
 * "emails from Bill" reached search as the words emails | bill, so every newer
 * message containing "email" outranked Bill.
 */
import { describe, expect, it } from 'vitest';

import { nameVariants, parseMailIntent, parseSearchQuery } from '@chord/kernel';

const NOW = Date.parse('2026-10-19T12:00:00.000Z');

describe('parseMailIntent', () => {
  it.each([
    ['emails from Bill', { from: 'Bill', text: '' }],
    ['find me emails from Bill Smith', { from: 'Bill Smith', text: '' }],
    ['from Bill about the cabin', { from: 'Bill', text: 'the cabin' }],
    ['what did Bill Smith send me', { from: 'Bill Smith', text: '' }],
    ['mail from the dentist', { from: 'dentist', text: '' }],
    ['emails I sent to Bill Smith', { to: 'Bill Smith', text: '' }],
    ['what did I send to bob@x.com', { to: 'bob@x.com', text: '' }],
    ['Bill Smith about the cabin', { from: 'Bill Smith', text: 'the cabin' }],
  ])('%s', (q, want) => {
    expect(parseMailIntent(q, NOW)).toEqual(want);
  });

  it('reads a rolling window', () => {
    const r = parseMailIntent('emails from Bill last week', NOW);
    expect(r.from).toBe('Bill');
    expect(r.after).toBe(new Date(NOW - 7 * 86_400_000).toISOString());
  });

  it.each(['plumber quote', 'costco receipt', 'flowers from the garden show', 'emails from me', 'cabin'])(
    'leaves %s as plain text',
    (q) => {
      const r = parseMailIntent(q, NOW);
      expect(r.from).toBeUndefined();
      expect(r.to).toBeUndefined();
      expect(r.text).toBe(q);
    },
  );
});

describe('nameVariants', () => {
  it('goes both ways', () => {
    expect(nameVariants('Bill')).toContain('william');
    expect(nameVariants('william')).toContain('bill');
    expect(nameVariants('bob')).toContain('robert');
  });

  it('is the name alone when there is no nickname', () => {
    expect(nameVariants('Nolan')).toEqual(['nolan']);
  });
});

describe('to: operator', () => {
  it('lifts a recipient out of the text', () => {
    expect(parseSearchQuery('to:bill@x.com directions', NOW)).toMatchObject({ to: 'bill@x.com', text: 'directions' });
  });
});
