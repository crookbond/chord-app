#!/usr/bin/env node
/**
 * Splits the server tests CI runs over runners by how long each file took
 * last time (ADR 0265 addendum). Plain node with builtins only: the `pick`
 * job runs it before any `npm ci`.
 *
 *   node test-shards.mjs plan <tests.txt> <timings.json> <maxShards>
 *       tests.txt is select-tests.mjs's output (paths, or the word ALL).
 *       Prints one line of JSON: {"count":N,"plan":{"1":[...],...}}.
 *   node test-shards.mjs record <vitest-report.json> <out.json>
 *       Vitest's JSON report -> {"<server-relative path>": seconds}.
 *   node test-shards.mjs merge <old.json> <dir of new *.json> <out.json>
 *       Old times blended with this run's; files that no longer exist dropped.
 *
 * Times are a file's seconds on a worker, measured with 2 workers per runner,
 * so a runner's wall time is roughly its files' total over 2.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listTests } from './select-tests.mjs';

/** A runner costs ~45 s before the first test (checkout, cache, Postgres, setup),
 * so another one is added only for this much more test time (~90 s of wall). */
export const TARGET_SECONDS_PER_SHARD = 180;
/** For a file with no recorded time yet, until enough files have one to take their median. */
export const DEFAULT_FILE_SECONDS = 2.4;
const MIN_KNOWN_FOR_MEDIAN = 20;
/** Vitest's report times a file's tests, not its imports and setup; this stands in for those. */
export const FILE_OVERHEAD_SECONDS = 0.5;

/**
 * @param {string[]} tests server-relative test paths
 * @param {Record<string, number>} timings
 * @param {{ maxShards: number, targetSeconds?: number }} opts
 * @returns {{ shards: string[][], seconds: number[] }}
 */
export function planShards(tests, timings, { maxShards, targetSeconds = TARGET_SECONDS_PER_SHARD }) {
  const known = Object.values(timings).filter((s) => Number.isFinite(s) && s > 0).sort((a, b) => a - b);
  const fallback =
    known.length >= MIN_KNOWN_FOR_MEDIAN ? known[Math.floor(known.length / 2)] : DEFAULT_FILE_SECONDS;
  const weighed = [...new Set(tests)].map((file) => {
    const t = timings[file];
    return { file, seconds: (Number.isFinite(t) && t > 0 ? t : fallback) + FILE_OVERHEAD_SECONDS };
  });
  const total = weighed.reduce((sum, w) => sum + w.seconds, 0);
  const count = Math.max(1, Math.min(maxShards, weighed.length, Math.ceil(total / targetSeconds)));
  // Longest first onto the least loaded runner. Name breaks ties so a plan is repeatable.
  weighed.sort((a, b) => b.seconds - a.seconds || (a.file < b.file ? -1 : 1));
  const shards = Array.from({ length: count }, () => []);
  const seconds = Array.from({ length: count }, () => 0);
  for (const w of weighed) {
    let least = 0;
    for (let i = 1; i < count; i++) if (seconds[i] < seconds[least]) least = i;
    shards[least].push(w.file);
    seconds[least] += w.seconds;
  }
  for (const s of shards) s.sort();
  return { shards, seconds: seconds.map((s) => Math.round(s)) };
}

/**
 * Vitest matches a CLI file argument as a substring of a path, so one test's
 * path inside another's would run that other test on this runner as well.
 * @param {string[]} tests
 * @returns {[string, string][]}
 */
export function overlappingPaths(tests) {
  const out = [];
  for (const a of tests) for (const b of tests) if (a !== b && b.includes(a)) out.push([a, b]);
  return out;
}

/**
 * @param {{ testResults?: { name: string, startTime?: number, endTime?: number }[] }} report
 * @param {string} serverDir
 * @returns {Record<string, number>}
 */
export function timingsFromReport(report, serverDir) {
  const out = {};
  for (const r of report.testResults ?? []) {
    if (!Number.isFinite(r.startTime) || !Number.isFinite(r.endTime)) continue;
    const file = relative(serverDir, r.name).split(sep).join('/');
    out[file] = Math.round(Math.max(0.01, (r.endTime - r.startTime) / 1000) * 100) / 100;
  }
  return out;
}

/**
 * Blends this run's times into the stored ones (half each, so one slow run
 * moves a file but does not decide it) and drops files that no longer exist.
 * @param {Record<string, number>} old
 * @param {Record<string, number>[]} fresh
 * @param {string[]} existing
 */
export function mergeTimings(old, fresh, existing) {
  const keep = new Set(existing);
  const out = {};
  for (const [file, s] of Object.entries(old)) if (keep.has(file)) out[file] = s;
  for (const run of fresh) {
    for (const [file, s] of Object.entries(run)) {
      if (!keep.has(file)) continue;
      out[file] = file in out ? Math.round(((out[file] + s) / 2) * 100) / 100 : s;
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

const readJson = (path) => {
  if (!path || !existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'plan') {
    const [testsFile, timingsFile, max] = args;
    const lines = readFileSync(testsFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    const all = listTests(serverDir);
    const tests = lines[0] === 'ALL' ? all : lines;
    const clash = overlappingPaths(all);
    if (clash.length > 0) {
      console.error(`test paths inside other test paths (vitest would run both): ${JSON.stringify(clash)}`);
      process.exit(1);
    }
    const timings = readJson(timingsFile);
    const { shards, seconds } = planShards(tests, timings, { maxShards: Number(max) || 1 });
    const timed = tests.filter((t) => t in timings).length;
    console.error(`${tests.length} test files (${timed} with a recorded time) over ${shards.length} runner(s)`);
    shards.forEach((s, i) => console.error(`  shard ${i + 1}: ${s.length} files, ~${seconds[i]} s of test time`));
    const plan = Object.fromEntries(shards.map((s, i) => [String(i + 1), s]));
    process.stdout.write(`${JSON.stringify({ count: shards.length, plan })}\n`);
  } else if (cmd === 'record') {
    const [reportFile, out] = args;
    writeFileSync(out, `${JSON.stringify(timingsFromReport(readJson(reportFile), serverDir))}\n`);
  } else if (cmd === 'merge') {
    const [oldFile, dir, out] = args;
    const fresh = existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(join(dir, f)))
      : [];
    const merged = mergeTimings(readJson(oldFile), fresh, listTests(serverDir));
    writeFileSync(out, `${JSON.stringify(merged, null, 1)}\n`);
    console.error(`${Object.keys(merged).length} test files with a recorded time`);
  } else {
    console.error('usage: test-shards.mjs plan|record|merge ...');
    process.exit(2);
  }
}
