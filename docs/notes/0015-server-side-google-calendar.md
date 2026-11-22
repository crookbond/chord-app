# 0015 — Server-side Google Calendar write (`Chord` calendar)

**Status**: accepted — **largely superseded by [ADR 0040](./0040-user-owned-two-way-calendar.md)** (one-way push → two-way sync; the single dedicated "Family" calendar → per-event selectable calendar). The server-side-write principle stands; the one-way/single-calendar mechanics do not.
**Date**: 2026-05-03
**Supersedes (in part)**: [ADR 0012 — Proactive event scanning and family-graph nudges](./0012-proactive-event-scanning.md), specifically the "Device calendar sync is client-side" section. The nudge mechanics in 0012 are unchanged.

## Context

ADR 0012 picked **device-only calendar sync** via `expo-calendar`:
when Chord wrote an event or trip, the mobile client mirrored it into
the device's native calendar app. Server had no concept of the cloud
calendar. Rationale at the time: avoid OAuth, avoid correctness
hazards (double-booking, deletion reconciliation).

Two things changed:

1. ADR 0014 commits us to Google OAuth anyway as the auth provider.
   The "avoid OAuth" half of 0012's reasoning is gone.
2. Multi-device usage is now in scope. Device-only sync writes to
   *one* device's calendar; if the user has Chord on iPhone and reads
   their calendar on a laptop, the laptop never sees Chord's entries.
   Cloud-side write to Google Calendar is the only fix that doesn't
   require Chord to host its own calendar UI.

## Decision

Chord writes events, trips, and reminders to the user's **Google
Calendar**, in a dedicated calendar named `Chord`, server-side.

Mechanics:

- **Calendar provisioning**. On the first server-side write for a
  user, call `calendars.insert({ summary: 'Chord' })` and persist the
  returned `calendar_id` on the user row.
- **Scope acquisition**. ~~Calendar scopes are *not* requested at
  sign-in.~~ **Superseded by [ADR 0028](./0028-calendar-scope-at-signin.md):**
  the `calendar` scope is requested as part of the initial sign-in
  PKCE flow so users land in the app with read+write already wired.
  The separate "Connect calendar" route stays as a fallback for users
  who declined at sign-in or who signed in under the old flow.
