# 0012 — Proactive event scanning and family-graph nudges

**Status**: accepted; "Device calendar sync is client-side" section superseded by [ADR 0015](./0015-server-side-google-calendar.md)
**Date**: 2026-04-30
**Builds on**: D1 reversal (see [`docs/tasks/README.md`](../tasks/README.md))

## Context

Chord today is purely reactive. The bot stays silent unless `@Chord` is
mentioned in a shared group, or any message arrives in a personal
group. That gating was deliberate — D1 in the roadmap rejected silent
ambient extraction because false positives are unbounded when the bot
listens to every message.

The product brief asks for a different kind of proactivity: the bot
should anticipate **based on calendar content the user has already
committed to**, not on ambient chat. Two concrete shapes:

- **Event-write hook.** When a new event or trip lands on the calendar
  ("Hans's birthday June 12", "Miami trip June 15–20"), the bot
  immediately surfaces the ancillary needs that follow from it — book a
  hotel, arrange childcare, get the kids' camp physicals, send a card.
- **Daily morning scan.** Once a day the bot looks 30 days ahead at
  what is on the user's calendar across all their groups, identifies
  what needs action soon (reservation windows closing, conflicts,
  long-lead-time items, gaps in trip bookings), and posts a single
  morning briefing into the user's personal chat.

The trigger surface is bounded (committed calendar items, not ambient
chat), so the false-positive risk that killed D1 doesn't apply: the
bot is only ever talking about events the user themselves put on the
calendar.

This ADR also pins down how the calendar surface is realized.
The product direction is "use an existing calendar, don't build one":
events and trips written by Chord get pushed to the user's device
calendar (iOS Calendar / Google Calendar) so they appear in the
calendar app the user already uses. Chord doesn't ship a calendar
view of its own.

## Decision

### Two delivery paths, one scheduler

Both use the existing
[`server/src/services/proactive.service.ts`](../../server/src/services/proactive.service.ts)
infrastructure (`proactive_messages` table + `setInterval` drainer).
We add two new `kind` values and one new ingress per kind:

| Kind | Triggered by | Schedule | Posts to |
|---|---|---|---|
| `event_created_nudge` | Successful `create_event` / `create_trip` in the bot executor | `scheduled_for = now()` (drained on next tick); **rate limit bypassed** | Triggering user's personal group |
| `daily_morning_scan` | Self-rescheduling row, seeded at server startup | Next 7am server-local; reseeds on fire | Each user's personal group |

Both kinds invoke the LLM provider for body generation. The provider is
the same factory the bot turn uses
([`services/llm/factory.ts`](../../server/src/services/llm/factory.ts)),
called as a single-shot completion (no streaming, no tool loop) — these
are short messages, not bot turns.

### Scope of the daily scan

The scan looks 30 days ahead across:

- All `events` rows in groups the user is a member of
- All `trips` rows (with their legs / accommodations / reservations)
  in groups the user is a member of

Gap detection reuses the existing `TripStatus.gaps` shape produced by
the `get_trip_status` executor case — the scan computes gaps from the
DB, not by querying a calendar. "Calendar" here means the projection
of `events` + `trips`, not the iOS/Google calendar view.

### Event-write hook nudge shape: act now vs. save for later

The event-write hook does not just announce ancillary needs — it
offers a two-way choice. The LLM is prompted to produce:

1. A one-line acknowledgment of the event/trip the user just created.
2. A short bulleted list of the ancillary actions Chord thinks
   follow from it ("book a hotel", "arrange childcare", "get camp
   physicals", "send a card").
3. A trailing question of the form *"Want to work on these now, or
   should I remember them and bring them up closer to the date?"*

If the user replies affirmatively in the personal chat, the bot's
normal turn handles the work (creating tasks, saving links, etc.).
If the user defers, the bot writes the items into the existing memory
system as `[event]`-scoped memory rows tied to the originating event
or trip, so the daily morning scan can resurface them when the date
draws near. No new persistence surface; reuses the memory layer that
already exists in `services/bot/context.ts`.

The "act now / defer" trailing question is the interaction contract.
A nudge that just announced needs without asking would either nag
forever or be ignored.

### Personal chat as the delivery surface

Every nudge lands in the recipient's personal group, never in shared
groups. Rationale: nudges are inherently per-user (Mother's Day matters
to whoever's mother it is; childcare is the parents' problem), and
posting them in a shared group would broadcast assumptions about other
members' obligations.

This also keeps the existing in-shared-group gate intact: shared groups
remain `@chord`-only.

### Device calendar sync is client-side

> **Superseded by [ADR 0015](./0015-server-side-google-calendar.md).**
> Phase 5 adds server-side write to Google Calendar. The device-side
> `expo-calendar` write described below is **not** the primary path
> anymore: it is now a fallback that runs only for users who have not
> connected Google (see ADR 0015's updated "device-side write" point
> and `mobile/src/calendar.ts`). For Google-connected users the OS
> mirrors the server-written events to the device, so the client write
> is skipped to avoid duplicates and a server-invisible device-only
> copy. The rest of this ADR (proactive scheduler, nudge shape,
> personal-chat surface) is unchanged.

When the server creates an event or trip and broadcasts the existing
SSE (`SSE.eventCreated`, `SSE.tripUpdated`), the mobile client reacts by
calling `expo-calendar` to insert the entry into the device's native
calendar. The server has no concept of the device calendar.

Trips become an all-day event spanning `startDate` → `endDate`. Events
become single-time entries at `startsAt` with `location` populated.

### Timezone

Daily scan fires at 7am **server-local time**. Per-user timezones are
deferred — adding them requires a `users.timezone` column, sign-in
collection, and per-user scheduling. For the demo and early users
(single-deployment, US-clustered), server-local is acceptable.

## Alternatives considered

- **Skip the event-write hook; do everything in the daily scan.**
  Simpler — one delivery path, one cron-like row. Rejected: the demo
  value of "I just told Chord about Hans's birthday and it
  immediately suggested party planning" is too strong to defer to
  next-morning. The hook is cheap once `proactive_messages` already
  supports new kinds.

- **Use a real cron library (`node-cron`).** Cleaner scheduling
  semantics, especially if we later want per-user timezones. Rejected
  for now: the existing `setInterval` + `proactive_messages` row gives
  us durability across restarts and is already in use. Adding
  `node-cron` introduces a second scheduling model. Revisit when we
  add per-user timezone scheduling.

- **Push notifications for nudges.** More urgent, more annoying.
  Rejected for now: in-chat is consistent with the rest of Chord's
  output surface, and we don't yet have notifications wired (Expo
  Notifications is on the post-Phase 4 list).

