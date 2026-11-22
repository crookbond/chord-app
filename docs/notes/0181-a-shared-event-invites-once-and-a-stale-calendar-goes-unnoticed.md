# 0181 — A shared event invites once, and a stale calendar goes unnoticed

**Status**: accepted
**Date**: 2026-09-17
**Amended by**: [0295](./0295-guests-live-on-the-calendar.md) — guests are no longer kept in `event_attendees`; they are added and removed on the provider event directly.

## Context

Prod (`ownertest@gmail.com`, 2026-09-17): "Add to calendar - meeting with Ahf at
2p today. Invite hannah, victor and scott" was said in the family group chat.
The bot created the event on the group's "Family" calendar (ADR 0040 §7 /
0136 / 0137 — that is the correct, intended target for a group event with no
explicit calendar named). One of the invited guests received what looked like
an extra, confusing invitation from a "Family…" identity that was not John.
Separately, the user edited the event directly in Google Calendar to move it
to their Personal calendar, and ended up with two events — the Personal copy
and a stale Family copy — and had to delete the Family one by hand. Two
independent defects, found by reading the code behind both symptoms.

### 1. A fanned-out group event re-invites guests once per family member

A group event is not one Google event — `createEvent` gives **every group
member their own row** (ADR 0040 §7): the organizer's copy plus one
"attendee"-role copy per other member, each destined for that member's own
Google account. All of them are inserted with the **same** `ical_uid` — a
locally-generated placeholder, because a row only gets its own *real* Google
iCalUID once it is individually pushed (`markPushed` stamps `resp.iCalUID`
onto that one row at that moment, not the others).

`create_event`'s invitee handling (ADR 0157) calls `addEventAttendees`
immediately after `createEvent` returns, in the same request — well before
any of the fire-and-forget `firePush` calls it kicked off have completed.
`addEventAttendees` writes the guest emails into `event_attendees` keyed on
`ev.ical_uid`, which at that moment is still the **shared placeholder** every
sibling row carries. Each family member's own `pushDirtyEvents` pass later
looks up `event_attendees WHERE ical_uid = row.ical_uid` with no `role`
check — and since every sibling still has that same placeholder at push time,
**every family member's independent push re-attached and re-sent the same
guest list**, each from their own Google account. A guest ends up invited
once per family member with calendar write access, and whichever member's
push happened to run last is the "organizer" identity the guest actually
sees — not necessarily John's.

### 2. A calendar nobody is looking at never gets reconciled

Two-way calendar sync (`syncTwoWay` / `maybeSyncCalendar`, ADR 0040) only
ever runs **opportunistically**: after a bot `create_event`/`update_event`
call, a foreground refresh, or the manual `/me/calendar/sync` route, each
throttled to once per 5 minutes. There is no periodic background pass —
unlike mail, which hit the identical shape and was fixed by a sweep (ADR
0144/0159). An event edited directly in Google Calendar between chat/app
sessions — such as moving it to a different calendar — sits unreconciled
until the user happens to trigger one of those opportunistic paths. If they
look at Google Calendar (or the Chord app) before that happens, whatever
Google's own UI left behind (here: a duplicate, since the user had to
manually remove the stale Family copy themselves) is exactly what they see,
with no independent process working to converge it.

## Decision

**Attach external guests to the organizer's push only.** `pushDirtyEvents`
now attaches `event_attendees` (and the `sendUpdates=all` notify flag) only
when `row.role === 'organizer'`; every other fanned-out sibling's push
carries no attendees at all. Only the organizer's copy is the real,
single Google-facing event that guests should see; every other member's copy
is a private reflection of it on their own calendar and must never carry or
re-send its guest list. This is a pure narrowing — a solo (non-fanned-out)
event's single row is always `role: 'organizer'`, so its behavior is
unchanged.

**Sweep the calendar mirror periodically, mirroring ADR 0144.** New
`sweepCalendars` (`services/google/calendar-sweep.ts`), wired into the same
proactive tick as `sweepMailboxes`: each pass picks up to `CALENDAR_SWEEP_BATCH`
non-shadow, calendar-write-scoped users whose `google_calendar_synced_at` is
older than `CALENDAR_SWEEP_MINUTES` (stalest-first, so nobody is starved) and
runs the existing `syncTwoWay` for each. `syncTwoWay` is push-then-pull and
idempotent, so this is a strict reduction in staleness with no new
architecture on the sync side — unlike ADR 0144's mail sweep, there is no
"multiplies LLM spend" question to reason through here at all, since
calendar sync makes no LLM calls.

## Alternatives considered

- **Refuse to push an event with external invitees to a shared/group
  calendar; force it onto the creator's primary calendar instead.** Would
  also have prevented both symptoms, but changes what family members can see
  on their shared calendar — a real product trade-off (a family member losing
  visibility into "meeting with Ahf" on the calendar they check), not a pure
  bug fix. The organizer-only-push fix removes the actual defect (duplicate,
  confusing invites) without touching where the event is visible to the
  family.
- **Give `update_event` a `calendar` field to move an event between
  calendars from within Chord**, doing the swap as an atomic
  create-on-new-then-delete-on-old rather than relying on Google's own
  calendar-reassignment UI. Would give users a supported way to avoid ever
  hitting whatever Google's own edit flow does with a guest-bearing event,
  but is a materially larger feature (new write path, attendee/description
  transfer, its own failure modes) than this incident's evidence justifies
  building blind — left as a follow-up if the underlying Google-side
  limitation turns out to be the recurring cause rather than sync staleness.
- **Re-key `event_attendees` by event id instead of `ical_uid`.** Doesn't fix
  the actual bug: the leak is that every sibling's *push* pulls the same
  guest list, not that the table's key is wrong — `ical_uid` is still the
  right join key for the (rarer) case of adding a guest to an
  already-pushed, single-copy event.
- **Do nothing about sync staleness and treat the duplicate as a one-off
  Google Calendar UI quirk.** The opportunistic-only sync gap is real and
  independent of whatever exactly Google's UI did — mail already proved this
  exact shape needs a periodic sweep, not just better opportunistic triggers.

## Consequences

A guest invited to a shared group event now receives exactly one invitation,
from the organizer's own account, regardless of how many other family
members that event fans out to. A calendar edit made outside Chord now
converges within one `CALENDAR_SWEEP_MINUTES` window instead of whenever the
user next happens to trigger the app — shrinking, but not eliminating, the
window in which a stray duplicate could be visible (the sweep does not
retroactively clean up anything that predates it, and does not change
whatever Google's own UI does when an event with guests is reassigned to a
different calendar). `CALENDAR_SWEEP_ENABLED=false` returns calendar sync to
its prior purely-opportunistic behavior.
