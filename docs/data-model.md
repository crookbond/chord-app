# Data model

Postgres database addressed by `DATABASE_URL` (default: `postgresql://chord@127.0.0.1:5432/chord`). SQLite → Postgres cutover is documented in [ADR 0038](./notes/0038-sqlite-to-postgres.md). Migrations live in `server/src/db/migrate.ts` and run idempotently (`CREATE TABLE IF NOT EXISTS` everywhere + an `_migrations` ledger); the historical 46-entry SQLite migration list was squashed into `001_pg_init` at cutover, and new migrations resume from `002_*`.

Type mapping notes (ADR 0038, deferred type cleanup): `text` ISO datetimes are kept as `text` (not yet `timestamptz`), booleans stay as `integer 0/1` (compare with `= 1`, never `IS TRUE`), and JSON-shaped columns are still `text`. `LIKE` is case-sensitive in Postgres — use `ILIKE` or lowercase both sides when comparing user input.

Kernel ships a TypeScript view of each entity (`Group`, `Message`, etc.); the DB rows use snake_case column names. Row-to-entity conversion happens in each service file (e.g. `rowToMessage`).

## Tables

### `users`
| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | `u_<nanoid>` |
| `username` | TEXT UNIQUE | |
| `display_name` | TEXT NULL | |
| `created_at` | TEXT | ISO 8601 |

### `sessions`
| `token` | TEXT PK | `t_<nanoid>` |
| `user_id` | TEXT FK → users | CASCADE |
| `created_at` / `last_seen_at` | TEXT | |

### `groups`
| `id` | TEXT PK | `g_<nanoid>` |
| `name` | TEXT | |
| `kind` | TEXT | `group` or `personal` |
| `invite_code` | TEXT UNIQUE | 6-char uppercase |
| `ingest_email` | TEXT UNIQUE | `{slug}-{idFragment}@chord.app` |
| `created_by` | TEXT FK → users | |
| `adults_only` | INTEGER | `0 / 1`, used by document-visibility rules |
| `created_at` | TEXT | ISO 8601 |

### `group_members`
| `(group_id, user_id)` | composite PK | |
| `role` | TEXT | `owner` or `member` |
| `tier` | TEXT | `verified`, `trusted`, or `guest` |
| `joined_at` | TEXT | ISO 8601 |

### `messages`
| `id` | TEXT PK | `m_<nanoid>` |
| `group_id` | TEXT FK → groups | |
| `sender_id` | TEXT FK → users NULL | `NULL` when `kind='bot'` or `'system'` |
| `kind` | TEXT | `text`, `file`, `system`, `bot` |
| `body` | TEXT | |
| `attachment_id` | TEXT NULL | |
| `reply_to_id` | TEXT NULL | |
| `mentions_bot` | INT | 0 / 1, precomputed from `@chord` regex |
| Index | `(group_id, created_at)` | |

### `attachments`
| `id` | TEXT PK | `a_<nanoid>` |
| `scope_kind` | TEXT | `group` or `user` |
| `scope_id` | TEXT | group or user id |
| `uploaded_by` | TEXT FK → users | |
| `filename` / `mime_type` / `size` | | |
| `path` | TEXT | relative to `DATA_DIR` |
| `summary` | TEXT NULL | LLM-generated, up to ~220 tokens |
| `extracted_text` | TEXT NULL | up to 40 000 chars |
| `pinned` | INT | 0 / 1 |
| `indexed_at` | TEXT NULL | set when extraction completes |
| `created_at` | TEXT | ISO 8601 |
| Index | `(scope_kind, scope_id)` | |

### `tasks`
`(id, group_id, title, details?, assignee_id?, status, due_at?, remind_at?, remind_cue?, live_until?, archived_at?, completed_at?, source_raw_context?, created_by?, created_at)`

- `status` is one of `open`, `active`, `done`, `superseded`, `archived`.
- `remind_at` drives rows in `proactive_messages`.
- `live_until` and `archived_at` support demo-specific task lifecycle cleanup.

### `lists` / `list_items`
`lists`: `(id, group_id, name, created_by?, created_at)`
`list_items`: `(id, list_id, text, checked, created_at)`

### `saves`
`(id, group_id, kind [link|place|media|note|contact], title, url?, note?, tags [JSON], trip_label?, created_by?, created_at)`

### `events` / `rsvps` / `event_attendees`
`events`: `(id, group_id, title, location?, starts_at, ends_at?, status, transparency, external_uid?, …google-sync + ADR-0040 columns…, created_by?, created_at)`

