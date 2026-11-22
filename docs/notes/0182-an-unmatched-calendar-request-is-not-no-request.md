# 0182 — An unmatched calendar request is not no request

**Status**: accepted
**Date**: 2026-09-17

## Context

Prod (`ownertest@gmail.com`): asked to add "Appointment at Lenox Hill
Radiology" to the personal calendar, the bot replied "Added your
appointment ... to your personal calendar" — and the event landed on the
Family calendar instead.

Two composed defects, found by reading `resolveTargetCalendarId`
(`calendar-sources.service.ts`) and `create_event`'s tool result
(`bot/executor.ts`):

**1. A requested name that matches nothing was treated as no request at
all.** `resolveTargetCalendarId`'s resolution order is: a name requested
this turn → the group's remembered default → the user's default → primary.
When `args.calendar` was set but `matchCalendarsByName` found neither an
exact/alias match nor even an ambiguous partial match — the caller's
phrasing didn't hit the literal `PRIMARY_ALIASES` set (`personal`, `primary`,
`me`, `my`, `mine`, `my calendar`, `self`) or any real calendar's name — the
function fell straight through to the **group's cached default**, exactly
as if the user hadn't named a calendar at all. But a REQUESTED-and-unmatched
name is a different situation than no name: the user expressed a specific
intent, and silently substituting whatever calendar a *past* request
happened to cache (Family, from an earlier "add to Family calendar") answers
a different question than the one asked. ADR 0137 already drew this
distinction for the *ambiguous* (2+ matches) case — it explicitly does not
fall through to the group default — but left the *zero* match case
unhandled.

**2. The tool result never said which calendar was used, at all.**
`create_event`'s summary was just `event ${title}` plus invitee info — no
mention of the destination calendar, successful or not. So even when
resolution behaves correctly, the model has no factual grounding to report
the outcome from; it can only echo the user's own words back ("personal
calendar") or guess. Combined with defect 1, the model told the truth about
what it *intended* and a falsehood about what *happened*, with no way for
it to have known otherwise — the ADR 0102 "a failed tool does not get to
explain itself" problem, on the *success* path instead of the failure path.

## Decision

**`resolveTargetCalendarId` no longer falls through on an unmatched
request.** When `opts.requestedName` is set and matches nothing (not even
ambiguously), it returns `{ calendarId: 'primary', source: 'primary',
requestedNotFound: opts.requestedName }` — skipping the group/user default
entirely. `primary` is always a real, writable calendar; the group/user
default might be exactly the calendar the user was trying to avoid. This
mirrors ADR 0137's own reasoning for the ambiguous case, extended to the
zero-match case it didn't cover.

**`create_event`'s tool result states the real destination.** A new
`calendarLabel` helper resolves a calendar id to its human name (`primary`,
or the stored `calendar_sources.summary`), and the summary always appends
either `· added to your <label> calendar` (with an instruction to report
THIS calendar, not the user's own wording) or, when `requestedNotFound` is
set, an explicit `· could not find a calendar named "<name>" — used your
<label> calendar instead` with an instruction not to claim it went where the
user asked. The model now has a factual anchor for the one sentence people
actually check.

## Alternatives considered

- **Broaden `PRIMARY_ALIASES` to loosely match phrases like "personal
  calendar" or "my own calendar".** Treats the symptom (this one phrasing)
  rather than the defect (an unmatched request silently answering a
  different question) — the same gap would resurface for the next phrasing
  variant, or for a genuinely misspelled/unknown calendar name.
- **Refuse and ask, the way the ambiguous (2+) case does.** Reasonable but
  more disruptive for a case with nothing to *enumerate* — there's no
  candidate list to offer, only "that name doesn't exist." Defaulting to
  primary (never the group's default) and disclosing it in the reply gives
  the user a safe, correctable outcome without an extra round trip.
- **Leave the tool result silent and fix only the resolution fallthrough.**
  Would have fixed this specific incident but left the underlying honesty
  gap: the model still has no grounding for what it says about the
  destination, for any future create_event call whose resolution path
  changes for an unrelated reason.

## Consequences

An explicitly-requested-but-unrecognized calendar name now lands on the
user's primary calendar, never a stale group default, and the bot says so
honestly instead of repeating the user's own words. A clean match (the
common case) now also states the real destination, closing the same
class of confabulation risk before it manifests through some other
resolution path.

## Addendum 2026-10-04 — the destination is only true if the event can get there

Prod: a user asked for "Josh Brooks's Bar Mitzvah" and could not find it in
Google or on her phone. The row was correct and queued (`local_dirty = 1`),
but her Google grant had been refused fifteen hours earlier, so nothing could
push it. The tool result still read "added to your primary calendar": the
note above named the destination without asking whether it was reachable.

`googleCalendarConnection` (`calendar-write.service.ts`) answers that:

- **connected** — the note is unchanged.
- **expired** (connected once; token and scopes cleared on `invalid_grant`,
  `google_connected_at` still set) — "saved in Chord ONLY", not on Google or
  the phone yet, will appear after reconnecting in Settings, and an explicit
  instruction not to say it was added to their calendar.
- **never** — "saved in Chord", no claim about any Google or phone calendar,
  and no urging to reconnect something that was never connected.

The event is still created and still queued; ADR 0042's drain on reconnect is
what delivers it.

Not covered: `update_event`, a confirmed proposal and a trip leg's calendar
event do not state a calendar at all, so they make no false claim, but they
also say nothing about a dead connection.

Why her grant had expired is separate and larger: 11 of the 12 Google
connections ever made stopped working seven days after they were made, which
is what Google does to refresh tokens while an OAuth app's consent screen is
in "Testing". That is a console setting, not code.
