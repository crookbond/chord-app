# 0178 — Bot turns on a BullMQ job queue

**Status**: accepted — implemented (Phase 5, last of the scaling effort
started by ADR 0170/0172/0174/0176 — deliberately done last as the
highest-risk phase)
**Date**: 2026-09-15

## Context

`reactToMessage` (`server/src/services/bot/bot.service.ts`) is the last piece
of AI work in this codebase with no concurrency bound. Bot turns are
fire-and-forget — the HTTP POST (or connector webhook) returns before the
turn runs — chained onto a per-`groupId` promise tail so same-group turns
stay ordered (ADR 0155), but nothing limits how many *different* groups' LLM
streams run at once. A burst of activity across many groups today launches
one concurrent LLM stream per group with no ceiling — unlike proactive scans
(ADR 0174) and mail sync (ADR 0176), which already moved onto BullMQ queues
with an explicit `concurrency` cap.

## Decision

`reactToMessage`'s tail hands each turn to a registered enqueuer when one
exists (`REDIS_URL` set), falling back to calling `runBotTurn` directly
otherwise — same `REDIS_URL`-gated pattern as every phase since ADR 0170.

- `bot.service.ts` gains `setBotTurnEnqueuer(fn | null)` — injected, not
  imported, mirroring ADR 0118's `setMailboxSyncRunner` / ADR 0176's
  `setMailSyncEnqueuer` exactly. `reactToMessage`'s tail chain is otherwise
  unchanged: `tail.then(() => runTurn(...))` where `runTurn` is the enqueuer
  when set, `runBotTurn` when not.
- New `server/src/services/bot/bot-turn.queue.ts`: `startBotTurnQueue(db,
  redisUrl)` runs a BullMQ `Worker` with `concurrency:
  BOT_TURN_QUEUE_CONCURRENCY` (default 8). The job payload carries only
  `{groupId, groupKind, messageId, tz, sourceBinding, chordVisible}` — ids
  and small fields, never the live `Message` row (BullMQ job data must be
  JSON-serializable) — and the processor re-fetches the trigger message by
  id before calling the **unchanged** `runBotTurn(db, message, group, tz,
  sourceBinding, chordVisible)`.

## Deviates from the original plan: the queue lives in the web role

The plan written before touching this code put the bot-turn queue in the
**worker role** (`roles/worker.ts`), alongside the proactive and mail-sync
queues — the whole framing was moving AI work off the process that serves
HTTP. Reading `bot.service.ts` and `roles/web.ts` first showed that's wrong
for this specific queue, for a reason neither of the other two queues run
into: a silent turn (`chordVisible: 0` — an IM-bridge reply) delivers via
`connectorRegistry.getForBinding(sourceBinding.platform,
sourceBinding.botUserId).send(...)` inside `runBotTurn`'s
`persistAndBroadcast`, and the connector registry is constructed **only** in
the web role (`roles/web.ts` — inbound webhooks need an HTTP endpoint only
that role serves; ADR 0172 already established this and left two of the four
`onBroadcast` consumers there for the identical reason). Running the bot-turn
worker in the worker-role process would silently break every silent
WhatsApp/Slack/Discord/Telegram reply the moment `REDIS_URL` was set — the
one path this migration cannot regress.

So `startBotTurnQueue` is called from `roles/web.ts`, not `roles/worker.ts`.
This is the same shape of deviation ADR 0172 already documented for
`startOutboundPublisher`/`startProposalResolutionNotifier` — a call site
decided by where the connector registry lives, not by which role's stated
theme better matches the work.

**What this phase actually buys**, given the worker stays co-located with
the enqueue call rather than moving to a separately-scalable tier:

- A real process-wide concurrency cap on simultaneous LLM streams
  (`BOT_TURN_QUEUE_CONCURRENCY`) — today's fallback has none.
- A queue seam that a future connector-registry split (letting bot-turn
  processing move to its own scalable tier) can relocate with no further
  change to `bot.service.ts` — `runBotTurn`'s signature is untouched, and the
  enqueuer indirection already exists.
- Job durability infrastructure (Redis-backed job storage) — but see below,
  this phase deliberately does **not** turn on the retry/redelivery half of
  that.

Splitting the connector registry out so bot-turn processing could move off
the web process entirely is real future work, not done here — same posture
as ADR 0172's own deferred item.

## Deliberately at-most-once, not at-least-once

BullMQ's `Worker` defaults to `maxStalledCount: 1` — verified against the
real installed `bullmq@6` types, not assumed (`worker-options.d.ts`): if a
worker dies mid-job, the stalled-job checker automatically moves the job back
to `wait` and a worker (possibly a different one) picks it up again, once,
independent of `attempts`. That default is wrong for this queue specifically:
a bot turn's tool calls run in ADR 0009 propose mode with no idempotency key
of their own, so redelivering a turn that crashed after inserting some
proposals but before finishing would rebuild the LLM context from scratch
(now including those very proposals as prior messages) and risks duplicating
them — a new failure mode today's direct-call fallback cannot produce, since
a mid-turn crash today just silently loses that reply and is never retried.

