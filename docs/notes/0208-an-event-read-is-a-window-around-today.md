# 0208 — An event read is a window around today, not the oldest N ever

**Status**: accepted
**Date**: 2026-09-25

## Context

`listEventsForUser` read a user's events **oldest first** with no start date and stopped at 500. It fed the calendar screen, the morning briefing's facts and the proactive scan. In prod, ownertest@gmail.com had **1,669** live events going back to 2021 (a Google sync of the whole history), so every one of those surfaces got the first 500 — all from 2021 — and none of today's. guest.three@gmail.com (719) was past the cap too. `listEvents` (the group's schedule in the bot's context) and `listEventsForUserInGroup` had the same shape.

Two more things were wrong with the same reads:

- **Times were compared and sorted as text.** `starts_at` is stored in three shapes — UTC `…Z` (REST, `.ics` timed), the event's own offset `…-04:00` (Google pull, bot tools) and floating `…T00:00:00` (all-day, ADR 0040) — so a "10:00-04:00" event (14:00Z) sorted before a "12:00Z" one, and a floating all-day event sorted below a same-day `…T00:00:00.000Z` bound.
- **The device-calendar delete reconcile (ADR 0057) diffed against `/me/events`.** Any event *not in the list* had its device copy deleted. That was already dangerous: `listAllEvents().catch(() => [])` meant one network error deleted every device copy. With a windowed list it would delete every copy outside the window.

A sweep for the same "oldest-first plus a cap" shape found it in the vacation responder, list items, title matching, the RSVP default and task lists (listed in the commit).

## Decision

**Event reads are a window around now, compared as instants.**

1. `listEventsForUser` / `listEventsForUserInGroup` / `listEvents` take an `EventWindow` (`pastDays`, `futureDays`, `tz`). Default **7 days back, 30 forward** (owner call) — what the briefing, proactive scan and bot context need. An event is in the window if it **overlaps** it (starts before the far edge and has not ended before the near one), so a trip-long all-day block that began last month still shows today. Ordered by instant; a 3000-row cap remains only as a safety net.
2. **The calendar screen is the exception: two years forward, always** (owner call). `/me/events` and `/groups/:id/events` return 730 days ahead regardless of what the app asks, and `?pastDays=` for how far back — the app grows it as the user pages into past months (starting at 45, the current month's grid). An app that does not send it (older builds) gets 365 days back, so history browsing on an old build does not vanish.
3. **All text-timestamp comparisons go through `server/src/db/text-instant.ts`** (`textInstant` in SQL, `byInstant` / `instantMs` in JS): zoned values cast directly, floating ones are wall time in the reader's zone, unparseable ones are NULL rather than failing the query.
4. **The device delete reconcile asks, instead of diffing.** New `POST /me/events/live {ids}` → `{live}` returns which of exactly the ids the device wrote still exist (same owner/deleted/cancelled predicate as the list, no date window). A failed lookup throws out of the reconcile — it can no longer read as "nothing is live".

## Consequences

- The briefing, scan and bot now see today again for heavy calendars; the bot's group context no longer lists events more than 30 days out (it previously showed up to the oldest 500, i.e. usually none of the near future for a busy group).
- `pastDays` is a new query parameter the app must send when paging back; old builds are covered by the 365-day default, not by all-time history.
- `findLatestEvent` is gone: `record_rsvp`'s default is now `findNearestEvent` (soonest upcoming, else the most recent past). "Latest by start" picked the furthest-future event — next year's birthday, the tail of a recurring series.

## Rejected

- **Raising the cap** (5000, 10000): the next sync of a long history hits it again, and the payload grows with history nobody is looking at.
- **Newest first + cap:** drops the near future for anyone with far-future recurring events, the mirror image of the bug.
- **One window for every surface:** the calendar screen is paged by a person through months and years; the bot and briefing are about this week. Different questions, different windows.
- **Keeping the reconcile's list diff with a wider window:** still deletes device copies outside it, and still turns a failed request into "delete everything".
