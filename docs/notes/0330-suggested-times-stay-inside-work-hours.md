# 0330 — Suggested times stay inside work hours

- Status: accepted
- Date: 2026-11-10
- Amends: ADR 0197 (availability rendering), ADR 0244 (asked-time verdicts), ADR 0245 (away days)

## Context

Owner report: "in suggested times, we treat Sundays as free." The
availability lines the reply drafter and `get_my_availability` read
(`availability.service.ts`) said only what was on the calendar - "Sun, Nov
15: nothing scheduled" - and the prompt's "roughly 8 AM-7 PM on weekdays"
was a hint the model did not reliably follow. An empty Sunday read as the
freest day of the week. Nothing knew when the user works, and there was no
way to tell Chord.

A second ask came with it: the order of what to suggest. (1) If the sender
asked about a time and it works, confirm it. (2) Otherwise offer the
closest next free times, not three picked anywhere in the fortnight.

## Decision

**Work hours are a per-user default** (`users.defaults` key `work_hours`,
ADR 0255 addendum; `work-hours.service.ts`): work days, a start and end
(minutes after local midnight), and whether public holidays are off. Unset
= Monday-Friday, 9:00 AM-5:00 PM, holidays off. The rules are pure, in
`kernel/src/work-hours.ts` (tested): `workDayOf(day, tz, hours)` answers
"work day, with this window" or "not a work day, because Sunday / holiday:
Thanksgiving Day".

**Holidays are the US federal list, as observed** (a Saturday holiday on
the Friday before, a Sunday one on the Monday after), computed per year,
applied only when the user's zone is a US zone. Columbus Day and Veterans
Day are on it (they are federal); many employers work them, and a user who
does says so with `observeHolidays: false` - there is no per-holiday
switch. A non-US zone gets no holidays rather than the wrong country's.

**Every day line leads with the work fact**, first on the line (ADR 0245's
lesson: the model reads the first words):

- `Mon, Nov 16: work hours 9:00 AM–5:00 PM, free in work hours: 11:00 AM–12:00 PM, 1:00 PM–5:00 PM; busy 10:00 AM–11:00 AM, …`
- `Sun, Nov 15: NOT A WORK DAY (Sunday); nothing scheduled`
- `Thu, Nov 26: NOT A WORK DAY (holiday: Thanksgiving Day); nothing scheduled`

The free stretches inside work hours are worked out in code, as ADR 0244
did for asked times. The busy blocks stay on the line: `/plan` (ADR 0299)
reads the same lines and a Sunday plan is still a real plan.

**The closest free times are computed, not chosen**: `nextFreeText` lists
up to three free work-hours times, soonest first, one per free stretch
(three back-to-back half hours of one gap are one option, not three),
rounded to :00/:30, each long enough for the meeting (an offered window's
length up to two hours, else an hour). It searches from the first time
asked about, else now, up to 14 days, skipping non-work days; an AWAY day
keeps its tag (a call can still go there).

**An asked time keeps its verdict**: FREE/BUSY/PARTLY FREE is still the
calendar's answer, and a note follows it - `; OUTSIDE WORK HOURS (not a
work day: Sunday)` or `; partly outside work hours (9:00 AM–5:00 PM)`. A
family brunch on Sunday is fine; a work call is not; the drafter decides
from the thread.

**Prompts state the order**: both composers and `get_my_availability`:
(1) an asked time that is FREE (and in work hours, for a work meeting) -
confirm it and stop; (2) otherwise offer the first two or three closest
free times. Times the model proposes itself come only from "free in work
hours", never a NOT A WORK DAY line, unless the thread or instruction is
plainly personal or asks for evenings/weekends.

**Chat**: personal-only `set_work_hours { days?, start?, end?,
observeHolidays? }` (calendar tool group). Omitted fields are left alone
(models fill optional fields, ADR 0229, so a patch must not reset what was
not said); no fields reads the current hours. Bad day names, a time not
`HH:MM`, or an end not after the start change nothing (`ok: false`).
`get_my_availability` returns `workHoursText`, saying whether the hours are
the user's or the default. No Settings screen yet.

## Consequences

- Every day line's text changed; tests that pinned the old "Mon, …:
  nothing scheduled" shape were updated (the ADR 0245 tests, whose dates
  move with today, now accept any work-hours lead).
- One window per day; no split shifts, no overnight hours, no lunch break.
- Holidays: US only, and all eleven federal ones or none.
- Not read: the user's own holiday calendar (Google's holiday feeds mix
  observances such as Halloween with days off), out-of-office events.

## Rejected

- Prompt wording alone ("weekdays only") - it was already there and the
  model offered Sunday anyway.
- Marking non-work time as busy - it would make `/plan` and personal
  questions ("am I free Sunday?") wrong.
- Reading holidays from a subscribed holiday calendar - observances are not
  days off, and most users have none.
- A Settings editor in this change - the owner asked for a chat tool; the
  service function is ready for one.
