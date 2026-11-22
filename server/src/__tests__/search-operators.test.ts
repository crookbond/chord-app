/**
 * Search operators (ADR 0126). The rule under all of these: an operator we do
 * not recognise stays in the free text, because dropping it silently answers a
 * different question than the one asked.
 */
import { describe, expect, it } from 'vitest';

import { hasSearchOperators, parseSearchQuery } from '@chord/kernel';

const NOW = Date.parse('2026-08-25T12:00:00.000Z');

describe('parseSearchQuery', () => {
  it('lifts a sender out of the text', () => {
    const q = parseSearchQuery('from:mom dinner plans', NOW);

    expect(q).toMatchObject({ from: 'mom', text: 'dinner plans' });
  });

  it('takes a quoted value whole', () => {
    expect(parseSearchQuery('from:"school office" forms', NOW).from).toBe('school office');
  });

  it('reads has:attachment, singular or plural', () => {
    expect(parseSearchQuery('has:attachment invoice', NOW).hasAttachment).toBe(true);
    expect(parseSearchQuery('has:attachments invoice', NOW).hasAttachment).toBe(true);
  });

  it('leaves an unknown has: value in the text', () => {
    // "has:cheese" is not a thing we can answer, so it stays a search term
    // rather than being dropped into silence.
    const q = parseSearchQuery('has:cheese', NOW);

    expect(q.hasAttachment).toBeUndefined();
    expect(q.text).toBe('has:cheese');
  });

  it('reads absolute dates', () => {
    const q = parseSearchQuery('after:2026-08-01 before:2026-08-20 receipt', NOW);

    expect(q.after).toBe('2026-08-01T00:00:00.000Z');
    expect(q.before).toBe('2026-08-20T00:00:00.000Z');
    expect(q.text).toBe('receipt');
  });

  it('reads relative dates against the clock it is given', () => {
    expect(parseSearchQuery('newer_than:2d', NOW).after).toBe('2026-08-23T12:00:00.000Z');
    expect(parseSearchQuery('older_than:1w', NOW).before).toBe('2026-08-18T12:00:00.000Z');
  });

  it('leaves a vague date in the text rather than guessing', () => {
    const q = parseSearchQuery('after:tuesday', NOW);

    expect(q.after).toBeUndefined();
    expect(q.text).toBe('after:tuesday');
  });

  it('leaves a bare operator alone', () => {
    expect(parseSearchQuery('from:', NOW).text).toBe('from:');
  });

  it('does not treat a colon inside a word as an operator', () => {
    expect(parseSearchQuery('re:from:x', NOW).text).toBe('re:from:x');
  });

  it('allows an operator with no free text at all', () => {
    const q = parseSearchQuery('from:mom', NOW);

    expect(q).toEqual({ text: '', from: 'mom' });
  });

  it('reads label: for Chord labels', () => {
    expect(parseSearchQuery('label:Family dinner', NOW)).toMatchObject({
      label: 'Family',
      text: 'dinner',
    });
    expect(parseSearchQuery('label:"School stuff"', NOW).label).toBe('School stuff');
  });

  it('leaves an empty label: in the free text', () => {
    expect(parseSearchQuery('label:', NOW).text).toBe('label:');
  });

  it('leaves an ordinary query untouched', () => {
    expect(parseSearchQuery('  soccer practice ', NOW)).toEqual({ text: 'soccer practice' });
  });
});

describe('hasSearchOperators', () => {
  it('is false for a plain query', () => {
    expect(hasSearchOperators(parseSearchQuery('soccer', NOW))).toBe(false);
  });

  it('is true for anything only mail can answer', () => {
    for (const raw of [
      'from:mom',
      'has:attachment',
      'after:2026-08-01',
      'older_than:3d',
      'label:Family',
    ]) {
      expect(hasSearchOperators(parseSearchQuery(raw, NOW))).toBe(true);
    }
  });
});
