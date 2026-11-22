# 0033 — Calendar busyness policy: per-calendar `counts_for_busy` + per-event `transparency`

**Status**: accepted — **extended by [ADR 0040](./0040-user-owned-two-way-calendar.md)**: per-calendar `counts_for_busy` is unchanged, but (1) per-event `transparency` now has a second driver — events shorter than 5 minutes (and all-day / no-end events) are forced `transparent` (free); and (2) **the "soft conflict" bucket below is removed** — conflict detection (`find_conflicts`, the event-created nudge) now returns ONLY block-setting calendars + Chord-native events. Informational calendars are never surfaced as conflicts (they still appear in the daily briefing as heads-up — that part stands).
**Date**: 2026-05-19
**Related**: [ADR 0013 — ICS calendar ingest](./0013-ics-calendar-ingest.md),
[ADR 0015 — Server-side Google Calendar write](./0015-server-side-google-calendar.md),
[ADR 0028 — Calendar scope at sign-in](./0028-calendar-scope-at-signin.md),
[ADR 0030 — Group-chat calendar scope](./0030-group-calendar-scope.md)

## Context

`syncPrimaryCalendar` pulls events from every Google calendar the
user has `reader|writer|owner` access to (ADR 0028 gave us the scope;
ADR 0030 narrowed visibility but not what gets *synced*). A typical
account looks like:

- **Personal** (primary, owner) — real conflicts.
- **Family** (writer, shared) — real conflicts.
- **Work** (reader, separate account share) — real conflicts.
- **Kids' sports** (reader, shared from spouse) — informational; the
  user wants to know about the soccer game but a 9am game does not
  prevent them booking a 9am dentist.
