# 0170 — SSE fanout over Redis pub/sub

**Status**: accepted — implemented (Phase 1 of a larger scaling effort; see also the pending BullMQ job-queue ADR for Phases 3–5)
**Date**: 2026-09-15

## Context

ADR 0002 chose Server-Sent Events over WebSockets and, in doing so,
documented a known limitation: `sseHub` (`server/src/services/sse.hub.ts`)
is an in-process singleton — `Map<channel, Set<Subscriber>>` where each
`Subscriber` holds a live Express `Response` object. A `broadcast()` call
can only ever reach subscribers whose HTTP connection landed on the *same*
Node process. This is fine for one process on one VM (today's deploy), but
it is a hard structural wall against ever running more than one process —
not a tuning knob, a rewrite.

The trigger for revisiting this now: answering "how many users can we
support simultaneously" surfaced this as one of two architectural ceilings
(the other being the lack of a job queue for AI work — addressed
separately). Neither was an active incident; both were identified while
planning ahead of growth.

Any fix needs to satisfy three things: (1) the ~90 existing call sites
across `routes/` and `services/` that call `sseHub.broadcast()` /
`broadcastToUser()` must not change; (2) the four existing `onBroadcast`
consumers (Expo push, cross-group To-Do fanout, IM connector outbound
forwarding, proposal-button edits) must each still see every event exactly
once, never zero or twice; (3) local dev, CI, and the mock-LLM sim
(`npm run sim`) must keep working with zero new infrastructure required.

## Decision

Give `sseHub` an optional Redis pub/sub adapter, controlled entirely by a
new `REDIS_URL` env var (empty/unset = disabled, matching the existing `str()`
env-helper convention).

- When `REDIS_URL` is unset, `SseHub`'s behavior is byte-for-byte identical
  to before this ADR — no Redis client is constructed, `broadcast()` only
  ever writes to local subscribers and fires local listeners.
- When set, `broadcast()` still writes to local subscribers directly (an
  Express `Response` can only ever live on the node that accepted that HTTP
  connection — there is no way around this), **and** additionally publishes
  `{origin: nodeId, channel, event, data}` to a single fixed Redis channel
  (`sse:fanout`), where `nodeId` is a `randomUUID()` generated once per
  process at startup.
- A second, dedicated ioredis connection subscribes to `sse:fanout` and
  replays any message whose `origin` is *not* this process's own `nodeId`
  into local delivery (the same `deliverLocal()` code path used for
  locally-originated broadcasts) — this is the echo-suppression mechanism.
  It is simpler and more correct under concurrent broadcasts than tracking
  "did I just send this" with a mutable flag.
- Two separate ioredis connections are used (one for publish, one for
  subscribe) because ioredis cannot issue ordinary commands on a connection
  that is in `SUBSCRIBE` mode — this is a hard client-library constraint,
  not a design choice.
- The public API of `sseHub` (`subscribe`, `broadcast`, `broadcastToUser`,
  `onBroadcast`, `closeChannel`, `closeAll`) is unchanged, so none of the
  existing ~90 call sites needed to change.

## Alternatives considered

- **Postgres `LISTEN`/`NOTIFY`** — already ruled out by ADR 0038, which
  explicitly bans it in business code because it doesn't survive
  transaction-mode connection pooling (the path to managed Postgres later).
  ADR 0002's own text already named Redis pub/sub as the intended fix once
  multi-node was needed; this ADR just does it.
- **Redis-only delivery** (every `broadcast()` call, even a purely local
  one, is delivered exclusively via the Redis subscribe handler, so there is
  only one delivery code path instead of two) — rejected. It would make
  Redis a hard runtime dependency for *any* SSE delivery to have effect at
  all, including local dev, CI, and `npm run sim`, none of which run Redis
  today. It also adds one Redis round-trip of latency to every single-node
  write, which matters here because bot-turn token streaming rides this
  same path. The chosen hybrid design keeps the zero-Redis fallback exact
  and only adds cross-node fanout as a strict addition on top.
- **A mutable "just published this" flag for echo suppression** instead of
  an origin tag — rejected as more fragile under concurrent broadcasts on
  the same process; the origin tag is correct by construction regardless of
  ordering.

## Consequences

- Dev/CI/`npm run sim` require no Redis setup at all — confirmed by running
  the full server test suite (305 files / 2710 tests) with `REDIS_URL`
  unset, and by a dedicated `sse.hub.test.ts` unit suite that fakes ioredis
  in-memory to exercise the Redis-enabled path (fanout across two
  simulated "node" instances, echo suppression, and listener fan-out) without
  a real Redis server.
- This ADR fixes only the *transport* problem — a broadcast now reaches
  subscribers on any process, once Redis is turned on. It does **not** by
  itself make the app safe to run on more than one process: the four
  `onBroadcast` consumers, the proactive scheduler, and IMAP IDLE all still
  assume they run in exactly one process, and would each misbehave (duplicate
  pushes, duplicate sends, duplicate mailbox connections) if simply started
  on every node. That correctness problem is addressed by a planned
  web/worker process split (pinning those consumers to a single worker
  instance) and, for the AI work specifically, by a follow-up BullMQ-based
  job queue — both out of scope for this ADR.
- Rollout order matters: ship with `REDIS_URL` unset first to confirm zero
  behavior change, then enable it in production and confirm SSE still works
  (a Redis pub/sub round-trip to itself, single node) before anything
  depends on cross-node fanout actually working.
- `closeAll()` now also disconnects both Redis connections; any future
  caller of `SseHub`'s constructor directly (as the new unit tests do) is
  responsible for calling `closeAll()` to avoid leaking connections in tests.
