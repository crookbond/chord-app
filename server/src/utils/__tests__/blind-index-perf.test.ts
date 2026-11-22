/**
 * What indexing costs (ADR 0201). Timing tests live in a `*perf*` file so they
 * run serially, apart from the parallel suite where they measure the
 * neighbours (see vitest.perf.config.ts).
 */
import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { scaled } from '../../__test-helpers__/perf.js';
import { buildGramsVector, buildWordsVector } from '../blind-index.js';

const KEY = randomBytes(32);
const words = (doc: string, key = KEY) => buildWordsVector(key, doc);

describe('cost', () => {
  it('indexes a typical 2 KB message in well under a few milliseconds', () => {
    const doc = 'The plumber is coming Tuesday about the leak under the kitchen sink. '.repeat(30);
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) words(doc);
    const each = (performance.now() - t0) / 50;
    console.log(`PERF index 2KB words: ${each.toFixed(2)} ms`);
    expect(each).toBeLessThan(scaled(15));
  });

  it('indexes a 100 KB body in well under a second', () => {
    const doc = Array.from({ length: 12_000 }, (_, i) => `word${i % 900} plumber leak`).join(' ');
    const t0 = performance.now();
    words(doc);
    const took = performance.now() - t0;
    console.log(`PERF index 100KB words: ${took.toFixed(0)} ms`);
    expect(took).toBeLessThan(scaled(1200));
  });

  it('a subject-sized trigram index is microseconds', () => {
    const t0 = performance.now();
    for (let i = 0; i < 500; i++) buildGramsVector(KEY, 'Weekly update from Loudoun Schools about pickup times, Ms Chen');
    const each = (performance.now() - t0) / 500;
    console.log(`PERF index subject grams: ${(each * 1000).toFixed(0)} us`);
    expect(each).toBeLessThan(scaled(2));
  });
});
