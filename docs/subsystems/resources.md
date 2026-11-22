# Resources

Catch-all for the data primitives the bot creates and the mobile Resources screen displays. Seven resource types, all group-scoped.

| Resource | Service | Kernel type | Routes | SSE |
|---|---|---|---|---|
| Task | `tasks.service` | `Task` | `/groups/:id/tasks`, `/tasks/:id` | `task.created`, `task.updated` |
| List | `lists.service` | `List`, `ListItem` | `/groups/:id/lists`, `/lists/:id/items`, `/list-items/:id` | `list.updated` |
| Save | `saves.service` | `Save` | `/groups/:id/saves`, `/saves/:id` | `save.added` |
| Event | `events.service` | `GroupEvent` | `/groups/:id/events`, `/events/:id/rsvps`, `/rsvps/:id` | `event.created`, `event.updated`, `event.deleted`, `rsvp.updated` |
| Place | `personal.service` | `Place` | `/groups/:id/places` | — |
| Contact | `personal.service` | `Contact` | `/groups/:id/contacts` | — |
| Media | `personal.service` | `MediaItem` | `/groups/:id/media`, `/media-items/:id` | — |

## Shared shape

Every resource has `id`, `groupId`, `createdBy` (nullable — `null` when the bot created it), and `createdAt`. Fields beyond that are domain-specific; see [data-model.md](../data-model.md) for columns.

## RSVP upsert quirk

`upsertRsvp` keys on `(eventId, displayName)` — not `(eventId, userId)`. Why:
- Many RSVPs come in from non-user guests ("Tina + husband"). We don't have user rows for them.
- Natural-language updates ("Mark is out now, sorry") should update an existing row, not create a duplicate.

Consequence: if two real users share a display name, they collide. Tolerable for the demo.

## Tags

`saves`, `places`, `contacts` store tags as a JSON array in a TEXT column. Parsed on read via `JSON.parse` with a filter for non-string entries. Simpler than a join table; no indexed search yet.

## TripLabel

`saves.trip_label` is the demo's bucketing mechanism for "save this Carbone link to the Miami trip." Free-text today; clustering could promote heavily-used labels into first-class Trip rows later. Filter via `GET /groups/:id/saves?trip=Miami`.

## Bot interaction

Every resource except Place + Contact + Media has an SSE event. This is intentional — the bot-written rows are the ones the chat UI should reflect live. The silent-update tabs (places/contacts/media) are lower-velocity; users usually navigate to the Resources screen deliberately.

Adding an event to `save.added` parity for places/contacts/media is cheap — we just haven't needed it yet. See the `tasks/` roadmap.

## Mobile screen (`mobile/app/groups/[id]/resources.tsx`)

One stacked layout, not a tab bar — each section is an expandable card-style panel with an inline add form and optional item controls (toggle, chip-pick-kind, etc.).

Personal groups render a different set of sections (places/media/contacts instead of events). That branch is based on `group.kind === 'personal'` at the top of the screen.

Live-update wiring is aspirational today — the screen refreshes on focus, not on SSE. Wiring SSE here is a phase 3c task if needed.

## What's missing

- **No delete UI** for anything except line-item "delete task" via PATCH status.
- **No drag reordering** for list items.
- **No date picker** for task `dueAt` — today it arrives only via bot tool or raw API.
- **Events display is read-only** in the mobile UI; the bot creates them via `create_event`, but there's no "+ New event" button.
- **RSVP editing is API-only**. Mobile doesn't render RSVPs yet.
