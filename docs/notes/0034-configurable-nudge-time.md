# 0034 — User-configurable daily-briefing ("nudge") time

**Status**: accepted
**Date**: 2026-05-21
**Related**: [ADR 0013 — ICS calendar ingest](./0013-ics-calendar-ingest.md),
[ADR 0007 — Triggering user identity in the turn](./0007-user-identity-in-turn.md)

## Context

The proactive daily morning scan (`proactive.service.ts`) fires a
briefing into each user's personal group. The fire time was hardcoded to
07:00 in the user's last-seen timezone (`nextScanDate`), and the only
user-facing control was a "trigger now" button whose copy read
"(DEMO_MODE only)". That button hit `POST /_dev/proactive-scan`, which
enqueued the caller's scan and then ran a global `drainOnce` — firing
*every* user's due nudges early — which is why it was DEMO_MODE-gated.
Users had no way to pick a time or turn the briefing off, and the
demo-only framing leaked into production UI.

## Decision

Make the schedule a per-user setting: `nudge_hour` (0–23),
`nudge_minute` (0–59), and `nudge_enabled` (default 07:00, on). Stored as
columns on `users` — the same row that already carries `last_tz`, the
other half of "when does this user's scan fire" — rather than a separate
table or a cron expression. The schedule is a fixed daily wall-clock
time, so three scalar columns model it exactly; a cron string would be
over-powered and harder to render/parse in the UI.

Two write paths set it, mirroring `set_my_name` (ADR 0007):

- **Settings UI** → `PUT /api/v1/me/nudge` with `{hour?, minute?, enabled?}`.
- **Chat**, in the personal group only → `set_nudge_time` tool ("nudge me
  at 7am daily", "stop nudging me"). Personal-only, like `set_my_name`,
  since changing another member's schedule from a group chat would be
  surprising.

Time parsing/formatting (`parseTimeOfDay` / `formatTimeOfDay`) lives in
`kernel` so the UI text field and tests share one implementation; the
chat path lets the LLM emit `hour`/`minute` directly.

**Immediate reschedule.** `seedDailyScan` dedupes one row per user per
local day, so simply changing the time would not move a row already queued
for today. Both write paths call `rescheduleDailyScanForUser`, which
deletes the user's pending (unfired, non-dev) `daily_morning_scan` row and
re-queues it at the new time — or queues nothing when `nudge_enabled=0`.
Dev-triggered scans (`-dev-` scanDate, ADR 0013 testability) are left
alone. The self-reseed in `fireOne` and the boot-time `seedDailyScan` both
skip disabled users.

**On-demand "send me a briefing now".** `POST /_dev/proactive-scan` now
calls `runDailyScanForUserNow`, which enqueues the caller's row and fires
*only that row* (`fireOne`) instead of `drainOnce`. Because it touches
only the caller's personal group it is no longer DEMO_MODE-gated — it
backs the production "Send me a briefing now" button. It returns
`{ ok, posted }`. The demo *reset* endpoint in the same router stays
DEMO_MODE-gated.

## Consequences

- Existing rows default to 07:00/enabled, preserving prior behavior.
- Turning nudges off stops seeding/rescheduling but does not delete a row
  that is already firing; the next reseed simply won't run.
- `nextScanDate(tz, hour, minute)` stays backward compatible via defaults
  (`hour=7, minute=0`), so existing callers and tests are unaffected.
- A future per-day or quiet-hours schedule would outgrow three columns and
  warrant the separate-table option rejected here.
