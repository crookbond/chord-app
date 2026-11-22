# 0206 - A failing mailbox waits instead of retrying every tick

**Status**: accepted
**Date**: 2026-09-24

Amends ADR [0144](./0144-the-mirror-goes-stale-when-nobody-is-looking.md) (the background sweep) and follows ADR
[0159](./0159-the-pipeline-runs-as-mail-arrives-not-when-you-look.md).

## Context

The sweep picks every user whose `gmail_synced_at` is older than `MAIL_SWEEP_MINUTES`, and an attached account is
gated the same way on its own `synced_at`. Those timestamps move only when a sync **succeeds**. So a mailbox that
fails stays "stale" forever and is selected again on every proactive tick, which is 15 seconds, not the 5 minutes the
setting suggests.

Two prod incidents on 2026-09-24 were this one loop:

- One Gmail user's `history.list` returned the per-minute quota 403 (`Total Query Cost`, `Units per minute per user`).
  The sweep retried them every 15 seconds: 271 failures in an hour, flat at about 40 per ten minutes, never draining,
  because each retry spent the quota it was waiting for.
- Earlier the same day a missing `CONTENT_KEK` failed every mailbox's sync. The log held about 12,600 warnings, for the
  same reason: nothing slowed the retries.

## Decision

A failed background sync puts the mailbox on a wait, and the opportunistic paths skip it until the wait is over.

- The wait starts at `MAIL_SWEEP_MINUTES` (5) for an ordinary error and at 10 minutes for a rate limit or quota error
  (a quota 403 says "later", so retrying sooner is the wrong answer), doubles for each consecutive failure, and is
  capped by `MAIL_SYNC_BACKOFF_MAX_MINUTES` (60). `<= 0` turns it off.
- One success forgets the wait and the failure count.
- Keyed per mailbox: `gmail:<userId>` for the primary Gmail, `acct:<accountId>` for an attached Outlook, IMAP or
  second Gmail. One bad mailbox never holds back another, including the same user's.
- **Only the background paths consult it**: `maybeSyncGmail` and the per-account loop in `maybeSyncAccounts`. A sync a
  person asks for (the Email tab, the sync button, a push wake) never does, so "sync now" always tries. Every outcome,
  explicit or not, updates it, so a good explicit sync clears a stale wait.
- The failure warnings now carry `retryInMs`.

## Alternatives considered

- **Stamp `gmail_synced_at` on failure.** Reuses the existing throttle, but the column means "mail is current as of",
  and the Email tab and the read-state logic show it. A failure would make a stale mirror look fresh.
- **Persist the wait in a column.** Survives a restart, at the price of a migration for a value that only matters for
  the next hour. In memory costs one early retry after a restart, and the sweep runs in one worker process.
- **A fixed pause.** Recovers no better from a quota that is still exhausted, and waits too long after a one-off error.
- **Honour Gmail's "retry after" time from the response body.** More exact, but it means parsing an error string the
  API does not promise to keep. Doubling with a cap gets to the same place.
- **Slow the fetch rate instead.** The quota error was a symptom of the loop, not of the fetch volume; slowing
  requests would not have stopped a retry every 15 seconds.

## Consequences

- A failing mailbox is tried a handful of times an hour instead of 240, and the log stops being flooded by it.
- A mailbox that has recovered can wait up to the current backoff (at most an hour) before the background paths try it
  again; opening the Email tab tries at once.
- The sweep still selects the user every tick (a cheap query) and logs `mail sweep refreshed`; only the provider calls
  are skipped.
- The backoff is per process. If the worker role ever runs on more than one instance (ADR 0172, 0178), each keeps its
  own, which is still bounded.

## Addendum 2026-10-24: a backfill resumes instead of restarting

The backoff spaced out the retries of a mailbox that could never finish. One prod mailbox had a token that was dead for
two months, so its history id expired. Every pass then fell back to the full backfill. The backfill fetched every message
in the 90-day window again (`messages.get` format=full, 12 at a time), including ones already mirrored, and ran into the
per-minute "Total Query Cost" quota partway through. It threw, and because the page token, the seen ids and the new
history id lived only in local variables and were written at the very end, the next pass started at page 1 again. That
happened 48 times in three days. A quota pause cannot fix a loop whose every attempt costs more than one minute's quota.

`runGmailBackfill` (gmail.service.ts) now drives both the primary Gmail and attached Gmail accounts (ADR 0080 addendum),
which had the same shape:

- **The current historyId is stored first.** `users.getProfile` is read before page 1 and stored as `gmail_history_id`
  (attached: the `sync_cursor` historyId). Incremental sync later resumes from it, so changes made while the backfill ran
  (reads, archives, deletes, new mail on pages already passed) are replayed by History.
- **Progress is saved after every page**: the next page token, the page count, and a fetch/finish phase. For the primary
  Gmail this is the `users.defaults` key `gmail_backfill_progress` (ADR 0255 addendum). For attached Gmail it is a
  `backfill` field in `sync_cursor`. While progress exists, incremental sync does not run; the next pass resumes the
  backfill. A page token that is refused later restarts the listing once from page 1, which costs list calls only.
- **Only messages not already mirrored are fetched.** A message already in `email_messages` keeps its stored labels. To
  keep the commonest gap state correct, the finishing pass lists `is:unread` and `in:inbox` over the window and sets
  `UNREAD`/`INBOX` on mirrored messages to match. That is 5 quota units per 100 ids, against 5 per message to re-fetch.
  Mail trashed during the gap is not a label problem: `messages.list` leaves trashed mail out, so the reverse-delete
  removes it and `recomputeThread` withdraws its suggestions, as before. Other labels (stars, user labels) changed during
  a dead-token gap stay stale: History from the start id does not reach back before the backfill, so only a later change
  to that message corrects them.
- **A quota error pauses rather than fails.** On a rate-limit error the pass keeps what it fetched, saves progress at the
  current page, and returns cleanly with `backfillDone: false`. Nothing is thrown, so no route answers 500.
  `gmail_synced_at` does not move, and `recordSyncPause` sets the quota wait. The wait does not escalate when the pass
  made progress, because a pass that fetched mail is not a repeat failure. The paused pass does not run the AI passes;
  they run when the backfill finishes.
- **The backfill fetches at most 4 at a time** (`min(GMAIL_FETCH_CONCURRENCY, 4)`), down from 12, since it is the call
  site that meets the per-minute quota.
- **The reverse-delete runs only on the finishing pass, and only on a complete snapshot.** The pass re-lists the window,
  which costs list calls only, instead of carrying seen ids across passes. A paused pass, or one cut off by the 20-page
  cap (still a total across passes), deletes nothing.

Same shape elsewhere, left alone: the Outlook delta (`outlook.service.ts`) and the calendar full re-pull also save their
cursor only at the end of a resync. But their pages carry the items inline, with no per-item fetch, so a restart repeats
list pages only, and neither has hit a quota in prod. IMAP already backfills in fixed batches (`IMAP_FETCH_BATCH`) with
`backfill_done = 0` until the last one.
