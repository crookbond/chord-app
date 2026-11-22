---
name: ADR 0008 — WhatsApp chat-export import
description: Decision record for the one-shot WhatsApp `.zip` ingestion pipeline that bootstraps a chord group from a historical chat
type: project
---

# 0008 — WhatsApp chat-export import

**Status**: accepted
**Date**: 2026-04-18
**Covers**: Phase A of the PoC-borrow plan (see `docs/tasks/README.md`)

## Context

The investor demo needs a "wow" entry moment. Starting from an empty group
and typing a few @Chord messages proves the bot works but doesn't prove
that the product handles *real* family data. A colleague's PoC
(`john-app`) shipped a WhatsApp chat-export ingestion pipeline that
parses a `.zip` export — `_chat.txt` + embedded media + forwarded PDFs —
and auto-populates a database with structured trips, tasks, and
attachments via windowed GPT-4o extraction. The output is exactly the
shape chord's domain model already expects (trips, travel_legs,
accommodations, tasks, lists, saves).

Porting that ingestion into chord gives us: (a) a repeatable demo seed
from any real chat history, (b) a showcase of the bot's tool executor
running outside a bot turn, (c) an audit-trail feature (raw-context
provenance) that strengthens trust in every subsequent LLM extraction.

### Tension with `demo-tasks.md`

That doc explicitly de-scopes "WhatsApp as the primary surface" (scope
rule, line 13) — chat stays in-app. **This ADR does not reverse that.**
What we're adding is a one-shot *file upload* of a historical export,
not a live WhatsApp channel, not IMAP / OAuth / webhook integration.
The surface the investor sees during the demo is still the in-app chat.
The import is a **setup step**, analogous to `npm run demo:seed` but
driven by a file the user chose. The scope rule that "the LLM is the
only real external call" is preserved: WhatsApp is not contacted at any
point.

If a future reviewer feels even the import conflicts with the demo's
"pure in-app" framing, pivot the feature to a chord-native export format
(same parser pipeline, different input file) and keep everything else.

## Decision

Add a new ingestion pipeline at `server/src/services/ingest/whatsapp/`
exposed as `POST /api/v1/ingest/whatsapp`. Accepts a multipart `.zip`
upload. Orchestrates:

1. **Extract zip** to a temp dir (adm-zip).
2. **Parse `_chat.txt`** into messages (two WhatsApp date formats,
   zero-width-char stripping, multi-line body accumulation). Ported
   verbatim from `john-app/src/ingest/parse.ts` — the regex pairs and
   zero-width strip are the hardest-won part; don't re-derive them.
3. **Persona → user resolution**: auto-create shadow user accounts for
   unmatched WhatsApp sender names. Case-insensitive trim lookup against
   existing group members and global users. Shadow users have a
   `shadow=true` flag (new column) so the UI can offer a "merge with
   real user" action later. **Resolved lean (a) from the planning
   conversation.**
4. **Create or resolve group**: a new group named after the export
   (derivable from zip name or user-provided). Owner = uploader.
5. **Insert messages** with **backdated** `created_at` = original
   WhatsApp timestamps. **Resolved lean: backdate.** Loses nothing
   compared to "imported now" and preserves the narrative that makes
   the demo land.
6. **Copy media** to `data/files/group/<groupId>/<attId>/` via the
   normal `saveFile()` path. Link messages that referenced the file
   (`has_attachment + attachment_filename`) via the new
   `messages.attachment_id` FK.
7. **Windowed extraction** (200 msgs, 20 overlap — john's proven
   tuning). Run synchronously *during the request*, streaming
   progress over SSE (`ingest.progress` event) so the uploader sees
   "parsed 1247 / extracted 3 trips / 18 tasks" live. **Resolved lean:
   sync with SSE progress** — the wait is the demo moment. Guard with a
   5-minute request timeout; if the chat is larger, the caller splits
   it or we queue in Phase A.1.
8. **Tool-executor reuse**: each extracted trip / task / link becomes a
   call to the existing `executor` with `actorUserId = uploader` and a
   new `{ kind: 'import', sourceRawContext }` provenance tag. The
   executor's SSE broadcast shape gains an optional `source` field so
   the UI can tell "bot created this" apart from "import created this."

