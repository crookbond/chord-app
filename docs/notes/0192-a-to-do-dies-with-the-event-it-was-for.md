# ADR 0192 — A to-do dies with the event it was for

**Status:** Accepted (2026-09-21)
**Extends:** [0143](./0143-a-to-do-dies-with-the-email-it-came-from.md) (same
rule, one hop over — the source *event* instead of the source *email*)
**Related:** [0073](./0073-email-delete-archive-convergence.md),
[0092](./0092-closing-out-stale-todos.md),
[0132](./0132-a-to-do-is-not-a-list-item.md),
[0162](./0162-an-event-remembers-what-made-it.md)

## Context

Reported, twice in three days: the morning briefing told the user to *"Prepare
for building water shut off today from 10 AM to 2 PM by setting aside water and
ensuring faucets are off"* — for a shutdown that had already been taken off the
calendar and now sat a week later.

The first report was diagnosed as the event side and fixed as such (5391a3e:
the scan's `find_events` and the nudge-context neighbour query read the user's
own, non-tombstoned rows, not a sibling member's stale copy or a delete waiting
on its Google push). That fix was correct and deployed. It did not fix this,
because **the event was never what the briefing was reading.** The Calendar
screen and the scan both go through `listEventsForUser`, and neither showed the
deleted event. The line came from an open **to-do**.

One building-notice email produced two things, both stamped with the same
`gmail:<threadId>` provenance: a calendar event ("Building water shut off
10 AM-2 PM") and a to-do ("Prepare for the water shut off — set aside water,
ensure faucets are off"). Removing the event retired nothing that hung off it.
The to-do stayed `open`, still due on the day the event no longer occupied, and
`loadScanContext` hands every open to-do to the scan model under `OPEN_TASKS`,
where the model dutifully rendered it as something to do *today*.

ADR 0143 already decided this rule for the source **email**: deleting the mail
is how someone says the obligation is over, so the to-do is retired (`archived`,
not `done`). But an email is not the only thing a to-do can be *for*. When the
mail produced an event, the event is the thing the obligation is attached to,
and removing the event says the same thing.

## Decision

Removing an email-derived event retires the still-open to-dos from the same
thread that were **for** it.

- **Every true removal of an event row** now calls
  `retireTasksForRemovedEvents` (`events/retire-event-tasks.ts`): `deleteEvent`
  (the REST route, the bot's `delete_event`, and the legacy reverse-delete),
  and in the Google pull the cancelled tombstone (`delete-local`), a full-sync
  snapshot that no longer contains the event (`reverseDeleteAbsent`), and the
  user declining the event (the local copy and its keyless email twin). The
  helper reads the row's provenance and times *before* the delete, so it works
  for hard-deleted rows.
- **Narrow, as 0143 is.** Only `gmail:` provenance; only the event owner's own
  `open` to-dos with a null `archived_at` (`active` means someone picked it up,
  `done` is history, and a non-null `archived_at` is ADR 0092's fire-once
  marker). Reuses `retireTasksByProvenance`, which gains an optional
  `dueOnOrBefore`.
- **Only to-dos that were for the event.** An undated one, or one due no later
  than the event's end plus 12 hours of same-day slack. A follow-up due days
  later ("send the building a note about the water damage") survives an event
  that got deleted. An unparseable due date is left alone.
- **A twin cleaned up by hand is not a cancelled meeting.** If a live, non-
  cancelled event from the same email for the same owner still starts within
  the slack window, nothing is retired.
- **`archived`, not `done`** — ADR 0092's reasoning, unchanged.
- **Best-effort.** Every caller is a delete path that must finish; a failure
  here logs a warning and is swallowed. Retired tasks broadcast
  `SSE.taskUpdated` on their group, as ADR 0143's caller does.

### A side effect on the briefing that has to be fixed with it

The briefing closes with *"retired N to-dos that were more than a week past
their date"* (`RETIRED_TODOS`, "never omit"). It counted every archived, dated
task archived in the last 24 hours. A to-do retired because its source went
away is archived and dated too, but was never a week overdue — so the new
retirement (and ADR 0143's, which had the same latent problem) would make that
line false at precisely the moment the user is watching for it. The count now
includes only rows the overdue sweep retired: due at least
`TASK_OVERDUE_ARCHIVE_DAYS` before they were archived.

## Alternatives considered

- **Filter the to-do out of the briefing at render time when its event is
  gone.** The event row is *hard-deleted* on most paths (`deleteEvent`, the
  Google pull), so at render time there is nothing to compare against — the
  only moment the link between the to-do and its event can be read is the
  moment of removal.
- **Retire every to-do from the thread regardless of due date.** Simpler, and
  wrong for an email that yields an event plus an independent obligation
  ("sign and return the permission slip by Friday" beside "field trip Tuesday"):
  dropping the event from the calendar is not dropping the slip.
- **Retire on any event edit, including a reschedule.** Not built; see below.
- **Add a `source_event_id` on tasks.** A new column and a backfill to
  re-derive what provenance + a due-date window already answers, and it would
  not cover to-dos confirmed before it existed — the ones in the wild now.
- **Filter or de-emphasize tasks in the scan prompt.** The model was doing what
  it was told with what it was given; the data was wrong.

## Consequences

- **Not retroactive.** To-dos already orphaned by a past event deletion stay
  open until the user closes them (Drop in the ⋯ sheet) or ADR 0092's sweep
  retires them a week after their due date. There is no event row left to
  derive the link from, and guessing one from titles is the failure this ADR
  avoids.
- **A rescheduled event is not handled.** Moving an email-derived event leaves
  its prep to-do due on the old date — the same class of stale line, from a
  different action. The natural rule is to shift the to-do with the event
  rather than retire it (a rescheduled prep is still owed), but that guesses at
  what the user meant and wants its own decision.
- The slack window and the "live copy remains" check are heuristics with
  tests on both sides; an unusual case (a same-thread follow-up due within
  12 hours of the deleted event's end) is retired. Recoverable: it lands in
  To Do's → Archived, and ADR 0092 never re-stamps it.
- Chat- and attachment-derived events (`chat:` / `attachment:` provenance) are
  untouched — the pairing this addresses is specific to mail, where one message
  routinely yields both an event and an obligation.
