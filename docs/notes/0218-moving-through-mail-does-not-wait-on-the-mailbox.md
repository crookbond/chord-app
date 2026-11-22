# 0218 — Moving through mail does not wait on the mailbox

- **Status:** Accepted
- **Date:** 2026-09-30
- **Amends:** ADR 0128 (bulk triage), ADR 0144 (freshness), ADR 0180 (read-time pass), ADR 0215 (trash)

## Context

Four complaints about the Email screens, web and phone:

1. Refresh is slow.
2. Mail deleted in the mail app still shows in Chord.
3. Trashing an open email goes back to the list; it should be able to open
   the next one, and that should be a setting.
4. Select + Trash "refreshes all emails first, then deletes".

What each turned out to be:

- **Every return from an email ran a full mailbox sync.** The list's focus
  effect called status, then the mirror, then `POST /me/email/sync` over every
  mailbox, then the mirror again. Coming back from an email re-focuses the
  list, so reading five emails in a row cost five syncs.
- **The Sync call stopped at the first failing mailbox.** `syncAllAccounts`
  walked mailboxes in connect order and re-threw the first non-auth error, and
  the route did the primary Gmail and the attached mailboxes one after the
  other. A throttled Yahoo or a Gmail quota error meant every mailbox after it
  was never synced on a pull — its deletions never reached Chord. (The
  background sweep already continued past a failure; only the user's own Sync
  did not.)
- **A thread with one trashed message was judged by that message.** Gmail
  trashes per message. `aggregateThread` took the union of every message's
  labels, so one trashed reply in a live thread put TRASH on the thread and hid
  it from the inbox, and when the trashed message was the newest the row showed
  its snippet. Prod on 30 Sep had two such threads (LinkedIn job alerts).
- **Bulk Trash was undone on screen by its own events.** The server trashed
  the threads one at a time and emitted `email.thread.updated` for each; the
  list answered every event with a refetch of the whole list, which still held
  the threads not yet processed. The optimistic removal was overwritten, rows
  came back, then vanished one by one.
- **Opening an email paid for itself twice.** The auto mark-read re-fetched
  the whole thread (a second open, a second wait on the ADR 0180 pass) to learn
  one flag, and the next email was never fetched until tapped.

## Decision

**The list re-reads the mirror on focus; it syncs only when it last did so
more than 60 s ago.** Status and the mirror are read in parallel and the list
paints before any sync. Pull-to-refresh and a return from the background
always sync.

**Every mailbox is synced, whatever another one does.** `syncAllAccounts`
runs the attached mailboxes side by side (`Promise.allSettled` — they are
different servers) and the Sync route runs the primary Gmail beside them.
The first real failure is still reported, after the others have finished.

**A thread is judged by its live messages.** When any message is not in
Trash, `aggregateThread` and the reader's message list ignore the trashed
ones. Only a thread trashed throughout reads as trashed, which is also the
rule `recomputeThread` already used for retracting suggestions.

**A removal is hidden until it is settled.** A shared set of "being removed"
thread ids (in the thread-nav store) is filtered out of every write of the
list — refetch, next page, rendering, and the ids the reader navigates over.
An id is released only after the server answered, and the list is then
re-read, so a thread the mailbox refused comes back and the list says why.
`email.thread.updated` patches the one row it names (drops it when it left
the inbox) instead of refetching; `email.synced` refetches coalesced at 300 ms.

**The bulk route writes several threads at once.** Still one provider write
per thread (ADR 0128), but grouped by mailbox and run four at a time — except
IMAP, where each write is its own login and Yahoo throttles on login rate
(ADR 0080), so those stay one at a time. Results are reported in request order.

**After Archive/Trash in the reader, go to the next email — a setting.**
`users.email_after_remove` (`'next'` default | `'list'`, migration `097`),
Settings → Email, beside the swipe choice. "Next" is the email below it in the
list (the previous one when it was the last). The reader leaves at once and
the provider write finishes behind it; a refusal surfaces on the list.

**The reader warms its neighbours.** Once an email is shown, the next and
previous are fetched with `?prefetch=1` and kept for two minutes, so the next
one paints on tap. A prefetch skips the ADR 0180 read-time pass — that pass is
for an email someone is reading, and the real open still runs it and replaces
the prefetched copy. Auto mark-read patches the thread in place.

No bot tool: the new setting only changes where a screen goes after a tap
(ADR 0215 made the same call for the swipe setting).

## Consequences

- Right after returning from an email, the list can be up to 60 s behind the
  provider until the next sync (pull to refresh, background return, or the
  5-minute sweep with its SSE event).
- A reader-side Trash that the provider refuses is reported on the list, not
  in the reader the user already left.
- Prefetching costs one thread read per neighbour per email opened — local
  rows, plus a provider body fetch where bodies are lazy.

## Rejected

- Suppressing per-thread SSE events on bulk writes: other screens (an open
  reader on another device) need them; the list now treats them cheaply.
- A client-side undo toast for reader Trash: the provider's Trash is the undo.
- Running the read-time pass on prefetch: spends the one-time check on mail
  nobody opened.
- Syncing on every focus but in the background: still N syncs for N emails
  read, just less visible.
