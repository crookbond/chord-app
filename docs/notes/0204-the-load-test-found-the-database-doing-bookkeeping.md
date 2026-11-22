# 0204 - The load test found the database doing bookkeeping

**Status**: accepted
**Date**: 2026-09-24

Reads with [`docs/ops/load-test.md`](../ops/load-test.md) (how to run it) and [`docs/perf/2026-09-24-load-test-500-users.md`](../perf/2026-09-24-load-test-500-users.md) (numbers, and the open items).

## Context

Nothing had ever measured the server with more than a handful of users. A harness (`server/scripts/load`) now runs 500 users in 500 groups of five, all acting at once, against the real web and worker roles on a throwaway database, with the LLM, Google Calendar and Gmail mocked at realistic round-trip times. What it found was not one slow thing. The database was the limit, and most of what it was busy with was per-request bookkeeping rather than the work being asked for: total database time per 60 s level equalled ten pool connections times sixty seconds, so every connection was busy, and Node itself sat at 0.7 of one core.

## Decisions

Each is a change to how something is done, not to what it does, and each has a test that fails on the old code.

- **The session is looked up once per request.** Nineteen routers each mounted `loadSession`, and a router-level `use` runs for every request reaching the router whether or not a route in it matches, so a request answered by the Nth router paid N lookups first (34,088 lookups for about 6,000 requests). Later mounts now pass through. A failed lookup is also passed to `next(err)`: Express 4 does not catch a rejected async middleware, so it used to hang the request.
- **A group fan-out is written in one statement.** Catch-up assignments were one INSERT per member, awaited in sequence, after two selects over the same folder rows. Members whose folder simply resolves are now one multi-row insert; a member who needs a side effect (an archived folder to revive, a suggested name that may tip a promotion) still takes the per-member path and lands where it always did. Seed-folder creation skips on conflict and re-reads, because two fan-outs for one member can run at once and the plain insert used to fail the whole assignment.
- **A classification snapshot is written in chunks.** The classifier's snapshot carries the whole mailbox forward, so its size is every thread the user has. It was written as an insert and an update per thread inside a transaction holding the per-user advisory lock. It is now 500-row multi-row inserts and a set-based `UPDATE ... FROM (VALUES ...)`. The batch stamp after a pass is one update per verdict instead of one per thread.
- **A Google access token is reused for up to ten minutes.** Every calendar push, pull and refresh exchanged the refresh token again (4,554 exchanges in one level). The cap is far below the token's hour on purpose: a revoked token keeps working until it lapses, and the sooner it does the sooner `invalid_grant` asks the user to reconnect. The cache is dropped when the refresh token or its scopes change, since a token carries the scopes it was minted with.
- **A member's event copy goes only to that member.** A group event fans out into one copy per member (ADR 0040), each tagged with its owner, and each was broadcast to the whole group channel: N members meant N broadcasts written to N sockets, 10,000 writes for one event in a 100-member group. The hub now delivers an owner-tagged `event.created` / `updated` / `deleted` only to that owner's streams (subscribers carry their user id). The mobile client already acted only on the copy it owned and refreshed its list for the rest, so this also removes N refresh triggers per client. `onBroadcast` listeners still see every copy.
- **The timezone helpers reuse a formatter per zone.** `toLocaleString('sv-SE', { timeZone })` builds an `Intl.DateTimeFormat` on every call, 79 microseconds against 3.6 for a reused one. `svWall` returns the same string, including the `RangeError` for an unknown zone and `'Invalid Date'` for an invalid date, pinned over twelve zones and thirteen instants around DST changes. `recordUserTimezone` remembers the zone it last saw stored per user, so the zone the client reports with every message costs no read.
- **Blind-index lexemes are memoised.** A lexeme is a pure function of (key, kind, value) and one message asks for thousands (every word contributes one per prefix, 3 to 12 characters). Indexing a ~350-word body went from 7.9 ms to 1.5 ms; it had been about 10% of server CPU under mail load, because the index is maintained on every write even with encryption off. Entries are scoped to the key instance, so two owners can never share a lexeme through it.
- **Two more per-row statements became per-batch:** the snooze wake is a `CASE` inside the thread update that was already being made, and an attachment-import batch is marked with one update.

## Alternatives considered

- **A larger pool.** `DB_POOL_MAX=25` was measured and was worse (99.6 vs 127 ops/s, 58% more database time for the same work): Postgres is the ceiling on the rig and shares its cores with the app, so more connections only add contention. Ten stays. (Production is Linux on an SSD and will differ; measure there before changing it.)
- **Caching the session lookup or `isMember`.** They are the two most repeated statements, but both are authorisation decisions, and a short TTL means a revoked session or a removed member still passes for that long. Fixing the 19-fold repetition removed most of the cost without that trade; what is left (about 4% of database time) does not justify it.
- **Caching the personal-group id per user.** A shadow merge or an Apple fold deletes or moves that group, so a stale entry would point at a group that no longer exists.
- **Prepared-state HMAC (inner/outer hashes) instead of a memo.** Benchmarked: slower than `createHmac` (5.0 vs 3.8 microseconds), because two hash copies cost more than the key schedule they avoid.
- **Fixing `recomputeThread` and the rest of the per-message sync path.** About ten statements per new thread remain. Batching them across threads is a rewrite of `gmail.service.ts`'s core with real risk, for a cost that only matters at first backfill. Listed in the findings, not done.
- **Moving the AI passes out of the sync request, and out of thread-open.** The single largest remaining latency, and a product decision (the client waited for classification and expected the tiles fresh). Not changed in this ADR's change; the owner then chose to make it, in [0205](./0205-a-sync-returns-the-mail-and-the-ai-follows.md).

## Consequences

- At a workload equal to about ten to forty operations per second across 500 users, chat p95 fell from 962 ms to 225 ms and task, save and hub reads from 0.6 to 1.3 s down to 0.05 to 0.2 s. At 60 versus 83 operations per second served, chat p95 fell from 1.7 s to 0.4 s. The most the rig served moved from 92 to 125 operations per second. At the heaviest level (think time 1 s) more operations get through but mail sync, search and bot turns are about as slow as before, because the pool is still the wall there.
- The event-copy change is the only one that alters what a client receives. A client that wanted other members' copies over the group stream would no longer get them. None does today; a new one needs its own channel.
- Token reuse means a token revoked at Google keeps working for up to ten minutes.
- The harness and its instrumentation live in `server/scripts/load`; `src/` carries two hooks (`openDb({ log })`, and the Gmail mock's arrival helper), and no tracing.

## Addendum 2026-10-23: Outlook and secondary Gmail reuse their tokens too

The reuse above covered only the primary Google account. Outlook (`getOutlookAccessToken`) and secondary Gmail mailboxes (`refreshAccessTokenWith`) still exchanged the refresh token on every call. In prod an Outlook email took about 300 ms to open on the server against 17 ms for primary Gmail, because each open began with a round trip to Microsoft, and the 5-minute Outlook sync did the same (353 exchanges that day). Reopening the same email three times in a second cost about 290 ms each time.

Both now go through `utils/access-token-cache.ts`, with the same caps (at most 10 minutes, a minute short of the stated expiry). The key is the mailbox plus a hash of the refresh token itself, not the mailbox alone: a reconnect stores a new refresh token and so misses without an invalidation hook, and when Microsoft rotates the refresh token, the new access token is filed under the rotated one as well, so the next call (which reads the resealed row) still hits. Callers that miss at the same moment share one exchange. A token with no stated lifetime, or a failed exchange, is not kept. The same consequence applies: a token revoked at Microsoft keeps working for up to ten minutes.