- **One-way for writes, with delete reconciliation on read**. Chord →
  Google for create/update; we do not subscribe to push channels and
  do not propagate Google-side *edits* back. We *do* reconcile
  **deletions**: `syncPrimaryCalendar` builds the set of event ids Google
  still returns across *all* calendars this run, then deletes any
  Google-linked local row (matched by `external_uid` or `gcal_event_id`)
  that no calendar returned. Scoped to the fetched window (we can't judge
  events we didn't query), skipped entirely if any calendar fetch failed
  (incomplete data must not trigger deletes), and guarded by
  `REVERSE_DELETE_GRACE_MS` so a just-pushed event mid-propagation isn't
  race-deleted. The fetch window is −7d..+90d by default
  (`DEFAULT_FUTURE_DAYS`), widened on demand up to `MAX_FUTURE_DAYS` (730)
  when the client asks for a further horizon (`GET /me/events?futureDays=N`)
  — and since the sweep is window-scoped, the wider fetch also reconciles
  deletes further out. The sync runs on the manual `POST /me/calendar/sync`,
  on bot calendar tools (throttled 5 min), and on `GET /me/events` — so
  opening/refreshing the calendar reconciles (throttled 60s; a
  deeper-than-default request bypasses the throttle). Field edits made in
  Google are still not propagated.
- **Write-after-commit**. The DB row is the source of truth. After
  the SQLite insert/update commits, we enqueue a sync task that calls
  the Google API. Sync failure does not roll back the row.
- **Sync state**. New columns `gcal_event_id TEXT NULL`,
  `gcal_sync_status TEXT NOT NULL DEFAULT 'pending'`, `gcal_synced_at
  INTEGER NULL`, `gcal_last_error TEXT NULL` on `events`, `trips`, and
  whatever surface reminders end up on. A small worker drains
  `pending` and `error` rows with backoff.
- **What writes**:
  - `events` → single-time Google Calendar event at `startsAt`,
    `location` populated.
  - `trips` → all-day event spanning `startDate` → `endDate`.
  - Reminders (the proactive `task_remind` surface) → Google Calendar
    event at the reminder time, no attendees, default 10-minute
    popup reminder.
- **Device-side `expo-calendar` write is demoted to a no-Google
  fallback** (not removed — this ADR originally claimed removal, but
  the client write was never actually deleted). For a user with Google
  connected (write scope), cloud sync already places Chord's entries on
  every device via the OS, so the client write is **skipped** — running
  it too would (a) double every entry and (b) create a device-only copy
  the server can't see, so Telegram and the daily nudge would miss it.
  The client write therefore survives only for users who have **not**
  connected Google, so their events still appear on their phone. The
  gate is a client flag (`setGoogleHandlesDeviceSync` in
  `mobile/src/calendar.ts`) fed by the calendar-status / connect /
  disconnect calls in `mobile/src/api.ts`, keyed on the same
  `calendar` / `calendar.events` write scope the server checks.

## Alternatives considered

- **Stay with device-only `expo-calendar` sync (status quo from
  0012).** Rejected: doesn't handle multi-device, doesn't support a
  web client, and the "avoid OAuth" rationale is moot once 0014
  ships.
- **Two-way sync (subscribe to Google push, reconcile edits).**
  Rejected for now. Big increase in surface area: webhook channel
  lifecycle, conflict resolution, soft-delete vs. hard-delete
  semantics. We don't yet have the user-facing surface that would
  make two-way valuable, and one-way captures the demo value.
- **Write to the user's primary Google calendar.** Rejected:
  pollutes the calendar the user already curates; a dedicated `Chord`
  calendar is trivially toggleable in Google's UI, which is the
  user's escape hatch when they want Chord-generated entries off
  their main view.
- **CalDAV (works for iCloud, Fastmail, etc.)**. Cleaner protocol,
  not Google-specific. Rejected for now because 0014 commits to
  Google as identity provider — there's no path to CalDAV without
  also widening 0014. Revisit if/when we add Apple sign-in.

## Consequences

### What this commits us to

- **Two `proactive_messages` paths now share a Google Calendar
  surface.** Both `event_created_nudge` (which informs about a newly
  created event) and `daily_morning_scan` (which summarises upcoming
  ones) read from a calendar that Chord itself wrote to. Make sure the
  scan doesn't pick up a Chord-written event and treat it as
  "discovered" — filter on `events.gcal_event_id IS NULL OR
  events.source != 'chord'` if needed. Capture as a Phase 5 follow-up.
- **Token-refresh is now load-bearing for the bot's write path.** A
  failed refresh blocks GCal sync. The DB row still lands, so the
  user sees the entity in Chord; but it doesn't appear on their
  calendar. UI must surface re-connect when refresh fails (Q3 in
  `phase-5-plan.md`).
- **`gcal_event_id` is now a semi-public identifier.** Don't log it
  next to message bodies; treat as PII-adjacent.
- **Deleting a Chord row should attempt a Google delete.** Best-
  effort, queued the same way as the create. If the user already
  deleted it on Google's side, we get a 404; treat as success.
- **The `gcal_sync_status` worker is a new scheduled job.** Lives in
  `server/src/services/gcal/sync-worker.ts` (parallel to
  `proactive.service.ts`). Same `setInterval` shape; same restart
  durability.

### What we explicitly do NOT do

- **No two-way sync.** Edits in Google Calendar do not flow back.
- **No outbound CalDAV / Apple / Outlook write.**
- **No silent retry forever.** After N failures (say 5) with non-
  transient errors, mark `gcal_sync_status='error'` and stop; surface
  in the user's settings UI.
