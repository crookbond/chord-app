// Tiny e2e runner: discovers every *.test.js suite here, runs each, prints a
// PASS/FAIL line per check, and exits non-zero if anything failed (CI-friendly).
// No test framework on purpose — these drive a real browser over the dev stack.

const fs = require('fs');
const path = require('path');

(async () => {
  const suites = fs
    .readdirSync(__dirname)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => require('./' + f));

  if (suites.length === 0) {
    console.error('no *.test.js suites found in e2e/');
    process.exit(1);
  }

  const results = [];
  const checkFor = (suite) => async (name, fn) => {
    try {
      await fn();
      results.push({ suite, name, ok: true });
      console.log(`  PASS  ${name}`);
    } catch (e) {
      results.push({ suite, name, ok: false, err: e.message });
      console.log(`  FAIL  ${name} — ${e.message}`);
    }
  };

  for (const suite of suites) {
    console.log(`\n# ${suite.name}`);
    try {
      await suite.run(checkFor(suite.name));
    } catch (e) {
      results.push({ suite: suite.name, name: '(suite crashed)', ok: false, err: e.message });
      console.log(`  FAIL  (suite crashed) — ${e.message}`);
    }
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n=== ${passed}/${results.length} checks passed ===`);
  fs.mkdirSync(path.join(__dirname, 'shots'), { recursive: true });
  fs.writeFileSync(
    path.join(__dirname, 'shots', 'results.json'),
    JSON.stringify(results, null, 2),
  );
  process.exit(results.length > 0 && results.every((r) => r.ok) ? 0 : 1);
})().catch((e) => {
  console.error('runner crashed:', e);
  process.exit(1);
});
