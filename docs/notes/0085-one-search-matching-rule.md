# ADR 0085 — One matching rule for both search surfaces

**Status:** Accepted · 2026-08-13
**Extends:** [0062](./0062-global-search-fts.md) (user-facing FTS search),
[0059](./0059-unified-search-tool.md) (the bot's umbrella `search` tool),
[0084](./0084-email-and-todos-in-search.md) (email + to-dos in both)

## Context

Chord shipped two search surfaces that looked like one feature:

- the 🔍 in the chat composer → `searchHits`, Postgres **FTS** over generated
  `search_tsv` columns, with `ts_rank_cd` ranking and `ts_headline` snippets;
- the `search` bot tool → `searchEverything`, **`ILIKE '%q%'`** on messages and
  an in-memory `.includes()` filter over the list services for everything else.

Two implementations, two answers to the same question:

| Query | 🔍 (FTS) | bot (ILIKE) |
|---|---|---|
| `plumbers` | finds "plumber" (stemming) | nothing |
| `soccer schedule` | matches either word, ranked | only the literal phrase |
| `512` (in "UA512") | nothing — `512:*` is a prefix match, and `ua512` is one token | finds it |

The owner asked why the icon exists at all when you can just ask. The honest
answer was that the icon works when the AI plan is gated
([ADR 0079](./0079-thirty-day-trial-then-gate.md) — `/me/search` has no
entitlement check), is free and instant, and refines live. But the question
exposed the actual defect: **the two paths disagree**, silently, and
[ADR 0084](./0084-email-and-todos-in-search.md) had just widened the split by
adding email to each with different matching.

## Decision

**One rule, stated once and applied on both paths:**

> A row matches when the query's FTS tokens hit its generated tsvector **OR**
> when the raw query appears literally in its text.

Not FTS-primary-with-fallback, and not either alone — a union. The two arms
cover each other's blind spots exactly:

- **FTS** brings stemming and multi-word recall, which substring matching
  cannot express at all.
- **The literal arm** recovers what FTS cannot tokenize. `extractKeywords`
  drops tokens under three characters and stopwords, and Postgres tokenizes
  `UA512` as one word, so `512` matches nothing through FTS. Flight numbers,
  confirmation codes and order references are exactly what a family assistant
  gets asked to find, so this is not a corner case.

The rule is applied where each path already does its filtering rather than by
merging the two into one function: `searchHits` gains an `OR lower(col) LIKE`
arm inside its existing SQL (no extra round trip), and `searchEverything` gains
`ftsMatchIds()` — one raw tsvector lookup per table, unioned with the
substring filter it already ran in memory.

### Why not one shared implementation

They return genuinely different shapes for genuinely different consumers: a
flat, ranked, `href`-carrying `SearchHit[]` for a scrollable result list, and a
per-category DTO (`matchedItems` on lists, `startsAt` on events, `action` on
emails) that an LLM summarizes. Collapsing them would mean one renderer serving
both and serving neither well. Sharing the *matching* while keeping the
*shaping* separate is the seam that actually matters.

### The sentinel

`searchHits` used to bail out entirely when `toTsQuery` returned null, so a
query of only short/stopword tokens returned nothing. It now substitutes a
sentinel token that matches nothing (`zzz_no_fts_match_zzz`), which keeps
`ts_rank_cd` and `ts_headline` valid while the literal arm does the work —
cheaper than threading conditional SQL through five query builders.

### The floor

The literal arm must not become "match everything". `%a%` or `%the%` hits
almost every row, so the literal arm is disabled when the raw query is under
three characters or consists only of stopwords — below that floor the FTS arm
runs alone, which is the behaviour that predates this ADR. This is not a
detail: adding the literal arm without the floor broke an existing test
asserting that a one-character query returns nothing, and that test was right.
Both paths share the floor, and the parity suite pins it.

## Consequences

- **Both surfaces now return the same rows for the same query** on the shared
  types (messages, tasks, saves, lists, email). A parity test asserts the id
  sets are equal across stemming, multi-word, short-literal, nonsense and
  empty queries; it exists to fail loudly when one path drifts.
- **Recall went up on both.** The bot gained stemming and multi-word matching;
  the box gained short literal codes it previously could not find at all.
- **`ftsMatchIds` is deliberately unscoped.** Every caller intersects it with
  an already group-scoped candidate set, so scope stays enforced where it
  already was instead of being re-implemented (and re-buggable) here.
- Ranking is still not unified: the box ranks by `ts_rank_cd`, the bot returns
  per-category source order. That is a presentation difference, not a matching
  one, and normalising scores across entity types remains ADR 0062's open
  follow-up.
- **Events, places, contacts and media stay on substring matching** — they have
  no tsvector. They are small personal lists where a migration buys little, but
  it does mean the rule is currently "FTS where an index exists, literal
  everywhere" rather than universal.

## Alternatives considered

- **Delete the icon, keep only "just ask."** Rejected: the icon is the surface
  that still works when the AI plan lapses (ADR 0079 gates bot turns but not
  `/me/search`), costs no LLM turn, and cannot mis-summarize results. It is
  also the only *discoverable* entry point — "the bot is undiscoverable" is the
  top onboarding pain point on record.
- **Delete the bot tool, keep only the icon.** Rejected for the opposite
  reason: asking in prose is the product's whole thesis.
- **FTS primary, ILIKE only on zero results.** Cheaper, but it makes recall
  depend on result count — a query returning one weak FTS hit would hide a
  strong literal one. The union has no such cliff.
