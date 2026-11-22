# 0035 — Recency-aware bot context window

**Status**: accepted
**Date**: 2026-05-21
**Related**: [ADR 0006 — Keyword retrieval](./0006-keyword-retrieval.md),
[ADR 0007 — Triggering user identity in the turn](./0007-user-identity-in-turn.md)

## Context

`buildLlmContext` (`server/src/services/bot/context.ts`) fed the LLM the last
30 messages by count, with no time awareness. Two problems followed when a user
returned to a group after several days:

1. **Staleness** — in a quiet group the 30-message window stretches back weeks,
   so the bot reasons over conversation that's no longer relevant.
2. **Salience** — the bot sometimes answered an *older* message instead of the
   one that just arrived. The triggering message id was passed into the builder
   but never used: the trigger ended up as just one more `Name: body` line in a
   flat list, with no recency anchor and no signal that time had passed between
   turns.

These are separate problems. Trimming the window (1) does not fix (2): even a
perfect window can leave several plausible messages with nothing marking which
one to answer.

## Decision

Keep the count-based fetch, then layer recency on top — fixed constants in
`context.ts`, no env var or per-user setting (the value needs tuning in code,
not per deployment or per user):

- **Time window with a floor.** After fetching the newest 30, drop messages
  older than `HISTORY_MAX_AGE_DAYS = 3`, but always keep at least
  `HISTORY_MIN_MESSAGES = 20` regardless of age. The floor guarantees a quiet
  group never strands the bot with zero conversational state. Filtering happens
  in JS (not SQL) because "within cutoff **OR** within the last N" doesn't
  express cleanly in one query.
- **Temporal gap markers.** A `system`-role separator `[N days later]` is
  inserted before any message more than `GAP_MARKER_HOURS = 12` after the
  previous one, so the model sees discontinuity instead of reading a 3-day-old
  line as the immediately preceding turn.
- **Trigger anchor + instruction.** The message matching `triggerMessageId` is
  prefixed `→ (latest, respond to this)`, and a system-prompt line tells the
  model the history is oldest→newest and to answer the most recent message,
  treating earlier ones as background.

The windowing, gap, and marker steps are pure helpers (`windowByRecency`,
`formatGap`, `buildConvo`) exported via `__testing` and unit-tested without a
DB.

## Alternatives considered

- **Embeddings / semantic recall of old messages** — heavier infra, and ADR
  0006 already chose keyword retrieval over embeddings for attachments; the
  same reasoning applies. The problem here is recency, not semantic search.
- **Summarizing dropped history** — extra LLM calls per turn and a new failure
  mode (bad summaries) for marginal benefit over a floor of recent messages.
- **Hard time cutoff with no floor** — risks an empty window in slow groups.
- **Env var / per-user config** — over-engineered for a value we expect to tune
  in code; unlike the nudge time (ADR 0034) there's no user-facing reason to
  vary it.
