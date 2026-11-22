/**
 * The query-side rules both search surfaces share (ADR 0085): how a typed
 * query becomes FTS tokens, and when the literal arm is allowed to run.
 *
 * These pin today's behaviour on purpose. A blind-index rewrite has to
 * reproduce the token rules exactly (same stopwords, same length floor, same
 * prefix + OR shape) or the two surfaces stop agreeing with what users already
 * get, so a change here should be a decision, not an accident.
 */
import { describe, expect, it } from 'vitest';

import { extractKeywords } from '@/services/bot/retrieval.js';
import { literalQueryUsable, toTsQuery } from '@/services/search.service.js';

describe('toTsQuery', () => {
  it('prefix-matches every token and ORs them', () => {
    expect(toTsQuery('plumber leak')).toBe('plumber:* | leak:*');
  });

  it('drops tokens under three characters', () => {
    expect(toTsQuery('go to nyc')).toBe('nyc:*');
    expect(toTsQuery('ab')).toBeNull();
  });

  it('drops stopwords and returns null when nothing is left', () => {
    expect(toTsQuery('the of and')).toBeNull();
    expect(toTsQuery('what is the plumber')).toBe('plumber:*');
  });

  it('is case-insensitive and de-duplicates', () => {
    expect(toTsQuery('Plumber PLUMBER plumber')).toBe('plumber:*');
  });

  it('strips punctuation, so the output cannot carry tsquery syntax', () => {
    expect(toTsQuery("o'brien's e-mail")).toBe('brien:* | mail:*');
    expect(toTsQuery('leak & (drip) | !x:*')).toBe('leak:* | drip:*');
  });

  it('keeps a code as one token unless punctuation splits it', () => {
    // `ua512` stays one token, which is why the literal arm exists: a search
    // for `512` cannot reach it through FTS. `ua-512` splits, and `ua` is
    // then below the length floor.
    expect(toTsQuery('ua512')).toBe('ua512:*');
    expect(toTsQuery('ua-512')).toBe('512:*');
  });

  it('does not fold accents: they are dropped, not transliterated', () => {
    // José -> "jos", café -> "caf", naïve -> nothing. Pinned so the rewrite
    // makes a deliberate choice about accent folding rather than inheriting
    // this one.
    expect(toTsQuery('José')).toBe('jos:*');
    expect(toTsQuery('café')).toBe('caf:*');
    expect(toTsQuery('naïve')).toBeNull();
  });

  it('yields nothing for non-latin scripts', () => {
    expect(toTsQuery('学校の連絡')).toBeNull();
  });
});

describe('extractKeywords', () => {
  it('lowercases, drops stopwords and short tokens, keeps order', () => {
    expect(extractKeywords("What's Nolan's Term 2 calendar?")).toEqual([
      'nolan',
      'term',
      'calendar',
    ]);
  });

  it('keeps digits inside a token', () => {
    expect(extractKeywords('flight UA512 and 2026')).toEqual(['flight', 'ua512', '2026']);
  });
});

describe('literalQueryUsable', () => {
  it('needs three characters', () => {
    expect(literalQueryUsable('')).toBe(false);
    expect(literalQueryUsable('ab')).toBe(false);
    expect(literalQueryUsable('512')).toBe(true);
  });

  it('refuses a query that is nothing but stopwords', () => {
    expect(literalQueryUsable('the')).toBe(false);
    expect(literalQueryUsable('of the')).toBe(false);
  });

  it('allows a query with one real word among stopwords', () => {
    expect(literalQueryUsable('of plumber')).toBe(true);
  });
});
