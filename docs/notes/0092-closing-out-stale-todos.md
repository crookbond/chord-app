# 0092 — Closing out stale to-dos: dated work retires itself, undated work never does

**Status**: accepted
**Date**: 2026-08-21
**Relation**: narrows the auto-archive half of [0009](./0009-consensus-before-commit.md)'s
staging model; implements §6.2 of
[`../references/chord-spec-v4.md`](../references/chord-spec-v4.md), which was
specified in the demo build and never carried into the Postgres codebase.

## Context

Open tasks accumulated without bound and were read back to the user every
morning indefinitely. Three symptoms were reported: to-dos well past their
date, to-dos derived from email, and months-old items with no due date at all.

Tracing all three, only one is a real defect.

**Email is not leaking.** A thread is mined *once ever*. `runEmailMagics`
anti-joins `email_extraction_marks` (ADR 0076) and calls
`markThreadExtracted` unconditionally at the end of every loop iteration —
including after an exception. Marks are never deleted anywhere in the
codebase, and survive a mirror wipe by design. A rejected or expired email
suggestion therefore cannot be re-proposed.

**Proposals are not leaking.** They carry a 72h TTL (ADR 0009 §4, raised from
24h on 2026-07-16), `expireStale` flips them on every list read, and the
briefing section is capped at `BRIEFING_PROPOSALS_MAX`.

**Tasks were the whole problem.** A confirmed suggestion becomes an ordinary
task, and a task had exactly two exits: `done`, or hard delete.
`archiveStaleTasks` deliberately refused to touch overdue work — a rule
asserted in three places (the `ARCHIVE_DONE_MINUTES` env comment, a comment
in the sweep itself, and a regression test named
`no-auto-archive-overdue`) and **backed by no ADR**. Meanwhile the morning-scan
prompt instructed the model to surface anything *"already overdue"* over an
unsorted, untagged 30-row dump ordered by `created_at`. Nothing decayed, and
nothing could be closed except by claiming it was finished.

The rule was well-intentioned — "only the user closes work" — but it was half
a policy. It withheld the automatic exit without supplying a manual one, and
paired that with a briefing that re-read the backlog daily.

## Decision

Split the population by whether the task carries a **due date**. A deadline is
the user's own statement that the item has a shelf life; its absence is not.

### 1. Dated work retires itself

`archiveStaleTasks` gains a third rule: archive an `open`/`active` task whose
`due_at` is more than `TASK_OVERDUE_ARCHIVE_DAYS` (default 7) in the past.

Two qualifiers, both from spec §6.2:

- **A pending reminder defers it.** Never retire something we are about to
  ping about (`remind_at IS NULL OR remind_at < now`).
- **It fires at most once per task** (`archived_at IS NULL`). If the user
  pulls an item back out of Archived, we never overrule them again.

That second guard is load-bearing beyond politeness: without it, reopening a
long-overdue task re-archives it on the next tick — the same open↔archived
oscillation that the `completed_at` keying was written to prevent for done
tasks. It also removes any need for an `updated_at` column, which `tasks` does
not have.

### 2. Undated work is never auto-closed

An undated task is never archived by age, however old. "Renew passport" typed
once and ignored for a year is still work the user means to do. The original
principle survives intact for exactly the population where it was right.

### 3. The briefing stops nagging

- The 30-row context query orders by `due_at ASC NULLS LAST` instead of
  `created_at DESC`. The budget was being spent on whatever was typed most
  recently, which pushed genuinely dated work out of the briefing entirely.
- Rows are tagged `[OVERDUE]` / `[STALE]` the way events, trips and important
  days already are, rather than handing the model raw ISO strings and asking
  it to compare dates itself.
- The prompt now collapses `[STALE]` items into at most one counted line, and
  treats an undated task as a someday item.

Because rule 1 retires dated items at 7 days, "already overdue" is now bounded
to a one-week window by construction.

### 4. Dropping is a first-class outcome

`archived` records "not going to do it". The ⋯ sheet gains **Drop (keep in
Archived)**, and `complete_task` gains `drop: true` — same resolution path,
terminal status `archived` instead of `done`. Forcing abandonment through
"done" would corrupt the completion signal.

`superseded` stays unwritten. It has no writer today and adding a second
closed-state vocabulary buys nothing until something needs to tell the two
apart.

### 5. Staleness becomes visible

The task row never rendered `dueAt` at all — the meta line showed only
relative created time, creator and group. It now shows the due date and
"N d overdue". Tasks more than `TASK_STALE_MS` (48h) past due sort to the
bottom of the active list and render muted: not closed, just no longer
competing for the top of the screen. The threshold lives in `kernel/` so the
server's tagging and the client's styling cannot drift.

## Alternatives considered

- **Auto-archive by age regardless of due date (rejected).** Sweeps up
  precisely the long-lived intentions a family assistant exists to hold.
  The due date is the only signal the user actually gave us about shelf life.
