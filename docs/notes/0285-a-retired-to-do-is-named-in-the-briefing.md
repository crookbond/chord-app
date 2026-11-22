# 0285 — A retired to-do is named in the briefing, with why

**Status:** Accepted, 2026-10-22. Extends ADR 0092 (the overdue sweep owns up
to what it retired), ADR 0143 and ADR 0192 (a to-do goes with its email or
event).

## Context

Chord takes to-dos off a list on its own in four ways: the overdue sweep
(ADR 0092, a week past due), a to-do whose `live_until` passed, one whose
source email was deleted (ADR 0143) and one whose calendar event was removed
(ADR 0192). ADR 0092 promised the briefing would own up to the first, as a
count: the scan context carried `RETIRED_TODOS: N` and the prompt asked the
model never to omit it.

That was not enough to know what happened. The count named nothing, so a user
could not tell which to-do went. A count asked of a model is not a
guarantee (ADR 0100/0102). And the short briefing (WhatsApp template, the
gated teaser) counted every dated to-do archived in the window as "past-due
retired": that took in the user's own Drop and a to-do whose email went away,
neither of which was past due.

Nothing in the row said why it was archived. The sweep, the email/event
retirement and the user's Drop all wrote the same `status = 'archived'`.

## Decision

**Record why, at the moment of archiving.** `tasks.archived_reason`
(migration `119`): `overdue` / `expired` / `email_gone` / `event_gone` from
Chord, `dropped` / `completed` from the user. The three writers set it: the
sweep per row (a done task being filed is `completed`, a passed `live_until`
is `expired`, else `overdue`); `retireTasksByProvenance` (`event_gone` when
called with a cutoff, which only event removal does, else `email_gone`);
`updateTask` sets `dropped` on a transition into `archived` and clears it on
the way out (and on ADR 0239's revival by a future due date).

**The briefing names them, printed by code.** `retiredTodosSince`
(`briefing/retired-todos.ts`) reads the to-dos archived in the last 24 hours
with a Chord reason, one line per to-do (copies in several groups are one),
and `renderRetiredSection` prints them under the model's sections: "🗂 Taken
off your to-dos" with each title and why ("more than a week past its date",
"its time ran out", "its email was deleted", "its calendar event was
removed"), eight shown and the rest counted. It counts as news for the
greeting. The model no longer sees `RETIRED_TODOS` and the prompt rule is
gone. The short briefing gives the count of the same set and names the first
("2 taken off your list (Pay the CVS bill +1 more) — see Archived"), since the
approved WhatsApp template has one line for to-dos.

**A to-do the user dropped or finished is not reported.** They did it.

**Not backfilled.** A row archived before migration 119 has no reason. It is
reported only when the old overdue rule fits it (due a week before it was
archived); otherwise nothing can say whether Chord or the user did it.

## Consequences

- A to-do retired because its email or event went away is now reported,
  where before only the short briefing counted it, as "past-due".
- The To Do's Archived tab could show the same reason; not done here (see
  the addendum).

## Rejected

- **Keeping a count for the model to mention.** The count named nothing and
  depended on the model obeying.
- **Inferring the reason from dates.** A Drop and an email retirement look the
  same afterwards; only the writer knows.
- **Listing the user's own Drops too.** Telling someone what they just did is
  noise, and it was the source of the wrong "past-due" count.

## Addendum 2026-10-22 — the app and chat say why too

The reason was recorded but never left the server, and the briefing pointed
to "To Do's → Archived" while the app labelled the section **Dropped**.

- `Task.archivedReason` (kernel) comes back on every task read
  (`rowToTask`). The type `TaskArchivedReason` lives in kernel; the server
  schema re-exports it rather than keeping a copy.
- One wording for both surfaces: `archivedReasonText` and `retiredByChord`
  in `kernel/src/types/task.ts`. The briefing section uses them, and so does
  the app.
- The Tasks tab's **Dropped** section is renamed **Archived**, since it now
  holds both what the user dropped and what Chord retired. Each row there
  says "Archived: <why>" ("you dropped it", "its email was deleted", …). A
  to-do archived before migration 119 shows no reason line. The briefing now
  points to "To Do's → Tasks → Archived".
- `list_tasks` rows carry `archivedBecause` in the same words, so "why did
  that to-do go?" has an answer in chat. Read-only: no new tool.
