# Load test, 500 users: results and perf-bug log

Run 2026-09-23 and 24 on a 6-logical-core Windows box that also ran Postgres 18 (default settings, `fsync` on) and the driver. Decisions and alternatives are in [ADR 0204](../notes/0204-the-load-test-found-the-database-doing-bookkeeping.md); how to run it is in [`docs/ops/load-test.md`](../ops/load-test.md). Compare runs against each other, not against a target: the production VM differs.

## The workload

500 users, 500 groups of five (every user in five), a personal chat each, 2,000 open SSE streams, mock mail delivered continuously, every user acting at once with an exponential think time. The mix: chat (30), bot turns (8), tasks (8 + 4 done), list items (6), saves (5), calendar add (6) and remove (3), cross-group reads (8), calendar view (4), chat open (6), app open (2), mail arrive + sync (8), mail browse (8), search (4). Four levels, mean think time per user: 20 s, 8 s, 3 s, 1 s. Then one group of 100 members, all listening.

"Before" is the original `main` (`1feb731`) with only the harness and its two hooks added. "After" is this branch. Same harness, same seeds.

## Before and after (p95 ms / mean ms)

| operation | 20 s: before | 20 s: after | 3 s: before | 3 s: after |
|---|---|---|---|---|
| ops/s served | 8.7 | 9.9 | 60.3 | 83.4 |
| chat message | 962 / 183 | 225 / 45 | 1,734 / 1,473 | 406 / 297 |
| task add | 1,061 / 175 | 136 / 37 | 3,608 / 3,119 | 729 / 574 |
| save add | 1,243 / 229 | 169 / 41 | 4,213 / 3,591 | 854 / 680 |
| event add (5 copies) | 1,318 / 299 | 274 / 63 | 4,561 / 4,036 | 1,573 / 1,251 |
| cross-group read | 629 / 120 | 48 / 12.5 | 2,349 / 1,881 | 469 / 326 |
| calendar view | 769 / 147 | 77 / 17 | 2,574 / 2,248 | 391 / 298 |
| mail threads list | 402 / 96 | 67 / 16 | 1,313 / 1,103 | 517 / 383 |
| mail sync | 9,709 / 5,142 | 5,753 / 3,934 | 40,498 / 19,663 | 21,571 / 10,686 |
| search | 814 / 133 | 289 / 73 | 3,845 / 3,152 | 1,921 / 1,490 |
| bot turn, start to done | 2,932 / 1,660 | 1,756 / 1,334 | 8,046 / 5,672 | 4,430 / 2,980 |

At 1 s think time (the most the rig can be made to do) the server serves 92 operations per second before and 125 after. The pool is the limit there and mail sync, search and bot turns are about as slow as before (mail sync p95 25.7 s vs 24.6 s).

Realistic load for 500 users is the 20 s and 8 s levels (10 to 40 operations per second); the heavier levels find the ceiling. Setup is unchanged in shape: first mail sync of 500 users at 40 at a time averages 13 to 14 s in both.

Every level ran with 0 errors, 2,000 SSE streams held and none dropped, RSS flat (about 500 to 600 MB over the run).

## The 100-member group

| | before | after |
|---|---|---|
| SSE deliveries for 8 event creations | 80,000 | 800 |
| event add, POST latency (mean) | 117 ms | 72 ms |
| event remove, POST latency (mean) | 185 ms | 100 ms |
| 10 task creations, POST latency (mean) | 86 ms | 29 ms |
| message reaching all 100 streams (mean) | 11 ms | 8.6 ms |

## Where the time was going

The database, not Node. Total database time per 60 s level equalled `DB_POOL_MAX` (10) times 60 s, so every connection was busy; requests waited on the pool (up to 488 waiting at 3 s think time before, 322 after). Node used 0.7 to 0.8 of its one core, 30 to 40% idle. A pool of 25 was worse.

Before the changes, one level's statements were dominated by: the session lookup (34,088), catch-up assignment inserts (10,631), Google events pulled and inserted (30,680, an artefact: see "harness bugs"), and per-thread classification writes. At 3 s think time, once the first fixes were in, mail sync was 6% of requests and 59% of all queries.

## Fixed (each with a regression test)

| # | bug | cost measured | commit |
|---|---|---|---|
| 1 | session looked up once per router, 19 mounts | 34,088 lookups for ~6,000 requests, 110 s of DB time in one level; a failed lookup hung the request | `804550b` |
| 2 | group fan-out: one insert per member, in sequence, in the request | 10,631 inserts; the largest single statement by DB time | `ffb55bc` |
| 3 | timezone read and zone validation on every message post | 5,600 reads per level; 1% CPU in `Intl` construction | `ffb55bc` |
| 4 | Google access token exchanged on every calendar call | 4,554 exchanges per level, each a round trip to Google | `9aaaf76` |
| 5 | concurrent fan-outs collided creating seed folders | `duplicate key catchup_folders_user_id_name_key`; one fan-out's assignment lost (a latent race in the old code) | `c14fc7d` |
| 6 | classification snapshot written a statement at a time | 18.9 updates + 18.9 inserts per sync at 19 threads; O(mailbox) per pass, holding the advisory lock | `02658a5` |
| 7 | classifier batch stamped a thread at a time | 3.3 updates per sync | `96c3d44` |
| 8 | blind-index lexeme: one HMAC per prefix per word | ~10% of server CPU under mail load; 7.9 ms per body | `6bd17c7` |
| 9 | event copies broadcast to the whole group | N² socket writes: 10,000 per event at 100 members | `112941d` |
| 10 | snooze wake was a second UPDATE per thread; attachment marks one UPDATE per message | ~7 and ~4 statements per sync | `88e574e` |
| 11 | timezone helpers built an `Intl.DateTimeFormat` per call | 79 µs vs 3.6 µs; ~5% of CPU | `08ff288` |
| 12 | `POST /me/email/sync` returned only after every AI pass; a second pull waited on the first's model calls | 2.3 to 2.4 s mean, 4.0 s p95 with a 0.5 s mock model (see below) | `b7a763b` (ADR 0205) |
| 13 | opening a thread awaited its one-time LLM check with no bound | the first open of every thread paid a full model call | `b7a763b` (ADR 0205) |