- **Server-side calendar sync (Google Calendar API, CalDAV).**
  Symmetrical with import — Chord could *read* and *write* to the
  user's actual Google Calendar. Rejected for the demo: requires
  OAuth, per-user calendar credentials, and a write surface that
  raises real correctness concerns (what if Chord double-books?
  what if the user deletes the event in Calendar — does Chord delete
  the row?). Device-calendar sync via expo-calendar is one-way
  (Chord → device), local, and free of OAuth.

- **Template-based nudges instead of LLM.** Cheaper, more
  predictable. Rejected: the whole point of the feature is that
  Chord notices things a template can't ("Mother's Day is a Sunday,
  reservations book up early"). Cost is bounded — at most one event
  hook per write, one daily scan per user.

- **Skip the personal chat; surface nudges as a separate "Suggestions"
  inbox.** Cleaner separation of bot output from human chat.
  Rejected: contradicts the brief explicitly ("reminders should
  appear in the chat window, not cluttering the calendar itself").

## Consequences

### What this commits us to

- **`proactive_messages.kind` becomes a real enum surface.** Today it
  has one value (`task_remind`). After this ADR there are three. Any
  new proactive surface (Phase B per-file extraction suggestions,
  reservation-window closing alerts, etc.) lands as a new kind here
  rather than a new table.
- **The proactive service depends on the LLM factory.** Adding a
  scheduler-time LLM call means a server with `LLM_PROVIDER=mock` and
  no API key still works (the mock provider responds). But scheduler
  outages now potentially correlate with LLM-provider outages — note
  the dependency in operational runbooks.
- **Event-write hooks bypass the rate limit.** `PROACTIVE_RATE_MINUTES`
  (default 1440 = 24h per group/persona) was sized for `task_remind`
  and applies to `daily_morning_scan`. `event_created_nudge` is
  exempt: it is triggered by a user action, not by a scheduler tick,
  and the demo value collapses if a freshly created event silently
  gets eaten by the morning scan's daily budget. The bypass is per-
  kind in `fireOne()`, not a global config flag.
  **Removed 2026-10-13.** Every other kind was exempted over time, which
  left the limit on `task_remind` alone. The 07:00 briefing's fired row
  then blocked any reminder in the same personal chat for 24 hours, and
  the 6-hour staleness cutoff retired it unsent (prod: a 09:00 "Text
  Nick" reminder never arrived). `PROACTIVE_RATE_MINUTES` and the
  check are gone; a reminder fires at the time its owner picked.
- **The daily scan must be idempotent on restart.** `seedDailyScan()`
  runs at startup; it must not insert a duplicate row if today's
  scan is already queued or fired. Use a uniqueness check on
  `(kind='daily_morning_scan', scheduled_for date = today)`.
- **Device-calendar sync is best-effort.** No retry, no reconciliation
  if the user denies calendar permission, no delete on Chord-side
  delete. This is acceptable for the demo; revisit if users
  complain that Chord's calendar entries get stale.

### What we explicitly do NOT do

- **No silent ambient extraction.** D1's decision still stands for
  *chat content*. This ADR only fires off committed calendar items.
- **No outbound write to Google/Apple cloud calendars.** Device-only.
- **No cross-user visibility of nudges.** Each user's morning briefing
  is computed and delivered independently from their own personal
  group; group members don't see each other's briefings.
- **No timezone customization.** Server-local 7am for everyone.

### Things to watch

- **LLM cost on startup floods.** If many users have many upcoming
  events, the morning scan does N LLM calls within a tick window.
  Consider batching or rate-limiting the scan firing if this becomes
  visible in cost.
- **"Why did Chord nudge me about this?" provenance.** The same
  drill-down pattern Phase A added for imported entities
  (`source_raw_context`) should eventually apply to nudges, so a
  user can tap a morning briefing line and see which event/trip on
  the calendar drove it. Out of scope for this ADR; capture as a
  follow-up.
