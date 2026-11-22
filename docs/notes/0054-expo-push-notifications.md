# 0054 — Expo push notifications

**Status**: accepted
**Date**: 2026-06-17
**Related**: [ADR 0002 — SSE over WebSockets](./0002-sse-over-websockets.md),
[ADR 0010 — IM connector outbound publisher](./0010-im-connectors.md),
[ADR 0034 — Configurable nudge time](./0034-configurable-nudge-time.md),
[ADR 0043 — Account deletion](./0043-account-deletion.md)

## Context

Until now everything the server emits to a client — new messages, bot replies,
and the proactive daily briefing / nudges (ADR 0034, `proactive.service.ts`) —
is delivered **only over SSE**. SSE requires an open app: if Chord is
backgrounded or closed, the message lands silently and the user finds out next
time they open the app. There is no way to reach the device when the app isn't
running.

The ask: enable real push notifications on iOS (delivered through TestFlight
builds), surfaced as a **Notifications toggle in Settings**, firing for (a)
proactive nudges, (b) bot replies / `@`-mentions, and (c) all new group
messages.

## Decision

Use the **Expo push service** (`expo-server-sdk` → `exp.host`) with a new
per-device `push_tokens` table, and fan notifications out by **mirroring the IM
outbound-publisher** (ADR 0010).

### One hook covers all three triggers

Proactive nudges, bot replies, and human messages **all** funnel through the
same call: `sseHub.broadcast(groupId, SSE.message, msg)`. So a single
`startPushPublisher` registered on `sseHub.onBroadcast` — structurally
identical to `startOutboundPublisher` — catches every trigger. For each
`SSE.message` it pushes to the group's members **minus the message's own
sender** (bot/proactive rows have `sender_id = null`, so everyone is a
recipient). `system` messages are skipped.

This avoids touching `proactive.service.ts`, the bot pipeline, and the message
route separately — they already broadcast; the publisher observes.

### Token presence is the enable signal — no `push_enabled` column

A device is "enabled" iff it has a row in `push_tokens`. The Settings toggle
registers (`POST /me/push-token`) on enable and unregisters (`DELETE`) on
disable / sign-out. A separate `users.push_enabled` flag would duplicate state
the token set already encodes and invite a two-source-of-truth bug. Multi-device
falls out for free (one row per token; `token` is the PK so re-registration
upserts). `ON DELETE CASCADE` on `user_id` means account deletion (ADR 0043)
cleans tokens automatically.

### Dead-token cleanup via the ticket, not the receipts API

Expo returns a *ticket* per send (synchronous) and, separately, delayed
*receipts* keyed by `receiptId`. We prune a token when its **ticket** comes back
`DeviceNotRegistered` (or fails `Expo.isExpoPushToken`) — the ticket still
carries the token, so cleanup is a one-step delete. We deliberately **skip the
receipts pass for v1**: receipts are keyed by `receiptId`, not token, so acting
on them would require persisting a `receiptId → token` map for marginal benefit
— a device that slips through gets the same `DeviceNotRegistered` ticket on the
very next send and is pruned then.

### Gated off by default

`PUSH_ENABLED` (env, default **false**) gates both the publisher and the send
path; `EXPO_ACCESS_TOKEN` is optional. Off by default so tests/CI/local dev
never reach Expo. The `Expo` client is constructed lazily inside `sendPush`
(after the gate), so importing the module is inert, and `deliver` short-circuits
before any Expo call when no recipient has a token.

## Addendum — notification preferences (per-category, quiet hours, per-group mute)

The base feature shipped with a single per-device master toggle (token presence).
A follow-up adds real preferences. Decisions worth recording:

- **Per-recipient gating in the publisher.** `deliver()` no longer fans every
  message to every token. `selectRecipientTokens()` classifies the message into a
  category and, per candidate member, applies: author-exclusion, per-group mute,
  the recipient's category toggle, and quiet hours — then fetches only the
  surviving users' tokens. Selection is exported and unit-tested independently of
  Expo.
- **Category split via `is_proactive`.** `text`/`file` → *New messages*
  (`notify_messages`); `kind='bot'` + `is_proactive=1` → *Daily briefing*
  (`notify_briefing`); `kind='bot'` + `is_proactive=0` → *Bot reply / @mention*
  (`notify_bot`). The kernel `Message` doesn't carry `is_proactive`, so the
  publisher looks it up only for bot messages.
- **Quiet hours exempts the briefing.** The window (per-user, evaluated in the
  user's `last_tz` via the same `toLocaleString('sv-SE')` technique as
  `nextScanDate()`) suppresses *New messages* + *Bot replies* only — the briefing
  fires on the schedule the user explicitly set (`nudge_*`). Windows may wrap past
  midnight; `isQuietNow()` handles that.
- **Account-level prefs vs device-level master.** Category toggles + quiet hours
  live on `users` (apply to all of a user's devices); the master on/off remains
  per-device (token presence). Both coexist in the Settings card.
- **Per-group mute is per-(user,group)**, stored as `group_members.muted`
  (mirrors `last_read_at`), surfaced as `Group.muted` on the single-group fetch
  and toggled from the *group* settings screen — kept out of the main Settings
  tab to avoid bloating it.

## Alternatives considered

1. **Raw APNs (`.p8` key, JWT signing).** Full control, no Expo dependency, but
   far more setup (certs, token signing, FCM for Android later) and a heavier
   lift to get working in TestFlight. Expo's service handles the APNs key via
   EAS credentials — the right trade for a managed-Expo app.
2. **Single `users.expo_push_token` column.** Simpler schema, but loses a device
   whenever the user has more than one. The per-device table is barely more code
   and is correct for multi-device.
3. **Push only the proactive nudges** (hook `fireOne` instead of the broadcast).
   Narrower, but the product wants new-message and bot-reply pushes too, and the
   broadcast hook gets all three for the cost of one.
4. **Add a `push_enabled` user column.** Rejected — see above; token presence is
   the single source of truth.

## Consequences

- New `push_tokens` table (migration `012_push_tokens`); `POST`/`DELETE
  /me/push-token` endpoints; `services/push/{expo.service,push-publisher}.ts`;
  `startPushPublisher` wired into `server.ts` next to the proactive scheduler.
- Mobile: `expo-notifications` + `expo-device`, the `expo-notifications` config
  plugin (injects the iOS `aps-environment` entitlement at build time),
  `src/push.ts` (permission + token registration + tap-routing), a Settings
  toggle, and a launch-time token refresh.
- Push only works in a real build on a real device (dev-client / TestFlight /
  production) — never the simulator or Expo Go on SDK 54. APNs credentials are
  managed by EAS (`eas credentials`); none are checked into the repo.
- In-process only: like the SSE hub (ADR 0002), the publisher runs per-node. A
  multi-node deployment fans out per node, which is fine — each broadcast is
  observed once per node it occurs on. (The hub itself would need a shared
  adapter first; same caveat.)
- Operational: set `PUSH_ENABLED=true` on the deployed server once a build is
  registering tokens.
- Future (not built): notification grouping / per-group mute, badge counts,
  Android channel tuning, and a `receiptId → token` map if stricter same-cycle
  receipt cleanup is ever needed.