- **US Holidays** (reader, Google's public feed) — informational;
  Thanksgiving is not a conflict for a Tuesday standup.
- **Birthdays** — informational; all-day, `transparency: transparent`.

Today the bot treats every event the same. "Is Saturday free?" returns
a conflict because the kids' soccer game is on the family member's
shared calendar, even though the user is the parent and isn't playing.

Google itself models this at two layers:

1. **`calendarListEntry`** — per-user toggles, but the relevant flag
   `selected` is purely a UI hint (whether to show in google.com/calendar).
   `accessRole` tells us read-only vs writable. There is **no**
   Google-side "this calendar counts against me" flag.
2. **`event.transparency`** — per-event override: `opaque` (default,
   "busy") or `transparent` ("show me but don't block me"). Holidays
   and birthdays come down as `transparent`. The /freeBusy endpoint
   respects this; we currently throw it away.

## Decision

Treat **sync**, **listing/nudges**, and **conflict-checking** as three
operations on the same data, governed by two orthogonal flags:

- **Per-calendar `counts_for_busy`** — does this calendar's events
  block time when answering "is X free?" Stored on a new
  `calendar_sources` row, one per `(user_id, google_calendar_id)`.
  Has an auto-picked value and a nullable user override; the override
  wins when set.
- **Per-event `transparency`** — `'opaque' | 'transparent'`, captured
  verbatim from Google on sync and stored on `events.transparency`.
  Defaults to `'opaque'` for non-Google events.

**Effective** `counts_for_busy = override ?? auto ?? false`. An event
blocks time iff its calendar's effective `counts_for_busy = true`
**and** its `transparency = 'opaque'`. Either flag flipped to false is
enough to make it informational-only.

Listing and nudges see **all** events. The user explicitly wanted
this: the soccer game and the federal holiday should still show up
in "what's on this weekend?" and feed into nudges ("Mom — kids'
soccer at 9am"). They just don't count as conflicts.

### Default `counts_for_busy_auto`

Computed on first discovery and refreshed on every sync (so a calendar
that flips from reader → writer auto-corrects). The auto value is
always a definitive `true` or `false` — the user is never prompted to
classify a calendar. The mobile settings UI exposes a per-calendar
toggle as a passive override for the cases the auto picker gets wrong.

| Rule (first match wins)                                | `counts_for_busy_auto` |
|--------------------------------------------------------|------------------------|
| `accessRole = freeBusyReader`                          | (calendar skipped entirely from sync) |
| `primary = true`                                       | `true` |
| `id = users.google_calendar_id` (the Chord-target "Family" calendar, ADR 0015) | `true` |
| `accessRole ∈ {owner, writer}`                         | `true` |
| else (reader-only shared calendars, holidays, birthdays, hidden) | `false` |

The bias is: **your own calendars block time; calendars you don't
own are informational by default.** This matches what most users
intuitively expect — the family soccer schedule and US holidays show
up in your day view but don't make Tuesday afternoon "busy." If
you actively use a shared calendar (e.g. you share a partner's
calendar that you both treat as authoritative), flip the toggle in
Settings → Calendars and the override sticks across re-syncs.

The schema keeps `counts_for_busy_auto INTEGER NULL` so old rows
written before this simplification (if any) still parse; new sync
runs never write NULL. Effective resolution stays
`override ?? auto ?? false` — a defensive fallback for the historical
NULL case.

### User override

`calendar_sources.counts_for_busy_override BOOLEAN NULL`. When non-null
it wins; when null the auto value is used. We persist `override`
separately so that a re-sync (which may flip the auto value as the
user's calendar list changes) never silently undoes a user choice.

The settings UI shows three states per calendar:

- **Auto: blocks time** / **Auto: informational** (no override)
- **You set this to block time**
- **You set this to be informational**

with a "reset to auto" affordance.

### Event-level transparency

Captured on sync from the Google `event.transparency` field. Stored
as `events.transparency TEXT NOT NULL DEFAULT 'opaque'`. ICS pipeline
(ADR 0013) reads the `TRANSP` property the same way (`OPAQUE` /
`TRANSPARENT`); native Chord events default to `opaque`.

The mobile event detail can render `transparent` events with a "free
time" badge so the user knows it won't block bookings.

### Bot tool surface

Today there is roughly one bot tool that reads events. Split intent:

- `list_events(range, ...)` — returns everything. Used by "what's
  on the calendar?", "what does Saturday look like?", recap nudges.
- `find_conflicts(startsAt, endsAt)` — returns two arrays for the
  overlapping window:
  - `hardConflicts` — events on calendars where the effective
    `counts_for_busy = true` (your primary, Chord-target Family,
    owned/writable cals) plus Chord-native events. The bot phrases
    these as real clashes.
  - `softConflicts` — events on informational calendars (shared
    read-only: soccer, partner, holidays). The bot phrases these as
    heads-ups, not blockers. Users explicitly want to hear "FYI,
    Ben's soccer game is at 6:30" when booking date night for 7pm.
  - Per-event `transparency = 'transparent'` is dropped entirely from
    both arrays — Google has explicitly marked the event as "show me
    as free."

Each row in either array carries `calendar` (the source calendar's
display name) so the bot can attribute the conflict in its reply
("Family dinner," "Ben's Soccer," "US Holidays").

The proactive service (`server/src/services/proactive.service.ts`) has two
distinct jobs, and they treat informational calendars differently:

- The **daily morning briefing** keeps using the unfiltered event set — a
  kids' soccer game still warrants a "don't forget" nudge regardless of the
  busy classification.
- The **event-creation conflict nudge** (fired when a new event is added) is
  conflict-detection, so it applies the same rule as `find_conflicts`: events
  on informational calendars, and events marked `transparency: transparent`
  ("free"), are excluded from the NEIGHBORS set and never flagged as conflicts.
  The shared `loadBusyContext` / `eventBlocksTime` helpers in
  `calendar-sources.service.ts` keep the two conflict paths from drifting.

### What we deliberately don't do

- **No live `/freeBusy` API calls.** We have the events locally
  already; once `transparency` is persisted the conflict query is a
  microsecond SQLite scan. Calling Google adds a round-trip per
  user-turn and gives the same answer.
- **No separate UI for "hide from listings."** That's what
  `selected = false` is for, on Google's side, and we respect it via
  the auto rule. If users want to hide a calendar entirely from Chord
  they can hide it in Google; we'll pick that up on the next sync.
- **No per-event override in Chord.** Users edit `transparency` on
  Google for synced events. Chord-native events default to `opaque`
  and we don't expose a toggle yet — add later if real users ask.

## Migration

1. Add `calendar_sources` table and `events.transparency` column
   (migration `040_calendar_sources`).
2. Backfill `events.transparency = 'opaque'` (the default).
3. On next sync per user, `calendar_sources` populates with current
   auto values. No user override is set.
4. Mobile settings screen reads `GET /calendar-sources`, writes
   `PATCH /calendar-sources/:id { counts_for_busy_override }`.

No data loss; users who never visit the settings screen get the
common-sense defaults.

## Consequences

- One extra table, one extra column. Sync gains a per-event field
  capture and a per-calendar upsert.
- Bot conflict answers stop including holidays and shared informational
  calendars — the headline win.
- Nudges and listings stay rich. Users still see what's happening,
  they just don't get false conflict reports.
- Group-scope rules from ADR 0030 are unchanged; this layer sits below
  them. Both filters apply.
- If we later move events to Postgres (the question that started this
  thread), the `transparency` column ports trivially and
  `calendar_sources` is just another small table.

## Addendum (2026-05-22) — sync heals transparency on existing rows

The Google sync was insert-only: an already-synced event matched on
`external_uid` / `gcal_event_id` was skipped wholesale, so its
`transparency` was only ever written at first insert. Rows that predate
this feature (backfilled to `opaque` by the migration) therefore stayed
`opaque` forever even after the user marked them "Free" in Google, and a
re-sync never overrode them — they rendered solid (blocking) in the
calendar UI while a fresh DB showed the same events dotted.
`syncPrimaryCalendar` now patches `transparency` on the existing-row
branch when Google's value differs (`setEventTransparency`, counted as
`updatedTransparency` in `SyncResult`). Scoped to transparency on
purpose: title/time can be edited Chord-side and pushed back, so we
don't clobber them from Google.
