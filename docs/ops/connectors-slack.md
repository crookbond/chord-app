# Slack connector — deploy + bind runbook

> **Deprecated (ADR 0154).** Deploy-wide Slack wiring was removed — there is no
> `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` env var and the UI no longer offers
> Slack. The `SlackConnector` code remains for a BYO token (ADR 0025) and for
> disconnecting a legacy binding. Kept for reference / a future revival.

For the design see [`../subsystems/connectors.md`](../subsystems/connectors.md)
and [ADR 0010](../notes/0010-im-connectors.md).

This runbook walks through getting a Slack workspace's `@chord` bot
talking to a Chord group end-to-end. ~10 minutes once you have a workspace.

## What you'll need

- Admin access to a Slack workspace (a personal one is fine).
- A publicly reachable URL for Chord's `/api/v1/webhooks/slack` —
  ngrok, Cloudflare Tunnel, or a deployed instance. Slack will not
  send events to `127.0.0.1`.
- The Chord server running with the new env vars.

## 1. Create a Slack app

1. <https://api.slack.com/apps> → **Create New App** → **From scratch**.
2. Name it (e.g. *Chord*), pick the target workspace.

## 2. Configure scopes

**OAuth & Permissions** → **Bot Token Scopes**, add:

- `app_mentions:read` — receive `<@chord>` mentions.
- `chat:write` — send replies via `chat.postMessage`.
- `channels:history` — read messages in public channels the bot is in.
- `groups:history` — read messages in private channels the bot is in.
- `im:history` + `im:read` + `im:write` — DM support (still routed
  through bound channel ids; v1 treats DMs as auto-mentions).

## 3. Enable event subscriptions

**Event Subscriptions** → toggle on.

- **Request URL**: `https://YOUR_PUBLIC_HOST/api/v1/webhooks/slack`.
  Slack pings this once with a `url_verification` challenge —
  the connector responds inline with the matching `challenge` string,
  so the URL should turn green within a second.
- **Subscribe to bot events**: add `message.channels`,
  `message.groups`, `message.im`, and `app_mention` (defensive — the
  connector parses both event flavours).
- **Save Changes** at the bottom.

## 4. Install to workspace + collect tokens

- **Install to Workspace** → approve.
- Copy the **Bot User OAuth Token** (starts with `xoxb-…`) →
  `SLACK_BOT_TOKEN`.
- **Basic Information** → **Signing Secret** → `SLACK_SIGNING_SECRET`.

Add both to `.env` at the repo root:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
```

Restart `npm run dev`. Look for:

```
connectors: slack initialized
```

If you see `slack disabled (missing SLACK_BOT_TOKEN ...)`, the env
file isn't being loaded; confirm it sits at the repo root, not in
`server/`.

## 5. Bind a Slack channel to a Chord group

Get the Slack channel id (right-click the channel name in the desktop
app → **Copy link** → the trailing path segment is the channel id, e.g.
`C012ABCDEF`). Get the Chord group id with
`psql -U chord chord -c 'SELECT id, name FROM groups'`.

```bash
npm run connector:bind --workspace=server -- bind slack C012ABCDEF g_yourGroup
```

Verify:

```bash
npm run connector:bind --workspace=server -- list g_yourGroup
# slack:C012ABCDEF
```

## 6. Add the bot to the channel

In Slack: `/invite @chord` in the bound channel. Without this, Slack
won't deliver `message.channels` events to the app.

## 7. Test the round-trip

In the Slack channel, type `@chord add to Costco list - milk`.

You should see, in order:

1. Server logs: `inbound dropped: …` if the channel isn't bound, or
   silent if it is.
2. The bot's reply appears in the Slack channel (`I've added milk to
   the Costco list`).
3. The Costco list + item exists in the Chord DB (visible in the
   mobile app's Resources screen, or
   `SELECT * FROM list_items WHERE list_id IN (SELECT id FROM lists WHERE group_id = ?)`).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Slack URL verification stuck on `Verifying…` | Connector didn't return the `challenge`. Check the connector started (`connectors: slack initialized`). |
| `signature mismatch` 401 in server logs | Check that `SLACK_SIGNING_SECRET` matches the app's *Signing Secret* (not the Client Secret). Also confirm a reverse proxy isn't rewriting the body. |
| Bot doesn't reply but Slack shows the event reached the server | Channel not bound. `npm run connector:bind --workspace=server -- list <groupId>`. |
| Bot replies in Chord but not in Slack | Check `chat:write` scope is granted; reinstall app if scopes changed. Logs will show `slack chat.postMessage failed: not_in_channel` if the bot was removed. |
| `not_in_channel` error on send | `/invite @chord` in the bound channel. |
| Replies in DMs don't work | DM event subscriptions need explicit `im:*` scopes. Slack also requires the user to *open* a DM with the bot before events flow. |

## Security notes

- `SLACK_BOT_TOKEN` is a workspace-wide credential. Treat like a
  password: keep it out of git, rotate via the Slack app's *OAuth &
  Permissions* panel if leaked.
- The connector ignores any Slack message with `bot_id` set — this
  prevents loops (the bot's own replies do not re-trigger the
  pipeline) and ignores other bots in the channel by default.
- Webhook signature verification uses 5-minute replay protection
  + timing-safe compare.

## What this connector deliberately does NOT do (v1)

- Slash commands (`/chord …`). Not registered in scopes; deferred.
- Threading. Replies post at top level, not in the triggering thread.
- Edit / delete propagation either direction.
- Slack mrkdwn formatting. Replies post as plain text; backticks and
  links pass through but bold/italic do not.
- File / attachment forwarding. A flight PDF dragged into Slack is
  not yet ingested into Chord.
