# 0199 — A read state is delivered, not dropped

**Status**: accepted
**Date**: 2026-09-23

## Context

Marking a thread read or unread writes to the provider first, then the local
mirror. When the provider refused, each provider did something different and
none of them did the right thing:

- **Outlook / IMAP** logged a warning and marked the mirror read anyway. The
  provider still had it unread, so the next sync flipped it back — mail that
  "un-read itself" with no explanation.
- **Gmail** threw. Correct for the mirror, but the automatic mark-read on
  opening a thread swallows the error, so it silently stayed unread until the
  thread was opened again.

The prod logs answered *why* providers refuse, and it was not throttling or
expired tokens: all seven `outlook modify failed` lines (Sep 9–17) were
`graph setRead 404 ErrorItemNotFound`, the same few messages failing again on
later days, every one of them archived ("Re: BOOKING CONFIRMATION - Kilima
Safari"). **Graph message ids are not stable** — Outlook issues a message a new
id when it moves to another folder, unless the app asks for immutable ids,
and Chord does not. 182 of that user's 196 Outlook messages sit outside the
inbox, each holding an id that may no longer exist. Retrying the stored id can
never succeed. No IMAP or Gmail failures appear in the retained logs.

## Decision

**Re-find a moved Outlook message instead of writing to a dead id.** Every
Outlook write (`withCurrentGraphId` — read state AND archive / un-archive)
tries the stored id; on 404 it looks the message up by its RFC 822
Message-ID (`findIdByInternetMessageId`, already stored as
`rfc822_message_id`), writes to the current id, and stores it so the next
write goes straight there. Found nowhere means deleted: nothing is owed.

**A refused read/unread is owed, not dropped — on every provider.** When a
pure read-state change fails (Gmail primary and secondary: only the UNREAD
label moving; Outlook: any message's setRead; IMAP: `\Seen` or the login
itself), the mirror shows what the user chose and `email_read_writes`
(migration `088`, one row per thread, the latest intent wins) records that the
provider still owes it. A write that does reach the provider clears the row.

**Sync cannot undo an owed change.** `recomputeThread` — the choke point every
provider's sync crosses — re-applies an owed read state before aggregating,
so a sync that reads the provider's stale UNREAD back does not flip the thread.

**The sweep retries with backoff.** `flushReadWrites` runs on the proactive
tick (before the mail sweep) through each provider's own modify path with
`fromRetry` — the same write a tap makes, including the Outlook re-lookup — so
a failure throws for the sweep to back off rather than re-queueing and
resetting its own backoff. Delay doubles from 2 minutes, capped at 6 hours;
after 12 attempts (~26h) the row is dropped, logged at **error**, and the
mirror is set back to the state the provider actually holds. That last step is
not optional: Outlook's delta only re-sends a message that changed, so without
it an undeliverable intent would leave Chord and the mailbox disagreeing
forever.

Archive, labels and other non-read changes keep failing loudly as before —
they have a user-visible refusal (ADR 0107's rule) and are out of scope here.

## Consequences

- Nothing tells the user a read state is still pending; it simply lands. An
  abandoned one is an error log, and the mailbox and Chord agree again.
- Rows for threads the user deletes go with the thread (`ON DELETE CASCADE`).
- Already-stale Outlook ids heal on the first write that touches them.

## Rejected

- **Immutable ids (`Prefer: IdType="ImmutableId"`).** The right long-run
  shape, but switching changes every id delta returns, so existing rows would
  stop matching and re-import as duplicates without a
  `translateExchangeIds` migration of every stored id. The Message-ID lookup
  fixes the observed failure with no migration; revisit if a second
  stale-id symptom appears.
- **Retrying the same id.** The prod failures were all permanent 404s.
- **Reverting the mirror on the first failure.** Throws away what the user
  chose because the provider was briefly unavailable.
- **An in-memory retry.** Lost on restart and invisible to the other worker.

## Addendum 2026-10-23: one message, one mirror row

The "second stale-id symptom" this ADR said would reopen immutable ids turned
up in a code read, and the same shape showed up twice more:

1. **Outlook re-issues the id on a move, on the read side too.** A message
   moved back into the Inbox (un-archive in Chord, or in Outlook, or
   not-junk) is reported by the Inbox delta under its new id, and rows are
   keyed on the id (`scopedId(accountId, m.id)`), so it was inserted beside
   the archived row it used to be. IMAP does the same thing: a message moved
   back to INBOX gets a new UID.
2. **A reply Chord sent was mirrored twice.** Outlook and IMAP store it under
   a placeholder `sent-<id>` with no Message-ID; the Sent-folder sync of ADR
   0116 later mirrored the real copy beside it.
3. **IMAP Inbox and Sent shared one key space.** Both were keyed `u<uid>`, but
   UIDs are numbered per mailbox, so Sent UID 101 overwrote the Inbox row with
   UID 101 (and stayed in the inbox thread, since the upsert never changes a
   row's thread), or hid an inbox message with that UID from sync for good.
   The same rows also fed their Sent UIDs to `setSeen`/`setArchived` against
   INBOX, marking or moving an unrelated inbox message.

**Decision: recognise the row a message already has, rather than switch to
immutable ids.** Before an Outlook or IMAP message is upserted,
`claimMirrorRow` (`email-accounts/mirror-identity.ts`) looks for it:

- under its own key (and moves it to this message's thread if it sits in
  another one, which is how the collided IMAP rows go home);
- else a row in the same mailbox with the same RFC 822 Message-ID **and the
  same kind of copy** (sent vs received), which it re-keys so the upsert
  updates it. The kind check is what keeps a message sent to yourself as two
  rows: one Message-ID, two real copies, one per folder.
- else, for a sent copy, a Chord placeholder in the same thread within 15
  minutes, nearest first. A Graph `reply` answers 202 with no id and no
  Message-ID, so time and thread are all there is for Outlook. IMAP no longer
  needs it: `send` now returns the Message-ID SMTP went out with, and the
  placeholder stores it.

IMAP Sent rows are keyed `s<uid>`. A cursor without `keys: 2` re-keys every
SENT `u<uid>` row of that account to `s<uid>` (freeing the inbox UID it was
hiding) and re-walks the Sent window, so each row returns to its own thread.
`withCurrentGraphId` no longer leaves a twin when the current id already has a
row: the stale row is deleted, since the other is the live copy.

**Why not immutable ids now.** They still need a `translateExchangeIds` pass
over every stored id and fresh delta links, neither of which can be checked
without a live Microsoft mailbox; they would not cover IMAP UIDs or the
placeholder at all; and an immutable id still changes when a message moves to
another mailbox (an online archive). One rule keyed on the Message-ID covers
all three cases on both providers. Immutable ids remain worth doing later to
save the re-lookup on writes; this reconciliation stays as the safety net.

**Accepted cost.** Two received copies that genuinely share a Message-ID in
one mailbox (the same message delivered twice) collapse to one row. A third
reply to the same thread sent from another client within 15 minutes of a
Chord reply can take that reply's placeholder; the result is still one row
per sent message, only the nearest-time pairing can be wrong.

The write-side re-lookup obeys the same kind rule: `findIdByInternetMessageId`
is told which copy it wants, searching Sent Items for a sent row and the rest
of the mailbox (Sent Items left out) for a received one. It used to take the
first match anywhere, so a write to the inbox copy of a message sent to
yourself could land on the Sent copy, and the twin clean-up then deleted the
inbox row as stale.

Existing duplicates already in the mirror are not merged by this change; see
the clean-up plan in the PR.
