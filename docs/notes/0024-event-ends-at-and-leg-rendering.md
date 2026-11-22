# 0024 — Event endsAt + per-leg trip rendering

**Status**: accepted — server + mobile wired 2026-05-05 (PR-B.1). Time model **extended by [ADR 0040](./0040-user-owned-two-way-calendar.md)** (named IANA timezones + the <5-minute "free" rule).
**Date**: 2026-05-05

## Context

Until now `events.starts_at` was the only time signal stored per event;
the calendar UI rendered every block as a 60-minute slot. Two problems:

1. A 3-hour potluck looked the same as a 30-minute coffee. Bot-created
   events imported from PDFs always ended after one hour even when the
   source said "5–9pm."
2. Trips already store per-leg `departAt` + `arriveAt`, but the calendar
   only rendered each trip as a top-band that spans the whole date range.
   The hour grid showed nothing — a 9am SEA→JFK flight didn't visibly
   block the morning, and the user had to drill into the trip detail to
   see when they'd actually be in the air.

ADR 0017 makes the server authoritative; ADR 0013 establishes that the
ingest path (Google Calendar, .ics, the bot tool) all funnel through one
`createEvent`. The right place to widen the model is at that single
chokepoint.

## Decision

### `events.ends_at` (nullable column)

Forward-only migration `026_events_ends_at` adds `ends_at TEXT` (no
default). Every read path returns it as optional; clients fall back to a
60-minute block when absent so all existing rows render unchanged.

Threaded through:

- `kernel.GroupEvent.endsAt?: IsoDateTime`
- `CreateEventRequest.endsAt: z.string().datetime().optional()`
- `services/events.service.createEvent` accepts `endsAt`
- `tools.create_event` zod schema accepts `endsAt`; tool description
  tells the bot to set it when the source says "5–9pm" / "for two hours"
- `services/google/calendar.service.syncPrimaryCalendar` reads
  `item.end.dateTime` / `item.end.date` and stores it

No other writers exist today — relay/connector inbound never creates
events directly.

### Per-leg rendering on the calendar grid

Pure layout helpers live in `kernel/src/calendar-layout.ts`:

- `clipBlockToDay(start, end, date, hourHeight)` — maps any `[start, end)`
  interval to `{top, height}` pixel coords on a 24h grid, clipping
  multi-day intervals to the visible day. Used for both events and legs.
- `legsForDay(trips, date)` — flattens every `TripStatus.legs` whose
  flight window intersects `date`. Multi-day legs (red-eyes) match each
  day they touch; the renderer clips per-day.

`mobile/app/calendar.tsx` adds a `LegBlock` component (orange-bordered,
cream fill to differentiate from event blocks) and renders
`legsForDay(...)` alongside events in both Day and Week views. Trip
*bands* at the top of the page stay — they communicate "you're traveling
this whole stretch"; the per-leg blocks add the in-day detail.

## Alternatives considered

- **Compute event end on the fly from a `durationMinutes` field**.
  Rejected — every other calendar in the world stores ends_at; converting
  to a duration is friction with no upside.
- **Render legs as a separate top band, like trips**. Rejected — the
  whole point is putting them inside the hour grid so the user can see
  conflicts ("the flight overlaps the dentist appointment").
- **Render legs only in Day view**. Rejected — Week view is where
  scheduling decisions happen.

## Consequences

- `kernel/src/calendar-layout.ts` is the first kernel module with
  non-type code. Pure functions only — still no runtime deps.
- Mobile picks up `endsAt` automatically; backwards-compatible fallback
  means no migration anxiety on clients still reading events from before
  the column existed.
- Out of scope:
  - Drag-to-resize an event block (would need a setter route + zod
    `UpdateEventRequest` adoption of `endsAt`).
  - Conflict-detection UI when two blocks overlap.
  - Mobile-side test runner — pure helpers are now tested via server
    vitest against the kernel module so they're covered without spinning
    up Vitest in the mobile workspace.
