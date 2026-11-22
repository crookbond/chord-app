# 0165 — One bot turn per group at a time

**Status**: accepted
**Date**: 2026-09-10

## Context

Prod: in a shared group, a member told Chord "add oatmeal to trader joes
list", then "add bananas", then "add to trader joes — frozen peas, aloo,
pyaaz", within a few seconds. Only oatmeal landed. The bot said it had added
all three.

`reactToMessage` is fire-and-forget — `POST /groups/:id/messages` returns
`201` before the turn runs (`routes/messages.ts`, `connectors/inbound-pipeline.ts`),
and the turn is tracked only in a `Set` for test teardown. Nothing serialises
turns for a group, so three quick messages ran three `runBotTurn`s
concurrently, interleaved on the event loop.

Each turn called `add_list_item` → `resolveOrCreateListByName`
(`lists.service.ts`), which is `SELECT` the group's list names → if none
match, `INSERT` a new list. There is no lock spanning that check-then-act and
**no unique constraint** on `lists(group_id, name)` or any normalised key.
All three turns' `SELECT`s ran before any `INSERT` committed (LLM streams take
seconds), so each turn saw "no Trader Joes list" and each created one.
Oatmeal, bananas and the frozen-peas batch landed on three separate lists all
named "Trader Joes". Every turn's `addItem` returned `created: true`, so the
bot's "added it" was truthful per-turn — the write went to a fork.

The group chat has no list panel, so the forks were invisible until the user
opened the wrong one. The same race exists for every resolve-or-create /
fold-if-exists path a turn can hit — task folding (ADR 0095), list-name
resolution on reads (ADR 0094), save dedup.

## Decision

Two layers.

1. **Serialise bot turns per group.** `reactToMessage` keeps a per-`groupId`
   promise tail (`groupTurnTails`, in `bot.service.ts`); each new turn chains
   onto the previous one, so a group's turns run one at a time in arrival
   order. Cross-group turns still run concurrently. The tail slot is cleared
   only by the turn that is still the tail, so a turn queued behind it is
   never orphaned.

2. **Guard resolve-or-create with a transaction-scoped advisory lock.**
   `resolveOrCreateListByName` now runs inside `db.transaction()` and takes
   `pg_advisory_xact_lock(hashtext(groupId), hashtext(listNameKey(name)))`
   before the `SELECT`. `_xact_` releases on commit/rollback and is the only
   advisory-lock form safe under transaction-mode pooling (same constraint
   ADR 0137 and ADR 0038 note). Two concurrent resolutions of the same spoken
   name in the same group now queue at the lock; the second sees the first's
   committed list and appends to it.

Layer 1 makes the list race unreachable from a single node's message path.
Layer 2 is defence in depth — it also covers the connector inbound path, a
future second node, proposal-confirm, and any caller that reaches the
resolver outside `reactToMessage`.

No schema change: both layers are runtime-only.

## Alternatives considered

- **Unique index on `lists(group_id, <name key>)`** — the natural DB
  backstop, but `listNameKey` is a JS function (kernel), not expressible as a
  Postgres generated column without porting the stemmer to SQL and keeping
  the two byte-identical forever (the drift trap ADR 0085/0106 describe). The
  advisory lock gets the same guarantee keyed on the JS value we already
  compute.
- **Hash `groupId || '\0' || key` into one `pg_advisory_xact_lock(bigint)`**
  (the original sketch) — Postgres rejects a NUL byte in `text` (ADR 0126),
  and any printable separator can collide across the split
  ("ab" | "c" vs "a" | "bc"). The two-int form
  `pg_advisory_xact_lock(int, int)` sidesteps both.
- **Advisory lock only, no per-group serialisation** — closes the list fork
  but leaves every other concurrent-write path in a turn (task fold, save
  dedup) racing, each needing its own lock. Serialising the turn is one fix
  for the class.
- **Serialise only, no advisory lock** — enough for the in-app path on one
  node, but the connector path and any future multi-node deploy would still
  fork. Cheap to hold both.
- **A global (not per-group) turn queue** — needless head-of-line blocking; a
  slow turn in one family's group would stall every other group's replies.
- **Debounce / coalesce rapid messages into one turn** — changes product
  behaviour (three intents, three confirmations) to paper over a correctness
  bug, and still races anything else writing concurrently.

## Consequences

- **A group's replies are now strictly ordered and one-at-a-time.** A slow
  turn (native loop, up to 20 iterations) delays that group's next reply
  until it finishes. This matches the follow-up-window mental model (ADR
  0051) — a sequential back-and-forth — and is the intended trade: a
  correct answer a few seconds later beats a fast forked one. Other groups
  are unaffected.
- **A hung `runBotTurn` stalls its group's queue.** Same failure surface as
  today (a hung turn already leaked one tracked promise); now later messages
  for that group wait instead of racing. `runBotTurn` must keep terminating
  on its own (LLM calls are timeout-bounded).
- `groupTurnTails` is in-memory and per-node, like the follow-up window and
  the SSE hub (ADR 0002). A second app node would serialise within each node
  but not across them — which is exactly why layer 2 exists and is not
  optional.
- `resolveOrCreateListByName` now opens a transaction per call **unless the
  caller already holds one** (`db.isTransaction`) — proposal confirm and
  bundle commit run `commitRow` inside `db.transaction()`, and nesting there
  threw. When already in a transaction it takes the lock on that one (it
  releases with the outer commit/rollback); otherwise it wraps its own. The
  lock is held only for the `SELECT` + optional `INSERT` (+ the best-effort
  catchup fanout `createList` already does), i.e. milliseconds.
- Migration `073_merge_forked_lists` re-runs `mergeDuplicateLists` to heal
  the forks the race already made (the "Trader Joes" trio and any others) —
  the same function migrations 042/043 use, idempotent, a no-op on a fresh
  DB and wherever one list per key already stands.
