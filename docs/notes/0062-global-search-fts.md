# 0062 — Global search (per-table FTS, user-scoped)

**Status**: accepted
**Date**: 2026-07
**Relates to**: [ADR 0021 — attachment tsvector FTS](./0021-attachment-fts.md), [ADR 0032 — strict per-group scope](./0032-strict-per-group-scope.md), [ADR 0059 — unified `search` bot tool](./0059-unified-search-tool.md), [ADR 0038 — Postgres](./0038-sqlite-to-postgres.md)
**Workstream**: Friends & Family release plan — L

## Context

As groups accumulate history, users need to *find* things ("where's the soccer
schedule", "that dentist task", "the link Mom shared"). Today there is no
user-facing search UI, and full-text search exists only for **attachments**
([ADR 0021] — `attachment_chunks.body_tsv` + GIN, `searchAttachmentChunks`).

ADR 0059 shipped a `search` **bot tool** (`searchEverything`) that spans every
entity, but for non-file types it uses the list services + an **in-memory
substring filter** — fine at demo scale and for an LLM consumer, but not a
ranked, indexed, user-facing search.

## Decision

Add real FTS for the four remaining human-text entities and expose a
**user-facing** search endpoint returning a flat, ranked hit list.

### Per-table generated `tsvector` + GIN (migration `020`)

For `messages`, `tasks`, `lists`, `list_items`, `saves`, add a
`STORED GENERATED` `search_tsv` column over the entity's human-text columns and
a GIN index — mirroring the attachment pattern exactly:

| Entity | `search_tsv` over |
|---|---|
| `messages` | `body` |
| `tasks` | `title` + `details` |
| `lists` | `name` |
| `list_items` | `text` |
| `saves` | `title` + `note` |

Postgres maintains these on every write, so there is **zero drift and no sync
code** — the reason a single denormalized `search_index` table (which five
services would have to keep in lockstep) was rejected. The columns are queried
only through raw `sql` fragments, so — like `attachment_chunks.body_tsv` — they
are intentionally **not** added to the Kysely schema types.

### `searchHits()` — the user-facing query path

A new `searchHits(db, input)` in `search.service.ts` (beside, not replacing,
the bot's `searchEverything`). It runs **one FTS query per entity type**
(scope- and visibility-gated), then merges + ranks in JS — the `UNION ALL`
shape the plan calls for, kept as separate queries so each entity's visibility
rule stays legible. `ts_rank_cd` for score, `ts_headline` for snippets,
recency tiebreak. Files reuse `searchAttachmentChunks` (ADR 0021).

Visibility rules carried over: `messages` exclude `chord_visible=0` (bot-only)
and `system`; `tasks` hide `archived`/`superseded`; files reuse the attachment
visibility set.

### Scope — user-scoped, not a bot leak (does NOT violate ADR 0032)

ADR 0032's strict per-group scope governs **the bot** not leaking across
groups. A **user searching their own data** is different: the searcher is a
member of every group queried, so results legitimately span all their groups.
Two surfaces:

- **`GET /api/v1/me/search`** — across **only the groups the searcher belongs
  to** (`group_members` pre-filter). The headline feature.
- **`GET /api/v1/groups/:id/search`** — one group, membership-gated by
  `require-member`.

Because this is a direct HTTP response to the searcher (not bot-tool output),
each `SearchHit` safely carries the real `groupId` (needed for deep-linking) —
unlike the ADR 0059 bot path, which must return a group *name* to survive
ADR 0032's `scrubCrossGroupLeak` post-filter.

### Contract

Kernel `SearchHit` / `SearchRequest` / `SearchResponse` (`kernel/src/types/
search.ts`) + `API.meSearch` / `API.groupSearch`. Entity types:
`message | file | task | list | save`. Each hit carries `entityType`,
`entityId`, `groupId`, `groupName`, `title`, `snippet`, an in-app `href`,
`createdAt`, and `score`.

## Consequences

- Five new generated columns + GIN indexes. Write cost is a tsvector
  recompute per row write (negligible at F&F scale); read cost is an
  index scan instead of a table scan / in-memory filter.
- **Two search code paths** for now: the bot's `searchEverything` (in-memory,
  categorized DTO) and the user-facing `searchHits` (FTS, flat list). They can
  converge later (back the bot tool with the FTS path); kept separate here to
  avoid disturbing the shipped bot tool + its tests. Documented debt.
- **Cross-type score normalization is approximate.** `ts_rank_cd` values are
  comparable across the four text entities; **file** hits reuse the attachment
  ranker and are mapped into a fixed score band (rank-ordered), so a file can't
  out/under-rank text hits precisely. Acceptable for F&F; a proper unified
  score is a follow-up.
- Entities beyond the five (events / places / contacts / media) are searchable
  via the bot tool but **not** in the user-facing endpoint yet — they have no
  generated tsvector. Add them the same way if demand appears.
- Mobile search UI (search bar → `meSearch`/`groupSearch`, deep-linked results)
  is the follow-up slice; the server contract here is complete and tested.
