# ADR 0239 — A to-do due in the future is still owed

**Status:** Accepted (2026-10-11)
**Amends:** [0143](./0143-a-to-do-dies-with-the-email-it-came-from.md),
[0092](./0092-closing-out-stale-todos.md)
**Related:** [0192](./0192-a-to-do-dies-with-the-event-it-was-for.md),
[0215](./0215-a-swipe-can-move-mail-to-trash.md)

## Context

Reported: to-dos with a due date still ahead were showing under **Dropped**,
and a dropped to-do stayed dropped after its due date was moved into the
future.

Nobody dropped them. Three automatic paths set `status = 'archived'`, and none
looked at whether the due date had arrived:

- **The source email was trashed or deleted** (ADR 0143,
  `retireTasksByProvenance`). 0143 read deleting the mail as "the obligation is
  over". That was a fair reading when deleting was rare; ADR 0215 then made
  Trash a swipe, and trashing a message *after reading it* is how many people
  keep an inbox. The to-do was the reason the mail no longer needed keeping.
- **The stale sweep's `live_until` rule** (ADR 0092 rule 2) retired an
  open/active task whose `live_until` had lapsed, whatever its due date.
- The overdue rule (rule 3) cannot retire a future-dated task by construction;
  it is listed only because it is the third writer.

And `updateTask` wrote a new `due_at` without touching `status`, so a to-do
retired by any of the above could not come back by being rescheduled.

## Decision

**A due date that is still ahead is the user's statement that the to-do is owed
until then. Nothing automatic overrides it on age or on trashed mail.**

1. `retireTasksByProvenance` called **without a cutoff** (the email path) skips
   a to-do whose due date is in the future. Undated and already-due to-dos from
   that thread are retired as before.
2. `archiveStaleTasks` rules 2 and 3 skip an open/active task whose due date is
   in the future. Rule 1 (a *completed* task, archived after
   `ARCHIVE_DONE_MINUTES`) is unchanged: that is filing something finished, not
   dropping it.
3. `updateTask`: a **dropped** to-do (`archived`, never completed) given a due
   date in the future becomes `open`, and its `archived_at` is cleared. Only
   when the caller did not also set a status.

"In the future" is decided on the parsed instant (`instantMs`), never on the
text: `due_at` is stored in mixed offsets (ADR 0208).

### Clearing `archived_at`

ADR 0092 keeps `archived_at` set after an un-archive so the overdue sweep fires
at most once per task; without that, a task the user pulled back out would be
re-archived on the next tick. That oscillation cannot happen here: the task is
revived *because* its due date is ahead, so rule 3 cannot match it until that
new date is `TASK_OVERDUE_ARCHIVE_DAYS` past. A new date is a new shelf life,
and the sweep should be able to act on it once.

### What still retires a future-dated to-do

- **A person dropping it** (the row's Drop action, `complete_task` with
  `drop: true`, or any edit that sets the status explicitly).
- **Its event being removed** (ADR 0192). That path passes the event's end as a
  cutoff, so it only reaches to-dos that were *for* the event. "Prepare for the
  water shut-off" should not outlive a shut-off that was taken off the calendar,
  and that is the bug 0192 fixed. Extending the protection there would reopen
  it.

## Consequences

- A to-do mined from an email survives that email being trashed whenever it
  carries a future due date. After the date passes it is subject to the
  ordinary overdue sweep, not retroactively to the trash.
- To-dos already dropped before this change are not revived. Editing the due
  date to a future one brings each back.
- The app's edit handler now applies the status the server returns, since an
  edit can change more than was sent.

## Rejected

- **Blocking a manual drop of a future-dated to-do.** Dropping is how a person
  says the plan changed (ADR 0092); the date does not outrank them.
- **Protecting future-dated to-dos from event removal too.** Reopens ADR 0192.
- **Reviving on any due-date edit**, including a past one. A past date says
  nothing about the to-do being owed again.
- **Reviving completed tasks.** `archived` with a `completed_at` is a finished
  task that was filed; a new date on it is not an instruction to redo it.
- **Keeping `archived_at` on revival.** The revived task could then never be
  retired by the overdue sweep, however long past its new date.
