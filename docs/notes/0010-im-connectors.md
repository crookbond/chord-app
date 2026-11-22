# 0010 — External IM connectors (Slack, Discord, Telegram)

**Status**: accepted — implemented — UPDATED 2026-06-01
**Date**: 2026-04-26

## Update — 2026-06-01

No longer "proposed": connectors are built and live under
`server/src/services/connectors/` (telegram/, slack/, discord/, plus mock/ and
the shared registry + inbound/outbound pipeline). Follow-on decisions that
refined this: [0011](./0011-supergroup-bot-mediated-bridging.md) (bridging
model), [0025](./0025-byo-connector-tokens.md) (BYO tokens),
[0029](./0029-tg-inline-actions.md) (Telegram inline actions), and
[0031](./0031-uuid-signup-soft-link.md) (Telegram signup soft-link).

## Context

Chord today is a closed system: users sign in via the mobile/web client,
post in Chord groups, and `@Chord` reacts via SSE. To extend the bot's
reach we want it to **join existing channels on external IM platforms**
— Slack, Discord, and Telegram — and behave as another member there:
listen, react when addressed, reply back in the same channel.

The webapp-start project already has Slack, Discord, WhatsApp, X, and
Reddit connectors organised around a `BaseBotService` abstraction
(`webapp-start/server/src/services/bot/`). Telegram is **not**
implemented there. The connector layer ports cleanly (~70%); the rest
is webapp-start's MongoDB bot-config + `llmInstanceManager`, which
Chord doesn't need — `bot.service.ts` already does that job.

Constraints:

- **Single-process.** ADR 0002 already accepts an in-process SSE hub.
  Discord adds a second persistent socket (gateway), but the same
  single-node assumption holds for the demo.
- **No new end-user auth surface.** External users surface as **shadow
  Chord users** (precedent: ADR 0008 — WhatsApp import). Mapping a
  shadow identity to a real Chord account is a *user-configuration*
  concern, not a connector concern.
- **One bot persona.** Chord has a single bot. webapp-start's multi-
  bot-per-platform machinery does not carry over.
- **One-way bot reply (v1).** Chord-native messages do **not** mirror
  out to bound external channels. A bridged group's primary surface is
  the external channel; the Chord group exists to give the bot context,
  memory, attachments, and tools.

## Decision

Add a connector subsystem at `server/src/services/connectors/` with:

1. A small `Connector` interface modelled on webapp-start's
   `BaseBotService` (signature verify → parse inbound → resolve identity
   & channel → `postMessage`; outbound `send` when bot replies).
2. Per-platform implementations: `SlackConnector`, `DiscordConnector`,
   `TelegramConnector`. Slack and Discord lift code from
   webapp-start (`slack.service.ts`, `discord.service.ts`,
   `discord-gateway.service.ts`); Telegram is written fresh.
3. Two new tables (migration `010_connectors`):
   - `external_identities (platform, external_id, user_id, …)` —
     shadow-user mapping.
   - `group_external_channels (platform, external_channel_id, group_id, …)`
     — channel↔group binding.
4. Inbound webhook route `POST /api/v1/webhooks/:platform` for Slack
   and Discord. Telegram uses long-poll `getUpdates` for the demo
   (no public URL needed). Channel↔group binding is established by a
   small CLI script, not an HTTP endpoint — admin UI is a future
   story in `client/`.
5. An **outbound publisher** that subscribes to the SSE hub. When the
   bot's final `message` event fires for a group with bound external
   channels, it forwards the reply text to each connector's `send`.
   No per-token streaming, no Chord-user mirroring.
6. A small refactor to `services/sse.hub.ts`: add an `onBroadcast`
   listener registry so non-Express subscribers (the publisher above)
   can listen without faking a `Response` object. The existing
   subscriber path is unchanged.

`bot.service.ts`, `executor.ts`, `context.ts`, retrieval, and the tool
registry **do not change**. Inbound becomes a regular `postMessage`
call, which already triggers the bot turn. Outbound observes the same
SSE event the mobile client observes.

## Alternatives considered