The base tuple has grown well beyond the original few columns. Shipped additions include `ends_at`, `status`, `transparency`, `external_uid` (+ the `gcal_*` sync set), and the **ADR 0040** two-way-calendar columns (`ical_uid`, `sequence`, `owner_user_id`, `group_ids`, …). See `server/src/db/migrate.ts` / `schema.ts` for the authoritative shape.

`rsvps`:  `(id, event_id, user_id?, display_name, status [yes|no|maybe|pending], solo, dish?, notes?, updated_at)` — upsert keyed on `(event_id, display_name)`. (ADR 0040 introduces `event_attendees` as the per-owner-copy attendee store; `rsvps` stays live.) External guests are not stored here: they live on the provider event (ADR 0295).

### `places` / `contacts` / `media_items`
Personal-chat primitives, parallel structure:
- `places`: `(id, group_id, name, area?, city?, tags [JSON], note?, created_by?, created_at)`
- `contacts`: same + `org?`, `education [JSON array]?`, `family?`
- `media_items`: `(id, group_id, kind [book|podcast|show|movie|article], title, note?, done, created_by?, created_at)`

### `memories`
`(id, group_id, persona_id?, scope, key, value, source, confidence, status, superseded_by?, created_at)`

- `status`: `proposed` or `confirmed` (drives the propose/confirm flow; `POST /memories/:id/confirm`)
- `scope`: `persona`, `group`, or `event`
- `source`: `passive`, `extracted`, or `explicit`
- `superseded_by` links old rows to the newer fact that replaced them
- indexes:
  - `(group_id, scope, superseded_by)`
  - partial index on `persona_id`

### `document_permissions`
`(id, attachment_id, group_id?, user_id?, granted_by?, granted_at)`

- exactly one of `group_id` or `user_id` is set
- this is the real read-visibility layer for attachments
- attachments are backfilled into this table from their original `scope_kind` / `scope_id`
- unique index on `(attachment_id, COALESCE(group_id,''), COALESCE(user_id,''))`

### `proactive_messages`
`(id, group_id, persona_id?, kind, payload [JSON], scheduled_for, fired_at?, created_at)`

- currently used for task reminders
- `payload` is kind-specific JSON
- due queue is indexed by `scheduled_for WHERE fired_at IS NULL`

### `trips`
`(id, group_id, name, destination, start_date, end_date, created_by?, created_at)`

- index on `(group_id, start_date)`

### `trip_participants`
`(trip_id, persona_id)` composite PK

- participants reference `users.id`

### `travel_legs`
`(id, trip_id, persona_id?, mode, origin, destination, depart_at, arrive_at, carrier?, flight_no?, confirmation?, source_doc_id?, created_at)`

- `mode`: `flight`, `train`, `car`, `ferry`, or `other`
- `source_doc_id` references the attachment that produced the leg when the PDF classifier or bot extracted it
- index on `(trip_id, depart_at)`

### `accommodations`
`(id, trip_id, property_name, address?, checkin_date, checkout_date, room_count?, confirmation?, source_doc_id?, created_at)`

- `source_doc_id` references the attachment that produced the accommodation row
- index on `(trip_id, checkin_date)`

### `_migrations`
`(_pk INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name UNIQUE, applied_at)`

## Scoping rules

- **Attachments** have a real scope (`group` or `user`). User-scope files are private even across groups.
- **All other entities** are group-scoped. A *personal* group is just a group with one human member and `kind='personal'`.
- **Document access** is decided by `document_permissions`, then filtered by group membership and the adults-only / guest rules.
- **Membership** = row in `group_members`. In the ideal model every endpoint that reads or mutates group-scoped data checks membership before access.

## Relationships worth knowing

- `messages.reply_to_id` links a message reply to another message.
- `messages.attachment_id` links a chat message to an uploaded file.
- `attachments` can feed:
  - `document_permissions`
  - `travel_legs.source_doc_id`
  - `accommodations.source_doc_id`
- `tasks.remind_at` can materialize a `proactive_messages` row.
- `trips` own `trip_participants`, `travel_legs`, and `accommodations`.
- `memories.superseded_by` creates a lightweight audit chain instead of in-place updates.

## Things we notably *don't* store

- Embeddings — see [subsystems/bot.md](./subsystems/bot.md) for the sliding-window + keyword strategy.
- Bot message "turn state" — each bot turn is stateless from the DB's perspective; context is rebuilt every time.
- A real user row for the bot — bot messages have `sender_id=NULL` and `kind='bot'`. Saves us a privileged-user dance.
