# 0201 — Email and attachments are sealed at rest

**Status**: accepted (phase 2 built; phases 3–4 recorded as they land)
**Date**: 2026-09-23

## Context

Google's restricted-scope review (Limited Use + CASA Tier 2) asks what stops
company staff reading a user's mail. The honest answer was: nothing. Mail
bodies, subjects, snippets, attachment text and files sat in plaintext Postgres
and on disk; the nightly `pg_dump` was plaintext and lived on the same VM as
`MASTER_KEY`; and `search_tsv` indexed the actual words even where the text
columns were hidden.

A server that runs full-text search, LLM passes and unattended mail sweeps has
to hold plaintext in memory at some point, so "nobody can read it" is not
achievable. The goal is narrower and real: **no human and no at-rest path (a
database session, a dump, a snapshot, a log) yields readable mail; only the
running service can, with a key that is audited and revocable.**

Owner decisions: threat model is database/backup/disk/log access (not root on
the app VM); encrypt everything except the sender address; search must not
regress.

## Decision

**Envelope encryption with per-owner data keys.** An owner is a user id (mail)
or a group id (files shared into a group). Each gets one random 256-bit key,
stored only wrapped by a key-encryption key. The KEK is behind a
`KeyProvider`: `local` (dev, tests, a stopgap) or `gcp-kms` (Cloud KMS over
REST, authenticated as the VM's service account; no SDK). Unwrapped keys live
in a bounded in-process cache, so the hot path is a Map read and KMS is asked
once per owner per TTL, not once per value.

**Self-describing sealed values.** Text is `enc1.<owner>.<ctx>.<b64url(iv|ct|tag)>`,
files are `CHENC1\n | ownerLen | owner | iv | ct | tag`. The owner is inside, so
a reader needs nothing else, and a column can hold sealed and plaintext values
side by side while a backfill runs. Owner and context are bound in as AAD, so a
value cannot be relabelled as another column or moved to another owner.

**Reads are one Kysely plugin; writes are explicit.** Dozens of services read
the columns that get sealed, so every result row is scanned and any string with
the sealed prefix is opened in place (`ContentDecryptPlugin`). Plaintext passes
through, which is what makes rollout and backfill safe. Writes are the few
places that create the values (`sealField`, `writeBlob`), because
`transformQuery` is synchronous and a key may need fetching. `CONTENT_ENCRYPTION`
gates only whether NEW writes are sealed: deploy the reading code first, flip
the flag, then run the backfill.

**Key lookups have their own connection pool.** Kysely runs a plugin's
`transformResult` while still holding the query's connection. Loading a key
through the app's pool therefore needs a second connection from a pool that
may be exhausted: with the test pool of one it deadlocked outright, and in
production it would under load. Keys are read and created through a separate
2-connection pool (`CONTENT_KEY_POOL_MAX`), closed together with the app
handle. This was found by a test hanging, not by inspection.

**Failure policy.** A value that cannot be opened for a reason about the value
(no key, key destroyed, altered, malformed) is returned as stored and logged
once, so one bad row cannot take a list down and a user-typed string that
merely looks sealed reads back as typed. A failure of the key provider (KMS
down) throws, since ciphertext on screen for an outage is worse than an error.
Reading never creates a key; only writing does, so a string starting `enc1.`
cannot mint key rows.

**Erasure by key destruction.** `KeyStore.destroy` nulls the wrapped key and
stamps a tombstone (a destroyed key must stay distinguishable from one that
never existed, and a destroyed owner never gets a new key). Account deletion
(ADR 0043) destroys the user's key and every solo group's key after the
transaction commits. Files answer `410 CONTENT_ERASED`. Limit stated plainly:
an older backup still holds the wrapped key, so it stays readable until that
backup expires; destruction protects the live system and future restores.

## Phase 2 (built): files

`saveFile` seals under the scope's owner; every reader of a blob goes through
`readBlob` (extraction, vision, PDF, the bot's image and form tools, mail
attachments, the Telegram and WhatsApp connectors). The download route opens a
sealed file in memory and sends it whole, and still uses `sendFile` for plain
files, so range requests and conditional GETs are unchanged for everything that
predates encryption. `encrypt:backfill --step attachments` seals existing files
in place: temp file, read-back check, atomic rename, idempotent, resumable, and
a blob shared by a copy into another group is sealed once. Config: env keys
`CONTENT_*`; migration `090_content_keys`.

## Consequences

- A group-shared file is sealed under the group. A copy into another group
  shares the blob, so erasing the source group makes the copy unreadable.
- `sendFile` is bypassed for sealed files, so those lose range support. No
  current file type in the product streams.
- Every process holds two more connections than before (`CONTENT_KEY_POOL_MAX`).
- Extracted text, summaries and chunk text are still plaintext in the database
  after this phase; they move in phase 4. Mail columns move in phase 3.
- `local` provider keeps the KEK in `.env` beside the database, which is no
  better than today against someone on the VM. It exists so the code can ship
  and be tested; the protection arrives with `gcp-kms`.

## Rejected alternatives

- **A plugin that also encrypts on write.** `transformQuery` is synchronous; a
  cold key would need fetching inside it.
- **Key lookups through the app pool.** Deadlocks, see above.
- **Row-id-bound AAD.** Stronger against value swaps by someone who can write
  the database, but needs the row id at every seal and open. Swapping is a
  tampering threat that still needs the key to exploit usefully; not a
  disclosure one.
- **Streaming chunked file encryption.** Files are capped at 20 MB (100 MB on
  ingest); one GCM pass measured 31 ms for a 5 MB round trip. Revisit if the
  cap rises.
- **One key for everything.** Erasing one user would mean re-encrypting all.
- **Failing the query on an unopenable value.** One corrupt row would blank a
  mailbox.

## Phase 3 (built): mail, and search that does not read it

**What is sealed.** `email_messages`: subject, snippet, from_name, body_text, body_html, body_excerpt, ics_text, attachments_json. `email_threads`: subject, snippet, from_name, and the four fact columns (delivery, flight, receipt, read advisory). Two kinds of value are deliberately NOT sealed because their absence carries meaning in SQL: `''` (e.g. `ics_text = ''` is "parsed, no invite") and `[]` / `{}` / `null`. Empty stays empty, so `attachments_json <> '[]'` and `flight_json IS NOT NULL` keep answering. **The sender address, recipients and labels stay readable** (owner decision): they are the join keys for bulk-gate, routing rules, unsubscribe and autocomplete, and hashing them would have moved every one of those to a keyed-hash column for a protection the owner did not ask for. The consequence is stated, not hidden: someone with database access can still see who a user corresponds with and when, but not what any message says. The sender's display name IS sealed.

**One write path.** Every provider funnels a message through `upsertMessageMeta` and a thread through `recomputeThread`, so those two call `content-seal.ts` and nothing else in sync changed. jsonb columns hold the sealed text as a JSON string scalar with a `~json` context suffix, and the read plugin parses it back. A recompute whose content is unchanged (a mark-read, a label change) rewrites no ciphertext: it reads the thread's current fields, compares, and skips. A fresh IV per seal would otherwise turn every flag change into a row version and WAL.

**The blind index** (`utils/blind-index.ts`). Two per-row indexes, both plain `tsvector` columns filled by the application. *Words*: Porter-stemmed words, each with its prefixes of 3 to 12 letters, keyed HMAC truncated to 32 bits, with positions so `ts_rank_cd` still rewards frequency. *Grams*: character trigrams, presence only. A word query is an OR of lexemes (`schools` finds `School`, `plumb` finds `plumber`, and both the word as typed and its stem are tried, since stemming a typed prefix can mangle it). A literal (`ua512`, `50%`, a domain, CJK) is an AND of trigrams and is then **confirmed against the opened text** for anything longer than one trigram, because every trigram being present is not the same as the text being present. Message bodies get trigrams only for code-like tokens (a digit inside, 4 to 40 long), so `512` finds `UA512` in a body; mid-word substrings of ordinary body prose are no longer findable (words and prefixes still are). Body indexing is capped at the first 100k characters. The key is per owner, derived (HKDF) from the data key, so nothing links two users. What it leaks to someone holding the database and no key is in the module header: how many distinct words a row has, and which rows share a lexeme. That is searchable encryption's ordinary access-pattern leak; truncating the hash blurs frequency without pretending to hide it.

**One search implementation.** The bot tool and the search box each carried their own copy of the email predicate and were kept honest by ADR 0085's parity test. With the text hashed, the match became a candidate query plus an in-application confirmation, which is not something to write twice, so `findEmailThreads` serves both and parity is structural. `ts_headline` cannot run over ciphertext, so the box's excerpt is built in the application from the opened body of the message that matched (an 18-word window, `<b>` markers, no ellipses, as `ts_headline` produced with one fragment). Two consumers that filtered on sealed columns in SQL moved: the digest's `subject_keyword` briefing rule now matches in JS like a category rule, and briefing-rule sender resolution reuses the `from:` lookup.

**Behaviour changes, each pinned by a test:** a `from:` or autocomplete query under three characters matches addresses only (a name needs a trigram); accents are not folded (as before); a word beyond the 100k-character cap is not found by word.

**Rollout, and why the legacy columns stay for a while.** `091_email_blind_index` only adds columns. The old generated `search_tsv` columns remain, and while `CONTENT_LEGACY_TSV` is on, search also reads them, **only for rows with no blind index**: a sealed row's legacy columns hold ciphertext, and a `LIKE` over base64 matches short queries by accident (a test pins this). Order: deploy; set `CONTENT_ENCRYPTION=true`; `encrypt:backfill --step email`; `--step verify` until nothing readable remains; set `CONTENT_LEGACY_TSV=false` everywhere; `--step finalize-email --vacuum` drops the columns and rewrites the tables so the old plaintext is not left in dead tuples. Finalize refuses while the flag is on or while any value is still readable.

**Measured** (1,500 threads per mailbox, the same queries on a plaintext and a sealed mailbox, on a loaded machine): sealed search 1 to 2.5 times the plaintext latency and all under 100 ms; sync of one message (upsert plus recompute) 10.7 ms with encryption off and 11.0 ms on; sealing and indexing one message and its thread 3.4 ms of application work; a 50-thread list page +1.5 ms; opening one message +0.6 ms.

**Rejected:** hashing the sender address (moves every sender join to a hash column); an in-memory per-user index (no leakage, but a cold start per process and cache invalidation between web and worker); provider-side search (breaks unified search across mailboxes); word-only indexing (cannot find `512` inside `UA512`, which the literal arm exists for); trigrams for whole bodies (a tsvector size limit and a GIN insert cost for the wrong problem).


## Phase 4 (built): what the product derives from mail and files

**What is sealed.** `attachments`: summary, extracted_text, image_meta, answerable_questions. `attachment_chunks.content` (the text the bot searches). `proposals.args_json` for suggestions mined from mail (provenance `gmail:...`; one a person made in chat is already chat content and stays as it is). `email_drafts`: subject and body. `events.meeting_context`. All under the same owner as the thing they came from: an attachment's group (so a copy into another group is re-sealed under THAT group's key, and the source is untouched), a user for their suggestions, drafts and meeting summaries. The filename stays readable, as it does on the attachment row and in the file listing.