- **External bot processes per platform.** One Node service per
  platform, talking to Chord's public API as a regular user. Cleanly
  separable; no schema changes; but each process would need its own
  LLM client, prompt, retrieval, and tool dispatch, since the bot's
  context is computed inside Chord. Rejected: too much duplication
  for a demo and a divergent prompt surface to maintain.

- **Mirror Chord-native messages out to external channels (full
  bridge).** Bidirectional sync. Doubles the surface: bot identity in
  the outbound direction (post as the Chord user? as the bot?), edit/
  delete propagation, loop prevention, formatting fidelity. Rejected
  for v1; revisit if real users want to participate from both sides.

- **Discord interactions-only (no gateway).** Slash commands without a
  WebSocket. Simpler to deploy; but the bot can only respond to
  `/chord …` — it can't react to a regular `@Chord` message in a
  channel. Rejected: contradicts "the bot joins a channel."

- **Bake user-claim flow ("link my Slack identity to my Chord
  account") into the connector layer.** Useful, but it belongs in
  user settings alongside username and preferences. Deferred to a
  separate user-config story; the connector layer just does
  find-or-create-shadow.

- **Auto-create a Chord group on first inbound from an unknown
  channel.** Nice for ergonomics; risky for privacy (anyone who
  installs the bot in a workspace would create groups). Rejected:
  channel binding is explicit, via a small admin endpoint or seed.

## Consequences

- New env vars (declared in `example.env`, parsed in `config/env.ts`):
  `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `TELEGRAM_BOT_TOKEN`,
  `DISCORD_BOT_TOKEN`. Missing creds disable that connector at
  startup with a one-line warn, not a crash.

- **Discord v1 is gateway-only**: no interactions webhook, no slash
  commands. Slash commands aren't part of the demo flow (users
  `@chord` in channels), and the interactions endpoint is purely
  opt-in — Discord doesn't ping it unless the bot owner sets the
  URL. Skipping the webhook means no Ed25519 verification and no
  `tweetnacl` dependency. Slash commands can be added in a later
  phase without restructuring. We also drop the originally-proposed
  `ENABLE_DISCORD_GATEWAY` flag: Telegram's long-poll loop already
  established that long-running connector loops are fine without a
  gate, so Discord enables on `DISCORD_BOT_TOKEN` alone.

- **Mention detection becomes platform-aware.** Chord's `mentionsBot`
  regex matches `@chord` literal; the connectors normalise platform
  natives (`<@U…>` Slack, `<@!…>` Discord, `@chord_bot` Telegram) and
  set `mentionsBot` on the inbound message before `postMessage` runs.
  `messages.service.postMessage` learns to accept a precomputed
  `mentionsBot` instead of always re-running the regex.

- **Bot replies become visible to people who never installed Chord.**
  Tool side effects (creating tasks, lists, events, etc.) remain
  Chord-internal — they do not propagate to the external channel.
  Only the bot's text reply does. The external channel will see the
  *consequence* in language ("I added 'milk' to your Costco list"),
  not the structured artifact.

- **The single-process constraint hardens.** Discord gateway means a
  Chord instance owns a sticky WebSocket. If we ever want HA, we now
  need to consider gateway sticky-connection ownership and webhook
  delivery deduplication on top of the existing SSE-hub adapter
  problem flagged in ADR 0002.

- **Telegram bot privacy mode.** Telegram bots in groups only see
  commands (`/cmd`) by default. The deploy runbook must include
  `/setprivacy → Disable` via BotFather, otherwise the bot sees
  nothing in groups. This is the most common Telegram bot footgun and
  there is no programmatic workaround.

- **Webhook signature and replay protection** become part of the
  surface area Chord must keep correct (Slack HMAC + 5-minute window;
  Discord NaCl Ed25519). Bugs here are silent — they only surface as
  "the bot doesn't reply."

- **Out of scope for v1, called out explicitly:** Chord→external
  mirroring; threading; edit/delete propagation; multi-bot per
  platform; file/attachment forwarding; per-channel bot personas;
  Telegram webhook (long-poll suffices).

See [`docs/subsystems/connectors.md`](../subsystems/connectors.md) for
the concrete shape (interface, schema, file layout, flows) and
[`docs/tasks/im-connectors.md`](../tasks/im-connectors.md) for the
phased breakdown.
