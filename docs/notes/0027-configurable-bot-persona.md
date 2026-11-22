# ADR 0027 — Configurable bot persona

**Status:** accepted — Phase 1 implemented; Phase 2 (multi-persona) still future — UPDATED 2026-06-01
**Date:** 2026-05-12

## Update — 2026-06-01

Phase 1 has shipped: the `bot_personas` table exists
(`server/src/db/migrate.ts`) and is seeded from env (`server/src/config/env.ts`)
for a single persona — mention aliases, display name, and provider are config,
not hardcoded. Phase 2 (multi-persona M:N dispatch) is still future, as
signposted below.

## Context

The bot's identity strings — the things users type to address it, the
name the LLM identifies as, and the slash-command prefix — are
hardcoded throughout the codebase as the literal `chord` / `Chord` /
`@chord` / `/chord`. The call sites split into three families:

1. **Mention/invocation literals** users type in the native app.
   - `kernel/src/types/message.ts:51` — `BOT_MENTION_REGEX = /(^|\s)@chord\b/i`
   - `bot/bot.service.ts:489` — imperative-verb regex `/^\s*(?:@chord|chord),?\s+(remember|remind|…)\b/i`
   - `bot/confirm-verb.ts:44` — confirm/approve/drop/reject verb grammar
   - `connectors/inbound-pipeline.ts:30` — `/chord pair <code>` slash command
2. **Display strings** the model and the UI render.
   - `bot/context.ts:359` and `proactive.service.ts:153,185` — `"You are Chord, …"` in system prompts
   - Mobile bubble headers, placeholder text, empty-state copy
3. **Connector-platform identity** — already per-binding via ADR 0025
   (`bot_user_id`, `bot_username` columns), so the platform-native
   mention syntax (`<@U…>`, `@chord_bot`) is detected against the
   binding's own bot, not a global literal.

Family (3) is solved. Families (1) and (2) are baked in at the kernel
and service layer, so a deployment cannot run a bot called anything but
"Chord," and two app instances bridged into the same external chat
cannot give their bots distinct in-app handles. That blocks two
near-term scenarios:

- **Multiple instances of the app** (dev/staging/prod, or separate
  customer deployments) joining the same external group. Each needs a
  distinguishable address so users in the external chat can talk to
  the right one.
- **Future within-app persona variants** — different prompt voices,
  toolsets, or models running side by side for product experiments
  (e.g. a read-only "ask only" persona alongside the default).

This ADR makes the bot's identity a first-class, configurable entity
without committing to the full multi-persona feature yet.

## Decision

Introduce a `personas` table. **Phase 1** (this ADR) seeds it with a
single row, populated from env vars at migration / startup. Code that
today reads kernel constants reads the persona record instead. The
relation `persona ↔ group` is implicitly 1:N — every group uses the
deployment's single persona, no join table needed yet.

### Schema (Phase 1)

**Naming note.** `persona_id` already exists in `memories`, `trips`,
`travel_legs`, `proactive_messages` referring to a *user* / family-graph
person. To avoid overloading the term we name the bot side
`bot_personas` / `bot_persona_id`. In prose and product copy we still
say "persona" — the prefix is purely for schema disambiguation.

```sql
CREATE TABLE bot_personas (
  id              TEXT PRIMARY KEY,                       -- 'default'
  display_name    TEXT NOT NULL,                          -- "Chord"
  mention_aliases TEXT NOT NULL,                          -- JSON array, ["chord"]
  prompt_name     TEXT NOT NULL,                          -- what `"You are <X>"` says
  llm_provider    TEXT,                                   -- override env LLM_PROVIDER, nullable
  model           TEXT,                                   -- override env model, nullable
  enabled_tools   TEXT,                                   -- JSON array of ToolName or NULL = all
  write_allowed   INTEGER NOT NULL DEFAULT 1,             -- 0 = read-only persona
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
```

Seed-from-env on first migrate:

| env var | persona column | default |
|---|---|---|
| `BOT_PERSONA_ID` | `id` | `'default'` |
| `BOT_DISPLAY_NAME` | `display_name` | `'Chord'` |
| `BOT_MENTION_ALIASES` (comma-separated) | `mention_aliases` | `'chord'` |
| `BOT_PROMPT_NAME` | `prompt_name` | value of `display_name` |
| `BOT_LLM_PROVIDER` | `llm_provider` | NULL (fall back to `LLM_PROVIDER`) |
| `BOT_MODEL` | `model` | NULL |
| `BOT_ENABLED_TOOLS` (comma-separated, optional) | `enabled_tools` | NULL = all |
| `BOT_WRITE_ALLOWED` (`'true'`/`'false'`) | `write_allowed` | `1` |

After the seed migration, the persona row is the source of truth.
Env vars are read only when the row is missing (fresh deploy).
Operators change identity by editing the row; the seed-from-env path is
not a continuous sync.

### Code changes

- **kernel** — `BOT_MENTION_REGEX` deleted; export
  `buildMentionRegex(aliases: string[])` and
  `mentionsBot(body, aliases)`. Call sites pass aliases from the
  persona resolver. Imperative + confirm regexes move out of bot.service
  / confirm-verb.ts into kernel builders parameterised on aliases.
