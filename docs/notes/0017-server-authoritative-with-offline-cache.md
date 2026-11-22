# 0017 — Server-authoritative storage; on-device cache deferred

**Status**: accepted
**Date**: 2026-05-05

## Context

The product direction is "notes and lists feel local and instant on
the device, with sync to other devices as a paid feature." A natural
reading is that on-device SQLite owns these entities and the server
becomes a sync target.

This is **not a security question.** A user already only sees data
they're entitled to (their own groups' contents). Persisting that
view to their own device is the same trust model as the in-memory
zustand cache today, just durable across app launches. There is
nothing to leak.

The actual blockers are engineering cost:

1. **The bot reads this data server-side.** When you message in the
   family group, `bot.service.ts` runs on the server and pulls
   tasks / lists / saves out of server SQLite to build the LLM
   context (ADR 0006). If a list lives only on a phone, the server
   can't see it. So either the bot moves to the device — impractical
   given async @-mentions, IM-connector messages, and per-user LLM
   keys — or the data is mirrored back to the server. Local-first
   in practice means *local-cached-plus-server*, not local-only.

2. **Shared entities need replication, not just storage.** When a
   family member adds milk to the Costco list, every other member
   on a different device has to see it. The server is the natural
   relay. The hard work is the sync protocol (CRDT or LWW), not the
   on-device DB.

3. **Multi-device for one user.** Phone + web + iPad need to
   converge for the same account. Same sync-protocol cost.

4. **Conflict UX.** Offline edits collide. Resolution rules,
   undo / redo, "this got overwritten" surfaces — all new design
   surface the product hasn't speced.

None of these are weeks of code in isolation; together they're a
multi-week initiative.

## Decision

**Server-authoritative for v1. No on-device SQLite for tasks /
lists / saves / events / trips / memories.**

Storage continues to live in `server/data/chord.sqlite`. Mobile
renders from API calls + zustand store; SSE keeps it live across
clients. Bot tools mutate server state and broadcast.

This is deferred for engineering cost, not for any privacy or
security reason. When we revisit, the work is justified by either:

- a typing-latency complaint we can't solve server-side,
- a meaningful offline use case (in-flight, on a subway), or
- multi-device sync becoming a feature we want to differentiate on.

Whether the eventual implementation is gated as premium is a
pricing question, not a design constraint. We can ship local cache
+ sync to everyone if that's the right call at the time.

### Cheap wins along the way (non-blocking)

These are improvements we can land without committing to local-first:

- **Boot-time read cache.** Persist the last `/me/*` response to
  AsyncStorage so the app shows content before the network round-
  trip lands. Read-only; no conflict surface.
- **Optimistic mutation UI.** When the user toggles a checkbox or
  adds a list item, render the change immediately and reconcile if
  the server rejects. Reduces perceived latency without changing
  the data model.

Both can ship inside an ordinary mobile PR. Neither is a step toward
local-first specifically — they're just polish.

## Alternatives considered

- **Local-first with CRDTs (Yjs / Automerge).** Correct end state
  for a multi-device collaborative product. Real cost is the sync
  layer + conflict UX, not the storage. Defer until we want to do
  that work.
- **Local-first for "private" entities only.** Splits the data
  model on a line that doesn't match user mental model — a Costco
  list is "mine" until I share the family group, then it's "ours."
  Different storage policy per entity is worse than one consistent
  policy.

## Consequences

- **No code change needed.** This ADR ratifies the existing setup.
- ADR 0004 (group-scoped agent) and ADR 0006 (keyword retrieval)
  remain valid as written.
- The boot-time read cache and optimistic-mutation UI are open to
  land any time; they're independent of this decision.

`revisit` — re-evaluate when (a) typing latency becomes a real
complaint, (b) offline write becomes a real use case, or (c) we
have bandwidth for a sync protocol. Pricing is decided then, not
now.
