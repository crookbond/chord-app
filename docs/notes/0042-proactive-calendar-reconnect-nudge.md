# 0042 — Proactive calendar-reconnect nudge

**Status**: accepted
**Date**: 2026-06-03
**Extends**: [ADR 0034 — Configurable nudge time](./0034-configurable-nudge-time.md), [ADR 0040 — Two-way calendar](./0040-user-owned-two-way-calendar.md), [ADR 0041 — Native iOS OAuth client](./0041-native-ios-oauth-client.md)

## Context

Google refresh tokens die (revoked, password change, and — while the OAuth
consent screen is in "Testing" — every ~7 days). When that happens the server
clears the token and reports `needsReconnect`, but **only reactively**: the
user sees it if they open Settings or trigger a sync. Someone who doesn't go
looking silently falls out of calendar sync for days.

Two things were missing:
1. a **proactive** warning to reconnect, and
2. certainty that events the user **created in Chord while disconnected** still
   reach Google after they reconnect.

## Decision

**Proactive nudge.** The existing daily-scan scheduler (ADR 0034) already fires
a morning briefing into each user's personal group. Riding that, once a day we
call `maybeNudgeCalendarReconnect`: for a user who looks connected
(`google_connected_at` set), probe `getAccessToken` (which itself clears a dead
token); if it's dead, post a one-time actionable bot message with an `action`
card whose deep link is **internal** — `chord://settings?reconnect=calendar`.
Mobile's Settings reads that param and launches the connect flow. (iOS won't
auto-open the auth sheet without a fresh tap, so it lands on the one-tap
Connect button.)

**Throttle.** `users.calendar_reconnect_nudged_at` (migration 009) is set when
we warn and cleared by `persistRefreshToken` on reconnect — one warning per
disconnect, not every morning.

**Don't nudge intentional disconnects.** The disconnect route now clears
`google_connected_at` (and the nudge marker), so the nudge — which keys off
`google_connected_at` — fires only for true expiry, never for a user who chose
to disconnect.

**No event loss.** Offline-created events already stay `local_dirty=1` and push
on the next sync. But `pushDirtyEvents` *claimed* dirty rows (`local_dirty=0`)
**before** fetching the access token; a dead token there left them claimed but
un-pushed — stuck forever. Fixed: if `getAccessToken` throws after the claim,
restore `local_dirty=1` so a post-reconnect sync re-drains them.

## Consequences

- One extra Google token call per user per morning (the health probe), and a
  second message on the day a disconnect is first detected.
- Users with the daily briefing disabled (`nudge_enabled=0`) won't get the
  proactive nudge — they still see the reactive Settings prompt. Acceptable.
- The durable fix for the weekly expiry is still publishing the OAuth consent
  screen to **Production** (removes the 7-day token life); this nudge is the
  safety net regardless.
