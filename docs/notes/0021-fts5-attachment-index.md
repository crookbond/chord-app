# ADR 0021 — SQLite FTS5 attachment index with chunked excerpts

Date: 2026-05-05
Status: Accepted — FTS engine now Postgres tsvector, see [ADR 0038](./0038-sqlite-to-postgres.md) — UPDATED 2026-06-01
Supersedes: the in-memory keyword scoring half of [ADR 0006](./0006-keyword-retrieval.md).

## Update — 2026-06-01

The chunked-excerpt retrieval design below is intact. Only the engine changed:
[ADR 0038](./0038-sqlite-to-postgres.md) replaced the SQLite FTS5 virtual table
with a Postgres `tsvector` generated column + GIN index, queried via
`to_tsquery` / `ts_rank_cd` (`server/src/services/attachments.index.ts`). Read
"FTS5" below as "the full-text index".

## Context

The bot used to score attachments in JS post-fetch on filename + summary,
then dump the first 4 000 chars of up to three files into the system
prompt. For long PDFs that means the cover page rather than the
paragraph that answers the question. ADR 0006 explicitly framed the
scorer as "replaceable wholesale behind `selectAttachmentsForTurn()`",
expecting a smarter retrieval layer eventually.

We hit the wall when prototyping "upload a calendar PDF, ask Chord about
a date on page 5" — the model couldn't see page 5. Bumping the truncation
limit just inflated token cost without fixing accuracy.

## Decision

Put a real full-text index inside the existing `data/chord.sqlite` using
SQLite's built-in **FTS5** virtual table (ships with `better-sqlite3`,
zero new infra). At index time, every attachment's `extracted_text`,
image OCR (`image_meta.ocrText`), vision caption + keyFacts
(`image_meta.caption`, `image_meta.keyFacts`), and `summary` get split
into ~200-word paragraph chunks. At query time, BM25 ranks the chunks
visible to the triggering user and returns the top **6** as snippets.

The LLM context block now lists each retrieved file with its filename +
summary, then the matching paragraph excerpts (with `«match»` markers
preserved from SQLite's `snippet()` so the model can see what was
truncated). The blind front-of-file dump is gone.

## Why FTS5, not Elasticsearch / Meilisearch / vectors

| Need | Elasticsearch / Meilisearch | SQLite FTS5 |
|---|---|---|
| Tokenization, stemming, BM25 | ✓ | ✓ (`porter unicode61`) |
| Snippet / highlight | ✓ | ✓ (`snippet()`, `highlight()`) |
| Phrase / boolean / prefix match | ✓ | ✓ |
| Multi-node sharding | ✓ | ✗ |
| Separate process / new infra | ✓ | **✗ — in-process** |
| Vector similarity | ✓ | ✗ (would need `sqlite-vec`) |

We're a single-process Express + SQLite server with a corpus measured
in tens of MB. Running a real search engine alongside it adds ops cost
with no payoff at this scale. If we ever go multi-node we'd revisit.

Vector / semantic search was also considered. BM25 with stemmed
prefix-OR queries is enough for the keyword-first questions our bot
fields ("what time is the soccer game", "who is the trip booked
through"). When recall on synonym questions starts visibly hurting, we
add `sqlite-vec` as a parallel index — that's a new ADR.

## Implementation

- **Migration `024_attachment_fts5`** — creates the FTS virtual table
  `attachment_chunks(attachment_id, chunk_idx, kind, filename, content)`
  and a sibling `attachment_chunk_meta` for non-indexed columns
  (`char_offset` for future page citations). Backfills every
  already-indexed attachment by calling `indexAttachmentChunks`.
- **`server/src/services/attachments.index.ts`** — `chunkText` (pure,
  paragraph-aware, word-window fallback for huge paragraphs),
  `indexAttachmentChunks` (idempotent — wipe + insert per attachment),
  `searchAttachmentChunks` (BM25 ranked, candidate-set filtered),
  `removeAttachmentChunks`.
- **Wiring** — `attachments.service.ts` calls `indexAttachmentChunks`
  on extraction completion and after `copyAttachmentToGroup`.
- **Retrieval** — new `selectExcerptsForTurn` in
  `server/src/services/bot/retrieval.ts`. Falls back to the existing
  pinned-only path when keywords are empty (so generic greetings
  still surface the always-on handbook). Visibility gating reuses
  `fetchAttachmentsVisibleTo`, unchanged.
- **Context** — `attachmentBlock` in `bot/context.ts` renders the
  excerpt list per file. Drops `MAX_FILES_WITH_CONTENT` and
  `MAX_CONTENT_CHARS_PER_FILE`.

## Caps

| | Old | New |
|---|---|---|
| Files cited per turn | 12 (6 pinned + 6 dynamic) | 12 still listed; 6 carry excerpts |
| Bytes of file body in prompt | ≤ 12 000 chars (3 × 4 000) | ≤ ~3 000 chars (6 × 500 snippet) |
| Match locality | front of file | matched paragraph |

That's a roughly 4× token-cost cut on long-file turns and a sharp
accuracy improvement on questions that aren't answered on page 1.

## Tradeoffs

- **BM25 isn't semantic.** "soccer" won't match "futbol". When that
  starts losing turns, swap in `sqlite-vec` (separate ADR).
- **Re-index on every extraction.** Cheap at our scale (sub-second per
  file with a 40 000-char cap on `extracted_text`), but the migration
  backfill scans every existing attachment. Future-proofing: the
  `extraction-recovery on boot` item already on the roadmap will
  share this pass.
- **Permission filtering is O(N) in candidate IDs** because we pass
  them as `attachment_id IN (...)`. That stays fast until a user is in
  thousands of groups; we'll revisit when it shows up in profiles.

## Update (2026-05-22) — full-text for the focused doc + conversation-aware query

Snippet-only retrieval flip-flopped in practice: the bot would say "yes I
have Nolan's vaccine record" then "please re-upload it" on the next turn,
because a content-free follow-up ("summarize it", "show me", "when did he get
rubella") carried none of the file's keywords, so BM25 returned no excerpts and
the doc dropped out of context. Two refinements:

- **Conversation-aware query.** `recentRetrievalText` (`bot.service.ts`) builds
  the retrieval text from the last few human turns, not just the trigger, so a
  follow-up inherits the file's keywords.
- **Full text for the top docs.** `attachmentBlock` inlines the full
  `extracted_text` (≤24k chars) for the top **2** ranked docs instead of only
  snippets; lower-ranked docs keep excerpts. This walks back part of the
  snippet-only decision for the focused doc, accepting more tokens for reliable
  content-level answers. The forms autofill path (`gatherKnowledge`) was raised
  in step with this: 8→10 records, 2k→6k chars each.

## Out of scope (deferred)

- Vector embeddings.
- Per-user SQLite databases (would require splitting all of `chord.sqlite`,
  far beyond the index alone).
- On-device search on mobile (the LLM call is server-side, so the
  index has to live next to the LLM caller).
- Page / line citations in bot replies (the `char_offset` column is
  there for it; UI work is separate).