**Attachment chunks get the same blind index as mail** (`092_attachment_chunk_blind_index`): a `blind_words` tsvector built from the chunk text and its filename, so a filename-only hit still works exactly as the old `body_tsv` did (which also folded the filename into every chunk, so a file can still return one hit per chunk and the caller collapses them). The bot's per-turn retrieval calls `searchAttachmentChunks` for a set of candidate files that can belong to several groups, so the query runs once per OWNER (one key each), not once per file, and returns plaintext chunks: the ciphertext is opened only for the rows that matched, and the snippet is built in the application with the same guillemet markers (the word wrapped in « and ») `ts_headline` was asked for. A chunk with no blind index (written before the switch) is read through the old column only while `CONTENT_LEGACY_TSV` is on, and never for a sealed row.

**Reads of an owner with no usable key find nothing instead of failing.** `indexKeyFor(owner, false)` now returns null for a destroyed key as well as a missing one, so a search across several files where one owner's key was erased returns the others' hits, not an error. A write still refuses.

**Nothing on the reply path got slower.** Measured with the same 150-file corpus in a plaintext group and a sealed group (same database, run back to back): a chunk search 5 to 30 ms either way; the bot's per-turn retrieval 63 ms plaintext vs 43 ms sealed on a loaded machine; indexing one six-chunk file 27 ms vs 34 ms; opening a list of 60 sealed suggestions +1.3 ms. The bot itself is unchanged: its prompt still carries plaintext excerpts (an LLM needs the words) and a test pins that the excerpt of a sealed file reaches it readable, that `search` returns opened mail, and that an ordinary "add to Costco list" turn runs end to end with encryption on.

**Rollout.** `089` only adds a column. Order: deploy; `CONTENT_ENCRYPTION=true` (already on from phase 2); `encrypt:backfill --step derived`; `--step verify-derived` until nothing readable or unindexed remains; `CONTENT_LEGACY_TSV=false` everywhere; `--step finalize-derived --vacuum` drops `attachment_chunks.body_tsv` and rewrites the four tables. The backfill opens a sealed value only to build an index, seals each batch in one transaction, and skips what is already done.

**Not sealed, on purpose.** Confirmed tasks, events, list items, people and saved places: once someone accepts a suggestion it becomes family content in a shared group, and encrypting shared group content per user is a different design (who holds the key when four members read it). It is the boundary this ADR draws, and the answer to "can an admin read my family's task list" is yes. What an admin cannot read is what came out of a person's mail or files and has not been accepted.

**Rejected:** sealing accepted family content in this pass (see above); indexing chunks under the user rather than the group (a group file is read by every member, so the key must be the group's); a single query across owners (a lexeme is only comparable within one key, so it cannot be one predicate).
