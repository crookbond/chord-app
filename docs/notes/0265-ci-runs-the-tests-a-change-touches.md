# 0265 — CI runs the tests a change touches

**Status:** Accepted, 2026-10-18

## Context

Every PR ran the whole server suite (482 files, about 12 minutes of tests
inside a 15-minute job). Runs were being cut off at the limit with every
test passing, and most of each run tested code the change never touched.

The obvious tool, `vitest --changed`, follows imports from the changed files
to the tests that reach them. Measured here it is no help: a one-line change
to one kernel file selected 402 of 475 test files, because every test reaches
kernel through its single index file and most server modules through the app
setup.

## Decision

Lint, typecheck and build run on every change. The server tests run only for
what the change touches, picked by `server/scripts/ci/select-tests.mjs`:

- a changed test runs;
- a changed server or kernel file runs the tests **named after** it, anywhere
  (`compose-reply.service.ts` → `compose-reply.integration.test.ts`,
  `compose-reply-asked-day.integration.test.ts`); when no test carries its
  name, the tests **next to** it (its folder's `__tests__/`) run instead;
- mobile and docs changes run no tests (typecheck covers mobile);
- the two tests that scan the whole codebase rather than importing it
  (`one-key-chooser`, `signature`) always run;
- a change to something every test reads without importing it (the lockfile,
  a `package.json`, the vitest config, `server/tsconfig.json`, the test
  helpers, `example.env`, the CI workflow) runs the whole suite.

The **whole suite** runs when asked: the `full-ci` label on a PR, or "Run
workflow" on the Actions tab. Pushes to main use the same selection, diffed
against the previous main commit. The job limit is raised to 30 minutes so a
full run fits.

For the tldr change (#81) this picks 28 of 482 files; for the category-walk
change (#83), the one test named after its kernel file plus the two guards.

## Consequences

- A change can break a test it is not named after, and CI will not see it
  until a full run. Typecheck catches the type-level part of that; the rest
  is the trade the owner chose. Add `full-ci` to a PR that touches shared
  code (schema, migrations, a widely used service).
- A short, common file name (`email.ts`, `index.ts`) matches many tests by
  name. That errs toward running more.
- Adding a label other than `full-ci` does not cancel or start a run.

## Rejected

- `vitest --changed` (selects nearly everything here, see above).
- Keeping the whole suite on every PR with a longer limit (the owner's call:
  run what the change needs unless asked).
- A nightly full run (not asked for; easy to add as a `schedule:` trigger).

## Addendum 2026-11-18: runners split by recorded time, picked subsets too

Measured over the last 40 runs: PRs took 2-6 min and main pushes 2-9 min. The
slowest runs were not the full suite. A change to shared code picked 150-300
of the 770 files, and a picked subset always ran on ONE runner: 299 files took
477 s, 247 files 380 s, longer than the whole suite takes on four (~4-5 min).
The full suite's four shards were uneven too, because `vitest --shard` splits
by file, not by time: one run's shards took 181, 201, 181 and 298 s.

Now both go through one planner, `server/scripts/ci/test-shards.mjs`:

- Each file is weighed by how long it took on main's last runs (vitest's JSON
  report, plus 0.5 s for imports and setup the report does not time). A file
  with no time yet is weighed at the median, or 2.4 s while fewer than 20
  files have a time; one run with two tiny times once planned the whole suite
  onto one runner.
- Runners = recorded seconds / 180, at least 1, at most 4 (`MAX_SHARDS`). A
  runner costs ~45 s before its first test, so a small subset stays on one.
- Files go longest first onto the least loaded runner; each runner gets its
  file list from the `pick` job and runs them in ONE vitest call (an empty
  list exits rather than running the whole suite).
- Each runner uploads its times; the `timings` job (main only, since a PR's
  cache is visible to that PR alone) blends them half-and-half into the
  stored times, drops deleted tests, and saves a new Actions cache entry.
  `pick` restores the newest entry, which PRs can read.
- The planner refuses to run if one test path is contained in another
  (vitest matches a file argument as a substring, so that file would also
  run on another runner).

Not changed: lint, typecheck and build still run one after another in the
checks job (~2 min); splitting them saves ~1 min only when the tests are
small, and each job pays setup again.
