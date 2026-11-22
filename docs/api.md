# API

All endpoints are prefixed with `/api/v1`. Session token can be sent either as the cookie `chord.sid` (web, set automatically on `POST /session`) or the header `x-chord-token: <token>`. Every route below except `/health` and `/session` requires a valid session.

Canonical paths are defined in `kernel/src/api.ts` as `API.*` constants — import them on both server and client.

## Session

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/session` | `{ username, displayName? }` | `{ user, token }` — creates user if new, auto-creates their personal group |
| GET | `/me` | — | `User` |

## Groups

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/groups` | — | `Group[]` — user's memberships |
| POST | `/groups` | `{ name, kind? }` | `Group` — kind defaults to `group` |
| POST | `/groups/join` | `{ inviteCode }` | `Group` or 404 |
| POST | `/chat-invites` | `{ email, groupId?, message? }` | `InviteByEmailResponse` (`added` / `asked` / `emailed`) — ADR 0318 |
| GET | `/me/chat-invites` | — | `ChatInvite[]` waiting for the caller |
| POST | `/me/chat-invites/:id/accept` · `/decline` | `{}` | `{ ok, groupId }` |
| GET | `/groups/:id` | — | `Group` (403 if not member) |
| GET | `/groups/:id/members` | — | `Member[]` (403 if not member) |

## Messages + stream

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/groups/:id/messages` | `?before=<iso>&limit=<n>` | `Message[]` ordered ascending; `limit` capped at 200, default 50 |
| POST | `/groups/:id/messages` | `{ body, attachmentId?, replyToId? }` | `Message` — broadcasts `message` SSE; triggers bot if applicable |
| GET | `/groups/:id/stream` | — | `text/event-stream` (SSE) — see [architecture.md § SSE events](./architecture.md#sse-events) |

## Attachments

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/groups/:id/files` | `multipart/form-data` field `file` (max 20 MB) | `Attachment` — extraction runs async |
| GET | `/groups/:id/files` | — | `Attachment[]` |
| GET | `/attachments/:id` | — | binary (sends file) |
| PATCH | `/attachments/:id` | `{ pinned: boolean }` | `Attachment` |
| POST | `/attachments/:id/share` | `{ groupId }` | 201 with the copied `Attachment` in the target group |
| POST | `/demo/reset` | — | `{ ok, tablesWiped }` — wipes all user data + reseeds the Doe corpus. Gated by `DEMO_MODE=1`; returns 403 otherwise. |

## Tasks

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/groups/:id/tasks` | — | `Task[]` |
| POST | `/groups/:id/tasks` | `CreateTaskRequest` | `Task` — broadcasts `task.created` |
| PATCH | `/tasks/:taskId` | `UpdateTaskRequest` | `Task` — broadcasts `task.updated` |
| DELETE | `/tasks/:taskId` | — | 204 |

## Lists

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/groups/:id/lists` | — | `Array<List & { items: ListItem[] }>` |
| POST | `/groups/:id/lists` | `{ name }` | `List` — broadcasts `list.updated` |
| POST | `/lists/:listId/items` | `{ text }` | `ListItem` — broadcasts `list.updated` |
| PATCH | `/list-items/:itemId` | `{ checked }` | `ListItem` |
| DELETE | `/list-items/:itemId` | — | 204 |

## Saves

| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/groups/:id/saves` | `?trip=<label>` | `Save[]` |
| POST | `/groups/:id/saves` | `CreateSaveRequest` | `Save` — broadcasts `save.added` |
| DELETE | `/saves/:saveId` | — | 204 |

## Events + RSVPs

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/groups/:id/events` | — | `GroupEvent[]` |
| POST | `/groups/:id/events` | `CreateEventRequest` | `GroupEvent` — broadcasts `event.created` |
| GET | `/events/:eventId/rsvps` | — | `Rsvp[]` |
| POST | `/events/:eventId/rsvps` | `UpsertRsvpRequest` | `Rsvp` — upserts by `(eventId, displayName)`; broadcasts `rsvp.updated` |

## Memories + trips

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/groups/:id/memories` | — | `Memory[]` |
| GET | `/groups/:id/trips` | — | `TripStatus[]` |

## Personal-chat primitives

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/groups/:id/places` | — | `Place[]` |
| POST | `/groups/:id/places` | `CreatePlaceRequest` | `Place` |
| GET | `/groups/:id/contacts` | — | `Contact[]` |
| POST | `/groups/:id/contacts` | `CreateContactRequest` | `Contact` |
| GET | `/groups/:id/media` | — | `MediaItem[]` |
| POST | `/groups/:id/media` | `CreateMediaRequest` | `MediaItem` |
| PATCH | `/media-items/:itemId` | `{ done }` | `MediaItem` |

## Health

| Method | Path | Returns |
|---|---|---|
| GET | `/health` | `{ ok: true, t, demoMode, authMode, botAlias }` |
| GET | `/health/ready` | readiness probe (checks Postgres) |

## SSE consumer protocol

On `/groups/:id/stream`:
- Web clients: use native `EventSource` with `withCredentials: true` (auth via cookie).
- Native clients: `react-native-sse` with `x-chord-token` header.

The stream emits an initial `: subscribed to <groupId>` comment, then named events (`event: <name>` / `data: <json>`), then a `ping` every 25s. Common events include `message`, `bot.start`, `bot.receipt`, `bot.done`, `bot.share-offer`, `bot.save-offer`, `bot.card`, `bot.tool`, `bot.sources`, `task.created`, `task.updated`, `list.updated`, `save.added`, `event.created`, `rsvp.updated`, `memory.created`, `trip.updated`, `travel_leg.created`, and `accommodation.created`. (`bot.token` is deprecated since quiet mode — ADR 0022 — and no longer fires.) Close the connection to unsubscribe.

## Error shape

All 4xx / 5xx responses: `{ error: string }`. Validation failures come from zod and surface the first issue message.
