# 0057 — Device calendar as a first-class (optional-Google) source

**Status**: accepted
**Date**: 2026-06-30
**Related**: [ADR 0040 — User-owned two-way calendar](./0040-user-owned-two-way-calendar.md),
[ADR 0015 — Server-side Google Calendar](./0015-server-side-google-calendar.md),
[ADR 0033 — Calendar busyness policy](./0033-calendar-busyness-policy.md),
[ADR 0013 — .ics ingest pipeline](./0013-ics-calendar-ingest.md)

## Context

Chord's calendar has been **Google-first**. The server pulls a user's Google
calendars into the `events` table (ADR 0040), and the mobile device calendar was
only an *advisory, write-only fallback* (`mobile/src/calendar.ts`): Chord-created
events were written to the device when Google wasn't connected, but the device
was **never read back into the DB**. So unless a user connected Google, web and
the bot were blind to their real schedule.

We want the device calendar to be a **synced source of record**, with Google
**optional**:

1. Mobile reads the user's *selected* device calendars over a **−30 day / +60
   day** window and upserts them into the Chord DB.
2. If Google is connected we keep its server-side two-way sync; if not, the
   device is the source.
3. Web (which can't read a device calendar) renders whatever is in the DB via the
   existing `GET /me/events`.
4. The device calendar is read **and** written.
5. Separately, Chord tasks/lists are written into the iOS **Reminders** app, and
   read back (two-way) — see "Reminders" below.

## Decision

### Device events are a personal mirror, stored exactly like Google read-pulls

A device event is upserted into `events` with:

- `external_uid = device:<deviceCalendarId>:<deviceEventId>` (new provider prefix
  alongside the existing `gcal:` scheme),
- `group_ids = []` (a calendar-only item, **never** surfaced in a chat or
  auto-shared to a group — the same shape `insertLocalFromRemote` writes for a
  Google pull),
- `group_id = <user's personal group>` (the legacy NOT NULL column),
- `owner_user_id = <user>`, single copy (**no fan-out**), `chord_uid = null`,
  `local_dirty = 0` (the device is the source; we never push these back to
  Google).

This means **no change to the `events` table** and lets `/me/events`
(`listEventsForUser`) surface device events with zero read-path changes.

### Calendar selection is opt-in; device calendars become `calendar_sources` rows

Nothing leaves the device until the user selects a calendar. Each selected
calendar is upserted into `calendar_sources` with a new **`provider`** column
(`'google' | 'device'`, default `'google'`; migration `015`). The device
calendar id is stored in the existing `google_calendar_id` column (treated as a
generic source id). The ADR-0033 busy policy is provider-agnostic and reused
unchanged (`pickCountsForBusyAuto`): a device-writable calendar counts as busy,
a read-only one is informational, and the user can override.

### Differentiating Google-on-device from Google-from-Google (the dup problem)

When Google is connected, iOS mirrors those Google events **onto the device**, so
a naive device read would re-ingest them as `device:` rows duplicating the
`gcal:` rows the server already pulled. `expo-calendar` exposes only a
device-internal event `id`, **not** `calendarItemExternalIdentifier`/iCalUID, so
we can't dedup per-event with it alone. Three layers:

- **Layer 0 — exact UID dedup (primary).** A custom native module
  (`mobile/modules/chord-eventkit/`, Swift) surfaces EventKit's
  **`calendarItemExternalIdentifier`** (the calendar-server UID, stable across
  device copies). The read-up sends it; the ingest stores it as the row's
  `ical_uid` and **skips** inserting a `device:` event when the owner already has
  a non-device row (`gcal:`/Chord-native) with the same `ical_uid`.
- **Layer 1 — exclude the connected-Google source (optimization, client-side).**
  Each device calendar carries a `source` (`type`+`name`); a Google account on
  iOS is a CalDAV source named after the account. The mobile read-up skips
  calendars whose source matches the user's connected Google email (from OAuth)
  and the dedicated "Chord" write calendar — avoiding wasted upload of events
  Layer 0 would only dedup away.
- **Layer 2 — fuzzy dedup (backstop, server-side).** For events lacking a usable
  UID, the ingest also skips a `device:` insert when the owner already has a
  non-device row with the same normalized `(title, starts_at, ends_at)`.

Device read-up runs **whether or not Google is connected**; only the excluded
source set and the available UIDs differ. This replaces the old all-or-nothing
"only read the device when Google is off" gate.

**Two scenarios:**

- **Google not connected (primary case):** all selected calendars are mirrored
  — including a Google account synced to the *device* but never connected to
  Chord (the device is the only source; Layer 1 excludes nothing but the "Chord"
  calendar). This is the path the design centers on.
- **Google connected:** the server pulls Google directly; the device read-up
  excludes the connected Google account's calendars (Layer 1) but still mirrors
  iCloud / Exchange / other-account calendars Google can't see; Layers 0/2 mop
  up residue.

### Reverse-delete and LWW

On each sync, any `device:`-sourced row for a synced calendar inside the
`[windowStart, windowEnd]` window that is **not** in the payload is soft-deleted
(`status='cancelled'`, `deleted_at`) — the same rule the Google pull uses. An
event already present is overwritten only when the incoming `updatedAt` is newer
(last-writer-wins), mirroring `reconcileRemote`.

### Writing Chord events to the device — and through to Google without OAuth

Chord-created events are written to the device (the existing one-way path,
upgraded to upsert + delete). The **target calendar** changes:

- Previously Chord always wrote into a dedicated local **"Chord"** calendar it
  created. Now, when the user has **not** connected Google to Chord but *does*
  have a Google account synced to the device, we prefer to write into their
  **Google-backed (CalDAV) device calendar**. iOS then syncs that event up to
  Google over CalDAV — so a Chord event reaches the user's real Google calendar
  (visible on their other devices / Google web) **without any OAuth token**.
  This is the only way to land an event on a non-connected user's Google
  calendar; the server can't (no token).
- Resolution order for the write target (first writable match wins): the user's
  Google-backed CalDAV calendar (source name matches their Google account /
  contains a Google domain) → their default/primary device calendar → the
  dedicated "Chord" calendar (created on a local/iCloud source as the fallback).
- Gating unchanged: when Google **is** connected to Chord, the server pushes to
  Google and iOS mirrors it back to the device, so the client write is skipped
  (`googleHandlesDeviceSync`) to avoid doubling.
- Constraints: identifying "Google" is inferred from the CalDAV source
  name/account (iCloud is also CalDAV), so it's best-effort and the user can
  override the target; only *writable* Google calendars qualify; invitees are
  not settable (EventKit attendees are read-only). A Chord event written into a
  Google-backed device calendar round-trips back as a `device:` row on the next
  read-up — deduped by `chord_uid`/UID so it doesn't double.

### Reminders (iOS) — two-way, on-device

Chord tasks/lists are written into the iOS Reminders app via `expo-calendar`
(EKReminder), and read back: completion toggles, edits, and reminders created in
a Chord-managed list flow back into Chord tasks/list items through the existing
REST API, with LWW conflict resolution and an on-device id-map. iOS only (no
Android/web Reminders provider). This half is **client-only** and needs no server
change beyond the existing task/list endpoints.

## Alternatives considered

1. **Keep the device advisory-only / all-or-nothing Google gate.** Simplest, but
   throws away a non-Google user's entire calendar and a Google user's
   iCloud/Exchange calendars. Rejected — the whole point is to make Chord useful
   without Google.
2. **A dedicated `device_events` table.** Cleaner separation, but `events`
   already stores external personal pulls in exactly the right shape; a second
   table would fork every read path (`/me/events`, busy/conflict). Rejected.
3. **Source-exclusion + fuzzy dedup only (no native module).** Avoids native
   code, but account-name matching is not robust and fuzzy matching is lossy.
   The native module gives a real per-event UID; the other two layers remain as
   optimization + backstop.
4. **A server-side Apple API.** None exists. Apple's only write/read surface is
   EventKit, on-device. The bridge therefore lives in mobile.

## Consequences

- The device→Chord write is the first time client-observed calendar state is
  pushed up to be stored (the prior device read was advisory-only by design —
  `mobile/src/calendar.ts`). Device→Chord edits flow through the existing REST
  endpoints, so the server (and bot) sees them.
- The iOS client now bundles a custom native module, so it requires a custom dev
  build / prebuild — already true because `expo-calendar` ships a config plugin.
- `calendar_sources` is now multi-provider; any future provider (e.g. a CalDAV
  server Chord talks to directly) reuses the `provider` column and the same
  external_uid prefixing scheme.
- Recurring events are still expanded only as far as `expo-calendar` returns
  instances; server-side recurrence remains deferred (ADR 0040 decision 3).

## Addendum (2026-07): provider/color in settings + recurring-instance fix

- **Recurring occurrences no longer collapse.** `expo-calendar` returns each
  occurrence of a recurring series as a separate object that **shares the series
  `id`** (they differ by `instanceStartDate`). The read-up keyed the row on
  `deviceEventId = event.id`, so every occurrence produced the same
  `external_uid` and the ingest overwrote one row instead of inserting each — so
  a recurring series showed as a single event (heavy on iCloud). Fixed in the
  read-up by keying the occurrence as `<id>:<instanceStartDate>` when the
  instance start is present.
- **Settings distinguishes providers.** `calendar_sources.provider` is now
  surfaced through `CalendarSourceRow` → the `CalendarSource` kernel type → the
  settings list, which renders `Name (Google)` / `Name (Device)` so a same-named
  Google and device calendar are distinguishable. The per-calendar busyness list
  is no longer gated on Google being connected (device-only users have sources
  too).
- **Per-calendar color.** New `calendar_sources.color` column (migration
  `019`). Google's color comes from the calendarList entry's `backgroundColor`;
  the device's from `expo-calendar`'s `Calendar.color` (no native change — the
  chord-eventkit module still only supplies the per-event UID). Surfaced as a
  swatch in settings. A color-less re-sync preserves the stored color.

- **Bidirectional delete is now reconciled, not just live.** Deletes propagate
  both ways even across an app close:
  - *Device → Chord* was already robust: `syncDeviceCalendar`'s reverse-delete
    soft-deletes any in-window `device:` row for a synced calendar that's absent
    from the batch, and it runs every foreground via `pullDeviceCalendar`. (A
    deleted recurring *occurrence* is a distinct `device:<cal>:<id>:<instance>`
    row post the recurring-instance fix above, so it reverse-deletes the same
    way — the other occurrences stay.)
  - *Chord → device* previously relied **only** on the live `event.deleted` SSE
    (`removeEventFromCalendar`), so a delete that landed while the app was closed
    left a stale device copy forever. Added `reconcileCalendarDeletes(liveIds)`
    (`mobile/src/calendar.ts`), run each foreground in `runAppleSync`: any event
    we wrote to the device (id-map) that is no longer in `/me/events` is removed
    from the device — mirroring the Reminders sync's delete-detection. No-op when
    Google handles device sync (deletes propagate Google→device via the OS).

**Addendum 2026-10-23 (subscribed calendars re-id every refresh).** Prod: one user's phone mirror held 71,525 tombstoned `device:` rows (of 82k events in the whole table) and added ~2,000 a day, all from one read-only subscribed calendar (a school ICS feed). iOS hands every event in a subscribed calendar a NEW event id and external id on each refresh, so each sync inserted the feed again and reverse-deleted the previous copy. Layer 2 should have dropped most of them anyway, since the same feed is also pulled from Google, but it compared `starts_at` as a string: the phone sends `…20:00:00.000Z`, the Google pull stores `…20:00:00Z`, so it never matched (the ADR 0208 class). Now Layer 2 compares instants (`instantMs`), and an event that arrives under a new id takes over the live row the same calendar already holds for the same title and start (one row per incoming event, never a row whose id is still in the batch) instead of inserting a new one. Existing tombstones are left in place.

**Addendum 2026-10-23 (all-day events matched by date).** An all-day event on a Google or Outlook calendar that is also on the phone was mirrored twice. Neither side sends a date: iOS sends the instant of LOCAL midnight (`2026-07-04T04:00:00.000Z` in New York, `2026-07-03T18:30:00.000Z` in Kolkata, the previous UTC day), Android sends UTC midnight wherever the phone is, and the Google/Outlook pull stores a floating `2026-07-04T00:00:00` (ADR 0040). After the instant fix above, iOS never matched; Android matched only because a floating value is read as UTC, while its stored row showed on the previous day west of UTC. Now an all-day pair is compared by DATE (`server/src/services/events/device-all-day.ts`, `sameEventStart`): a floating value as written, exact UTC midnight as its UTC date (Android, and any zone at UTC+0), anything else as local midnight in the phone's zone. The batch carries that zone (`DeviceCalendarSyncRequest.timeZone`, sent by both the iOS and Android app); an older app omits it and `users.last_tz` stands in (no zone at all: the nearest UTC midnight, right from UTC-11 to UTC+11). An all-day and a timed event never match. A phone all-day row is now STORED floating too (start date, exclusive end date), so every client puts it on its day. Three more changes: `dropDeviceTwin` (ADR 0228) now runs after a Google insert as well as an Outlook one, with the same date rule, since Layer 1 misses a Google calendar the phone holds under another account; the device sync drops an EXISTING phone row that has a server copy (the doubles already in prod, removed on the next sync rather than left forever); and the server-copy check reads the user's non-device events once per sync instead of one query per event. Not covered: a stale `last_tz` on an older app whose user changed zone, for iOS all-day events in that window.

**Addendum 2026-11-02 (a calendar the phone stopped sending).** A phone calendar no phone has sent for `RETENTION_DEVICE_CALENDAR_DAYS` (30) is forgotten by the daily prune, with its mirrored events, except rows the Google/Outlook pull has adopted (they carry `google_calendar_id` / `gcal_event_id`). Time-based because a second phone sends only its own calendars. Details in ADR 0226's addendum.
