/**
 * Runs the concurrency scenarios against a running dev server and exits 1 if
 * any expectation failed. `npm run concurrency --workspace=server -- [name ...]`
 * runs the named scenarios, all of them by default (docs/ops/concurrency-tests.md).
 */
import { API } from '@chord/kernel';

import { BASE, Checks, type Scenario } from './harness.js';
import { chatSend } from './chat-send.js';
import { todoSync } from './todo-sync.js';

const SCENARIOS: Scenario[] = [todoSync, chatSend];

const wanted = process.argv.slice(2);
const unknown = wanted.filter((n) => !SCENARIOS.some((s) => s.name === n));
if (unknown.length) {
  console.error(`unknown scenario: ${unknown.join(', ')}. Known: ${SCENARIOS.map((s) => s.name).join(', ')}`);
  process.exit(2);
}

const health = await fetch(BASE + API.health).catch(() => null);
if (!health?.ok) {
  console.error(`no server at ${BASE} (start one with npm run dev:server, or set CHORD_BASE)`);
  process.exit(2);
}

const results: Checks[] = [];
for (const s of SCENARIOS.filter((x) => !wanted.length || wanted.includes(x.name))) {
  console.log(`\n${s.name}: ${s.about}`);
  const checks = new Checks(s.name);
  try {
    await s.run(checks);
  } catch (err) {
    checks.expect('scenario ran to the end', false, (err as Error).message);
  }
  results.push(checks);
}

console.log('');
for (const c of results) console.log(c.summary());
const failures = results.flatMap((c) => c.failures);
if (failures.length) {
  console.log(`\n${failures.length} failed:`);
  for (const f of failures) console.log(`  ${f}`);
  process.exit(1);
}
