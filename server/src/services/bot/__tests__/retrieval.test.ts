import { describe, expect, it } from 'vitest';

import { extractKeywords, wordsQualifyFile } from '../retrieval.js';

describe('extractKeywords', () => {
  it('drops stopwords, short tokens, and chord itself', () => {
    expect(extractKeywords('@Chord where is the school calendar?')).toEqual([
      'school',
      'calendar',
    ]);
  });

  it('lowercases + dedupes', () => {
    expect(extractKeywords('Seattle trip SEATTLE hotel')).toEqual([
      'seattle',
      'trip',
      'hotel',
    ]);
  });

  it('returns empty for greeting-only input (all stopwords)', () => {
    expect(extractKeywords('hi ok thanks please')).toEqual([]);
    expect(extractKeywords('')).toEqual([]);
  });

  it('strips punctuation', () => {
    expect(extractKeywords("what's Nolan's term 2 calendar?")).toEqual([
      'nolan',
      'term',
      'calendar',
    ]);
  });
});

describe('wordsQualifyFile (ADR 0288)', () => {
  const contract = ['Binding instructions must be received by Friday.', 'The effective date is the renewal date.'];

  it('does not let one generic word, or two of many, bring a file in', () => {
    expect(wordsQualifyFile('anything on friday?', 'Insurance Proposal.pdf', contract)).toBe(false);
    expect(
      wordsQualifyFile('can you suggest a restaurant for Friday? Date night with Alice', 'Insurance Proposal.pdf', contract),
    ).toBe(false);
  });

  it('brings a file in when most of a message is in it', () => {
    expect(wordsQualifyFile('what time is the soccer game', 'spring.pdf', ['The soccer game starts at 3:45pm'])).toBe(true);
  });

  it('brings a file in when the message names it', () => {
    expect(wordsQualifyFile('summarize the lease', 'Lease 2026.pdf', [])).toBe(true);
  });

  it('matches whole words, not letters inside words', () => {
    expect(wordsQualifyFile('update the date', 'notes.pdf', ['We will updated them on the mandate.'])).toBe(false);
  });

  it('judges each message of the window on its own', () => {
    const text = 'friday works\nwhat time is the soccer game';
    expect(wordsQualifyFile(text, 'spring.pdf', ['soccer game on Friday'])).toBe(true);
    expect(wordsQualifyFile('friday works\ndate night ideas', 'x.pdf', contract)).toBe(false);
  });
});
