import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { listTests } from '../ci/select-tests.mjs';
import {
  DEFAULT_FILE_SECONDS,
  FILE_OVERHEAD_SECONDS,
  mergeTimings,
  overlappingPaths,
  planShards,
  timingsFromReport,
} from '../ci/test-shards.mjs';

const files = (n: number) => Array.from({ length: n }, (_, i) => `src/__tests__/t${String(i).padStart(3, '0')}.test.ts`);

describe('planShards', () => {
  // CI, 2026-11: a picked subset of 299 files ran on ONE runner for 477 s,
  // longer than the whole suite takes on four.
  it('splits a large picked subset over several runners', () => {
    const { shards } = planShards(files(299), {}, { maxShards: 4 });
    expect(shards).toHaveLength(4);
    expect(shards.flat().sort()).toEqual(files(299));
  });

  it('keeps a small subset on one runner', () => {
    expect(planShards(files(5), {}, { maxShards: 4 }).shards).toHaveLength(1);
  });

  it('never uses more runners than allowed or than there are files', () => {
    expect(planShards(files(2), { [files(2)[0]]: 1000, [files(2)[1]]: 1000 }, { maxShards: 4 }).shards).toHaveLength(2);
    expect(planShards(files(800), {}, { maxShards: 4 }).shards).toHaveLength(4);
  });

  // The same run: shards split by file count took 181, 201, 181 and 298 s.
  it('balances runners by recorded time, not file count', () => {
    const tests = files(40);
    const timings: Record<string, number> = {};
    tests.forEach((t, i) => (timings[t] = i < 4 ? 120 : 5));
    const { shards, seconds } = planShards(tests, timings, { maxShards: 4 });
    expect(shards).toHaveLength(4);
    for (const s of shards) expect(s.filter((t) => timings[t] === 120)).toHaveLength(1);
    expect(Math.max(...seconds) - Math.min(...seconds)).toBeLessThanOrEqual(5);
  });

  it('puts every file on exactly one runner, and gives the same plan twice', () => {
    const tests = files(97);
    const timings = Object.fromEntries(tests.map((t, i) => [t, (i * 7919) % 13 + 0.5]));
    const a = planShards(tests, timings, { maxShards: 4 });
    expect(a.shards.flat().sort()).toEqual(tests);
    expect(planShards([...tests].reverse(), timings, { maxShards: 4 })).toEqual(a);
  });

  it('weighs a file with no recorded time at the median of the others', () => {
    const tests = files(22);
    const timings = Object.fromEntries(tests.slice(0, 21).map((t, i) => [t, i < 10 ? 1 : 9]));
    const { seconds } = planShards(tests, timings, { maxShards: 1 });
    expect(seconds[0]).toBe(Math.round(10 * 1 + 11 * 9 + 9 + 22 * FILE_OVERHEAD_SECONDS));
  });

  // Found trying it: with two tiny recorded times, their median weighed all
  // 770 files and the whole suite was planned onto one runner.
  it('does not take the median of a handful of times', () => {
    const tests = files(770);
    const { shards } = planShards(tests, { [tests[0]]: 0.01, [tests[1]]: 0.17 }, { maxShards: 4 });
    expect(shards).toHaveLength(4);
    expect(planShards(files(3), {}, { maxShards: 1 }).seconds[0]).toBe(
      Math.round(3 * (DEFAULT_FILE_SECONDS + FILE_OVERHEAD_SECONDS)),
    );
  });
});

describe('overlappingPaths', () => {
  it('finds a test path that vitest would also match inside another', () => {
    expect(
      overlappingPaths(['scripts/__tests__/a.test.ts', 'src/scripts/__tests__/a.test.ts', 'src/__tests__/b.test.ts']),
    ).toEqual([['scripts/__tests__/a.test.ts', 'src/scripts/__tests__/a.test.ts']]);
  });

  it('finds none among the real tests', () => {
    expect(overlappingPaths(listTests(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')))).toEqual([]);
  });
});

describe('timings', () => {
  it('reads a vitest JSON report into seconds per server-relative file', () => {
    const server = path.resolve('/repo/server');
    const report = {
      testResults: [
        { name: path.join(server, 'src', '__tests__', 'a.test.ts'), startTime: 1000, endTime: 4500 },
        { name: path.join(server, 'src', '__tests__', 'b.test.ts') },
      ],
    };
    expect(timingsFromReport(report, server)).toEqual({ 'src/__tests__/a.test.ts': 3.5 });
  });

  it('blends a new run into the old times and forgets deleted tests', () => {
    const merged = mergeTimings(
      { 'a.test.ts': 10, 'gone.test.ts': 4, 'b.test.ts': 2 },
      [{ 'a.test.ts': 20 }, { 'c.test.ts': 3 }],
      ['a.test.ts', 'b.test.ts', 'c.test.ts'],
    );
    expect(merged).toEqual({ 'a.test.ts': 15, 'b.test.ts': 2, 'c.test.ts': 3 });
  });
});