Rather than build the idempotency this would need (no small thing — every
proposal-creating tool would need a stable dedup key derived from the turn,
not just the group), this queue keeps today's at-most-once semantics
explicitly: `attempts: 1` (BullMQ's own default, stated for clarity) and
`maxStalledCount: 0` on the `Worker` — a stalled job goes straight to failed,
never redelivered. `lockDuration` (`BOT_TURN_QUEUE_LOCK_MS`, default 5
minutes) has to stay comfortably longer than the slowest realistic turn (up
to `MAX_ITERATIONS` = 20 LLM round-trips) as a direct consequence: with
redelivery off, a lock that expires while a turn is still legitimately
running would fail that turn outright instead of recovering it.

## Per-group ordering (ADR 0155) is unchanged, not reinvented

The original plan's Phase 5 text proposed a non-blocking
`pg_try_advisory_lock` at the top of the processor, with re-enqueue-on-delay
for a contended group — needed if the queue's worker could run on a
different node than the one holding the in-memory `groupTurnTails` map.
Since this queue's worker runs in the **same process** as every
`reactToMessage` call (the web role, pinned to one instance — ADR 0172),
there is no cross-process gap to guard against today: `groupTurnTails`
already provides the correctness guarantee, unchanged, because the tail
promise for a group doesn't advance until `enqueue()` resolves, and
`enqueue()` doesn't resolve until the queued job actually finishes
(`job.waitUntilFinished(queueEvents)`). Two same-group turns still can never
run concurrently through this queue, exactly as before.

Building the advisory-lock/re-enqueue mechanism now, with nothing to
exercise it against, was rejected on this codebase's own established
discipline (see ADR 0174/0176's verification sections): lock behavior gets
verified against real infrastructure before being trusted, and there is no
real multi-node scenario to verify against until the web role actually scales
past one instance or the connector registry is split out. Documented here as
the concrete follow-up once either of those happens — not silently dropped.

## Verification

- **BullMQ's default stalled-job redelivery, and the effect of turning it
  off, were checked against a real Redis, not assumed** (`redis-memory-server`,
  installed `--no-save`, never committed): a throwaway worker configured with
  `attempts: 1, maxStalledCount: 0` whose processor always threw was invoked
  exactly once (not retried), and `job.waitUntilFinished` correctly rejected
  rather than hanging or silently resolving.
- **The full path was run end-to-end against a real Redis and a real,
  migrated Postgres test database with the mock LLM provider**: a message
  posted through `reactToMessage` with a bot-turn enqueuer registered
  reached the queue, was picked up by a real `Worker`, ran `runBotTurn`
  against the real DB, executed a tool call (`add_list_item`), and persisted
  both the resulting list row and the bot's reply message — the identical
  outcome the ADR 0155 in-process test already asserts, now proven through
  the queue instead of a direct call.
- `server/src/services/bot/__tests__/bot-turn-enqueuer.test.ts` (committed):
  pins the injection point itself, mirroring the split already established
  for `mirror-sweep.integration.test.ts`'s `mailSyncEnqueuer` tests — a
  registered enqueuer receives the turn instead of running it inline;
  clearing it restores the direct-call fallback; same-group turns still
  serialize strictly through the enqueuer (no overlap, verified with an
  artificially slow mock enqueuer and an in-flight counter); different-group
  turns still run concurrently through it.
- Full server test suite passes.

## Alternatives considered

- **Put the queue in the worker role, per the original plan** — rejected
  once `runBotTurn`'s silent-turn delivery path was read: it needs the
  connector registry, which only exists in the web role. Doing this anyway
  would have shipped a regression the moment `REDIS_URL` was set in
  production.
- **Split the connector registry out now so bot-turn processing could move
  to a real worker tier** — rejected as out of scope: a bigger design pass
  (ADR 0172 already deferred exactly this for its two web-role-pinned
  `onBroadcast` consumers), not something to fold into what was scoped as
  "add a queue in front of an unchanged function."
- **Build the cross-process advisory-lock/re-enqueue mechanism from the
  original plan now, even with only one instance to run it on** — rejected:
  nothing to verify it against, and this codebase's whole pattern this
  migration has followed is verifying locking behavior against real
  infrastructure rather than trusting an untested guess (ADR 0174's own
  advisory-lock test was rewritten once after a first design turned out
  wrong under real timing).
- **Let BullMQ's default stalled-job redelivery run** — rejected once the
  propose-mode duplicate-proposal risk was identified; at-most-once matches
  what this codebase already has today and needs no new idempotency
  machinery to stay correct.
- **Give every proposal-creating tool a turn-scoped idempotency key so
  redelivery would be safe** — a real, larger fix that would make
  at-least-once semantics viable; out of scope for this migration, which was
  bounded to "add the queue," not "redesign propose-mode idempotency."
