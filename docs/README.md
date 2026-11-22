# Chord Demo — Documentation

Reference docs for the Chord demo. Grouped by audience, not by file type.

> **New here?** Read [`../README.md`](../README.md) for the human quick-start,
> or [`../CLAUDE.md`](../CLAUDE.md) if you're an AI agent orienting yourself.

## For a first read

| Doc | Why you'd read it |
|---|---|
| [architecture.md](./architecture.md) | System shape — what runs where, how pieces connect |
| [features.md](./features.md) | What the product does (mapped to the demo flows) |
| [data-model.md](./data-model.md) | Tables, relationships, scoping (group vs. user) |
| [api.md](./api.md) | REST + SSE reference |

## Subsystems

Deep docs on each major feature area. Read these when you're touching that code.

| Doc | Covers |
|---|---|
| [subsystems/chat.md](./subsystems/chat.md) | Messages, SSE hub, bot-reaction gating |
| [subsystems/groups.md](./subsystems/groups.md) | Group kinds (group vs. personal), members, invite codes, ingest email |
| [subsystems/attachments.md](./subsystems/attachments.md) | File upload, extraction, indexing, privacy scope |
| [subsystems/bot.md](./subsystems/bot.md) | Bot prompt, tool protocol, executor, provider abstraction |
| [subsystems/resources.md](./subsystems/resources.md) | Tasks, lists, saves, events+RSVPs, places, contacts, media |

## Ops

Runtime + developer concerns.

| Doc | Covers |
|---|---|
| [ops/dev.md](./ops/dev.md) | `npm run dev`, workspaces, mobile quirks, environment vars |
| [ops/kernel-path.md](./ops/kernel-path.md) | Why `kernel/` isn't a workspace, how metro + tsx resolve it |
| [ops/storage.md](./ops/storage.md) | `data/` layout, log files (DB lives in Postgres — see ops/postgres.md) |
| [ops/postgres.md](./ops/postgres.md) | One-time Postgres setup, backups (SQLite import is historical-only) |
| [ops/byok-providers.md](./ops/byok-providers.md) | Per-user model key (BYOK) setup examples — OpenAI, Anthropic, Gemini, OpenRouter, DeepSeek, Ollama, vLLM |

## Meta

| Doc | Covers |
|---|---|
| [notes/](./notes/) | ADRs — *why* decisions were made |
| [tasks/](./tasks/) | Roadmap + open design questions |
| [plans/](./plans/) | Investor-demo narrative + open design questions |
| [investigations/](./investigations/) | Write-ups of reported problems that turned out not to need a code change |
| [references/](./references/) | External inputs — feature briefs, brainstorms, discussion notes. Read for spirit, not contract. |

## Conventions

- **Doc tone**: terse. Short headings, bullet points, example snippets over prose.
- **When to write an ADR vs. a subsystem update**: an ADR captures a decision *between viable alternatives*. Ongoing implementation details belong in the subsystem doc.
- **When to add a `tasks/` entry**: whenever you notice a gap, a rough edge, or a design question you don't want to resolve right now. Favour capture over polish.
