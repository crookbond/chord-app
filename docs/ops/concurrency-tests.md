# Concurrency tests

Two kinds of test check what happens when several writers change the same
thing at the same moment: two people in one family, or one person on two
devices.

| | Where | Runs | What it shows |
|---|---|---|---|
| Server-suite tests | `server/src/routes/__tests__/*-concurrency.integration.test.ts` | `npm test`, CI | The rule holds when requests truly overlap |
| Live scenarios | `server/scripts/concurrency/` | by hand, against a dev server | The rule holds at real gaps between sends (0, 2, 10, 50, 250 ms) |

## Server-suite tests

The database handle from `openTestDb()` has ONE connection, so requests in a
test take turns and two writes can never overlap: a race test written on it
passes whether or not the race is fixed. Build the test's app on
`openParallelHandle(db)` (`server/src/__test-helpers__/db.ts`) instead, send
with `Promise.all`, and close it with `closeParallelHandle` before
`closeTestDb`. Read results through the ordinary `db`.

Write each assertion so it holds whichever request the server takes first
(for example "one applied, one conflict", not "the first applied"). Never
sleep a guessed number of milliseconds.

A race is timing-dependent, so check the test against the code without the
fix more than once: `todo-sync-concurrency` failed 4 runs out of 5 without the
`addItem` lock.

## Live scenarios

Start a dev server with rate limiting off (the scenarios send hundreds of
requests in seconds), then run the scenarios from `server/`:

```bash
RATE_LIMIT_ENABLED=false npm run dev:server
```

```bash
npm run concurrency --workspace=server
```

`npm run concurrency --workspace=server -- todo-sync` runs one scenario.
`CHORD_BASE` points at another server (default `http://127.0.0.1:4000`). It
needs `AUTH_MODE=dev`: users sign in by name, and signing in twice with one
name gives the same person two sessions, as two devices. Every scenario makes
its own group and deletes it at the end. The run prints one line per check and
exits 1 if any failed.

| Scenario | Checks |
|---|---|
| `todo-sync` | Both people and both devices, at every gap: rename one item (one kept, the other asked), tick one item (done once), tick + rename (both land), rename vs delete (never deleted over an unseen rename), add the same item (one item), due date + title (both land), done vs dropped (one kept, the other asked), add the same to-do (two: app creates are not folded, ADR 0095). Then 20 renames at once (one kept), 20 unticks (all applied), one create sent 10 times with one key (one to-do) |
| `chat-send` | One message retried 10 times with one key (posted once); two people and two devices posting together (both land once) |

## Adding a scenario

A change to a write path that two people or two devices can reach at once
gets both:

1. a file in `server/scripts/concurrency/` exporting a `Scenario`
   (`harness.ts`: `signIn`, `call`, `pair(gapMs, a, b)`, `together(n, fn)`,
   `Checks.expect`), added to the list in `run.ts`;
2. an overlap test on `openParallelHandle` for the case that matters most.

## What they have found

- 2026-10-31: two adds of the same list item at once made two items.
  `addItem` looked for a match and then inserted, with no lock; it now takes
  the same advisory lock as `resolveOrCreateListByName` (ADR 0165), keyed on
  the list and the item's normalised text.
