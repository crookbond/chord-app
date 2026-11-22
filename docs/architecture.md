# Architecture

## Shape

```
┌───────────────────────────────────────────────────────────────────┐
│ mobile/                               client/ (placeholder)        │
│ Expo SDK 54 + expo-router             Vite + React (phase 4)       │
│ iOS · Android · Web (RN Web)          admin/inspection UI          │
└───────────────┬───────────────────────────────────┬───────────────┘
                │ HTTPS + SSE                       │
                ▼                                   ▼
┌───────────────────────────────────────────────────────────────────┐
│ server/  (Express 4, ESM, tsx-dev / tsc-build)                    │
│  routes → services → db (Kysely / pg)                             │
│  services/bot (LLM factory + tool executor + SSE broadcaster)     │
│  services/sse.hub (in-process pub/sub, 25s keep-alive)            │
└────────────┬──────────────────────┬────────────────────┬──────────┘
             │                      │                    │
             ▼                      ▼                    ▼
      Postgres@127.0.0.1      data/files/…          logs/*.log
      (DATABASE_URL)
```

- **kernel/** — plain TypeScript shared module (minimal `package.json` marker: `"type": "module"` + `"private": true`, **never** a `"name"` field, not a root workspace package). Shared types, zod schemas, API path constants, SSE event names. Imported via tsconfig `paths` in server/mobile and a metro alias in mobile. See [ops/kernel-path.md](./ops/kernel-path.md) for the rationale.
- **data/** and **logs/** sit at the repo root regardless of which workspace launches the server (anchored via `import.meta.url`, not CWD).

## Request flow — message post

```
mobile POST /groups/:id/messages
   │
   ▼
auth middleware (loads session → req.userId)
   │
   ▼
groups.service.isMember?  ─── no → 403
   │ yes
   ▼
messages.service.postMessage
   │
   ├──► sseHub.broadcast(groupId, "message", msg)
   │       fan-out to every open /stream connection on this group
   │
   └──► bot.service.decideReaction
           │ yes → bot.service.reactToMessage (fire-and-forget)
           │          ├──► llm.stream(…)
           │          │       tokens → sseHub.broadcast(gid, "bot.token", …)
           │          ├──► parseReply(body) → cleanBody + ToolCall[]
           │          ├──► for each call: executeTool(db, gid, call)
           │          │       → CRUD + per-type SSE broadcast
           │          └──► persist bot message + "bot.done" + final "message"
   │
   ▼
HTTP 201 with Message
```

## Stack

| Layer | Choice | Why |
|---|---|---|
| Mobile | Expo 54 + expo-router + RN Web 0.21 | One codebase, file-based nav, typed routes, works on iOS/Android/web |
| State | zustand + React `useEffect` fetches | Small app, no need for React Query |
| Server | Express 4 + TypeScript ESM | Familiar, minimal ceremony |
| SQL | Kysely + `pg` (node-postgres) | Typed; same-VM Postgres via `DATABASE_URL`. SQLite → Postgres cutover in ADR 0038. |
| SSE | Custom hub (Map<groupId, Set<Response>>) | Simpler than WS for this chat topology |
| LLM | Factory → OpenAICompat / Gemini / Mock | OpenAI-compatible covers Ollama + vLLM via `OPENAI_BASE_URL` |
| File extract | `pdf-parse` + raw UTF-8 for text formats | No OCR yet |
| Auth | Opaque token in `x-chord-token` / cookie | Demo only; no password |

## What's deliberately absent

- **No WebSockets.** SSE is one-way from server → client; the client sends writes via plain POST. This is enough for chat and dramatically simpler than maintaining a socket lifecycle.
- **No embeddings or vector DB.** Bot context is a sliding window + pinned attachment summaries + filename keyword matching. See [subsystems/bot.md](./subsystems/bot.md).
- **No job queue.** Bot turns and file indexing are fire-and-forget `Promise.then(…)` calls. If the process crashes mid-turn, the turn is lost. Acceptable for demo.
- **No auth.** Users pick a username. Sessions are opaque tokens. No passwords, no email, no OAuth.
- **No client/ implementation.** The `client/` workspace exists as a phase-4 placeholder; admin UI TBD.

## Data scoping

Two scopes, captured in the `attachments` table and implied for the rest:

- **group** — visible to every member.
- **user** — private to one user (not visible to other members of any group).

Right now only attachments have an explicit scope enum. Tasks, lists, saves, events, places, contacts, media are all group-scoped (a *personal* group is still a group with one member). See [data-model.md](./data-model.md) for the tables.

## SSE events

Every event name is declared in `kernel/src/sse.ts` as `SSE.*`. Payload types are in `SseEventMap`.

| Event | When | Payload |
|---|---|---|
| `message` | Any message inserted (user or bot) | `Message` |
| `bot.token` | LLM token arrives during a bot turn | `{ messageId, delta }` |
| `bot.done` | LLM stream complete, final message about to be persisted | `{ messageId }` |
| `bot.share-offer` / `bot.save-offer` / `bot.card` | Bot emits UI-specific follow-up affordances | offer/card payload |
| `bot.tool` | One tool invocation finished inside a bot turn | `BotToolEvent` (name + summary + status) |
| `bot.sources` | Attachments that fed the prompt for this bot turn | `BotSourcesEvent` (filenames + summaries + pinned flag) |
| `task.created` / `task.updated` | Task CRUD or bot tool | `Task` |
| `list.updated` | List/item create, check, delete | `{ listId, item? }` |
| `save.added` | Save created | `Save` |
| `event.created` | Event created | `GroupEvent` |
| `rsvp.updated` | RSVP upsert | `Rsvp` |
| `memory.created` | Memory extraction created a live row | `Memory` |
| `trip.updated` | Trip created or materially updated | `Trip` |
| `travel_leg.created` / `accommodation.created` | Trip detail created | trip detail row |
| `ping` | Every 25s to keep the connection alive | `{ t }` |

## Directory tree

```
chord-demo/
├── mobile/          Expo app (primary client)
├── client/          Phase-4 admin placeholder
├── server/          Express + TypeScript
├── kernel/          Shared types + zod + API constants (not a workspace)
├── data/            uploaded files (gitignored; DB lives in Postgres — ADR 0038)
├── logs/            Winston output (gitignored)
└── docs/            This directory (+ references/chord_demo_flows.html brainstorm)
```
