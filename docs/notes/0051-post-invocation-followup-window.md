# 0051 — Post-invocation follow-up window

**Status**: accepted
**Date**: 2026-06-10
**Related**: [ADR 0018 — Listening modes](./0018-listening-modes.md),
[ADR 0002 — SSE over WebSockets](./0002-sse-over-websockets.md),
[ADR 0035 — Recency-aware context window](./0035-recency-aware-context-window.md)

## Context

In a shared group the bot only replies when a message `@`-mentions it
(`decideReaction` in `bot.service.ts`). That makes multi-turn exchanges
unnatural: every turn of a back-and-forth has to re-tag `@Chord`. The
motivating case is the calendar import (ADR 0050):

> "@chord import the school calendar" → *"Which county, or paste the link?"* →
> "Fairfax County" → *(imports)*

The middle user turn ("Fairfax County") carries no mention, so today the bot
never sees it as a turn to answer — the conversation stalls. The ask: **once
invoked, Chord listens to the next few prompts for context and actions**, with
the count configurable by the server.

This is **not** ADR 0018's `active` mode. That mode is a reserved, premium,
always-on tier gated by an opinion/confidence classifier — a different feature.
This is a short, bounded continuation of an *explicit* invocation.

## Decision

Add a **post-invocation follow-up window**, scoped to the **group**.

- When the bot reacts to an `@`-mention in a group, open a window for that
  `groupId` with `BOT_FOLLOWUP_TURNS` remaining turns.
- While that window is open, the group's subsequent messages — **from any
  member** — are answered **without** a re-mention; each answered follow-up
  spends one turn. At zero, the window closes and a re-mention is required
  again.
- A re-mention at any time re-opens (refreshes) the window.

### Scope: the group, not the invoking user

The window keys on `groupId` alone (product decision, 2026-06-10). After anyone
invokes the bot, the group's next few messages get answered regardless of who
sends them — a family back-and-forth where Mom asks and Dad clarifies stays in
one conversation with the bot. This deliberately accepts more reply volume than
a user-scoped window in exchange for natural multi-party threads; the TTL and
the (capped) turn count bound the cost.

### Bounded twice: count (hard-capped) + TTL

- `BOT_FOLLOWUP_TURNS` (default **3**, `0` disables) — the "next N prompts."
  **Hard-capped at `MAX_FOLLOWUP_TURNS = 20`**: any configured value above 20 is
  clamped, a runaway-cost backstop independent of operator config.
- `BOT_FOLLOWUP_TTL_MINUTES` (default **10**) — wall-clock expiry, so a window
  opened and then left idle for an hour doesn't answer a much-later, unrelated
  message out of the blue.

Both are server config (`env.ts` / `example.env`) per the ask ("configurable by
server").

### Storage: in-memory, ephemeral

State lives in a module-level `Map` (`followup-window.ts`), not the database.
Rationale: this is transient conversational state measured in
seconds-to-minutes. Losing it on restart just means the user re-mentions once —
no durable value to persist. This matches the **in-process** SSE hub assumption
(ADR 0002). The same caveat applies: a multi-node deployment would need a shared
store (Redis), exactly like the hub.

This is the deliberate opposite choice from ADR 0018's *listening-mode toggle*,
which is persisted on `users` because it must survive sign-out/reinstall. A
toggle is a durable preference; a follow-up window is a fleeting conversation
state — different lifetimes, different storage.

### Wiring

`decideReaction` stays pure and unit-testable: it takes an `inFollowupWindow`
input and returns a `followup: 'open' | 'consume'` recommendation alongside the
existing `react` / `passiveExtract`. The two call sites that drive bot reactions
— `routes/messages.ts` (native client) and `connectors/inbound-pipeline.ts` (IM
bridges) — read the window before deciding and apply the recommendation after.
Precedence in a group: **mention → follow-up window → passive → silent**.

## Alternatives considered

1. **Reuse / implement ADR 0018 `active` mode.** Wrong semantics — `active` is
   an always-on opinion-gated tier, not a continuation of an explicit
   invocation. Overloading it would conflate two features and couple this to a
   classifier that doesn't exist yet.
2. **User-scoped window** (only the invoking user's follow-ups answered).
   Quieter and the initial instinct (ADR 0018's noise concern), but it breaks
   the real family case where one member asks and another answers the bot's
   clarifying question — that second member would be ignored. Rejected by the
   product owner in favour of group scope; the turn cap + TTL bound the extra
   volume.
3. **Persist the window in Postgres.** Rejected — durable storage for state
   that's meaningless after a few minutes; adds a migration and write per turn
   for no benefit. Re-mention is a trivial recovery after a restart.
4. **Count only, no TTL.** Rejected — a window opened then abandoned would lie
   in wait and answer a much-later, unrelated message. The TTL bounds surprise.

## Consequences

- More bot turns (cost): up to `BOT_FOLLOWUP_TURNS` (≤20) extra LLM turns per
  invocation, across the whole group, only while actively conversing.
  `BOT_FOLLOWUP_TURNS=0` restores the exact prior invocation-only behavior.
  Group scope means an active multi-member group spends the window faster than
  a user-scoped one would — the cap and TTL are the guardrails.
- In-memory state is per-node; documented as a multi-node caveat alongside the
  SSE hub.
- No schema change, no migration. Behavior is config-gated and on by default
  (N=3).
- Future: a per-user or per-group override (mirroring ADR 0018's slider) could
  tune or disable the window without a server restart; not built.
