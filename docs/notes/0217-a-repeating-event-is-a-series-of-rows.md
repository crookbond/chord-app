# ADR 0217 — A repeating event is a series of rows

**Status:** Accepted
**Date:** 2026-09-28
**Amends:** ADR 0040 (reverses decision 3, "recurrence: deferred")

## Context

Prod, 2026-09-28: "Add to calendar - recurring - nolan sci oly at
330-530pm weekly" produced one event on one Wednesday, and the bot said
"Added a weekly recurring event". Asked again ("This should recur
weekly"), it created a second one-off event under a different title and
said it was now set to recur. Nothing in Chord could represent a repeat:
the chat tools had no field for it, `createEvent` never wrote the reserved
`events.recurrence` column, and the Google push never sent a rule. The
model had nowhere to put "weekly", and the tool reply did not say so,
which is the ADR 0102/0188 failure.

Checking the pull found an older, silent bug with the same root. Google
returns a series as one item per occurrence (`singleEvents=true`), each with
its own id but all sharing the series' iCalUID, and `findLocalCopy` matched
on iCalUID. Each occurrence overwrote the previous one's row, so any weekly
event made in Google (practice, a standing meeting) appeared in Chord, the
briefing and the conflict checks exactly once.

## Decision

1. **A series is its own row; its occurrences are ordinary event rows.**
   New `event_series` table (the rule, the first start, the zone the rule
   runs in, exceptions, Google master id). Occurrences are materialized
   into `events` with `series_id` and `original_start`, ahead to the same
   horizon the Google pull covers (365 days), and topped up as time
   passes. Every reader (calendar screen, briefing, conflicts, search,
   Apple mirror) keeps reading rows and needs no change: that is the
   reason for materializing rather than expanding at read time.
2. **Each occurrence has its own `ical_uid`** (`<series uid>:<start>`),
   shared only by the family members' copies of that one occurrence.
   `updateEvent`/`deleteEvent` fan out by `ical_uid`, so a shared uid
   would make "move this Wednesday" move every Wednesday. The pull and the
   push no longer overwrite an occurrence's uid with Google's (the series
   master's, identical across every occurrence).
3. **Google gets a real series.** The push inserts one master event with
   `recurrence: ['RRULE:…', 'EXDATE;TZID=…:…']` and a named `timeZone`, so
   the repeat holds its wall-clock time across daylight saving. Occurrence
   rows are not pushed on their own; Google expands the master, and the
   pull **adopts** each instance onto the matching row by (series master
   id, original start). After adoption an occurrence edit or delete is an
   ordinary instance write.
4. **The pull matches an instance by its own id, never by the shared keys.**
   An item with `recurringEventId` matches its row by `gcal_event_id`, or
   by master id + original start for a Chord series; iCalUID and chordUid
   are skipped for it. A migration clears the stored Google sync cursors
   once, so the next pull is a full one and the collapsed series come back
   as separate rows.
5. **The rule is a small vocabulary, built by the server.** The model
   passes `repeat: { frequency, interval?, weekdays?, monthlyWeek?,
   until?, count? }` (daily / weekly on days / monthly on a date or an
   Nth weekday / yearly), never a raw RRULE. What it cannot say, it
   cannot claim.
6. **"This one" or "all", and the bot asks when it is unclear.** Editing or
   deleting an occurrence takes `scope: 'this' | 'all'`; with no scope on
   a repeating event the tool refuses with `scope_required` and the bot
   asks, the shape ADR 0094 uses for an ambiguous list. "This one" edits
   the occurrence row; deleting it adds an EXDATE to the series, so the
   rule never regenerates it and Google drops it too. "All" edits the
   series and Google master and regenerates the upcoming occurrences;
   deleting all removes the series, its occurrences and the Google master.
   `update_event` with `repeat` turns an existing one-off event into a
   series in place (the answer to "this should recur weekly"), rather
   than creating a second event.
7. **The tool reply says what was stored**: "repeats weekly on Wed until
   …" or "one-off". The bot has no other source for the claim.

## Alternatives considered

- **Expand at read time from the rule** — one row per series, every
  reader taught to expand. Calendar, briefing, conflict checks, search,
  the Apple mirror and the email context blocks would each need it, and
  a reader that forgot would show a repeating event once: the bug the
  pull already had.
- **Let Google own series and pull them in** — only works for users with
  Google Calendar connected, and the event would not exist in Chord until
  the next pull.
- **Accept a raw RRULE from the model** — the model can then claim any
  rule, including ones we cannot expand; a structured field keeps what is
  sayable equal to what is stored.
- **"This and following"** — Google splits the series into two masters.
  Not needed for the requests seen so far; "all" plus editing single
  occurrences covers them.

## Consequences

- A series longer than the horizon is materialized as time passes (the
  proactive tick tops it up); a rule with no end is fine.
- An occurrence edited in Chord before Google has expanded the master is
  held locally and pushed once the pull adopts it.
- Editing "all" regenerates only upcoming occurrences. Past ones keep what
  they were, and an occurrence someone changed individually keeps its
  change only until an "all" edit.
- Series made in Google stay Google's: Chord now shows every occurrence
  and edits them one at a time, but does not own their rule.
- A group event that repeats fans out like any group event (ADR 0040 §7):
  one series per member, linked by a shared `series_uid`.
- A Chord series deleted wholesale in Google comes back as its instances
  being cancelled, which removes the occurrences Chord had adopted; but the
  pull never sees the master, so occurrences Chord writes later by top-up
  have no Google counterpart. Deleting a series in Chord is the supported
  path.
- Invitees on a repeating event are sent per occurrence, not on the
  master (an ADR 0157 guest added to "this one" gets that one). Inviting
  someone to a whole series is not built.
- Calendar rows of a series show "↻" after the title. There is no repeat
  editor in the app; repeating is set and changed from chat.
- Found in the same code: a cancelled recurring invite (`METHOD:CANCEL`,
  ADR 0074) cancels every row sharing its UID, which is right for the whole
  series and too wide for a single cancelled occurrence. Unchanged here.
