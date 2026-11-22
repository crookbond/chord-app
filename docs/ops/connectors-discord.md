# Discord connector — deploy + bind runbook

> **Deprecated (ADR 0154).** Deploy-wide Discord wiring was removed — there is no
> `DISCORD_BOT_TOKEN` env var and the UI no longer offers Discord. The
> `DiscordConnector` code remains for a BYO token (ADR 0025, `makeConnector`)
> and for disconnecting a legacy binding. Kept for reference / a future revival.

For the design see [`../subsystems/connectors.md`](../subsystems/connectors.md)
and [ADR 0010](../notes/0010-im-connectors.md).

Discord differs from Slack in v1: **gateway-only**, no interactions
webhook, no slash commands. The bot opens a persistent WebSocket to
`gateway.discord.gg`, listens for messages where it's `@-mentioned`,
and replies via the REST API. **No public URL is needed**.

## What you'll need

- A Discord account.
- A server (guild) where you can install a bot.
- The Chord server running with `DISCORD_BOT_TOKEN` set.

## 1. Create a Discord application + bot

1. <https://discord.com/developers/applications> → **New Application**.
2. Name it (e.g. *Chord*) → **Create**.
3. Left sidebar → **Bot** → confirm by clicking *Yes, do it!* if
   prompted. You now have a bot user.
4. **Reset Token** → copy the token. This is `DISCORD_BOT_TOKEN`.
   Save it now — Discord won't show it again.

## 2. Enable MESSAGE CONTENT INTENT (mandatory)

Still on the **Bot** page, scroll down to **Privileged Gateway Intents**:

- **MESSAGE CONTENT INTENT** → *Enable*.

Without this, every `MESSAGE_CREATE` payload arrives with **empty
`content`**, and the bot never sees what was actually said. There's no
error — the bot just looks broken.

The other two intents we need (`GUILD_MESSAGES`, `DIRECT_MESSAGES`)
are non-privileged and don't appear here.

## 3. Add the token to `.env`

```
DISCORD_BOT_TOKEN=your-token-here
```

Restart `npm run dev`. Look for:

```
discord connector ready { botUserId: '...' }
discord gateway: READY { botUserId: '...' }
```

If you see `discord disabled (missing DISCORD_BOT_TOKEN)`, the env file
isn't being loaded; confirm it sits at the repo root, not in `server/`.

## 4. Generate an OAuth invite URL

Left sidebar → **OAuth2** → **URL Generator**.

- **Scopes**: `bot`.
- **Bot Permissions**: `View Channels` + `Send Messages` (`Read Message History`
  is also useful for context but optional).

Copy the generated URL at the bottom (looks like
`https://discord.com/oauth2/authorize?client_id=…&permissions=…&scope=bot`).
Open it in a browser, pick the target server, **Authorize**.

## 5. Find the channel id

In Discord client:

- **Settings** (gear) → **Advanced** → **Developer Mode** → on.
- Right-click the target channel → **Copy Channel ID** → numeric snowflake.

For DMs with the bot, the channel id is the DM channel's snowflake —
right-click the DM in your sidebar after sending the bot at least one
message.

## 6. Bind the channel to a Chord group

```bash
npm run connector:bind --workspace=server -- bind discord 1234567890123456789 g_yourGroup
```

Verify:

```bash
npm run connector:bind --workspace=server -- list g_yourGroup
# discord:1234567890123456789
```

## 7. Test the round-trip

In the Discord channel, type `@Chord add to Costco list - milk`. (Use
the actual @-mention popup — typing the bot's name as plain text
won't trigger the `mentions[]` array.)

You should see the bot's reply appear in the channel within a couple
of seconds, and the Costco list + item exist in the Chord DB.

For DMs, the @-mention is **not required** — the bot is the only
addressee, so every DM message is treated as a mention.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Server logs show `discord connector ready` but messages never arrive | MESSAGE CONTENT INTENT not enabled. Re-check Developer Portal → Bot → Privileged Gateway Intents. |
| Bot is in the server but never replies | Channel not bound. `npm run connector:bind --workspace=server -- list <groupId>`. |
| `discord gateway: READY timeout` at startup | Token is wrong, expired, or revoked. Reset Token in the developer portal. |
| Bot replies in Chord (mobile/web) but not in Discord | Bot lacks `Send Messages` permission in that channel. Channel-specific overrides win over guild defaults. |
| `Missing Access` (Discord error code 50001) on send | Bot isn't in the guild that owns this channel, or the channel was deleted. |
| Replies cut off at 2000 chars | Discord per-message limit; the connector slices silently. v1 doesn't paginate long replies. |
| Reconnect spam in logs | Network blip — the gateway exponentially backs off (1s → 30s cap, infinite). After 5 min of consecutive failures, a single loud warn fires; otherwise it keeps trying quietly. |

## Security notes

- `DISCORD_BOT_TOKEN` is the bot's whole identity. Treat like a
  password. **Reset Token** in the developer portal if leaked.
- Anyone who installs the bot in their server controls a guild it
  joins, but cannot read other guilds' channels — the gateway scopes
  `MESSAGE_CREATE` events to guilds the bot is in.
- Gateway frames are TLS-encrypted; no application-layer signatures
  are required.

## What this connector deliberately does NOT do (v1)

- **Slash commands** (`/chord …`) and the interactions webhook. No
  Ed25519 verification, no command registration, no `tweetnacl` dep.
  Adding slash commands later means adding the webhook route +
  `tweetnacl` + a one-off command-registration call.
- **Embeds, attachments, reactions, threads.** Replies post as plain
  text in the triggering channel.
- **Role / user mentions in replies.** The bot's reply is plain text;
  if it says `@someone`, Discord won't ping them.
- **Edit / delete propagation either direction.**
- **Voice or stage channel support.**
