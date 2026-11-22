# ADR 0143 — A to-do dies with the email it came from

**Status:** Accepted (2026-08-31)
**Supersedes in part:** [0073](./0073-email-delete-archive-convergence.md) (the
"created entities are never touched" half, for tasks only)
**Related:** [0092](./0092-closing-out-stale-todos.md),
[0132](./0132-a-to-do-is-not-a-list-item.md),
[0137](./0137-a-proactive-message-is-not-always-the-briefing.md)

## Context

Reported: *"if mail is read and deleted anywhere else, to-dos from that should
be assumed completed — it should not even enter to-do ideally."*

Two different defects, and reading them apart is what made the fix small.

### 1. Deleting the mail did not retire the to-do it had already produced

ADR 0073 decided that a whole-thread trash retracts the thread's **pending**
proposals and that *"decided proposals + created entities never touched"*. So
`retractByProvenance` filters `status = 'pending'`, and a to-do the user had
already confirmed outlived the deletion of the mail that justified it — with no
way to find it and no event that would ever clear it.

0073's reasoning is right for most of what the email pipeline creates. A saved
place, a calendar event, an imported attachment: these are **records of
something**, and a record reasonably outlives its source.

A to-do is not a record. It is an **outstanding obligation** — the one entity
type whose entire value is that it is still owed. Deleting the email is the
most direct way a person says the obligation is over, and it is a signal we
already receive, already act on for the pending half, and were discarding for
the confirmed half.

The enabling fact was already in place and easy to miss: `create_task` writes
`sourceRawContext: provenance` (`executor.ts`), so an email-derived task
carries `gmail:<threadId>` in `tasks.source_raw_context`. The link existed;
nothing read it.

### 2. Settled mail became fresh obligations in the first place

The magics candidate query filtered on `is_archived = 0` and nothing else about
whether the mail had been dealt with. It had **no age bound and no read-state
filter**, while `GMAIL_BACKFILL_DAYS` is **90**.

So connecting a mailbox mined a quarter of a year of already-handled inbox —
every read-but-not-archived thread, which is how most people leave mail — into
brand-new to-dos. This is the same shape as ADR 0137's past-dated events, which
`shouldStageEventProposal` now refuses; but that guard keys on the event's
`startsAt`, and a `create_task` (ADR 0132) frequently has no date at all, so
nothing caught it.

## Decision

### A deleted thread retires the open to-dos it produced

`retireTasksByProvenance` sets matching tasks to **`archived`**, and
`recomputeThread`'s two deletion paths now call one `retireFromDeletedThread`
helper that does both halves.

**`archived`, not `done`** — deliberately against the wording of the request.
ADR 0092 made dropping first-class precisely because forcing abandonment
through `done` corrupts the completion signal, and nobody did this task: the
reason to do it went away. The user-visible outcome is identical (it leaves the
list); what differs is what the row afterwards *means*, and the briefing and
archive policy both read that.

The match is deliberately narrow — **`open` only, with a null `archived_at`**:

- `active` means a person picked it up. Their work is not ours to cancel.
- `done` is history.
- A non-null `archived_at` is ADR 0092's marker that the overdue sweep already
  retired this task once. Re-stamping restarts a clock built to fire exactly
  once, which is the open↔archived oscillation that ADR documents.

Scoped by `created_by` as well as provenance. Thread ids are opaque per
mailbox, so a cross-user collision is unlikely rather than impossible, and this
writes into groups other people can see.

Archive (as opposed to delete) still keeps everything, exactly as ADR 0073
decided. Archiving is filing; it is not a statement that the thing is done.

### Mail already read and left sitting is not mined

The magics candidate query gains one predicate: a thread is minable when it is
**unread OR newer than `EMAIL_MINE_READ_MAX_AGE_DAYS`** (default 7).

The rule is the *combination*, and each half matters:

- **Unread at any age is always mined.** Nobody has looked at it, so its
  obligation is still owed. An age-only cutoff — the obvious version — would
  drop exactly the mail most likely to still need action.
- **Read but recent is still mined.** Reading the school email this morning
  does not mean the slip is signed.
- **Read and old is history.** Leaving mail read and un-archived for weeks is
  how people signal they are done with it.

Set far below `GMAIL_BACKFILL_DAYS` on purpose: that window exists so search
and context have history, which is a different job from deciding what someone
still owes. Kept as an env var rather than a constant so a deployment can tune
it — a missing suggestion is otherwise indistinguishable from a model that
declined.

Applied to **magics only**, not to person extraction (ADR 0076). An obligation
goes stale; a fact does not. Learning someone's spouse's name from a month-old
read email is still true.

The skipped thread is **not** marked extracted. The mark is once-ever, so
burning it would mean a deployment that later widens the window never revisits
the mail.

## Consequences

- Confirming a to-do and then deleting the mail now clears the to-do. Someone
  who deletes mail as a filing habit *and* wants the to-do will lose it — the
  deliberate direction, since the reported failure is a pile of to-dos nobody
  can close.
- The first sync after connecting a mailbox produces far fewer suggestions.
  Threads read within the last week still yield them.
- A genuinely-still-owed obligation sitting in mail read 8 days ago is now
  missed. Accepted: a missed suggestion costs a search, a false to-do costs
  trust — the same asymmetry ADR 0133 chose on tracking numbers.
- Found and removed in passing: `minablePredicate` was applied **twice** in the
  same query (identical block, ANDed with itself). Harmless, but it is the kind
  of duplication ADR 0085 keeps having to warn about.

## Rejected alternatives

- **Marking the to-do `done`.** What was asked for, and it corrupts the
  completion signal ADR 0092 exists to protect. `archived` is indistinguishable
  to the user and honest in the data.
- **Retiring `active` and `done` tasks too.** Someone picked those up; deleting
  an email is not authority to cancel another person's work in a shared group.
- **A new `tasks.source_thread_id` column.** `source_raw_context` already holds
  the provenance string, written by the same executor path for every tool. A
  second column is a second thing to keep true.
- **Reacting to *archive* as well as delete.** ADR 0073 already decided archive
  keeps the proposal, and it is right: archiving is filing, and plenty of people
  archive the mail precisely *because* they have logged the task.
- **An age-only cutoff on mining.** Simpler, and it drops old unread mail —
  which is the mail most likely to still need action.
- **Retro-retiring the to-dos already piled up from past backfills.** Their
  source mail mostly still exists, so there is no signal to act on; the ADR 0092
  archive policy and the ⋯-sheet Drop are the exits for those.