Storage additions:

- `users.shadow` (boolean, default false) — an account auto-created by
  import with no login credentials. Merge-later UX is a separate
  follow-up.
- `messages.source` (text, nullable) — `'chat' | 'import'`. Default
  null (== `'chat'`). Enables filtering imported messages out of
  retrieval if we later find they're noisy.
- `<entity>.source_raw_context` (text, nullable) on `tasks`, `trips`,
  `travel_legs`, `accommodations`, `saves`, `events` — the ±5 messages
  (or PDF excerpt) that produced this entity. Mirror of john's design.

### Reusing the bot executor outside a bot turn

The current executor lives in `server/src/services/bot/executor.ts` and
assumes a `messageId` context plus `bot.tool` SSE broadcast. Factor the
per-tool dispatch into a pure function:

```ts
applyToolCall(
  db, { groupId, actorUserId, call, provenance }
): Promise<{ ok: true; data?: unknown } | { ok: false; error: string }>
```

Both `bot.service.ts` and the new ingest pipeline call through this.
Bot wraps the result in a `bot.tool` SSE broadcast; ingest wraps in
`ingest.tool` (same shape, different channel). No behaviour change for
existing bot code.

### Extraction LLM usage

Reuse the existing `LlmService` factory. The extraction prompt is a new
module (`services/ingest/whatsapp/extract.ts`) that asks the model for
a JSON array of tool calls from the chord registry — not raw domain
objects. That way the same zod validation, same executor, same SSE.
Prompt design draws on john's windowed prompt but targets chord's tool
schemas directly.

Mock provider gets a deterministic regex path (matches "flight", "hotel",
"book table", etc.) so the demo is reproducible without a live key.

## Alternatives considered

- **Auto-create shadow users (chosen) vs. interactive persona-map
  UI.** An upload-time dialog asking the uploader to map each
  WhatsApp name onto a chord user is more correct but a heavy first
  step and blocks the demo path. Shadow users are fast and reversible.
- **Stamp messages as "imported now" vs. backdate.** Stamping-now is
  simpler and avoids any edge case with SSE ordering (SSE clients
  expect monotonically-increasing `created_at`). Backdating wins
  because the demo narrative depends on the chat *looking like a real
  chat*. SSE isn't emitted for imported historical messages, so
  monotonicity isn't at risk.
- **Async ingestion (queue + return 202) vs. sync-with-SSE.** Async is
  friendlier for large chats but the demo benefit evaporates — the
  "watch it populate live" moment is the whole pitch. Sync with SSE
  progress is the right choice for demo scale; if we hit production
  scale this becomes a worker.
- **Keep john-app's Postgres pipeline as a separate service.** Clean
  split but doubles the deployment story, and chord's domain model is
  strictly richer than john's. Port, don't proxy.
- **Skip WhatsApp, ship per-file structured extraction only (Phase B).**
  Equivalent demo power for the "flight PDF → travel leg" moment,
  without the WhatsApp tension. Viable fallback if this ADR gets
  reversed. Phase A and Phase B are independent and either can ship
  first; we chose A because the "populate a whole group" moment is a
  bigger wow.

## Consequences

- New dependency: `adm-zip` (MIT, ~40 KB). `@types/adm-zip` for dev.
- New route, new service subdirectory, three schema columns, one new
  SSE event family (`ingest.*`). No existing subsystem changes
  behaviour — ingest is additive.
- The bot executor refactor (extract `applyToolCall`) is the only
  change that touches running bot code. Gate it with the existing
  tests in `server/src/services/bot/__tests__/`.
- Shadow users are a new identity concept. Until a "merge" UX exists,
  they appear as authored users on historical messages but cannot log
  in. Document the sentinel clearly so the mobile client doesn't
  mis-render.
- Raw-context provenance is the most portable win: any LLM extraction
  chord does (imports, per-file extraction in Phase B, memory
  extraction) can adopt the same column + "Why this entity?" UI.
- Demo reproducibility depends on the LLM provider. Keep the mock
  provider fully exercised — the demo script should run with
  `LLM_PROVIDER=mock` and still produce non-trivial extractions from a
  canned fixture zip.
