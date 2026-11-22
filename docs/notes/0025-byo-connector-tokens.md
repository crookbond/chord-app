# ADR 0025 — BYO bot tokens for IM connectors

**Status:** accepted
**Date:** 2026-05-08

## Context

ADR 0010 introduced IM connectors (Telegram, Slack, Discord) with a single
deploy-wide bot token per platform, supplied via server `.env`
(`TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `DISCORD_BOT_TOKEN`). That model
fits the demo: one operator runs the server, sets the env vars, and every
group on the deployment shares the same bot identity.

It does not fit production. There is no admin UI today (`client/` is a
Phase-4 placeholder per CLAUDE.md), and we don't intend to add system-level
configuration in the mobile app — system config will live in the web admin
when that exists. So in the absence of `client/`, every group that wants a
Telegram/Discord bridge must wait on the operator to edit `.env`. That
breaks self-service.

The natural fix is **bring-your-own bot token per binding**: the user
creates their own bot on the platform, pastes its token into the per-group
settings page, and Chord runs that bot for that binding. The deploy-wide
bot stays as a fallback for the demo and for operators who want a default
shared bot.

## Decision

1. **Per-binding token.** Encrypted bot tokens live on
   `group_external_channels.bot_token_{ciphertext,iv,tag}` and on
   `pending_connector_pairings.*` so a token chosen at pair-start travels
   to the binding when the code is consumed. Encryption reuses the
   existing `utils/crypto-tokens.ts` AES-256-GCM helper backed by
   `MASTER_KEY`. NULL token means "use deploy-wide bot."
2. **Bot identity.** `bot_user_id` is captured at pair-start (via a
   platform `getMe` call) and stored alongside the token. This is what
   the registry keys by, not the token itself, so multiple bindings that
   happen to use the same bot share one runtime connector + one poll
   loop.
3. **Registry keyed by bot identity.** `connectorRegistry` becomes
   `Map<connectorKey, Connector>` where `connectorKey = ${platform}:${botUserId|"default"}`.
   Outbound and inbound look up the right connector for a binding via
   that key. The deploy-wide entry registers under `${platform}:default`.
4. **Lifecycle.** At boot we scan `group_external_channels` for distinct
   `(platform, bot_user_id)` pairs with non-null tokens and instantiate
   one connector per pair. We also start a connector for any pending
   pairing whose code is not yet expired (so the user can complete the
   pair window without restarting the server). Connectors are torn down
   when their last binding *and* their last pending pairing both
   disappear — refcount on the union.
5. **Pair flow.** `POST /groups/:id/connectors/pair` now accepts an
   optional `botToken`. When present:
   - Server validates the token via the platform's identity call
     (`getMe` for Telegram, `users/@me` for Discord).
   - Server stashes the encrypted token and `bot_user_id` on the pending
     pairing row.
   - Server ensures a connector for that bot is running (instantiates
     and `initialize()`s if not).
   - The user's own bot picks up `/chord pair <CODE>` from their chat
     via the same inbound pipeline (`inbound-pipeline.ts`), and the
     existing consume path promotes the pending row to a binding,
     copying the token + `bot_user_id` across atomically.
6. **Outbound publisher.** Resolves connector by binding's
   `(platform, bot_user_id)`, falling back to `${platform}:default`
   when the binding has no BYO token.
7. **Mobile UX.** The per-group settings modal grows a "Bring your own
   bot token" field. The deploy-wide option stays as the default when
   the platform's deploy-wide token is configured; if it isn't, BYO is
   the only way to add a binding. Instructions text walks the user
   through creating a bot (BotFather for Telegram; Discord Developer
   Portal for Discord) and what permissions/intents to enable.

We do not do system-level configuration in mobile. Operators who want a
shared bot still edit `.env`. The web admin (when built) will surface
that.

## Why not …

- **Per-user shared bot.** We considered letting one user upload a token
  that all groups they're in could reuse. Rejected for v1 — entitlement
  semantics get messy when a group has multiple members who each
  uploaded different bots, and BYO-per-binding is the simpler default.
  A user who wants to reuse one bot across N bindings just pastes the
  same token into each pair; the registry's keying-by-`bot_user_id`
  collapses them onto one runtime instance for free.
- **Server-rotating tokens / OAuth-based BYO.** Would be ideal but
  Telegram's BotFather doesn't expose OAuth — the token is the
  permanent secret. Discord has OAuth but the bot user is created
  separately in the developer portal anyway. So users will paste tokens
  for the foreseeable future; we focus on encrypting them at rest and
  not logging them.
- **One connector instance per binding.** Simpler mental model but
  wasteful: two bindings with the same bot would each open a
  `getUpdates` long-poll loop on the same token, and Telegram
  serializes `getUpdates` per token (one call confirms the offset). The
  refcounted-by-`bot_user_id` design avoids this.

## Consequences

- New schema columns and a migration. The migration is additive — every
  existing binding gets NULL `bot_token_*` and runs through the
  deploy-wide bot exactly as before.
- Any code path that today calls `connectorRegistry.get(platform)` must
  switch to `getForBinding(platform, botUserId | null)`. The old
  signature is removed.
- A misconfigured BYO token (revoked, wrong format) breaks just that
  binding. The connector logs a warn and keeps the rest of the registry
  alive.
- `MASTER_KEY` is now load-bearing for all deployments that use BYO,
  not just `AUTH_MODE=google`. `assertCryptoReady` is widened so
  startup fails loudly when BYO bindings exist without a key.
- Slack BYO is out of scope for this slice — Slack still requires
  Socket Mode (a future ADR/PR) to work without an inbound webhook.
