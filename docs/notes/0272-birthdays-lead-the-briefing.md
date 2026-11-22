# 0272 — Birthdays and anniversaries lead the briefing

**Status:** Accepted, 2026-10-19

## Context

The owner asked that birthdays and anniversaries found in the calendar, in
reminders or in email always appear at the top of the morning briefing.

Before this, they reached the briefing in one way only: `IMPORTANT_DAYS`, built
from saved People rows (ADR 0016), handed to the model as one item among
eight in the scan prompt. So:

- a birthday that exists only on the calendar ("Ben's birthday", e.g. from
  Google's Birthdays calendar) was an ordinary event, bucketed by date beside
  the dentist;
- a to-do about one ("buy Ella's birthday gift") was an ordinary to-do;
- an email about one ("Ella's 7th birthday party!") never reached the
  briefing body at all, unless the email digest happened to list it;
- even a People birthday appeared wherever, and whether, the model put it.

## Decision

A deterministic section, built in code, is placed at the very top of the
morning message, above the weather:

```
🎂 Birthdays & anniversaries:
• Today — Ben's birthday (to-do: Buy Ben's birthday gift)
• Sat Oct 31 (in 12 days) — Mom — anniversary
• In your email — "Ella's 7th birthday party!" from Evite
```

`services/briefing/celebrations.ts` collects from four sources:

- **People** important dates of kind birthday/anniversary, next 14 days;
- **calendar** events whose title says birthday/bday/anniversary, next 14 days
  (the user's own day, `dayOf`);
- **open to-dos** with such a title, due in the next 14 days or undated;
- **email** threads from the last 14 days whose subject says so, not archived,
  not trash/spam, not bulk by either signal (ADR 0109/0110), at most 3.
  Subjects are sealed at rest (ADR 0201), so they are matched in code, not SQL.

Mentions of the same day are merged: People and calendar entries are the day
itself (same kind, same date, same first name = one line); a to-do or email
that names the same person attaches to that line as a note, otherwise stands
alone. "Whose day" is the first non-filler word of the title, used only for
merging, never printed.

The scan prompt still receives `IMPORTANT_DAYS` (so it can reason about gift
or RSVP prep) but is told the system already prints every birthday and
anniversary above its text and must not list them again.

The WhatsApp template's heads-up slot (ADR 0091) and the gated teaser
(ADR 0079), which render from `buildBriefingFacts`, now lead with the same
list instead of People rows alone.

## Consequences

- The section is shown even when the model answers "Nothing on the calendar
  needs attention today" — the birthday is still the first line.
- Keyword matching is English-only and can match an "Anniversary sale" email
  that was not marked bulk. Bulk mail is excluded, which catches most.
- `listImportantDayOccurrences` still computes "today" on the server clock;
  the collector filters by the user's day, but a recurring date on the user's
  today can be missed when the server's date has already rolled over (a
  briefing fires at ~07:00 local, so in practice this does not bite). Left as
  is.

## Rejected

- **Telling the model to put them first.** Prompt-only placement is what we
  had; ADR 0100/0102 show the model needs a code-side guarantee.
- **Creating People rows from calendar/email birthdays.** A write the user
  did not ask for; the briefing only needs to read them.
- **A model pass to find birthdays in email bodies.** Costs an LLM call for a
  subject-line signal that is almost always there.
