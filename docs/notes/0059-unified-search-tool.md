# ADR 0059 — Unified `search` bot tool across chats, files, and entities

**Status**: accepted
**Date**: 2026-06-30
**Related**: [ADR 0004 — Group-scoped agent](./0004-group-scoped-agent.md),
[ADR 0006 — Keyword retrieval](./0006-keyword-retrieval.md),
[ADR 0021 — FTS attachment index](./0021-fts5-attachment-index.md),
[ADR 0032 — Strict per-group scope](./0032-strict-per-group-scope.md),
[ADR 0037 — Catchup files + `/me/*` aggregation](./0037-file-management-and-delete.md)

## Context

Users could already ask the bot targeted read questions — `get_list` (one
list), `list_tasks` (this group's tasks), `search_saves` (saves + list
items), `find_events` (a date range). What they couldn't do was ask **one
broad question that spans types and groups**: "where did we talk about the
cabin", "find anything about Nolan's passport", "search my chats and files
for the plumber". Each existing tool is narrow by design; none searches
messages at all, and none crosses group boundaries.

The retrieval half of this already exists for files: ADR 0021's `tsvector`
chunk index (`searchAttachmentChunks`). Messages, tasks, saves, events,
lists, places, contacts, and media have no index — but the corpus is
demo-scale (tens of MB), and the `/me/*` catchup endpoints already prove
that reusing the group-scoped list services + a cheap in-memory filter is
good enough at this size.

## Decision

Add a single read-only **`search`** bot tool (native-function-calling only,
like the other read tools) backed by a new
`server/src/services/search.service.ts::searchEverything`. It returns
structured, per-category results the model summarizes; it writes nothing and
broadcasts no SSE.

**Entry point is the chat, not a screen.** Per the product decision, search
is invoked in natural language from the 1×1 personal chat (and works in
shared groups too). There is deliberately **no** `/me/search` HTTP endpoint
or mobile search screen in this cut — the tool is the whole surface. If a
structured search UI is wanted later, it reuses `searchEverything` unchanged.

**Coverage.** messages (chats), attachments (files), tasks, reminders
(tasks with `remind_at` set — there is no separate reminders table), saves,
events, lists + items, places, contacts, media.

**Retrieval.** Files reuse the ADR 0021 `tsvector` chunk search (ranked
snippets) over the visible-attachment candidate set, with a filename/summary
substring fallback so unindexed files still surface. Everything else reuses
the existing group / `*ForUser` list services and filters in memory
(lower-cased substring), exactly as `search_saves` already does.

## Scope model (the crux)

The scope is chosen by **where the turn came from**, not by a tool argument:

- **Personal (1×1) chat → cross-group, user-scoped.** Search every group the
  triggering user belongs to — the catchup `/me/*` contract. This is the
  user querying *their own* aggregate, so it does not violate ADR 0004
  (which forbids the agent in a *shared* group from surfacing another
  group's data).
- **Shared group → this-group only.** Strict ADR 0004/0032 scoping.

`applyToolCall` already receives `groupId` + `actorUserId`; the executor
looks up `groups.kind` and sets `crossGroup = kind === 'personal'`.

### Why cross-group results omit `groupId`

ADR 0032's defense-in-depth post-filter (`scrubCrossGroupLeak`) drops any
result object carrying a `groupId` that ≠ the current group. Cross-group
search results are legitimately from other groups, so returning raw kernel
entities (which all carry `groupId`) would get them **scrubbed away**. The
service therefore returns trimmed DTOs that carry a human `group` **name**
instead of a `groupId` — the same shape `find_events` already uses to return
cross-group event data safely. The scrubber stays a genuine backstop: in a
shared group (`crossGroup=false`) it still catches anything mis-scoped.

## Alternatives considered

- **Extend `tsvector` to every table (generated columns + GIN).** The
  "correct" long-term index, but it's a pile of migrations, per-table
  triggers, and backfills for a demo-scale corpus. ADR 0006/0021 already
  committed to "no new infra until recall visibly hurts." In-memory
  substring filtering over the list services is enough here; swapping in
  real per-entity FTS later is a drop-in behind `searchEverything`.
- **A `/me/search` HTTP endpoint + mobile search screen.** Not asked for in
  this cut (chat-only entry point). Left as a clean future extension.
- **A tool argument to pick scope.** Rejected — scope should follow the
  ADR 0004 boundary automatically, not be something the model can widen.

## Rendering — clickable results in the chat

The `search` turn returns **cards** (not just prose): the executor maps the
top few hits per category into `BotCard[]` and the bot loop persists them to
`message_cards` + broadcasts `bot.card`, exactly like every other tool card.
Because `search` is in `READONLY_TOOL_NAMES`, the turn surfaces as a **visible
bubble** (not a silent receipt), so the model's short prose summary shows with
the tappable cards beneath it, and they re-render on history reload.

Two new tap affordances on `BotCard`:

- **`href`** — an in-app expo-router path. The mobile bubble renders any card
  with `href` as a `Pressable` → `router.push(href)`, jumping to the right
  screen *inside* the app (distinct from the existing `url`/`appUrl`
  external-browser affordance on `kind:'action'` cards). Since there are no
  single-entity detail screens, targets are: messages → their own group chat
  (`/groups/<id>`), tasks/reminders → `/catchup/tasks`, saves/places/contacts/
  media → `/catchup/saves`, lists → `/catchup/lists`, events → `/calendar`.
- **`attachmentId` (+ `mimeType`)** — set on **file** cards. Tapping OPENS the
  actual file: OS viewer / Quick Look on native (PDFs, docs), an auth-fetched
  blob tab on web (images render inline) — reusing the same
  `openAttachmentNative` / `fetchAttachmentBlobUrl` helpers the file-message
  bubble already uses. So a PDF or image hit opens the document itself, not a
  list. Takes precedence over `href`.

The service computes `href` (it's the only layer with each hit's real group id
— and it's a plain string, not a `groupId` field, so the ADR 0032 scrubber
leaves it intact). Bridged surfaces (Telegram/Slack/plain) ignore `href` /
`attachmentId` and render the card as a text line.

## Consequences

- One umbrella read tool; the narrow tools (`get_list`, `list_tasks`,
  `search_saves`, `find_events`) stay for their precise jobs. The tool
  description steers the model: use `search` when the type is unknown or the
  query spans categories; use the narrow tools to *enumerate* a known list /
  all tasks / a date range.
- No embeddings, no new tables, no migration. Files keep their existing
  ranked-snippet quality; other types get substring recall.
- Replaceable wholesale behind `searchEverything` when a unified retrieval
  layer arrives — same containment ADR 0006 asked for.
