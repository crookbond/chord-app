# 0256 — A default calendar can be set, in chat or in Settings

**Status**: accepted
**Date**: 2026-10-15

## Context

ADR 0040 added `users.default_calendar_id`, and ADR 0232 made it the second
step of `resolveTargetCalendarId` (a calendar named for one event, then the
user's own default, then the primary). Every event create reads it. Nothing
outside the tests ever wrote it: no route, no Settings control, no bot tool.
A user saying "my default calendar is Family" got nothing stored; at best the
model put "Family" on that one event, and the next event went to the primary.

## Decision

**One writer, `setDefaultCalendar` (`calendar-sources.service.ts`), called by
Settings and by chat.**

- **By name (chat)**: resolved exactly like a calendar named for one event,
  `matchCalendarsByName`, so the same rules hold: exact or ask (ADR 0137),
  "primary"/"personal" mean the primary, never a device calendar (ADR 0136).
  Several matches return `ambiguous` + `candidates` and store nothing; no
  match returns `not_found` and store nothing.
- **By id (Settings)**: must be a Google or Outlook calendar of THIS user with
  owner/writer access, else `not_writable`. An id is client input, so it is
  checked even though the picker only offers valid ones.
- **The primary clears**: choosing the primary, an empty name, or null stores
  NULL, since an unset default already means the primary. Storing the
  primary's own id would make "go back to primary" two different states.
- **Read**: `getDefaultCalendar` goes through `resolveTargetCalendarId`, so a
  stored default that is no longer pushable reads as the primary, which is
  where the event will actually go.
- **Route**: `GET`/`PUT /api/v1/me/calendar/default` (`DefaultCalendar`,
  `SetDefaultCalendarRequest`); 400 with the reason on a refusal.
- **Chat**: `set_default_calendar { calendar? }`, personal 1:1 only (its
  candidates name the asker's own calendars). Omitting `calendar` reads the
  current default. Its description separates it from `create_event.calendar`,
  which applies to one event and remembers nothing.
- **Settings**: a "Default calendar" chip row (Primary + each writable Google
  and Outlook calendar) at the top of the Calendars list.

## Consequences

- Events from chat, the app, email suggestions and travel legs with no named
  calendar now follow the user's choice (they already read the column).
- A family member's fan-out copy uses THAT member's default (ADR 0232), so
  one user's choice never moves another's events.
- `users.default_invite_calendar_id` stays unused.

## Rejected

- **Storing the name instead of the id**: a renamed calendar would silently
  stop matching, or match a different one.
- **Remembering a calendar named on an event as the default**: the ADR 0232
  bug (a calendar named once became the group's default) in a new place.
- **Allowing the tool in shared groups**: the ambiguity question would list
  the asker's calendars to the whole group.
