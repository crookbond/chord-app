# 0172 — Web/worker process split

**Status**: accepted — implemented (Phase 2 of the scaling effort started by ADR 0170)
**Date**: 2026-09-15

## Context

ADR 0170 gave `sseHub` a Redis pub/sub adapter so a broadcast can reach
subscribers on another Node process. That fixes the *transport* problem,
but it doesn't by itself make the app safe to run on more than one process:
`server.ts` also starts four things that assume they are the only copy of
themselves running anywhere —

- The four `sseHub.onBroadcast` consumers (`startPushPublisher`,
  `startTodosMirror`, and, inside the connector registry,
  `startOutboundPublisher` / `startProposalResolutionNotifier`) each do a
  side-effecting external call (an Expo push, an outbound IM send, a
  proposal-button edit) with no idempotency key. If two processes both ran
  them, every event would fire twice with no way to dedup.
- `startProactiveScheduler`'s `setInterval` loop has no cross-process claim
  over `proactive_messages` rows — two processes would race to send the
  same nudge/briefing.
- `startImapIdle`'s live `ImapFlow` sockets are held only in that process's
  memory, with no ownership lease in Postgres — two processes would each
  open their own IDLE connection to the same mailbox, re-triggering the
  exact IMAP-login-rate problem ADR 0080 fixed.

So before any of this can run on more than one instance, the pieces that
assume singleton-ness need to be separated from the pieces that should
scale horizontally (the HTTP API).

## Decision

Split `server.ts` into two roles, each its own process in production:

- **Web role** (`entrypoints/web.ts` → `roles/web.ts`): the HTTP API —
  every route, including the message POST that fire-and-forgets a bot
  turn — plus the SSE subscribe endpoints. Horizontally scalable to N
  instances later; pinned to one today (this phase only creates the seam).
- **Worker role** (`entrypoints/worker.ts` → `roles/worker.ts`): the
  proactive scheduler, mail sync (sweep, push-webhook renewal, IMAP IDLE),
  the outbox scheduler, and two of the four `onBroadcast` consumers
  (`startPushPublisher`, `startTodosMirror`). Pinned to exactly one
  instance — nothing here coordinates across processes yet.
- **`server.ts` becomes a thin dev/CI/sim-only composed entrypoint** that
  calls both `startWebRole()` and `startWorkerRole()` against one shared
  `db` handle in one process — `npm run dev`, `npm run sim`, and vitest
  need no changes to how they invoke the server.
- Production runs `chord.service` (web) and `chord-worker.service`
  (worker) as two systemd units on the same VM, both rendered from
  `scripts/deploy/deploy.sh`'s existing `DATA_DIR`/`LOGS_DIR` variables so
  they can't drift from each other.
- `applyMigrations` gains a session-scoped `pg_advisory_lock` around its
  whole run: two processes now call it concurrently at boot, and without
  the lock a race on a fresh/unmigrated database would have both readers
  see an empty `_migrations` table and both try to insert the same row,
  the loser crashing on the table's unique constraint. `_xact_` isn't used
  here (unlike ADR 0165/0106's locks) because the run spans many
  independent statements, not one transaction.
- `DB_POOL_MAX` (default 10, unchanged) makes the per-process Postgres
  pool size configurable, since total connections against Postgres is now
  (number of running processes) × this value — the code comment in
  `db/index.ts` had anticipated this exact moment since ADR 0002.

## Deviation from the ADR 0170 text

ADR 0170 described "the four `onBroadcast` consumers" moving to the worker
role as one unit. In practice, two of them — `startOutboundPublisher` and
`startProposalResolutionNotifier` — are wired *inside* `ConnectorRegistry`
itself (`registry.ts`, using the registry instance as their binding
resolver), not called standalone from `server.ts`. Pulling them out would
mean splitting the connector registry's own construction (and the inbound
webhook routes it also serves, which only the web role can host, since
only that role runs an HTTP server) — a materially bigger, riskier change
than "move a function call," and not something the reviewed plan detailed.

This phase keeps the connector registry, and both consumers wired inside
it, entirely in the web role. Only the two consumers with no such coupling
(`startPushPublisher`, `startTodosMirror`) move to the worker role. A
future connector-registry split (an inbound-webhook half in web, an
outbound/long-poll half in worker) is left as explicit follow-up, not
silently dropped.

## Alternatives considered

- **Move all four `onBroadcast` consumers as literally specified** —
  rejected for this phase; see above. Doing it correctly needs its own
  design pass over the connector registry's construction and Telegram
  long-poll / Discord gateway ownership (already flagged as unsolved in
  `docs/tasks/im-connectors.md`), not a quick relocation.
- **One process owns `applyMigrations`, the other skips it** — rejected in
  favor of making concurrent calls safe via a lock. An ownership rule is
  one more thing to remember correctly at every future entrypoint; the
  lock makes the call self-evidently safe regardless of start order,
  and it's a no-op in the common case (already-applied migrations).
- **Leave `DB_POOL_MAX` hardcoded and just raise the constant** —
  rejected: the right number depends on the VM's configured
  `max_connections`, which this change has no way to verify from the
  repo. Making it configurable turns that into an operational decision
  instead of a guess baked into a commit.

## Consequences

- Local dev, CI, and `npm run sim` are unaffected — `server.ts` still runs
  everything in one process, byte-for-byte the same startup order as
  before this ADR (web role's `startWebRole` first, then worker role's
  `startWorkerRole`, both against the one `db` handle opened at the top).
- Production deploys now restart two systemd units instead of one;
  `scripts/deploy/deploy.sh` and `scripts/deploy/logs.sh` were updated
  throughout (render both unit files, `enable --now`/`restart` both,
  `journalctl -u chord -u chord-worker`, `systemctl status` for both).
- IMAP IDLE multi-node distribution and the connector-registry split
  remain open follow-ups, not solved here — noted in ADR 0170 and restated
  above so they aren't lost.
- This phase does not itself change any user-visible behavior; it is
  purely structural, verified by running `web.ts` and `worker.ts` as two
  local processes and confirming a worker-originated broadcast (e.g. a
  proactive nudge) reaches a browser subscribed to the web process via the
  ADR 0170 Redis adapter.
