# 0108 — A folder is a predicate, not a sync

**Status**: accepted
**Date**: 2026-08-25
**Relation**: closes the consequence [ADR 0107](./0107-chord-reads-and-answers-gmail-manages.md)
opened; narrows [ADR 0073](./0073-email-delete-archive-convergence.md) on the
reading surfaces only; extends the visibility half of
[ADR 0085](./0085-one-search-matching-rule.md); leads Wave 3 in
[`docs/tasks/email-parity-audit.md`](../tasks/email-parity-audit.md).

## Context

ADR 0107 shipped compose, and compose immediately produced the sharpest bug in
the mail surface: **you could send a message you could not find.**

A sent copy mirrors with the `SENT` label and no `INBOX`. `aggregateThread`
reads absent-INBOX as archived, so the row lands with `is_archived = 1` — and
ADR 0073 had established that archived mail is hidden from *every* listing
surface. The message was in the database, attributed correctly, fully indexed
for search, and reachable from nowhere in the product.

The same rule hid more than sent mail. Anything the user archived in Gmail —
which is most of what a person does with mail — was equally unreachable: not in
a list, not in a tile, and not in search, because both search paths carried the
same `is_archived = 0`.

The tempting reading is that this is a missing feature: we mirror the inbox, so
browsing other folders needs another sync. That is wrong, and checking it is
what made this ADR small. Gmail's backfill lists **all mail** —
`newer_than:${GMAIL_BACKFILL_DAYS}d`, with no `in:inbox` — and a thread archived
on the provider side keeps its row and merely loses the INBOX label. Sent and
archived threads have been in the mirror the whole time. The only thing between
the user and their own sent mail was one WHERE clause.

## Decision

**A folder is a predicate over the label set the mirror already holds.** No
column, no second sync, no new table.

`server/src/services/email/folders.ts` owns the three predicates:

| Folder | Predicate |
|---|---|
| `inbox` | `is_archived = 0` |
| `sent` | has `SENT`, not `TRASH` |
| `archive` | `is_archived = 1`, not `SENT`, not `TRASH` |

`listThreads` takes `folder` and **defaults to `inbox`**, so every existing
caller — tiles, categories, the decision queue — is behaviourally unchanged.
The route parses `?folder=` with ADR 0086's posture: an unknown value falls back
to the inbox rather than 400ing, so a stale client asking for a folder we later
remove still shows the user their mail.

Excluding `SENT` from `archive` is the load-bearing half. A reply you sent is
not a thread you dealt with; merging the two makes archive a junk drawer and
makes "did I ever answer that" unanswerable.

**Search stops filtering by folder entirely.** Both paths (ADR 0085 keeps them
in lockstep) now exclude only `TRASH`. This narrows ADR 0073 deliberately and
narrowly: hiding archived mail from the **listings** is what keeps dealt-with
threads out of the decision queue, and that stays. But search is not a decision
surface — it is the surface you reach for precisely when you do not know where
a message went. A search that silently skips half the mailbox answers a question
nobody asked.

Every AI-layer query keeps its `is_archived = 0` (classification, magics,
digest, person extraction, summary, briefing facts). Those are ADR 0073's real
subject and none of them changes.

## What ships as a stub, and why

Drafts and Trash stay disabled in the folder sheet — for reasons, not for lack
of time:

- **Drafts**: we keep no draft store. There is nothing to list. Listing the
  provider's drafts would mean reading a mailbox we do not mirror and offering
  edit affordances we do not have.
- **Trash**: trashed rows are transient. Gmail's `messages.list` omits trash, so
  ADR 0073's reverse-delete reaps them from the mirror on the next complete
  backfill. A Trash folder would be right the day you archived something and
  empty a week later — worse than absent, because empty reads as "nothing was
  deleted". Deleting is management, and ADR 0107 sends management to the
  provider; the per-thread deep link is already there.

`SPAM` gets no predicate at all. Junk is never mirrored (the sync skips it
outright, and the live peek reads the provider directly), so a clause filtering
a label that cannot appear in the table would be decoration.

## Honesty about coverage

Only Gmail mirrors a whole mailbox. Outlook syncs its Inbox delta and IMAP its
INBOX, so for those accounts **Sent holds only what Chord itself sent**. Archive
works for all three (a message that vanishes from the provider inbox drops its
INBOX label locally and lands in archive).

Rather than let a short Sent list read as lost mail, the folder banner says so
when a non-Gmail account is attached. This is ADR 0107's rule pointed the other
way: a write we do not perform must not report success, and a mirror we do not
hold must not present itself as complete.

## Consequences

- A message you send is findable, by folder and by search. That was the bug.
- Mail archived in Gmail is findable in Chord. Archive browsing is a side
  effect of the same predicate, not extra work.
- The action-axis chips are hidden outside the inbox, and picking a folder
  clears the filter. "Reply needed" against your own sent mail is nonsense.
- The Traditional list caches only the unfiltered **inbox**; priming a cold
  start from a Sent snapshot would look exactly like missing mail.
- One existing test flipped rather than being deleted: search asserting that
  archived mail is hidden now asserts it is found. The behaviour reversed on
  purpose, so the assertion had to say so.

## Alternatives rejected

**A `folder` column on `email_threads`.** Denormalizes something the labels
already say, and needs a backfill plus a write on every label change — a second
source of truth that can disagree with the first. The predicate cannot drift.

**A separate Sent sync.** The assumption that made this look like a feature.
Gmail already gives us the rows; Outlook and IMAP would need real work for the
narrow win of listing mail sent from another client, and the banner is an honest
answer until someone asks for it.

**Leaving search alone and adding only folders.** Would have fixed the
find-your-sent-mail bug only for someone who thinks to open the Sent folder
first — which is not how anyone looks for a message they remember writing.

**Trash as a fourth folder.** Same one-line predicate, so it was nearly free —
and that is the trap. Being cheap to build is not a reason to ship a folder
whose contents evaporate on a schedule the user cannot see.
