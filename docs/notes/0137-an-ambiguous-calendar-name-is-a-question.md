# 0137 — An ambiguous calendar name is a question

**Status**: accepted
**Date**: 2026-08-26
**Relation**: finishes what [ADR 0136](./0136-a-device-calendar-is-not-a-push-target.md)
started; takes the exact-name-or-ask posture from
[ADR 0077](./0077-user-declared-email-routing.md) and
[ADR 0094](./0094-symmetric-list-name-resolution.md).

## Context

ADR 0136 stopped a *device* calendar being handed to Google. Asked what now
happens when two calendars share a name, the honest answer was: only half the
ambiguity had been removed.

`matchCalendarByName` ran `.find()` over rows from a query with **no
`ORDER BY`**. Postgres returns rows in whatever order the heap gives, and that
order changes as rows are updated. So with two writable Google calendars named
"Family" — your own, and one a spouse shared with you — which one won was a
coin flip that could land differently between two identical calls.

Two things make that worse than it sounds:

- The result is **cached**. `executor.ts` calls `setGroupDefaultCalendar` right
  after a requested pick, so the coin flip becomes the group's default and
  every later event inherits it. This is precisely the mechanism that made ADR
  0136's bug persist for three days.
- The **substring fallback** widens it: with no exact match, "family" matches
  "Family Trips" *and* "Family Photos", and again first-row-wins.

The failure is quieter than 0136's — the event lands on a real calendar and
syncs — which is exactly why it would never be reported. It is just on the
wrong calendar.

## Decision

**Rank deterministically; ask when the ranking has no answer.**

### Owning a calendar beats being invited to it

`rankSource` orders writable calendars by: owner before writer, then primary,
then id. So "my Family" versus "a Family someone shared with me" is not really
a 50/50 — the one you own wins, outright and repeatably. That resolves the
common real-world shape without troubling the user.

### A genuine tie is a question, not a tiebreak

When the top candidates are *equally* yours — two shared calendars both named
"Family" — there is no defensible winner, so `matchCalendarsByName` returns
`candidates` and no id, and the executor returns `ambiguous_calendar` with an
instruction not to claim the event was created.

That is the same shape ADR 0077 uses for email routing ("the bot asks until the
name is exactly clear — never fuzzy") and ADR 0094 for list names (several
loose matches → `candidates`, ask rather than mint a third list). A calendar is
a stronger case than either: the wrong choice is *also* written to Google and
cached as a default.

A loose match over several names always asks. "family" spanning "Family Trips"
and "Family Photos" has no winner worth guessing at.

### An ambiguous request does not fall through

`resolveTargetCalendarId` could have quietly continued to the group default.
It does not: the user named a calendar, and answering with a different one is
answering a question they did not ask. It returns `primary` plus the
candidates, so a caller that ignores `candidates` still writes somewhere real
rather than failing — but the bot path asks.

## Consequences

- Two same-named calendars now resolve the same way every time, or produce a
  question. Neither outcome depends on row order.
- One extra turn when a name is genuinely ambiguous. That is the cost, and it
  is smaller than an event silently landing on a calendar the user did not pick
  and then *staying* there by default.
- `matchCalendarByName` is kept as a thin wrapper over `matchCalendarsByName`,
  so the callers that only want an id are untouched.
- The REST path (`routes/events.ts`) still takes the id and ignores
  `candidates`; it gets `primary` for an ambiguous name. Worth revisiting if
  that route ever grows a calendar-name field a human types into.

## Alternatives rejected

**Order by id and move on.** Deterministic, one line, and it silently picks a
calendar by alphabetical accident. Determinism is not the same as being right.

**Prefer the most recently used calendar.** Plausible, and it needs history
nothing currently stores — and it would have picked the *wrong* calendar
confidently in ADR 0136's case, since the device row was the one being used.

**Always ask when more than one calendar matches, even by ownership.** Purer,
and it interrupts the overwhelmingly common case where you own one "Family" and
someone shared another.

**Fail the call outright on ambiguity.** The ADR 0100 refuse-and-ask shape. It
is right for a past date, where writing anything is wrong; here `primary` is a
perfectly good answer for a caller that cannot ask.