- **bot.service** — `runBotTurn` looks up the persona for the group
  (today: the single row; future: by group + matched alias). System
  prompt assembly in `bot/context.ts` uses `persona.prompt_name`. The
  tool registry passed to the LLM is filtered through
  `persona.enabled_tools` when non-null. `write_allowed=0` removes
  every mutating tool from the registry regardless of `enabled_tools`.
- **confirm-verb / inbound-pipeline / connector mention detection** —
  regexes rebuilt from the persona's aliases. `/chord pair` becomes
  `/${alias} pair` for each alias the deployment exposes (typically
  one).
- **messages** — add nullable `bot_persona_id` column to `messages`.
  Bot reply rows set it; user rows leave it NULL. Mobile bubble header
  reads `persona.display_name` when present, defaults to "Chord" when
  NULL (back-compat for pre-migration rows).
- **Tool fence (` ```chord-tool ``` `) stays global.** It's an internal
  protocol token; never user-facing; renaming it gives no benefit and
  forces a coordinated LLM-prompt + parser change.
- **Group ingest email (`@chord.app`) stays global.** It names the
  *deployment domain*, not the bot.

### Phase 2 (out of scope, signposted)

When multiple personas in one app become needed:

- `persona_groups (persona_id, group_id, PRIMARY KEY(...))` join table.
- `connector_bindings.default_persona_id` — the persona that owns the
  platform's @handle on this binding (the one matched when the user
  uses the platform-native mention syntax).
- Inbound dispatch lets *any* persona in the group whose alias
  appears in the body text claim the turn, regardless of which
  binding's @handle was natively mentioned. This is how Discord /
  webhook / native-app connections fan one connection out to multiple
  personas — purely a text-level disambiguation.
- Telegram and Slack force `persona ↔ bot_user_id` to be 1:1 because
  the platform identity is the token. Bridging two personas there
  requires two bot accounts; the schema accommodates this via the
  per-binding `default_persona_id`.

Phase 2 needs no schema changes that aren't backward-compatible with
Phase 1. The reason we add the `personas` table now, even with a
single row, is so the M:N future doesn't require a data migration of
every existing group.

## Why not …

- **Pure env constants, no DB row.** Simpler today, but the moment
  Phase 2 lands we'd need to migrate every group to point at a row
  and every existing `messages.persona_id` would be NULL with no clear
  back-fill. Paying the table cost now is cheaper than the cutover later.
- **Hardcode-only (status quo).** Blocks the two-instances-one-external-chat
  scenario, which is the immediate motivation.
- **Full M:N multi-persona from day one.** No product demand yet; the
  join table + dispatcher logic + UI surface area is sizable. Premature.
- **Rename `chord-tool` fence to be persona-scoped.** It's an internal
  contract between the LLM call and the parser; both ends run inside
  the same persona's turn. No disambiguation benefit, real coordination
  cost.

## Consequences

- New table + migration; back-compat path is "if row missing, seed
  from env." Every existing call site that reads `@chord` literal
  goes through one new resolver function.
- Kernel exports change shape (regex constant → builder fn). Callers
  in `messages.service.ts`, `__test-helpers__/db.ts`, ingest pipelines,
  mock connector, and bot.service all need to thread the aliases. Tests
  that build messages with hardcoded `@chord` strings keep working
  because `'chord'` stays in the default aliases.
- `MASTER_KEY` is not needed for this slice — the persona record
  carries no secrets. (LLM API keys remain in env.)
- A misconfigured persona (empty aliases, unknown tool name in
  `enabled_tools`) breaks bot turns for the whole deployment. Startup
  validates the row and refuses to boot on malformed configuration.
- Future ADR (Phase 2) will spell out the M:N dispatch + per-binding
  default persona + text-alias fan-out rules. This ADR locks in the
  data shape that makes that ADR cheap.

### Pair-command policy (multi-bot chats)

Even with a single persona per instance, an external chat may host
multiple bots — either two app instances each with their own bot, or
a deploy-wide bot plus a BYO bot in the same chat. When the user
types `/<alias> pair <code>`, every bot in the chat receives the
message and runs `consumePairingCode`. Two rules keep that quiet:

1. **`consumePairingCode` only enforces bot identity for BYO
   pairings.** When `pending.bot_user_id IS NULL` (deploy-wide pair),
   any receiving connector is accepted; the binding is stored with
   `bot_user_id = NULL` and future lookups fall back to the
   deploy-wide registry entry. Without this, a deploy-wide bot's
   connector — which always reports its actual `bot_user_id` —
   trips `wrong_bot` against the NULL pending row and the pairing
   silently dies. This was the bug behind a second binding through
   one deploy-wide bot returning `wrong_bot`.
2. **`handlePairCommand` is silent for "not for me" outcomes.**
   `unknown_code` (this bot's DB doesn't have the code) and
   `wrong_bot` (BYO mismatch — this bot wasn't the addressee) both
   stay silent, logged only. The user sees a reply only from the bot
   that actually has something to say (success, expiry,
   channel-already-bound, alias-taken). The same rules cover the
   two-app-instances scenario: each instance's bot quietly ignores
   the other's code.
