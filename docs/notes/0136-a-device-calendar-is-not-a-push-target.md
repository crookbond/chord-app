# 0136 — A device calendar is not a push target

**Status**: accepted
**Date**: 2026-08-26
**Relation**: fixes a write-side hole in
[ADR 0040](./0040-user-owned-two-way-calendar.md)'s selectable target calendar,
opened by [ADR 0057](./0057-device-calendar-as-source.md)/[0072](./0072-unified-calendar-settings-and-one-briefing.md)
adding device rows to `calendar_sources`.

## Context

A prod report: *"some events I create in Chord show up in Google Calendar
online but never reach my phone."* The reported half turned out to be the
milder one, and looking at the data found a second, worse failure underneath.

**The reported half** is working as designed. Prod runs
`GCAL_TARGET_CALENDAR_NAME=Family`, so Chord pushes to a **secondary** Google
calendar. Google's web UI shows every calendar in the account; phones and
desktop clients sync only the calendars enabled *on that device*. Nine of the
user's events were on that calendar, visible on the web and absent from the
phone until they enabled it there. Nothing is broken; the consequence is simply
invisible until events appear to go missing.

**The half that was broken**: four events created between 29 and 31 August had
`google_calendar_id = BEE3A1B0-7D3E-4E0B-B6CC-5A95D6148DDF`, status `error`,
`events.insert 404`, and no `gcal_event_id`. That is not a Google calendar id —
it is an **EventKit** identifier. Those four events reached **no calendar at
all**, while looking perfectly normal inside Chord.

`calendar_sources` is multi-provider: a `device` row stores the phone's
calendar id in the same `google_calendar_id` column (a generic source-id, per
ADR 0057). The user's phone mirrors their Google "Family" calendar, so they had
**two writable rows with the summary "Family"** — one `google` (owner), one
`device` (writer). `matchCalendarByName` filtered on `access_role` and never on
`provider`, so "family" resolved to the device row.

Worse, the result was then **cached**: `setGroupDefaultCalendar` wrote the
EventKit id to `groups.default_calendar_id`, so every subsequent event in that
group inherited it. And ADR 0103 had just made a non-408/429 4xx give up rather
than retry — correct for the 400-loop it was written for, and here it meant the
four events failed once each and were never tried again.

## Decision

**Only a `google` source can be a Google push target, and a remembered default
is re-checked rather than trusted.**

Two changes, because the bug had two lives:

1. `matchCalendarByName` filters `provider = 'google'` — in both the
   primary-alias branch and the name-match branch. A device id can never be
   handed to `events.insert`.
2. `resolveTargetCalendarId` validates a cached `groups.default_calendar_id` /
   `users.default_calendar_id` before using it, falling back to `primary` when
   it names a known device calendar.

The second is not belt-and-braces. The defaults are **caches of an earlier
resolution**, so a bad value outlives the bug that produced it: fixing only the
matcher would have left this user — and anyone else who had already resolved
once — permanently broken.

### Unknown is not invalid

The guard rejects an id it knows to be a **device** calendar. An id absent from
`calendar_sources` entirely is allowed through: a calendar created in Google a
minute ago has not been synced into the sources list yet, and refusing it would
break a legitimate target to catch an illegitimate one.

### Falling back to primary, not to nothing

`primary` is the one calendar that certainly exists, that the user can write
to, and — relevant to the reported half — that **every device syncs by
default**. Refusing to write at all would turn a wrong-calendar bug into a
missing-event bug.

## Consequences

- An event can no longer be addressed to a calendar Google has never heard of.
- A user whose phone mirrors a same-named Google calendar now lands on the
  Google one. Before, which row won was scan order — so this was luck, not
  configuration.
- The four stuck events need re-arming by hand: ADR 0103's give-up rule means
  they will not retry on their own. Clearing `google_calendar_id` and setting
  `local_dirty = 1` sends them to primary on the next pass.
- **Not addressed here**: nothing tells the user that a chosen target is a
  secondary calendar their phone does not sync. That is the reported half, and
  it is a UI question — a note next to the calendar picker in Settings — rather
  than a correctness one.

## Alternatives rejected

**Detect the id by shape.** An EventKit id looks like a UUID and a Google id
looks like an email or `…@group.calendar.google.com`, so a regex would have
worked today. It encodes an assumption about two vendors' id formats that
neither has promised, and `provider` is already stored and authoritative.

**Refuse the write when the target is unresolvable.** Honest, and it strands
the event: the user asked for a calendar entry and would get nothing, with the
failure visible only in a status column.

**Drop `google_calendar_id` from device rows.** The column is documented as a
generic source id (ADR 0057) and the device sync needs it to address the
device's own calendar. The problem was never the storage, it was a read that
forgot the column means two things.

**Stop pushing to a secondary calendar at all.** That would fix the reported
symptom by removing a feature people deliberately use — the env var exists so
events land in a calendar the family already shares.

## Addendum 2026-11-09 — every member's copy is resolved, not just the creator's

A fanned-out group event (ADR 0040 §7) gave the creator's copy a calendar from
`resolveTargetCalendarId` and every other member's copy their raw
`users.default_calendar_id ?? 'primary'` — no re-check of a stale or phone
default (this ADR's second half), and no ADR 0228 Outlook-only primary, so an
Outlook-only member's copy was aimed at a Google `primary` nothing could push.
`createEvent` now resolves each member through `resolveTargetCalendarId`.
Left alone: `PushTargets.calendarFor` and `FanoutCopies.target` still read the
raw default, but only for a row with no calendar id, which a fan-out copy no
longer is.
