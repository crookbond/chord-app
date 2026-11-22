/**
 * Stored search vectors (ADR 0276): int8 with a scale must keep near-identical
 * similarities, and the fusion must reward agreement between the two lists.
 */
import { describe, expect, it } from 'vitest';

import { fuseRanks } from '@/services/search/semantic.js';
import { contentHash, cosine, packVector, unpackVector } from '@/services/search/vectors.js';

function randomUnit(n: number, seed: number): Float32Array {
  let x = seed;
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    v[i] = x / 2 ** 31 - 0.5;
  }
  const norm = Math.hypot(...v);
  return v.map((y) => y / norm);
}

describe('packVector', () => {
  it('round-trips with a similarity error far below a match/non-match gap', () => {
    for (let s = 1; s <= 20; s++) {
      const a = randomUnit(512, s);
      const b = randomUnit(512, s + 100);
      const exact = cosine(a, b);
      const packed = cosine(unpackVector(packVector(a)), unpackVector(packVector(b)));
      expect(Math.abs(exact - packed)).toBeLessThan(0.02);
    }
    expect(packVector(randomUnit(512, 1)).length).toBe(516);
  });
});

describe('contentHash', () => {
  it('changes with the model, so a model change re-embeds', () => {
    expect(contentHash('a@512', 'text')).not.toBe(contentHash('b@512', 'text'));
    expect(contentHash('a@512', 'text')).toBe(contentHash('a@512', 'text'));
  });
});

describe('fuseRanks', () => {
  it('puts what both lists found above what one list put first', () => {
    expect(fuseRanks([['a', 'b', 'c'], ['b', 'x']])[0]).toBe('b');
  });

  it('keeps an item only one list found', () => {
    expect(fuseRanks([['a'], ['z']]).sort()).toEqual(['a', 'z']);
  });
});
