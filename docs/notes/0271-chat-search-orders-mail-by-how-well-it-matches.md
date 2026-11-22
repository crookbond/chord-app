# 0271 — Chat search orders mail by how well it matches

**Status:** Accepted, 2026-10-19. Amends ADR 0152.

## Context

After ADR 0270 a person is a filter, but the topic words were still ordered
badly on the path chat uses:

- **The bot path sorted by date.** `searchEverything` asked `findEmailThreads`
  for `order: 'recent'` with a cap of 8. Words are OR'd, so a newer email
  mentioning ONE of the words ("receipt" in a Target promo) beat the older one
  matching all of them ("Your Costco receipt").
- **The score that did exist was flat.** `ts_rank_cd` over the blind words did
  not say how many of the query's words a thread matched, nor whether in its
  subject or deep in a body.
- **A named category replaced the keywords (ADR 0152).** "school" returned only
  threads the classifier filed under School; "School supplies list" filed
  elsewhere vanished.
- **One candidate window.** When trigram confirmation rejected most of it, the
  search stopped at whatever survived.
- **A sealed row's legacy rank.** The old plaintext tsvector rank was added for
  every row; on a sealed row it is computed over ciphertext.
- **Filters switched files off.** Any operator narrowed search to mail, so
  "the PDF Bill sent" found the email and not the PDF.

## Decision

- **Chat ranks** (`order: 'rank'`). For a query with words, a wide window of
  candidates (8x the cap, at least 80) is re-scored:
  `(coverage x 4 + ts_rank_cd x 10 + 6 if in the named category) x recency`,
  where **coverage** counts each query word (up to 8) twice when it is in the
  thread's own subject / snippet / sender and once when only in a body, and
  **recency** is `1 + 0.15 e^(-age/90 days)` - a tie-breaker, not a sort. A
  literal or pre-index row matched the whole query and counts as covering it.
  Ties go to the newer thread. A filter-only query (a person, no words) is
  newest first.
- **A named category is added and boosted, not swapped in.** The category's
  threads and the keyword matches are both candidates. ADR 0152's false positive
  (a newsletter saying "school" once) is still dropped: outside the category, a
  thread matching only one word, only in a body, does not survive. Category
  matching stays whole-query: matching per word would let "school trip form"
  pull in a whole Trips category.
- **Up to five candidate windows** are read until the cap is filled.
- **The legacy rank applies only to rows with no blind index.**
- **Mail filters narrow files instead of hiding them.** With a person, date or
  other mail filter, file results are the attachments imported from the
  matching threads (ADR 0071, `origin_email_thread_id`), keyword-ranked when
  there is a topic, and each carries the email's subject, sender and link.

## Consequences

- Eval (`email-search-eval.integration.test.ts`): MRR 0.82 -> 0.89, context
  hit@1 0.33 -> 1.00. Meaning-only queries ("kids excursion paperwork") still
  miss; that needs ADR 0276.
- One extra query per ranked search (per-word flags for the candidate window).
- The search box (`searchHits`) already ranked; it gets the same scoring because
  both go through `findEmailThreads`.
- Bot context retrieval (`bot/retrieval.ts`) still uses baseline file ranking;
  switching it needs its own eval run.

## Rejected

- **A larger category boost.** It would put every thread of a big category above
  any subject match and bring back ADR 0152's replace behaviour by weight.
- **Per-word category matching** (above).
- **Recency as the primary sort with relevance as a tie-break.** That is the
  behaviour that put the promo first.
