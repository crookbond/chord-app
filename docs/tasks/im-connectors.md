# IM connectors — phased plan

Implements [ADR 0010](../notes/0010-im-connectors.md) per the design in
[`docs/subsystems/connectors.md`](../subsystems/connectors.md). Pick up
phases in order; each is a self-contained commit.

## Status

Proposed 2026-04-26. Pending review of the ADR + design doc before
phase 1 starts. Not on the investor-demo critical path
(see [`../plans/demo-plans.md`](../plans/demo-plans.md));
runs in parallel with that work.

## Source material to lift

- `webapp-start/server/src/services/bot/base.service.ts` — the
  `BaseBotService` interface to model `Connector` on.
- `webapp-start/server/src/services/bot/slack.service.ts` (~440 lines)
  — signature verify, Events API parse, `chat.postMessage`.
- `webapp-start/server/src/services/bot/discord.service.ts` (~630 lines)
  — interaction verify, REST send.
- `webapp-start/server/src/services/bot/discord-gateway.service.ts`
  (~350 lines) — persistent WS for MESSAGE_CREATE.
- Telegram: write fresh — webapp-start has no Telegram service.

Drop on the way: webapp-start's `manager.service.ts` admission control
(Chord's `decideReaction` already covers it), `BotInstanceRecord`
Mongo schema (Chord has one bot), `llmInstanceManager` (Chord uses
`bot.service.ts`).

## Phase 1 — Scaffolding (no platform yet) — shipped 2026-04-26

Lands the connector subsystem skeleton + a mock connector so the inbound
and outbound flows can be exercised end-to-end without any real
platform creds. 15 new tests; full server suite (266 tests) green.

- [x] Migration `011_connectors`: `external_identities`,
      `group_external_channels`. Adds `external_message_id` (nullable)
      on `messages`.
- [x] DB schema: `MessagesTable.source` widened to
      `'chat' | 'import' | 'slack' | 'discord' | 'telegram' | null`.
      Kernel `Message` did not need changes — `source` is a server-only
      column today.
- [x] `services/sse.hub.ts`: `onBroadcast(handler) → unsubscribe`.
      Existing subscribe/broadcast paths untouched. Listener exceptions
      logged but never abort the broadcast.
- [x] `services/connectors/types.ts`: `Connector`, `InboundMessage`,
      `OutboundMessage`, `ConnectorPlatform`, `VerificationChallenge`.
- [x] `services/connectors/identity-resolver.ts`: find-or-create-shadow.
      Updates `external_display` if it changes; namespaced per platform.
- [x] `services/connectors/channel-resolver.ts`: `bind` / `unbind` /
      `lookupGroupForChannel` / `listBindingsForGroup`. `bind` validates
      the group exists; rebinding the same channel updates the group.
- [x] `services/connectors/inbound-pipeline.ts`: resolve identity →
      ensure `guest`-tier group membership → `postMessage` (with
      `source` + `mentionsBot` + `externalMessageId`) → `decideReaction`
      + `reactToMessage` (mirrors what `routes/messages.ts` does for
      native posts, minus the URL save-offer SSE).
- [x] `services/connectors/outbound-publisher.ts`: hooks
      `sseHub.onBroadcast`, filters `event === 'message' &&
      msg.kind === 'bot'`, fans out to every binding for the group.
- [x] `services/connectors/registry.ts`: env-driven init/shutdown.
      Wired into `server.ts` between `proactiveScheduler` and
      `app.listen`. Connector init failures log a warn and disable
      *that* connector — they never abort startup.
- [x] `services/messages.service.ts`: `postMessage` accepts optional
      `mentionsBot`, `source`, `externalMessageId`. Backward-compatible.
- [x] `services/bot/bot.service.ts`: `decideReaction` accepts optional
      precomputed `mentionsBot`, falls back to the kernel regex.
      Existing native callers unchanged.
- [x] `services/connectors/mock/mock.connector.ts`: in-memory connector
      that records outbound + exposes `injectInbound` for tests.
- [x] `routes/webhooks.ts` mounted at `/api/v1/webhooks/:platform`.
      Acks 200 fast (Slack 3s budget); pipeline runs async.
- [x] `scripts/connectors-bind.ts` + `npm run connector:bind
      --workspace=server -- bind|unbind|list …`. No HTTP route in v1;
      admin UI in `client/` is a future story.
- [x] Vitest coverage: identity-resolver, channel-resolver,
      inbound-pipeline (via MockConnector), outbound-publisher,
      `sseHub.onBroadcast`. 15 tests; live in
      `services/connectors/__tests__/connectors.test.ts`.

### Phase 1 deltas worth knowing

- **Auto-membership.** Inbound from a previously-unseen external user
  not only creates a shadow `users` row — it also adds them as a
  `guest`-tier `group_members` row in the bound group. Without this,
  the bot's context assembly skips them. This was implicit in the
  design but worth calling out.
- **Outbound covers zero-subscriber groups.** Previously, `broadcast`
  short-circuited when no SSE subscribers were attached. Now listeners
  fire even with zero subscribers, so a Chord group with no open
  mobile/web client still forwards bot replies to bound external
  channels. No behaviour change for existing native paths — they
  always have at least one subscriber when a user is online.

## Phase 2 — Slack — shipped 2026-04-26

HMAC verify, Events API parse, REST send. 22 new tests; server suite
288 tests green.

- [x] `services/connectors/slack/slack.api.ts`: thin Slack Web API
      wrapper using native `fetch` (no axios dep); typed
      `auth.test`, `chat.postMessage`.
- [x] `services/connectors/slack/slack.connector.ts`: ported from
      `webapp-start/.../slack.service.ts`, reshaped to the `Connector`
      interface. Slash commands and `sendBlockMessage` /
      `sendEphemeralMessage` / `updateMessage` deliberately dropped;
      only `chat.postMessage` outbound for v1.
- [x] `initialize`: calls `auth.test`, caches the bot's own user id
      for mention parsing.
- [x] Mention parse: `<@{botUserId}>` → `mentionsBot = true`. DM
      channels (`channelId.startsWith('D')`) treated as
      auto-mention. Other bots' mentions (different `U…`) do *not*
      count.
- [x] Event-id deduplication cache (1000-entry FIFO) covers Slack's
      retry behaviour.
- [x] **Raw-body capture for HMAC** — `app.ts` adds `verify` callback
      to `express.json` that stores `req.rawBody`. Required because
      Slack signs the literal bytes (key-order matters); a regression
      test asserts this. `Request.rawBody` declaration in
      `middleware/db.ts`.
- [x] `services/connectors/init.ts`: env-driven instantiation. Kept
      separate from `registry.ts` so the registry stays platform-
      agnostic for tests.
- [x] Wired into `server.ts`: `registerEnabledConnectors()` runs
      before `connectorRegistry.initializeAll(db)`.
- [x] Env vars added to `example.env` and `config/env.ts`:
      `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`. Missing creds disable
      the connector with a single `info` log; no crash.
- [x] `docs/ops/connectors-slack.md`: end-to-end runbook (create
      Slack app, scopes, event subscriptions, install, bind, invite
      bot, test, troubleshoot).
- [x] Vitest: 22 tests covering HMAC verify (positive, tampered body,
      replay window, missing headers, non-numeric ts, raw-body bytes
      vs re-stringified), URL verification challenge, event_callback
      parse (regular message, `<@bot>` mention, DM auto-mention,
      foreign bot mention, bot self-message, subtype, missing fields,
      non-callback payload, duplicate event id), `initialize`
      (`auth.test` calls, error surfacing), `send` (correct payload,
      `ok:false` errors).

## Phase 3 — Telegram — shipped 2026-04-26

No webapp-start code lifted; written fresh. Long-poll `getUpdates`,
no webhook, no public URL needed for local dev. 14 new tests; server
suite 302 tests green.

- [x] `services/connectors/telegram/telegram.api.ts`: typed `getMe`,
      `getUpdates` (with abort signal), `sendMessage`. Native `fetch`.
      `TelegramApiError` carries `errorCode` + `retryAfter`.
- [x] `services/connectors/telegram/telegram.connector.ts`:
      - `initialize`: `getMe` to learn `botUsername` + `botUserId`,
        then kicks off the long-poll loop in the background.
      - Long-poll loop owns the inbound flow (no webhook route).
        Offset advances past `max(update_id) + 1`. Errors trigger
        exponential backoff (1s → 30s cap); 429 honours
        `parameters.retry_after`.
      - `shutdown` flips `running=false`, aborts the in-flight
        `AbortController`, awaits the loop's exit.
      - **Mention detection**: scans `entities[]` for `mention`
        segments matching `@${botUsername}`, plus `text_mention`
        segments whose `user.id` matches `botUserId`. Substring
        fallback when entities are absent.
      - **Private chats are auto-mention** (the bot is the only
        addressee).
      - Filters `from.is_bot`, the bot's own user id, and empty-text
        messages.
      - Test-friendly: `botUsername` / `botUserId` /
        `longPollTimeoutSeconds` constructor overrides let tests
        construct the connector and call `pollOnce` directly without
        `initialize` ever spinning the loop.
- [x] `verifySignature` and `parseInbound` are stub no-ops since
      polling drives inbound; the connector still implements the
      `Connector` interface uniformly.
- [x] `services/connectors/init.ts`: signature change to
      `registerEnabledConnectors(db)` so Telegram can receive `db` at
      construction time. Slack is unchanged. `server.ts` updated.
- [x] `docs/ops/connectors-telegram.md`: BotFather walk-through,
      explicit **`/setprivacy → Disable`** step, three ways to find
      a chat id, troubleshooting table.
- [x] Vitest: 14 tests covering group `@-mention` (entity-based),
      group no-mention, substring fallback, `text_mention` by user id,
      private-chat auto-mention, foreign-bot filter, self-message
      filter, edited_message skipped, unbound chat dropped, offset
      advancement across multiple polls, empty-text dropped, send
      payload, `ok:false` errors, `initialize`+`shutdown` round-trip
      with mocked fetch.

## Phase 4 — Discord — shipped 2026-04-26

**Gateway-only in v1** (scope reduction from the original ADR — see
ADR 0010 *Consequences*). Slash commands and the interactions webhook
are deferred. Single env var, no `ENABLE_DISCORD_GATEWAY` flag, no
`tweetnacl` dep, no `ws` dep (native `WebSocket` in Node 24+). 22 new
tests; server suite 324 tests green.

- [x] `services/connectors/discord/discord.api.ts`: typed wrapper for
      `GET /users/@me` and `POST /channels/{id}/messages`. Native
      `fetch`. `DiscordApiError` carries status + Discord error code +
      message. 2000-char limit applied silently on send.
- [x] `services/connectors/discord/discord-gateway.ts`: state machine
      lifted in spirit from `webapp-start/.../discord-gateway.service.ts`.
      Native `WebSocket`. Lifecycle: `start()` → `HELLO (op 10)` →
      `IDENTIFY (op 2)` → `READY (op 0/READY)` → `MESSAGE_CREATE (op 0/...)`
      dispatches → handler. Heartbeats on `HELLO.heartbeat_interval`;
      server-initiated heartbeat (op 1) responded immediately;
      `RECONNECT (op 7)` and `INVALID_SESSION (op 9)` close + reconnect.
      Reconnect: exponential backoff (1s → 30s cap, infinite retries);
      loud warn after 5 min of consecutive failures; resets on `READY`.
      `awaitReady(timeoutMs)` resolves once with bot user id.
      `wsFactory` + `scheduler` constructor options for deterministic
      tests.
- [x] `services/connectors/discord/discord.connector.ts`: `Connector`
      impl. `initialize` calls `GET /users/@me` to cache `botUserId`,
      then opens the gateway and `awaitReady`s. `shutdown` stops the
      gateway.
- [x] **Mention detection via `mentions[]` array** (not substring
      scanning). DMs (no `guild_id`) auto-mention. `author.bot === true`
      and `author.id === botUserId` filters drop self + other bots.
      Message-id dedupe (1000-entry FIFO).
- [x] **Webhook surface is a no-op** for gateway-only mode:
      `verifySignature` returns `false`, `parseInbound` returns null,
      `handleVerificationChallenge` returns null. Slash commands can be
      grafted on later by replacing these stubs.
- [x] `services/connectors/init.ts`: registers `DiscordConnector` when
      `DISCORD_BOT_TOKEN` is present.
- [x] `DISCORD_BOT_TOKEN` added to `example.env` + `config/env.ts`.
- [x] `docs/ops/connectors-discord.md`: create Discord app, **enable
      MESSAGE CONTENT INTENT (privileged)** — flagged as the Discord
      footgun, OAuth invite URL setup, channel id discovery, bind, test,
      troubleshoot.
- [x] Vitest: 22 tests across two files. `discord-gateway.test.ts`
      covers the WS state machine via `FakeWebSocket` — HELLO triggers
      IDENTIFY with intents, heartbeat fires on schedule,
      server-initiated heartbeat is acked, RECONNECT closes the socket,
      unexpected close triggers exponential backoff, READY resets the
      backoff, `stop()` prevents further reconnects, `awaitReady`
      timeout. `discord.connector.test.ts` covers inbound dispatch
      (mention via `mentions[]`, foreign mention, DM auto-mention,
      bot/self filters, empty-content drop, unbound channel drop,
      dedupe, display-name with discriminator) and outbound REST (POST
      payload, 2000-char slice, non-2xx error surfacing).

## Phase 5 — Polish + follow-up (deferred — pick up when needed)

Catalog of everything we deliberately punted across phases 1–4. Each
is independent; pick what hurts first when real users land.

### Formatting + delivery fidelity

- [ ] **Per-platform outbound formatter.** Slack mrkdwn, Discord
      markdown subset, Telegram MarkdownV2 / HTML. v1 posts plain
      text everywhere. Backticks and links pass through; bold/italic
      / code blocks do not. A small per-platform `format(text)` step
      in each connector's `send` would fix this.
- [ ] **Long-message paging.** Discord caps at 2000, Telegram at
      4096, Slack ~40000. v1 silently slices Discord. For longer bot
      replies we'd split on paragraph boundaries with a continuation
      marker.
- [ ] **Threading.** Bot replies post at top level. Slack `thread_ts`,
      Discord thread auto-create, Telegram `reply_to_message_id` would
      let bot replies attach to the triggering message — much easier
      to scan in busy channels.
- [ ] **Edit / delete propagation either direction.** Touching a
      message in Slack/Discord/Telegram doesn't update the Chord row;
      editing in Chord doesn't reach the external channel. Schema
      hook is already there (`messages.external_message_id`); we'd
      add `message_updated` / `message_deleted` SSE events + an
      outbound API call per platform.

### Webhook / delivery hardening

- [ ] **Telegram webhook mode.** v1 long-polls. For a deployed
      multi-instance setup, switch to `setWebhook` against
      `/api/v1/webhooks/telegram` with a long random secret in the
      URL path. Connector keeps long-poll as the dev default.
- [ ] **Discord slash commands + interactions webhook.** Adds
      `tweetnacl` for Ed25519, registers a `/chord` slash command via
      `applications.{appId}.commands`, and replaces the
      `verifySignature` / `parseInbound` stubs in the Discord
      connector. Useful for explicit "ask Chord for X" UX without
      having to type `@chord`.
- [ ] **De-dup on `external_message_id`.** Webhook retries (Slack 3s
      timeout + retry) can in theory deliver the same message twice.
      Slack's in-memory event-id cache already covers this in v1, but
      a server restart loses it. A unique index on
      `messages.external_message_id` (NULL-safe) would make the
      database the source of truth.
- [ ] **Per-channel rate limiting / token bucket.** Slack and Discord
      both enforce per-channel rate limits. A loud bot in a busy
      channel could trip them. v1 logs the failure; a small per-
      `(platform, externalChannelId)` bucket would back off cleanly.
- [ ] **Auto-unbind on persistent send failure.** If `send` fails
      with `channel_not_found` / `Missing Access` / `chat not found`
      N times in a row, mark the binding stale and log a warn. v1
      lets dead bindings linger silently.

### Identity + multi-platform-user coherence

- [ ] **Linked-identity claim flow.** A real Chord user can claim
      one or more `external_identities` rows so the bot treats their
      Slack + Telegram + native Chord activity as one person. Lives
      in user settings, not the connector layer (per ADR 0010).
      Today: each `(platform, external_id)` is a separate shadow
      user; the bot has no way to merge them.
- [ ] **Cross-platform identity heuristic** (optional, off by
      default). When a shadow user is created, look for an existing
      Chord user with a matching email or username and surface a
      "claim" suggestion. Risky if wrong, useful when right.
- [ ] **Shadow-user display in member lists.** Shadow users
      auto-added to bound groups appear in member-list UIs on the
      mobile/web client. Decide whether to badge them (`📥
      external`), filter them out, or show them as first-class.

### Personal-group / DM semantics (still open)

- [ ] **Personal-group + DM binding semantics.** A Chord personal
      group could bind a Slack/Discord/Telegram DM. Personal groups
      always trigger the bot (no `@chord` needed) and frame the
      LLM prompt as 1:1. v1 doesn't prevent this binding but doesn't
      special-case it either. Decide: should DM-bindings always
      target personal groups?

### Rejected by design — do not revisit without a new ADR

Per [ADR 0011](../notes/0011-supergroup-bot-mediated-bridging.md), the
Chord group is a supergroup that bridges *information* via the bot,
not *messages* via mirroring. The following items are deliberately
not on the roadmap:

- ~~Chord-native → external message mirroring.~~ Native Chord posts
  stay in Chord. If a native user wants to address Slack folks, they
  ask the bot to do it.
- ~~External-to-external message mirroring.~~ Slack and Telegram
  bindings on the same supergroup do not cross-post. The bot's
  context-aware replies are the cross-surface channel.
- ~~Edit / delete propagation across surfaces.~~ Touching a Slack
  message does not update the Chord row; editing a Chord row does
  not reach Slack. The supergroup is append-only across surfaces.

### File / attachment handling

- [ ] **Inbound attachment forwarding.** A Slack file_share or a
      Telegram photo today drops the message (empty text or unknown
      subtype). Bridging them into Chord's attachments table would
      let the bot extract entities from a flight PDF dropped in
      Slack the same way it does from a Chord upload.
- [ ] **Outbound attachment delivery.** Bot-generated artifacts
      (e.g. a generated calendar `.ics`) could land in the external
      channel as a file. Today the bot can only describe them in
      text.

### Admin / observability

- [ ] **Admin UI in `client/`.** Read-only views over
      `external_identities` + `group_external_channels`. Live tail
      of connector logs. Inspect dead bindings.
- [ ] **Bind/unbind via HTTP** for the admin UI. v1 ships a CLI
      script (`npm run connector:bind`); the UI would call a small
      `POST /api/v1/admin/connectors/bind` route.
- [ ] **Per-channel bot persona override.** A workspace might want
      `@chord` in their #travel channel to behave more like a trip-
      planner; in #grocery to focus on lists. Today the bot persona
      is global. A `group_external_channels.persona_override` column
      + a per-binding system-prompt suffix would do it.
- [ ] **Connector health endpoint.** `GET /api/v1/health/connectors`
      returns each enabled connector's status (gateway connected?
      poll loop running? last successful inbound? last successful
      outbound?). Useful for ops dashboards.

