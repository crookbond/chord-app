# Calendar — expected changes

Planned/anticipated work on the calendar surface (`mobile/app/calendar.tsx`,
shared by web + native via RN Web). Scoping notes captured here before
implementation; promote items to commits as they land.

---

## 1. Edit / delete an event (web calendar)

**Status:** planned. Backend + schema already exist — this is almost entirely
web UI.

### Already done (no work)
- **Server:** `updateEvent` / `deleteEvent` in `server/src/services/events.service.ts`;
  routes `PATCH /api/v1/events/:eventId` + `DELETE /api/v1/events/:eventId`
  (`server/src/routes/events.ts`), both zod-validated.
- **Two-way Google sync** is wired into both (ADR 0040): an edit bumps
  `sequence` and patches Google; a delete tombstones the copy and removes it
  from Google. So edits/deletes from the web propagate automatically.
- **Kernel:** `UpdateEventRequest` (`title`, `location`, `startsAt`, `endsAt`,
  all optional/nullable).
- **`mobile/src/confirm.ts` `confirmDestructive`** (web-safe) for the delete
  confirm.

### Work required (all client-side)
1. **API functions** in `mobile/src/api.ts` — `updateEvent(id, patch)` and
   `deleteEvent(id)` (~10 lines, mirror existing `request<>` calls).
2. **Make `EventBlock` tappable** — it's a plain `View` today. Add `onPress`
   and thread a handler up from `DayView`/`WeekView` to a modal at the calendar
   root. (Also applies to the all-day strip + `LegBlock` if we want those
   actionable; legs are part of trips, so likely just events for now.)
3. **Delete** — `confirmDestructive` → `deleteEvent(id)` → drop from local
   `events` state (calendar already holds `events` + a `refresh()`).
4. **Edit modal** — title / location / start / end. Mirror the existing
   `TaskEditModal` / `SaveEditModal` pattern in `mobile/app/catchup/[tab].tsx`.
5. **Refresh after mutation** — optimistic local update or call `refresh()`.

### The fiddly bit
No native date/time picker in the app. The event composer uses a free-form
parseable string (e.g. `2026-05-01 18:30`) and emits ISO datetimes with the
user's tz offset. The edit modal should reuse that approach. Watch:
- timezone offset on `startsAt`/`endsAt` (match the `create_event` convention),
- all-day vs timed (floating-midnight `...T00:00:00`, no offset → free),
- editing a gcal-pulled event applies last-writer-wins and patches Google
  (works; minor caveat),
- group-shared events: server handles the per-owner fan-out + sequence; the web
  user edits their own copy.

### Effort
- Delete + tap-to-view: ~30–60 min (everything exists).
- + Edit modal: another couple hours.
- Total ≈ half a day for a clean edit+delete; works on native too modulo the
  datetime-picker polish.

### Suggested sequencing
Land **delete first** (fastest, high value), then the **edit modal** — each as
its own gated commit.

---

## Already shipped (for context)
- **Now-tracking** (ADR 0040 era): Day/Week views open centered on the current
  time and the red now-line ticks live; re-centers when "now" scrolls off-screen
  unless the user scrolled recently. (`useNowTracking` in `calendar.tsx`.)
