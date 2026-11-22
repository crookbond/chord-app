# IM connectors

Bridges the bot into Slack, Discord, and Telegram. The bridged channel
is the primary surface for users; the bound Chord group exists to give
the bot context, memory, attachments, and tools. Decision rationale:
[ADR 0010](../notes/0010-im-connectors.md) (per-platform shape) +
[ADR 0011](../notes/0011-supergroup-bot-mediated-bridging.md)
(supergroup framing — read this one first if you're new).

## Mental model: supergroup, bot-mediated bridge

A Chord group is a **supergroup** — a logical container that
federates one or more linked surfaces:

- the native Chord chat (mobile + web clients),
- zero or more bound external channels (Slack, Telegram, Discord).

Surfaces inside a supergroup do **not** mirror messages between each
other. A Slack message stays in Slack; a Telegram message stays in
Telegram. The bot is the bridge: every surface feeds the same
`messages` table for the supergroup (distinguished by
`messages.source`), the bot reads the unified history, and its replies
fan out to whichever bound external channel the trigger came from.

The product framing this implies: *Chord lives in your team's channel;
everything it learns there stays available everywhere Chord is*. We
have committed to this — bidirectional message bridging is not a
deferred-but-someday item, it's rejected by design (see ADR 0011).

## Mental model

```
   Slack channel C123          Telegram group T456          Discord channel D789
          │                            │                            │
          ▼                            ▼                            ▼
   [connector inbound]          [connector inbound]          [connector inbound]
          │                            │                            │
          ├──────── identityResolver ──┴────────────────────────────┤
          │   (platform, external_id) → users.id  (find or shadow) │
          │                                                         │
          └──────── channelResolver ───────────────────────────────┘
              (platform, external_channel_id) → groups.id (must be bound)
                                  │
                                  ▼
                  messages.service.postMessage
                            (source = 'slack' | 'discord' | 'telegram',
                             mentionsBot precomputed by connector)
                                  │
                                  ▼
                  existing bot turn machinery (unchanged)
                                  │
                                  ▼
                  sseHub broadcasts 'message' (kind='bot')
                                  │
                                  ▼
                  outboundPublisher.onBroadcast
                                  │
                                  ▼
                  connector.send(externalChannelId, text)
```

The bot turn never knows it was driven by a connector. Inbound is a
regular `postMessage`. Outbound observes the same SSE the mobile client
observes — there's no second source of truth.

## File layout

```
server/src/services/connectors/
├── types.ts                   Connector interface + InboundMessage / OutboundMessage.
├── registry.ts                Singleton. initialize/shutdown enabled connectors.
├── inbound-pipeline.ts        verify → parse → resolve → postMessage. Used by every connector.
├── outbound-publisher.ts      Subscribes to sseHub.onBroadcast. Forwards bot replies.
├── identity-resolver.ts       (platform, externalId) → users.id (find-or-create-shadow).
├── channel-resolver.ts        (platform, externalChannelId) → groups.id (binding lookup).
├── slack/
│   ├── slack.connector.ts     Ported from webapp-start/.../bot/slack.service.ts.
│   └── slack.api.ts           Thin Slack Web API wrapper (chat.postMessage, auth.test).
├── discord/
│   ├── discord.connector.ts   Ported from webapp-start/.../bot/discord.service.ts.
│   ├── discord-gateway.ts     Persistent WS for MESSAGE_CREATE; gated by env.
│   └── discord.api.ts
└── telegram/
    ├── telegram.connector.ts  Long-poll getUpdates loop, sendMessage. Written fresh.
    └── telegram.api.ts

server/src/routes/
└── webhooks.ts                POST /api/v1/webhooks/:platform.
                               Slack & Discord. Telegram polls; no route.
```

Nothing about connectors leaks into `kernel/` — the mobile/web clients
don't need to know. The shared `Message.source` field grows new
literals, but those are already opaque to the client (only the chat UI
reads `source` for the "imported" badge).

## Connector interface

```ts
export type ConnectorPlatform = 'slack' | 'discord' | 'telegram' | 'whatsapp';

export interface InboundMessage {
  platform: ConnectorPlatform;
  externalChannelId: string;
  externalUserId: string;
  externalUserDisplay: string | null;
  externalMessageId: string;
  text: string;
  ts: Date;
  mentionsBot: boolean;          // platform-native mention parse already resolved
  raw: unknown;                  // original payload, for audit only
}

export interface OutboundMessage {
  externalChannelId: string;
  body: string;
  cards: BotCard[];
  attachment?: OutboundAttachment;
  senderName?: string;
}

export interface Connector {
  platform: ConnectorPlatform;

  initialize(): Promise<void>;
  shutdown(): Promise<void>;

  // Inbound (HTTP webhook path)
  verifySignature(req: WebhookReq): boolean;
  parseInbound(req: WebhookReq): Promise<InboundMessage | null>;
  handleVerificationChallenge?(req: WebhookReq):
    { status: number; body?: unknown } | null;

  // Outbound
  send(msg: OutboundMessage): Promise<SendResult>;
}
```

Telegram does not implement `verifySignature` / `parseInbound` in v1 —
its inbound is the long-poll loop inside `telegram.connector.ts`, which
synthesises `InboundMessage` directly and hands it to the same
`inbound-pipeline.handle()`.

## Schema (migration `011_connectors`)

```sql
CREATE TABLE external_identities (
  platform           TEXT NOT NULL,           -- 'slack' | 'discord' | 'telegram'
  external_id        TEXT NOT NULL,           -- platform's user id
  external_display   TEXT,                    -- last-seen display name (advisory)
  user_id            TEXT NOT NULL REFERENCES users(id),
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (platform, external_id)
);

CREATE INDEX idx_external_identities_user ON external_identities(user_id);

CREATE TABLE group_external_channels (
  platform              TEXT NOT NULL,
  external_channel_id   TEXT NOT NULL,        -- e.g. Slack 'C123', Discord channel id, Telegram chat id
  group_id              TEXT NOT NULL REFERENCES groups(id),
  config_json           TEXT,                 -- per-platform extras (workspace id, guild id, …)
  alias                 TEXT NOT NULL,        -- per-Chord-group bridge label
  created_at            INTEGER NOT NULL,
  -- ADR 0025 BYO columns (NULL = use deploy-wide bot)
  bot_user_id           TEXT,
  bot_token_ciphertext  BLOB,
  bot_token_iv          BLOB,
  bot_token_tag         BLOB,
  PRIMARY KEY (platform, external_channel_id)
);

CREATE INDEX idx_group_external_channels_group ON group_external_channels(group_id);
CREATE INDEX idx_group_external_channels_bot
  ON group_external_channels(platform, bot_user_id) WHERE bot_user_id IS NOT NULL;
```

### BYO bot tokens (ADR 0025)

A binding can carry its own AES-GCM-encrypted bot token instead of
relying on the deploy-wide `*_BOT_TOKEN` env. The registry is keyed by
`(platform, botUserId | "default")` so multiple bindings sharing the
same BYO bot collapse onto one runtime connector instance + one poll
loop. Telegram + Discord ship today; Slack BYO needs Socket Mode (a
future ADR/PR) and is rejected with `platform_no_byo` until then.

`messages.source` (declared in `db/schema.ts` as a string) gains the
literals `'slack' | 'discord' | 'telegram'` alongside today's
`'chat' | 'import'`. No migration needed for the column itself.

## Inbound flow

```ts
// routes/webhooks.ts
router.post('/webhooks/:platform', async (req, res) => {
  // Webhook surface is always deploy-wide — only one URL per platform.
  const connector = registry.getDeployWide(req.params.platform);
  if (!connector) return res.status(404).end();

  const challenge = connector.handleVerificationChallenge?.(req);
  if (challenge) return res.status(challenge.status).json(challenge.body);

  if (!connector.verifySignature(req)) return res.status(401).end();

  const inbound = await connector.parseInbound(req);
  res.status(200).end();                         // ack fast — Slack 3s budget

  if (inbound) inboundPipeline.handle(inbound).catch(logError);
});

// inbound-pipeline.ts
async function handle(m: InboundMessage) {
  const userId  = await identityResolver.resolve(m.platform, m.externalUserId, m.externalUserDisplay);
  const groupId = await channelResolver.resolve(m.platform, m.externalChannelId);
  if (!groupId) return;                          // unbound channel → drop silently

  await postMessage(db, {
    groupId,
    senderId:  userId,
    body:      m.text,
    mentionsBot: m.mentionsBot,                  // precomputed, do not re-run regex
    source:    m.platform,
    externalMessageId: m.externalMessageId,      // stored on messages.external_message_id (new col)
  });
  // postMessage triggers decideReaction → reactToMessage → bot turn (unchanged)
}
```

Notes:
- `postMessage` currently recomputes `mentionsBot` from the body via the
  `@chord` regex (kernel). It learns a small overload: take a
  precomputed boolean when the caller provides one.
- `messages` gets a new optional column `external_message_id` so future
  edits / threading can correlate. Nullable for native posts.

## Outbound flow

```ts
// outbound-publisher.ts
sseHub.onBroadcast((channel, event, data) => {
  if (event !== 'message') return;
  const msg = data as Message;
  if (msg.kind !== 'bot') return;                 // only bot replies go out

  const groupId = channel;
  for (const b of channelResolver.listBindingsForGroup(groupId)) {
    const conn = registry.getForBinding(b.platform, b.botUserId);
    if (!conn) continue;
    conn.send({
      externalChannelId: b.externalChannelId,
      body: msg.body,
    }).catch((err) => logger.warn('connector send failed', { err, platform: b.platform }));
  }
});
```

Sse hub change required: a single new method,

```ts
onBroadcast(handler: (channel, event, data) => void): () => void
```

invoked once per `broadcast` call after subscribers are written. Cost
is one `for` loop per broadcast; negligible. The existing Express
`subscribe` path is untouched.

## Identity & channel binding

**Identity (find-or-create-shadow).** First inbound from a previously
unseen `(platform, external_id)` creates a `users` row with
`shadow: 1`, copies the platform display name into `display_name`, and
writes the `external_identities` mapping. Subsequent messages reuse
the row. Same pattern as ADR 0008 (WhatsApp import). Linking a shadow
to a real Chord account is **out of scope here** — it lives in user
settings, alongside username and preferences. Connectors do not know
about claimed identities; they always look up via
`external_identities`.

A shadow gets **no proactive messaging**. The WhatsApp taster
(ADR 0053) gives it a personal group so the bot's reply has somewhere
to land, which used to be enough to qualify it for a daily briefing —
timed off the server clock, since a shadow never opens a client and so
can never report a `last_tz`. `enqueueDailyScanForUser` now skips
shadows outright ([ADR 0098](../notes/0098-briefings-need-a-real-recipient-and-a-real-zone.md)).
A shadow becomes a real recipient only by merging into an account —
which happens on OTP proof (`linkWhatsappIdentityForPhone`) or a
consumed signup intent, never on a name match.

**Channel binding.** **Not auto-created.** v1 binds via a CLI script
(`server/src/scripts/connectors-bind.ts`, run as `npm run
connector:bind --workspace=server -- bind <platform> <externalChannelId>
<groupId>`) which calls `channelResolver.bind` directly against the
configured database. No HTTP endpoint, no admin UI — those land later in
`client/`. Seeds for the demo rig insert rows the same way.

Inbound from an unbound channel is **dropped silently** (no 4xx — we
don't want platforms to disable webhooks). This is deliberate: the bot
must not auto-create groups on first contact.

## Per-platform notes

### Slack

- Events API → webhook. HMAC-SHA256(`v0:<ts>:<body>`) with 5-minute
  replay window. Slack's URL-verification challenge handled in
  `handleVerificationChallenge`.
- Bot is added to a channel by a workspace admin: `/invite @chord`.
- Mention parse: `<@U…>` where `U…` matches the bot's own user id
  (resolved once via `auth.test` in `initialize`).
- Send: `chat.postMessage`.

### Discord

**Gateway-only in v1** (no interactions webhook, no slash commands).
Discord users `@chord` in a channel; the bot's gateway WS receives
`MESSAGE_CREATE`, replies via REST. Slash commands can land in a later
phase without restructuring.

- Bot added via OAuth invite URL with the `bot` scope and the
  `view_channels` + `send_messages` permissions. (`applications.commands`
  is not needed since we don't register slash commands.)
- **Required intent**: `MESSAGE_CONTENT` (privileged) — must be enabled
  in the Discord developer portal under *Bot → Privileged Gateway
  Intents*. Without it, `MESSAGE_CREATE` payloads arrive with empty
  `content`. Plus `GUILD_MESSAGES` and `DIRECT_MESSAGES` (non-privileged).
- Mention detection: scan `mentions[]` (array of user objects on each
  `MESSAGE_CREATE`) for the bot's own user id (resolved once via
  `GET /users/@me` at startup). DMs (no `guild_id`) treated as
  auto-mention.
- Send: REST `POST /channels/{id}/messages`.
- Reconnect: gateway uses exponential backoff (1s → 30s cap),
  infinite retries.
- Single env var: `DISCORD_BOT_TOKEN`. No `ENABLE_DISCORD_GATEWAY`
  flag — long-running connector loops are normal here (cf. Telegram
  poll).

### Telegram

- Long-poll `getUpdates` loop (no public URL needed). Webhook later
  if we deploy.
- **`/setprivacy → Disable` via BotFather is mandatory** — without it,
  the bot only sees `/commands` in groups, not regular text. Document
  this in `docs/ops/` alongside the deploy runbook.
- Mention parse: `@chord_bot` literal (the bot's own username, fetched
  via `getMe` at startup).
- Send: `sendMessage` with `chat_id`.

## Mention detection (cross-platform)

Chord's existing `mentionsBot(body)` lives in
`kernel/src/messages.ts` and matches `@chord` on a word boundary.
Connectors compute their own `mentionsBot` from platform-native
mention syntax and pass it through; `postMessage` accepts the
precomputed value. The existing `mentionsBot` regex still runs for
chat-source posts.

## Failure modes & their handling

| Scenario | Behaviour |
|---|---|
| Webhook signature mismatch | 401, log, no parse. Common with stale `.env` in dev. |
| Unbound external channel | Drop silently (no 4xx). |
| Unknown platform in URL | 404. |
| Telegram privacy-mode on (no group messages) | Logged once at startup if detectable; otherwise: bot just looks idle. |
| Discord gateway disconnect | Exponential reconnect; loud warn after 5 min; never gives up. |
| Outbound `send` fails (rate limit, deleted channel, revoked token) | Log, no retry queue. The reply still exists in Chord. |
| Inbound from new external user | Shadow user created; resolver returns its id. |
| Inbound from a bound channel where bot isn't a member of the bound Chord group | Membership check inside `postMessage` rejects. Rare (manual binding misconfig); surfaces as a logged 403. |

## Security boundaries

- **Webhook secrets** are env-only (never DB). Rotation = redeploy.
- **No connector-writable side effects on Chord beyond `postMessage`.**
  The connector cannot create groups, change membership, or write
  resources directly. Everything routes through the bot turn.
- **Outbound posts the bot's reply text only.** Tool-call structured
  results never leave Chord. (If an external channel needs to know an
  RSVP was recorded, the bot's natural-language reply will say so.)
- **Channel binding is admin-gated.** Inbound from an unbound channel
  is a no-op; bot writes never escape to channels we did not bind.

## Out of scope (v1)

- Chord-native messages mirroring out to bound external channels.
- Threading. Bot replies post at top level.
- Edit / delete propagation either direction.
- Multi-bot per platform.
- File / attachment forwarding either direction.
- Per-channel bot persona overrides.
- Webhook delivery for Telegram (long-poll suffices).
- Linking a shadow user to a real Chord account from the connector
  layer (handled in user settings).

## Open questions

- **Outbound formatting fidelity.** Slack mrkdwn ≠ plain text;
  Discord supports markdown subset; Telegram `parse_mode=HTML` or
  MarkdownV2. v1: post as plain text. Note for follow-up: per-platform
  formatter that respects backticks, links, and basic bold/italic.
- **Multi-channel bot identity.** A real-world workspace may want
  Chord to *introduce itself differently* in different bound channels
  (different name, different system prompt). v1 ignores; per-channel
  persona overrides are a future story.
- **De-duplication of webhook retries.** Slack and Discord both
  retry on non-2xx within seconds. v1 acks 200 immediately and runs
  the pipeline async, so retries are unlikely; we may still see
  duplicates if a process crash happens between ack and `postMessage`.
  Track via `external_message_id` uniqueness if it becomes a problem.
