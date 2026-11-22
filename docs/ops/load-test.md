# Load test

`server/scripts/load/` drives the real server with hundreds of users at once and
says where the time goes. It is not the mock-LLM chat sim (`server/scripts/sim`,
`npm run sim`); that checks the bot picks the right tool. This one measures
throughput and latency across everything a family does: chat, bot turns, tasks,
list items, saves, calendar add and remove with fan-out to members, mail
arriving and syncing, mail browsing, search.

## What it runs

- The real web and worker roles (`scripts/load/server.ts`) on a **throwaway
  Postgres database** (`chord_perf`; the name must end in `_perf` or `_load`, and
  the script refuses anything else). `LOAD_FRESH=1` drops and recreates it.
- Everything outside the box is mocked **at a realistic round-trip time**, since
  zero latency measures only our own CPU and flatters anything that waits:
  - LLM: the mock provider with a first-token delay (700 ms), a completion delay
    (500 ms) and 20 ms per streamed word. `LOAD_LLM_FIRST_TOKEN_MS`,
    `LOAD_LLM_COMPLETE_MS`, `LOAD_LLM_WORD_MS`.
  - Google Calendar: an in-process fake behind `fetch` (`fake-google.ts`) with
    per-user calendars, sync tokens, tombstones and 80 ms per call
    (`LOAD_GOOGLE_LATENCY_MS`). The real two-way-sync code runs unmodified.
  - Gmail: the existing mock provider, plus delivery of new mail with a history
    record so an incremental sync finds it (`__pushGmailMockArrival`).
- Instrumentation wraps the app; nothing in `src/` is traced. The load server
  hands a Kysely `log` hook to `openDb` and mounts a `/__load` control plane the
  real server never has.

## Running it

From `server/`:

```bash
npx tsx scripts/load/cycle.ts <name> --users 500 --levels 20000,8000,3000,1000 --level-seconds 60 --profile-level 2 --mega 100
```

`cycle.ts` starts a fresh server, runs the driver (`run.ts`), stops the server
and summarises the CPU profile. Everything lands in `logs-load/<name>/`
(git-ignored). A level is a mean think time per user (ms); a smaller number is
more load. Setup (login, 500 groups of 5, 2,000 SSE streams, first mail sync) is
timed too. `--mega N` adds a phase with one group of N members all listening.

Pass server settings after `--`, e.g. `-- DB_POOL_MAX=20 LOG_LEVEL=debug`.

Then:

```bash
npx tsx scripts/load/compare.ts 3000 i1 i2        # same level, runs side by side
npx tsx scripts/load/show.ts logs-load/i2/level-2-think3000.json 20 25 "POST /api/v1/me/email/sync"
npx tsx scripts/load/analyze-profile.ts logs-load/i2/server.cpuprofile
```

`show.ts` prints per-route latency with **queries per request** and DB time per
request, the heaviest statements, and, for a route name you give, the statements
that route runs per request. A cheap route with a high queries-per-request is an
N+1.

## Reading the numbers

- **Client latency** (per operation, p50/p95/p99) is what a person feels.
- **`sse_fanout`** is a message's time to reach another member's open stream.
  **`bot_to_start`**, **`bot_to_first_token`**, **`bot_turn_total`** split a turn.
- **Pool waiting** > 0 with **event-loop lag** low means the database, not
  Node, is the limit. The pool total is the sum of query time / elapsed: when it
  equals `DB_POOL_MAX`, every connection is busy.
- **Cores busy** splits the box between the app server, the driver and everything
  else (mostly Postgres). The rig shares one machine among all three, as the
  production VM shares the app and Postgres.

## Caveats

- Numbers are for this rig (6 logical cores, default Postgres settings, Windows
  fsync), not the production VM. Compare runs against each other, not against
  a target.
- No Redis: the BullMQ paths (bot turns, mail sync, proactive scan) are not
  exercised; the in-process fallbacks are.
- The driver has crashed natively (exit `0xC0000409`) a few times at 500 users
  and is rerun; `cycle.ts` enables Node's fatal-error report for both processes.
