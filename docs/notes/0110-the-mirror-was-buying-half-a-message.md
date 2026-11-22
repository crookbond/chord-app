# 0110 — The mirror was buying half a message

**Status**: accepted
**Date**: 2026-08-25
**Relation**: closes the item [ADR 0108](./0108-a-folder-is-a-predicate-not-a-sync.md)
left as the largest remaining gap; extends the index behind
[ADR 0084](./0084-email-and-todos-in-search.md) and keeps
[ADR 0085](./0085-one-search-matching-rule.md)'s parity; leads Wave 3 in
[`docs/tasks/email-parity-audit.md`](../tasks/email-parity-audit.md).

## Context

`email_threads.search_tsv` (migration `038`) indexes subject, snippet, sender
name and sender address. A snippet is about a hundred characters. So everything
actually *said* in an email — the flight number, the amount, the address, the
one sentence you remember — was unfindable, on both search surfaces.

The reason was one argument. The Gmail sync fetched every message with
`format=metadata`:

```
const raw = await api.getMessage(id, 'metadata');
```

`normalizeMessage` already called `extractBodies` on the result; with a metadata
payload there is nothing to extract, so it stored `null` and moved on. Bodies
arrived only when the user *opened* a thread, through a separate `format=full`
fetch in `getThread`.

That made body search structurally impossible rather than merely unbuilt.
Indexing what we had would have covered only threads the user had already
opened — a partial index with invisible coverage, which is the search-shaped
version of the failure [ADR 0102](./0102-a-failed-tool-does-not-get-to-explain-itself.md)
and [ADR 0107](./0107-chord-reads-and-answers-gmail-manages.md) both forbid.
So the real question was not *how do we index bodies* but *why don't we have
them*.

Two findings settled it.

**Outlook and IMAP already store bodies at sync.** `normalizeOutlookMessage`
and `normalizeImapMessage` both populate `bodyText`/`bodyHtml` inline. Lazy
bodies were never a system design; they were a Gmail-path artifact. Fixing
Gmail makes the three providers agree rather than adding a special case.

**A body is nearly free to ask for.** `messages.get` is one call and one quota
charge whether you ask for `metadata` or `full` — the format changes the
response, not the cost of the request. The sync was already paying per message
and taking half of what it paid for. What grows is bytes over the wire and rows
on disk, not quota and not round trips.

## Decision

**The Gmail sync asks for the whole message.** All five `'metadata'` fetches —
backfill, incremental add, and the spam-rescue path, across the primary mailbox
and attached Gmail accounts — become `'full'`, and go through a new
`normalizeFullMessage`.

That helper exists for one reason worth stating: on a full payload, *no
attachment parts* honestly means "this message has none", and we can store
`'[]'`. On a metadata payload the same emptiness means "nobody has looked yet",
and storing `'[]'` would tell the reader a message has no attachments when the
truth is we never asked. Same distinction as `ics_text = ''` in ADR 0080. The
two normalizers keep it impossible to confuse the cases by accident.

**Migration `048`** adds a generated `search_tsv` + GIN over `email_messages`,
and a partial index on the missing-body predicate for the backfill to drain
against.

```sql
to_tsvector('english', left(coalesce(body_text, ''), 200000))
```

The `left(...)` is load-bearing, not tidiness. `to_tsvector` raises on input
that would exceed the 1MB tsvector limit, and this is a GENERATED column — the
error would land on `INSERT`, inside the sync, and wedge that mailbox
permanently. That is exactly how ADR 0106 happened. One oversized newsletter
must cost us the tail of its index, never the message.

**HTML-only mail gets a text body.** `extractBodies` only ever returned text
from a `text/plain` part, and most receipts and newsletters have none — they
would have stored a null body and dropped straight back out of the index, in
exactly the mail people search ("what did that receipt say"). So a full payload
with no plain part now derives one with `htmlToPlainText`. Indexing the raw
HTML instead is not the alternative it looks like: tag and attribute names
become tokens, so `style` and `table` would match half the mailbox. The derived
text feeds the tsvector and the LLM prompts; the reader still renders
`body_html`.

