# Chat

Messages + live delivery + bot-reaction gating.

## Posting

`POST /api/v1/groups/:id/messages { body, attachmentId?, replyToId? }` via `routes/messages.ts`.

1. `loadSession` + `requireSession` — anonymous users cannot post.
2. `groups.service.isMember` — 403 if not a member.
3. Zod-validate the body (`PostMessageRequest.safeParse`).
4. `messages.service.postMessage` inserts the row. `mentions_bot` is precomputed once via `mentionsBot(body)` — a `@chord` word-boundary regex in kernel.
5. `sseHub.broadcast(groupId, 'message', msg)` — fan out to every open `/stream` connection.
6. Respond 201 with the message.
7. If the body contains an `http(s)` URL, broadcast `bot.save-offer` with `{ messageId, url, title }` so clients can show a one-tap save affordance.
8. Load the group's `kind`, then consult `bot.service.decideReaction`:
   - Personal group → react.
   - Shared group → react only if `mentionsBot` is true.
   - Never react to bot or system messages.
9. If reacting, `reactToMessage(db, msg, group)` fires async — see [bot.md](./bot.md).

## SSE hub (`services/sse.hub.ts`)

Single in-process instance. State:
```
subs: Map<groupId, Set<{ id, res }>>
```

- `subscribe(channel, res)` — writes SSE headers + initial comment, returns an `unsubscribe()` closure. Routes call `req.on('close', unsubscribe)`.
- `broadcast(channel, event, data)` — serialises once, writes to every `res` in the set. Drops subs whose writes throw.
- 25-second ping loop (`setInterval`) emits `event: ping\ndata: {"t":…}` to keep connections alive past reverse-proxy idle timeouts.

Why in-process and not Redis:
- Single-node demo. If we ever horizontally scale, the hub becomes an adapter interface.
- ADR idea (not written yet): switch to Postgres LISTEN/NOTIFY or Redis pub/sub when node count > 1.

## Pagination

`GET /groups/:id/messages?before=<iso>&limit=<n>`:

- Ordering: internally we select `ORDER BY created_at DESC LIMIT n` with `created_at < before`, then reverse so the response is oldest→newest.
- `limit` defaults to 50, capped at 200.
- Client scrolls up → pass `before=oldestLoadedMessage.createdAt` for the next page.

## Mobile chat screen (`mobile/app/groups/[id]/index.tsx`)

State shape:
- One `FlatList` of messages, backed by `useApp().messagesByGroup[id]`.
- SSE subscription on mount: `onMessage` → `upsertMessage`; `onBotToken` → `appendBotDelta`.
- Streaming bot replies appear as placeholders with `createdAt = '__stream__'`; the final `message` event replaces them in place via shared id.
- Attach button uses `expo-document-picker` → `uploadFile` (multipart) → posts a `📎 {name}` message referencing the returned attachment id.

## Keep-alive on flaky networks

SSE connections will reconnect automatically on native (react-native-sse retries with backoff). Web `EventSource` reconnects with `Last-Event-ID` — we don't currently set it, so reconnected clients only see future events, not gap-fill. For a demo this is OK; for production we'd sequence SSE events or require clients to re-fetch the latest page on reconnect.

## Known gaps

- No typing indicators, read receipts, or message edits — out of scope for demo.
- The bot can't cite which message prompted its reply; `replyToId` is set but not visualised.

## Deleting messages (ADR 0242)

`POST /groups/:id/messages/delete { ids } | { all: true }` (`all` = clear chat).

- **Personal chat**: the rows are removed, with the hidden bot reply of a
  directive turn; clients drop them on the `messages.deleted` event.
- **Shared chat**: for the caller only. Selected messages go in
  `message_hides`; clearing sets `group_members.cleared_at`. Other members and
  the bot still see everything, and no event is sent.

`inViewOf(userId)` (messages.service) is the one "is this in my view" rule,
used by the message list, search, and the chat list's preview and unread
count. The chat screen reconciles the newest page on every open (the hub has no
replay). Files stay in Attachments. Bot tool: `delete_messages` (proposable,
confirmable only by the asker).

## Blocking (ADR 0298)

A user can block someone they share a chat with: long-press their message or
tap their name, or Settings → Blocked people, or the `block_user` bot tool.
The blocked person's messages leave the blocker's view in every chat (the rule
is part of `inViewOf`, and of the chat-list SQL), the blocker gets no pushes
for them, and `message_user` refuses either direction. The chat screen drops
live SSE messages from its own block list. The blocked person is not told;
everyone else, and the bot, see the chat as before. Routes: `GET/POST
/me/blocks`, `DELETE /me/blocks/:userId`.
