#!/usr/bin/env node
/**
 * Which server tests CI runs for a change (ADR 0265). Prints one test path
 * per line, relative to `server/`, or the single word ALL.
 *
 *   node server/scripts/ci/select-tests.mjs <base-ref>
 *
 * A changed test runs. A changed source file runs the tests NAMED after it
 * (anywhere: `email-quote.ts` -> `email-quote.test.ts`,
 * `email-quote-folding.integration.test.ts`); when no test carries its name,
 * the tests NEXT to it (its folder's `__tests__/`) run instead. Mobile has no
 * tests; its typecheck covers it. The codebase-scan guards always run.
 * A change to anything every test depends on without importing it runs ALL.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Tests that read the whole codebase rather than importing it. */
export const ALWAYS = [
  'src/services/llm/__tests__/one-key-chooser.test.ts',
  'src/services/email/__tests__/signature.test.ts',
  'src/__tests__/mobile-theme-colours.test.ts',
  // ADR 0300 — reads docs/ops/skills/examples; any tool change can break one.
  'src/services/bot/skills/__tests__/definition.test.ts',
];

/** Read by every test without being imported by one. Repo-relative. */
const RUN_ALL = [
  /^package(-lock)?\.json$/,
  /^server\/package\.json$/,
  /^server\/vitest(\.[a-z]+)?\.config\.ts$/,
  /^server\/tsconfig\.json$/,
  /^server\/src\/__test-helpers__\//,
  /^example\.env$/,
  /^\.github\/workflows\//,
];

const isTest = (p) => /\.test\.ts$/.test(p) && !/perf[^/]*\.test\.ts$/.test(p);

/** `src/a/b.integration.test.ts` -> `b`; `src/a/b.ts` -> `b`. */
const stem = (p) => p.split('/').pop().replace(/(\.[a-z]+)*\.(test\.)?[cm]?[jt]sx?$/, '');

/**
 * @param {string[]} changed repo-relative paths (forward slashes), deleted files left out
 * @param {string[]} everyTest server-relative test paths
 * @returns {'ALL' | string[]}
 */
export function selectTests(changed, everyTest) {
  if (changed.some((p) => RUN_ALL.some((re) => re.test(p)))) return 'ALL';
  const allTests = everyTest.filter(isTest);
  const out = new Set(ALWAYS);
  for (const p of changed) {
    const inServer = p.startsWith('server/') ? p.slice('server/'.length) : null;
    if (inServer && isTest(inServer)) {
      out.add(inServer);
      continue;
    }
    if (!/^(server|kernel)\/.*\.[cm]?[jt]sx?$/.test(p)) continue;
    const name = stem(p);
    const named = allTests.filter((t) => {
      const s = stem(t);
      return s === name || s.startsWith(`${name}-`);
    });
    if (named.length > 0) {
      for (const t of named) out.add(t);
      continue;
    }
    if (inServer) {
      const folder = `${inServer.slice(0, inServer.lastIndexOf('/'))}/__tests__/`;
      for (const t of allTests) if (t.startsWith(folder)) out.add(t);
    }
  }
  return [...out].filter((t) => allTests.includes(t)).sort();
}

/** Every test file `npm test` runs, server-relative (the vitest config's include/exclude). */
export function listTests(serverDir) {
  const found = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (isTest(e.name) && full.includes(`${sep}__tests__${sep}`)) {
        found.push(relative(serverDir, full).split(sep).join('/'));
      }
    }
  };
  for (const top of ['src', 'scripts']) walk(join(serverDir, top));
  return found;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const base = process.argv[2];
  if (!base) {
    console.error('usage: select-tests.mjs <base-ref>');
    process.exit(2);
  }
  const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const repo = join(serverDir, '..');
  const changed = execFileSync('git', ['diff', '--name-only', '--diff-filter=d', base, 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
  })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const picked = selectTests(changed, listTests(serverDir));
  process.stdout.write(picked === 'ALL' ? 'ALL\n' : `${picked.join('\n')}\n`);
}