### Open design questions

These don't have an obvious right answer; surfacing them so we don't
forget. Resolve when a real user hits the edge.

- **`guest`-tier permissions for shadow users.** Inbound shadow
  users land as `tier: 'guest'`. ADR 0004 defines guest restrictions
  on attachment access. Audit: do those restrictions make sense for
  a Slack user @-mentioning the bot in a bridged channel? Should
  there be a separate `tier: 'external'` instead?
- **Proposal pills in external channels.** ADR 0009 introduces
  inline approve/reject pills on bot bubbles. External channels
  can't render them. Today external users can fall back to
  `@chord confirm` / `@chord drop` (the verb path, see
  `services/bot/confirm-verb.ts`), but they don't *see* what's
  pending. Decide: a "Pending: N" footer, or a card-format text
  reply listing pending IDs, or hide the proposal mechanism from
  external-only groups?
- **Bot's own messages in external context.** The bot reply is
  posted to the external channel as the bot's user account. If a
  Slack user replies *to that reply* with `@chord …` in a thread,
  is the threaded conversation handled? (v1: no — we don't thread.)
- **Cross-platform proposals + commits.** A Slack user proposes
  a trip; a Telegram user (in a different channel of the same Chord
  group) confirms via `@chord confirm`. Does that work? In theory
  yes, since proposals live on the Chord group, not on the
  external channel. Worth a real test.

## Risks worth watching

- **Telegram privacy mode.** Cheap to forget; leads to "the bot is
  silent" with no error. Baked into the runbook + `initialize` log
  line.
- **Discord MESSAGE CONTENT INTENT.** Same shape of footgun as
  Telegram privacy mode — empty `content` payloads with no error.
  Baked into the runbook.
- **Persistent connector loops.** Telegram poll + Discord gateway
  both run forever in-process. If we ever multi-instance the server,
  both need ownership coordination (sticky lease in the DB) — same
  problem ADR 0002 already flagged for the SSE hub.
- **Webhook signature drift.** Local dev `.env` going stale silently
  rejects every Slack event with a 401. We could surface a single
  warn at startup if `SLACK_SIGNING_SECRET` looks malformed (length
  mismatch).
- **Outbound floods.** A loud bot in a busy channel could trip
  per-platform rate limits. v1 logs and drops; if it bites, see the
  rate-limit task above.
- **Mention false positives.** Common bot usernames (`@chord_bot`)
  in Telegram substring fallback could collide with arbitrary text.
  Slack and Discord both use entity-based parsing; only Telegram has
  the substring-fallback path, and only when entities are absent.

## Done definition

For each platform:
- A clean `bind` brings a real channel online; an `@mention` produces a
  visible bot reply *in the same external channel* within seconds.
- Tool-call side effects (e.g., `add_list_item`) succeed in the bound
  Chord group; the bot's natural-language reply communicates the
  result back to the external channel.
- Disabling creds in `.env` cleanly disables the connector at startup
  without breaking unrelated server boot.
- Manual test plan in `docs/ops/connectors-{platform}.md` reproduces
  the round-trip in <5 minutes.

