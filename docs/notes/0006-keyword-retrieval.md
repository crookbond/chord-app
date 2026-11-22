# 0006 — Keyword retrieval over filenames + summaries (no embeddings)

**Status**: partially superseded by [0021](./0021-fts5-attachment-index.md) (see also [0038](./0038-sqlite-to-postgres.md)) — UPDATED 2026-06-01
**Date**: 2026-04-17
**Covers**: D5

## Update — 2026-10-19

The "no embeddings" half is superseded for search by
[0276](./0276-search-matches-by-meaning-on-sealed-vectors.md): chat search
blends keyword matches with meaning matches from per-user sealed vectors
(behind `EMBEDDINGS_ENABLED`). Keyword retrieval stays the base layer and the
whole answer when embeddings are off; there is still no vector database.

## Update — 2026-06-01

The decision to avoid embeddings/vector DB still holds, but the in-memory
filename+summary keyword scoring described below was replaced by full-text
search: [0021](./0021-fts5-attachment-index.md) introduced a chunked FTS index,
and [0038](./0038-sqlite-to-postgres.md) moved that engine from SQLite FTS5 to
Postgres `tsvector` + GIN (`server/src/services/attachments.index.ts`). Kept as
history.

## Context

Historically `buildLlmContext` bulk-injected up to 12 attachment summaries (pinned first, then recent). At ~12 files this works; at 50+ we'd either blow the context window or cherry-pick wrong.

A real retrieval system (embeddings + vector DB) is overkill for a demo and duplicates work that should live in a unified retrieval service when we build the real product. The sibling project (`webapp-start`) has KBI for this — not appropriate to pull into a demo.

## Decision

**Keyword retrieval over `filename + summary`**. No embeddings, no vector DB.

Scoring for an attachment given a trigger message:
```
score =   2 * (keyword hits in filename)
        +     (keyword hits in summary)
        + 10 if pinned
        +  1 if uploaded in the last 24 h
```

Selection per turn: all pinned (up to a cap of say 6), plus the top-scoring non-pinned up to a total cap of 12. Keywords come from the trigger message, tokenised + lowercased + stopword-stripped.

When the trigger message has no extractable keywords (one-word pings like "hi"), fall back to the current "pinned + most recent" ordering.

## Alternatives considered

- **Pure recency.** Current behaviour. Breaks when old reference docs (school calendar uploaded in January) are relevant again in April.
- **BM25.** More principled than raw keyword counts; slightly more code. Probably overkill at the scale we'll see. Worth revisiting if keyword hits feel flaky.
- **Embeddings.** Real answer for production. Needs vector storage + an embedding model. We explicitly punt — the demo doesn't need it, and whatever we'd build here would be thrown away when we adopt a unified retrieval service.

## Consequences

- Implemented as `selectAttachmentsForTurn()` in `services/bot/retrieval.ts`, invoked from `services/bot/bot.service.ts` before `buildLlmContext()`.
- Scoring is a pure function — unit-testable without spinning up anything else.
- When keyword matching misses (user asks for "the calendar" but the file is named `nolan-term-2.pdf`), the pinned set still gets injected. Pinning is the explicit fallback.
- This subsystem is replaceable wholesale when we adopt a unified retrieval layer. Keep it behind a single `selectAttachmentsForTurn()` function so the call site doesn't care.