- **Propose a batch cleanup through the ADR 0009 proposal machinery
  (rejected for now).** Preserves "only the user closes work" perfectly and
  reuses the TTL/confirm surface — but it answers a daily nag with a weekly
  nag, and the confirm burden scales with the backlog it is meant to clear.
  Worth revisiting if auto-archive proves too blunt.
- **Add `updated_at` and archive on "untouched for N days" (rejected).**
  Needs a migration, and "untouched" is the wrong predicate: a task you reread
  and dread every week is untouched by that definition.
- **Hard delete (rejected).** Destroys the audit trail and any recovery.
- **Stop at "stop nagging" without any auto-archive (rejected).** The list
  stays long forever; "Open tasks go well past the current date" would remain
  literally true.

## Consequences

- **The first sweep after deploy is large** — it clears the whole accumulated
  backlog in one tick. The count is logged, and the next briefing names it, so
  the list does not silently empty. Everything is recoverable from the
  default-open Archived bucket.
- **The notice has to reach three surfaces, not one.** `RETIRED_TODOS` in the
  scan context only covers the LLM briefing. ADR 0091 landed in parallel and
  routes the ADR 0079 gated teaser and the out-of-window WhatsApp template
  through `buildBriefingFacts` instead, which never reads that context — so
  the same count is computed there too and **folded into the existing tasks
  line** rather than given a field of its own: the approved Meta template has
  exactly five body variables and a sixth would need re-approval. The tasks
  fact is emitted even when no open work remains, since an empty list plus
  silence is exactly what reads as data loss.
- **A dated item you genuinely still intend to do will be archived** a week
  past its date. Recovery is one tap, and the once-only guard means it stays
  recovered. This is the accepted cost of the dated/undated split; the escape
  hatch is to clear the due date rather than to keep missing it.
- `archiveStaleTasks` now filters in SQL rather than pulling every non-archived
  task into memory on every scheduler tick.
- `updateTask` stamps `archived_at` on the transition into `archived`, and
  deliberately does **not** clear it on un-archive — that non-null value is
  what the once-only guard reads.
- Archived tasks stay out of the user-facing flat search (which already
  excluded them) and remain visible to the bot's rich `search` tool, so recall
  is unaffected.
- The regression test `no-auto-archive-overdue.integration.test.ts` is replaced
  by `task-archive-policy.integration.test.ts`. Its two live regressions (done
  keys off `completed_at`; reopen clears `completed_at`) are preserved.

## Addendum 2026-08-22 — the Tasks tab sorts by due date

The briefing's context was reordered `due_at ASC NULLS LAST` here; the Tasks
tab was not, and still opened newest-created-first. So the surface a person
actually looks at buried the thing due tomorrow under whatever was captured
most recently — the same starvation this ADR fixed for the model, left in
place for the user.

`applySort` gains a `due-asc` key and Tasks defaults to it (the chip reads
"Due"; Latest / Oldest / A–Z remain). Undated rows sort **below** every dated
one rather than at an implied infinity, keeping their own newest-first order —
the same NULLS LAST rule, and the same reasoning: nobody gave them a deadline,
so they must not sort as though they had one.

The stale sink survives and still wins. Sorting runs first, then the >48h-past-
due rows move to the bottom of the active list, so "closest first" orders live
work while a week-old dread pile stays out of the way. Strict due-ascending
would put the most overdue row at the very top, which is what §6.2 rejected.

Lists and Saves already ordered by creation date, newest first; unchanged.
Trips already hid finished trips behind `isTripArchived` (a trip ending
*today* is still live), but rendered them in full above the live ones and
relied on an auto-scroll to move past them — `measureLayout` is allowed to
decline, and when it did the tab opened on somebody's history. Past trips now
collapse behind a `▸ Earlier trips · N` disclosure, the same idiom as Done.

## Addendum (2026-08-23) — a ticked list item sinks too

Tasks got a Done fold in this ADR; **list items** did not, and they are the
other half of the same complaint. A `list_item` has no status and no exit — it
is checked or it is not — so a ticked one stayed exactly where it was, between
the things still to do. On a list the bot keeps appending to, the finished
half is also the *older* half, so it accumulated at precisely the top of the
card: the four-line "To-dos" a user actually reads sat under a dozen struck-out
lines they had already dealt with.

Checked rows now sort to the bottom of their card, each half keeping the
list's own order (oldest first, as the server returns items). **No fold.** A
task is a paragraph and worth hiding; a list item is one line, and seeing what
was done is half of why people keep the list. The Tasks tab's disclosure earns
its place, this one would not.

The card header reads `N left · M done` once anything is ticked (plain
`N items` otherwise), and the Lists tab badge counts only unchecked rows — the
same rule that made the Tasks badge count live work only. A badge that never
falls when you tick things off is a badge nobody reads.

One consequence for clustered cards (ADR 0094): the merged row's checked state
is now the **AND** across copies, not the lead's. A row still open in another
group is still to do, so it must neither strike through nor sink — the
most-open-wins rule the Tasks tab already merges by. The toggle takes its
target from that merged value, which is also what keeps two opposite-state
copies from swapping on every tap.
