# Telegram connector — deploy + bind runbook

For the design see [`../subsystems/connectors.md`](../subsystems/connectors.md)
and [ADR 0010](../notes/0010-im-connectors.md).

Telegram differs from Slack/Discord: v1 uses **long-poll**, not webhooks.
That means **no public URL is needed** — the Chord server reaches out to
Telegram, not the other way around. Local dev works without ngrok.

## What you'll need

- A Telegram account (any).
- The Chord server running with `TELEGRAM_BOT_TOKEN` set.

## 1. Create the bot via BotFather

In Telegram, open a chat with [@BotFather](https://t.me/botfather) and run:

```
/newbot
```

BotFather asks for:
- **Display name** — anything (e.g. *Chord*).
- **Username** — must end in `bot` (e.g. `mychord_bot`). This becomes
  the bot's @-handle.

It replies with a token like `123456:AAH-...`. Save it.

## 2. **Disable privacy mode** (mandatory for groups)

By default, a Telegram bot in a group only sees `/commands` — *not*
regular text. The connector treats every `@mychord_bot` as a mention,
but it can only see those mentions if privacy mode is off.

Still in BotFather:

```
/setprivacy
```

Pick the bot, then choose **Disable**. BotFather confirms with
*"'Privacy mode is disabled.'"*.

If you skip this, the bot will look completely silent in groups with no
error in any log. It is the most common Telegram-bot footgun.

## 3. Add the token to `.env`

```
TELEGRAM_BOT_TOKEN=123456:AAH-...
```

Restart `npm run dev`. Look for:

```
connectors: telegram connector ready { botUserId: 9001, botUsername: 'mychord_bot' }
```

If you see `telegram disabled (missing TELEGRAM_BOT_TOKEN)`, the env
file isn't being loaded; confirm it sits at the repo root, not in
`server/`.

## 4. Find the chat id of the target group

Telegram chat ids for groups are **negative numbers** (e.g.
`-1001234567890`). Three ways to discover one:

1. **Add the bot to the group**, type any message (e.g. `hi`), then
   connect to Postgres (`psql -U chord chord`). The bot's getUpdates
   loop will have run and you'll find the chat id in the server logs
   (filter on the group's name) or by querying recent telegram-source
   rows:
   ```
   SELECT external_message_id, body FROM messages
     WHERE source = 'telegram' ORDER BY created_at DESC LIMIT 5;
   ```
   The chat id won't be on `messages` — but the connector logs it on
   `inbound dropped: unbound channel` until you bind.
2. **Forward a message** from the target group to
   [@userinfobot](https://t.me/userinfobot). It replies with the
   forwarded sender + chat ids.
3. **Run a one-off curl** with your token:
   ```
   curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates"
   ```
   Each update's `message.chat.id` is the value you want. Note: this
   competes with the running connector's poll loop — easier to just
   read the server logs.

For 1-on-1 chats with the bot, the chat id is the **user id**
(positive number). The bot must have been DM'd at least once before
its chat id exists.

## 5. Bind the chat to a Chord group

```bash
npm run connector:bind --workspace=server -- bind telegram -1001234567890 g_yourGroup
```

Verify:

```bash
npm run connector:bind --workspace=server -- list g_yourGroup
# telegram:-1001234567890
```

## 6. Test the round-trip

In the Telegram group, type:

```
@mychord_bot add to Costco list - milk
```

You should see, in order:

1. The bot's reply appears in the Telegram group (`I've added milk to
   the Costco list`).
2. The Costco list + item exists in the Chord DB.

For 1-on-1 chats, the @-mention is **not required** — the bot is the
only addressee, so every message is treated as a mention.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Bot silent in groups | Privacy mode is on. `/setprivacy → Disable` via BotFather. |
| Bot silent everywhere; no logs | Env var not loaded. Confirm `connectors: telegram connector ready …` at startup. |
| Server logs show inbound but no reply | Channel not bound. Check `npm run connector:bind --workspace=server -- list <groupId>`. |
| `bot was blocked` on send | A specific user blocked the bot (1-on-1 chat). Nothing the connector can do. |
| `chat not found` on send | Wrong chat id — re-check via `getUpdates` or `@userinfobot`. |
| Replies arrive but Chord didn't see the trigger message | The bot posted using a non-mention; check `entities` in the raw payload. The connector falls back to `@username` substring search — works in most cases but can miss exotic Unicode at-signs. |
| Multiple connector restarts produce duplicate replies | The poll-loop offset is stored in-process. Until `getUpdates` is called, Telegram keeps unconsumed messages and re-delivers them on the next call. The first poll after restart will see all backlogged messages — this is by design but can spam if the bot was offline a while. |

## Security notes

- `TELEGRAM_BOT_TOKEN` is the bot's whole identity. Treat like a
  password. Rotate via BotFather → `/revoke` if leaked.
- Telegram does not sign incoming updates (the connector pulls them,
  so authenticity is implicit). There's no HMAC to forge.
- Bot tokens are **not** scoped to a workspace or owner the way Slack
  tokens are — anyone with the token can fully impersonate the bot.

## What this connector deliberately does NOT do (v1)

- Webhooks. Long-poll suffices for the demo. If we deploy and want
  push delivery, swap `getUpdates` for a `setWebhook` call against
  `/api/v1/webhooks/telegram` and add HMAC verification (Telegram
  doesn't sign webhooks; the standard guard is a long random secret
  in the URL path).
- Rich formatting (`parse_mode=HTML` or MarkdownV2). Replies post as
  plain text.
- File / photo / sticker handling. Empty-text messages are dropped.
- Inline queries, callback queries, chat-join requests, and other
  update types. Only `message` is consumed.
- Edit / delete propagation either direction.
