# 0152 — Email search trusts the classifier on a category-name match

**Status**: accepted
**Date**: 2026-09-09

## Context

Asking the bot "give me emails associated with school" returned three hits: one
genuine ("$125 Chase High School Checking promotion" — arguably not even genuine,
just literally on-topic), and two unrelated ("Enter to win an OpenRun Pro 2" from
Shokz, Matt Levine's "Money Stuff" newsletter). Both false positives matched
because the word "school" turns up once, incidentally, somewhere in a long
promo/newsletter body — the ADR 0110 full-body search arm doing exactly what it
was built to do (catch a buried confirmation code), applied to an ordinary English
word instead. Neither search surface (`searchEverything`, the bot tool;
`searchHits`, ADR 0062's user-facing endpoint) has any notion of *topic* — both
match a query only via Postgres FTS ∪ literal substring over subject/snippet/from,
unioned with the body-text arm, per ADR 0085's shared matching rule.

Chord already runs an LLM classifier (ADR 0066/0086/0109/0110) at sync time that
reads each thread and decides what it's about, filing it into a category path
(`email_categories` / `email_threads.category_id`). That judgment is already
trusted unconditionally by the tile/AI-view UI (ADR 0068/0083) and by the
structured `?category=` thread-list filter (`server/src/routes/email.ts`). Search
alone never consulted it.

## Decision

When a search query's text matches (case-insensitive substring) one of the user's
own classifier-assigned category **titles**, at any depth, **trust that match and
replace keyword/body matching for that query** — don't union the two. If the
query doesn't match a category, search runs exactly as before (ADR 0085,
unchanged).

New `resolveCategoryMatch(db, userId, queryText)` in
`server/src/services/email/classification.service.ts`, next to the existing
`categorySubtreeIds` (same tree walk, refactored out of `loadTree` into a shared
`loadCategoryNodes` so this doesn't pay for `loadTree`'s unrelated assignment-count
join). Both search surfaces call it identically (ADR 0085's shared-rule
discipline) and, on a match, filter `email_threads.category_id IN (subtreeIds)`
instead of the FTS/literal/body OR-arm. Every other ADR 0126 operator
(`from:`/`has:attachment`/`after:`/`before:`/`label:`) still ANDs on top
unconditionally, so `school after:2026/01/01` and `label:Family school` compose
exactly as before — only the *free-text* arm is replaced, never the operators.

**Replace, not union**, because a category match is the more precise answer
whenever there is one: it fixes the false positive (Shokz/Levine are filed
elsewhere, so they stop matching "school") *and* the mirror-image false negative
a keyword search can never fix (a genuine "Picture day reminder" from the school
that never says the word "school" would be invisible to literal/FTS matching but
is exactly what the classifier already filed correctly).

**Multiple matching category branches union their subtrees.** This is read-only
recall — more genuinely-matching mail from a second matching branch is not the
write-ambiguity problem ADR 0077/0094/0137 refuse on, so there's nothing to ask
about.

**Catch-all buckets (`CATCH_ALL_LEAVES` — "other", "notes", "misc", ...) are
excluded from matching**, even where they're a real top-level row
(`trimCatchAllLeaf` only trims below the top level). A search for "notes"
replacing results with someone's entire generic bucket is a worse failure than
falling through to keyword search.

**Direction of the substring test matters**: the category *title* must contain
the *query*, never the reverse. Matching the other way — a short, generic title
like "Mail" being a substring of a long natural-language query — would make an
ordinary sentence silently replace search with a near-arbitrary category. This
scopes the feature to the short, name-shaped queries it's meant for ("school",
"travel", "school forms") without a query-shape check.

**`searchHits`'s score/snippet for a category-only hit**: `ts_rank_cd`/
`ts_headline` legitimately return near-zero/empty when nothing lexically
matched — correct information, but it would sink these hits under the
cross-entity, globally-sorted result list (or past `limit`). Mirrors the
synthetic rank-ordered band already used for `file`/`todo` hits (same "no
natural FTS score" shape): ordered by recency, JS-assigned score from a small
constant band, snippet rendered as `Filed under "<matched title>"` instead of a
`ts_headline` that would highlight nothing.

**No gating flag.** This only reads already-computed, already-trusted
classifier output with a fully safe fallback (no match → byte-for-byte today's
behavior). Unlike `EMAIL_CLASSIFIER`/`EMAIL_BULK_GATE`, there's no new write path
or heuristic risk here to need a kill switch for.

## ADR 0149 gate

This is a **correctness fix to the shipped ADR 0085/0059/0062 search matching
rule** — keyword-only matching producing topically wrong results on ordinary
words — using data Chord already computed, with zero new UI and a safe no-match
fallback. It is not new mail-client polish, so ADR 0149's freeze on net-new
mail-surface work doesn't apply.

## Alternatives considered

- **Union instead of replace** — keep today's keyword/body arm and add category
  matches alongside it. Rejected: this is exactly what leaves the Shokz/Levine
  false positives in place; it improves recall (catches a school email that
  never says "school") without fixing the precision problem that motivated this.
- **A `category:` search operator** (mirroring `label:`) instead of implicit
  resolution on bare text. Considered but not needed as the primary mechanism:
  the goal was for a plain "school" query to already behave correctly, not to
  require new syntax nobody types. The implicit resolver subsumes it — a
  `category:` operator remains a reasonable future addition if someone wants to
  force it explicitly, but isn't required.
- **Ask the LLM to judge relevance at search time** (a per-query classification
  call). Rejected: doubles down on exactly what ADR 0066/0086/0109/0110 already
  paid to compute once at sync time; re-asking per search is a new LLM cost for
  no new information.
- **Match query-contains-title instead of title-contains-query.** Rejected: lets
  a long natural-language query be "matched" by any short/generic title that
  happens to be one of its substrings, silently replacing keyword search on
  queries the feature was never meant to touch.

## Consequences

- Search topically improves for both false positives and false negatives, using
  data Chord already computed — no new LLM cost.
- A search result for a category-matched email carries a `Filed under "..."`
  snippet on the user-facing surface, rather than a highlighted excerpt, since
  nothing in the email necessarily contains the query text.
- Search behavior for a given query can change over time as classification
  re-runs and reclassifies mail (ADR 0110's `classifier_version` top-up), the
  same way tile contents already do — this is not new drift, just extended to a
  second surface.
- An unclassified mailbox (`EMAIL_CLASSIFIER` never run, or no matching
  category) is unaffected: `resolveCategoryMatch` returns `null` and search is
  byte-for-byte what it was before this ADR.