### Sync, measured on its own

The full 500-user run after this change (`i12`) is not reported: the machine was in use that morning (Teams at ~170% CPU, Search Indexer, OneDrive) and Postgres was twice as slow per query at the same load, so it says nothing about the code. The change was measured instead with a small mail-only load (20 users, mail arriving and syncing, 45 s), alternating the old and new code back to back in the same conditions:

| run | sync mean | p50 | p95 | queries in the request |
|---|---|---|---|---|
| new | 63 ms | 44 ms | 180 ms | 28 |
| old | 2,332 ms | 2,175 ms | 3,942 ms | 94 |
| new | 33 ms | 25 ms | 110 ms | 29 |
| old | 2,414 ms | 2,281 ms | 4,053 ms | 96 |

The AI passes still run, right after the response; the queries are the same, they are just no longer in the request. The cost is that new mail is briefly unsorted after a pull (ADR 0205).

## Harness bugs found on the way (not product bugs)

Kept here because two of them changed conclusions. The mock Gmail's "arrival" silently did nothing for the first runs, so the early baselines carried no mail-sync load (the same-workload baseline above is a re-run). The first fake Google shared one calendar between all users, so every user imported everyone's events (30,680 inserts). `maxConnections = 0` refuses every connection in Node. The driver process dies natively (exit `0xC0000409`, no message, no report) at random under load in roughly half of runs; `cycle.ts` reruns from a fresh database. Dropping the load database can fail while autovacuum is in it.

## Open: perf bugs found and not fixed

Ordered by what a user would feel.

1. ~~`POST /me/email/sync` returns only after the whole AI pipeline~~ and ~~opening a thread awaits an LLM call~~: fixed, see 12 and 13 above and ADR 0205. What remains of them is the trade they made: unsorted mail for a few seconds after a pull, and a phishing-shaped message can show without its caution for up to the model's latency past the 1.5 s wait.
2. **Mail sync still costs about 128 queries per sync** (about 28 of them inside the request now, the rest in the background passes), ~10 statements per new thread (`ensureThreadRow`, the insert, and five inside `recomputeThread`), plus the per-message attachment-parts select. The dominant scaling risk (classification being O(mailbox)) is fixed, but the classifier still rewrites the whole tree each pass; an incremental update of only the changed threads would make it O(new). A 90-day first backfill of ~2,000 threads is ~20,000 sequential statements inside one request.
3. **Node is the next ceiling.** At 83 ops/s it is at 0.73 of its single core, so on a faster database it saturates near 110 ops/s. The profile is flat now: socket writes (`writev`) 10 to 12%, Kysely query building ~10%, `pg` result parsing ~5%. The web/worker split (ADR 0172) is the lever; a second web instance needs the Redis SSE fan-out and the other single-process assumptions noted in `CLAUDE.md`.
4. **Repeated single-row reads on every request:** the session lookup (still the most-run statement, ~4% of DB time), `isMember` (about two per request), `ensurePersonalGroup` (one per bot turn, calendar pull and mail pass). Not cached on purpose (see ADR 0204); revisit with a request-scoped memo.
5. **`markGroupRead` runs an UPDATE and an SSE broadcast on every message post.** A per-(group, user) throttle would remove most of them.
6. **Per-member Google push on event create**: five members means five claims, five scope reads and five Google inserts per event. Inherent to per-owner copies (ADR 0040), but the scope read and the claim could share a statement.
7. **`LOG_LEVEL` defaults to `debug`**, which writes a line per request; the load runs used `info`. Not measured.
8. **Default Postgres settings** (128 MB `shared_buffers`, `synchronous_commit` on) on the rig; the transaction commit alone averaged 27 ms. Worth an A/B on the production VM: `LOAD_DB_SETTINGS=synchronous_commit=off` is supported by the harness.
9. **Not exercised:** the BullMQ paths (no Redis), real LLM and Google latency variance, WhatsApp/push publishers, attachments and file extraction, trips.

## Reproducing

```bash
cd server
npx tsx scripts/load/cycle.ts mine --users 500 --levels 20000,8000,3000,1000 --level-seconds 60 --profile-level 2 --mega 100
npx tsx scripts/load/compare.ts 3000 mine
```