**Both search paths gain a body arm**, through one shared helper
(`email/message-search.ts`) rather than the same SQL written twice: ADR 0085
makes the two surfaces promise identical matching, and two copies of a predicate
is how that promise quietly stops being true. A thread matches when its own text
matches **or** any message inside it does, with the same FTS-OR-literal union.
The literal arm matters *more* here than on subjects — a confirmation code is
unindexable as a token and lives in the body.

The user-facing path also feeds the matching body excerpt into `ts_headline`.
Without it a body-only hit renders its ordinary snippet with nothing bolded,
which reads as a mis-hit rather than as a match you cannot see.

**A bounded backfill fills the past.** `backfillMessageBodies` takes 40
newest-first per sync tick, so a mailbox that predates this change catches up
over a few syncs instead of one enormous pass. A message Gmail no longer has is
marked with an **empty** body, not left null: null means "never asked", and
without that distinction the pass would spend its whole budget re-asking for the
same dead rows every tick and never reach a live one.

It runs **above** the ADR 0079 entitlement gate. The sentence that justifies
that gate — *it's their mail* — is the same sentence that says an unentitled
user still gets to find their own message. Bodies are mirror, not intelligence.

## Consequences

- Search reaches what an email actually says, on both surfaces.
- **The AI passes get bodies too, for the first time.** `runEmailMagics` and
  person extraction both prefer a message with a `body_text` and fall back to
  the newest one — and on a Gmail mailbox where nothing had been opened, that
  was always null. They have been extracting from a subject line and a hundred
  characters of preview. The prompt still caps the body at 2000 characters, so
  the token cost is bounded, but this is a real change to what those passes
  see, and the reason to expect their output to get better.
- Opening a thread no longer triggers a fetch: bodies and attachment metadata
  are already there, so the lazy path in `getThread` becomes a backstop for
  rows that predate this change rather than the normal case.
- Storage grows by roughly the text of every message in the backfill window.
  Bandwidth grows per sync. Quota and request count do not.
- The literal arm of the body predicate is an unindexed `LIKE` over one user's
  messages, so an `OR` against the GIN arm costs a scan of that user's mail.
  Bounded by `user_id` and consistent with what the thread-level and chat-message
  arms already do, but it is the first place this index will hurt if a mailbox
  gets very large. The FTS arm alone would be cheap; it would also be the arm
  that cannot find `UA512X`, which is the point of ADR 0085.
- ADR 0071's attachment import still does its own `format=full` fetch, because
  it needs the attachment *data* and not just the part list. Unchanged.
- It composes with [ADR 0109](./0109-bulk-is-how-mail-was-sent.md), landed in
  parallel: that one widened `METADATA_HEADERS` so `List-Unsubscribe` and
  `List-Id` survive a metadata fetch. `full` returns every header, so on the
  mirror path the bulk signal no longer depends on that allow-list being kept
  up to date at all. The allow-list is still live for the junk peek, which is
  the one caller left asking for metadata.
- Attached Gmail mailboxes get bodies on new mail, but their pre-existing rows
  fill in only on open — the backfill is primary-mailbox-only, because
  `getGmailApi` is the one seam reachable from `gmail.service.ts` without a
  service cycle. Bounded and decaying, so not worth a cycle to fix.

## Alternatives rejected

**Index the bodies we happen to have.** The obvious cheap move, and the wrong
one: coverage would be "threads you already opened", the user could not tell
which, and a search that silently skips most of the mailbox is worse than one
that admits it does not read bodies at all.

**A second pass that fetches bodies after the sync.** Doubles the `messages.get`
count for every message to buy exactly what the first call would have returned
for free. Only defensible if `full` were more expensive per call, and it is not.

**Index `snippet` harder, or store a longer snippet.** Treats the symptom. The
provider decides how long a snippet is, and no length of preview finds a
confirmation code buried at the bottom of a receipt.

**A separate `email_message_bodies` table.** Bodies are already a column on
`email_messages`; moving them buys nothing and costs a join on the reader's
hottest path.

**Truncating stored bodies to the indexable length.** Would keep the index and
the storage in sync at the cost of the reader silently losing the end of long
messages. Storing the whole message and indexing a prefix loses only search
recall on the tail, and only for messages longer than most books' chapters.
