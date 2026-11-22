# Bot

The bot is the product. Everything else is plumbing. Read this first if you're going to change how Chord behaves.

## Lifecycle of a turn

```
user message inserted
        │
        ▼
decideReaction(msg, group)    ── false → done, bot stays silent
        │ true
        ▼
reactToMessage(db, msg, group)   ── fire-and-forget, returns immediately
        │
        ▼
newId('m') → botMsgId           ── id reserved up-front so the turn's receipt/message can address it
        │
        ▼
providerKeyPresent()?   ── no → emit fallback bot message + bot.done + message; done
        │ yes
        ▼
emit 'bot.start' { messageId: botMsgId }   ── ADR 0022: client shows "👀 received"
        │
        ▼
buildLlmContext(…)              ── system prompt + memory + attachments + recency-windowed history
        │
        ▼
llm.stream(messages)            ── tokens are buffered, NOT broadcast (quiet mode, ADR 0022)
        │
        ├── native-tool providers → runNativeLoop: typed tool_calls → executeTool →
        │     append role:'tool' result → re-stream, up to MAX_ITERATIONS (20)
        └── text-fence fallback   → parseReply(text) → executeTool per fence (single shot)
        │
        ▼
executeTool(db, gid, call)
        │   ├── calls service (tasks, lists, saves, events, …)
        │   └── broadcasts SSE (task.created, list.updated, …)
        │
        ▼
persist bot message (body = cleanBody)
        │
        ├── directive turn → broadcast 'bot.receipt' (silent — no bubble, ADR 0022)
        └── Q&A turn       → broadcast 'message' <Message> + 'bot.done'
```

The turn is stateless — re-run it with the same DB and you get the same result (minus non-determinism from the LLM).

**Two protocols, chosen by `llm.supportsNativeTools` (ADR 0005):**

- **Native function-calling** (OpenAI, Gemini, Anthropic — every provider that reports `supportsNativeTools`) — `buildToolDefs()` generates JSON Schemas from the zod registry; `LlmService.stream` yields typed `tool_call` chunks; `runNativeLoop` in `bot.service.ts` executes each call, appends the result as a `role: 'tool'` message, and re-streams up to `MAX_ITERATIONS` (20). Multi-step reasoning works end-to-end. Each turn is sent only the core tools plus the topic groups its conversation names (`tool-groups.ts`); the model loads the rest with `more_tools`, and a tool it calls by name without being sent it still runs. Every new tool goes in `CORE_TOOLS` or one group. [ADR 0322](../notes/0322-a-chat-turn-is-sent-the-tools-it-needs.md).
- **Text-fence fallback** (mock, and any text-only provider that reports `supportsNativeTools = false`) — single-shot stream, `parseReply` extracts ` ```chord-tool ``` ` blocks post-stream, each call runs once (ADR 0003).

Both paths share `executeTool` + the `bot.tool` SSE broadcast, so the UI renders tool pills identically either way.

## `decideReaction` (`services/bot/bot.service.ts`)

```
personal group  → always react
bot / system msg → never
@Chord mention  → react
otherwise       → stay silent
```

This is where silent-background-tracking would hook in (today: not implemented). For example, detecting `"I'll bring dumplings"` in a Friends group with an open potluck Event and upserting an RSVP *without* replying. See [tasks/](../tasks/) design discussion.

## Context assembly (`services/bot/context.ts`)

`reactToMessage` first calls `selectExcerptsForTurn` (`retrieval.ts`, ADR 0021) to pick up to **12** relevant attachments for this group + their BM25 excerpts. The retrieval query is **conversation-aware**: `recentRetrievalText` builds it from the last few human turns, not just the current message, so a content-free follow-up ("summarize it", "show me") still re-finds a file named a turn earlier. The top 2 ranked docs get their **full extracted text inlined** (≤24k chars each) so content-level asks work even when the query doesn't snippet-match; lower-ranked docs fall back to excerpts. Those rows are passed into `buildLlmContext`.

`buildLlmContext` returns a single **system** message followed by the last 30 chat messages. The system message concatenates, in order:

1. **Chord persona + mode lines** — fixed strings in `buildLlmContext`, with a branch for personal vs shared groups (personal chats are framed as 1:1; shared groups are framed as multi-speaker). Whether Chord *reacts at all* in a shared group is still decided earlier by `decideReaction` (`@Chord` mention gate).

2. **Group roster** — `groupRosterBlock(...)` in `context.ts` lists the group's members and marks the triggering user with `(you)` so the model can resolve *"me/my"* to the sender. A dedicated *triggering-user identity* block was **deliberately removed** — see context.ts (`// Triggering user identity intentionally excluded from the system prompt`).

3. **Memory lines** — `memory.service.queryForTurn` + `memoryBlock(...)` (up to 12 memories; each line is tagged with `[persona]` / `[group]` / `[event]` scope).
   Learning runs after the turn (`extraction.ts`): each NEW fact gets a `memory` card under the reply, or in the sayer's personal chat when there is no visible reply; `correct_memory` / `forget_memory` change a fact in chat; a daily clean-up pass removes repeats and folds duplicates (ADR 0281, `memory-notices.service.ts`, `memory-cleanup.service.ts`).

4. **Attachment summary lines** — `attachmentBlock(...)` from the retrieved attachment rows (`★ filename` for pinned).

5. **Tool prompt** — `NATIVE_TOOL_PROMPT` or `TEXT_FENCE_TOOL_PROMPT` (from `services/bot/tools.ts`, chosen by `useNativeTools`). The text-fence variant spells out the `chord-tool` JSON fence protocol; both expose the full **46-tool** registry with their arg shapes.

Several more blocks are concatenated alongside these (`localTimeBlock`, `surfaceBlock`, `groupSnapshotBlock`, `eventsBlock`, `personalProfileBlock`, an About-Me block, …) — see `buildLlmContext` in `context.ts` for the authoritative, ordered list.

Cross-group attachment fallback is **not** injected into the LLM context by default. When the primary group yields **zero** attachments, `bot.service` may broadcast `bot.share-offer` after the turn (see `maybeOfferCrossGroupShare`).

Then the conversation:

- Up to the last 30 messages, oldest→newest, then **recency-windowed** (ADR 0035): messages older than 3 days are dropped, but the last 20 are always kept so a quiet group still has state.
- Each user message becomes `{ role: 'user', content: '{displayName}: {body}' }` so the model can distinguish speakers.
- Each bot message becomes `{ role: 'assistant', content: body }`.
- A `system` separator (`[N days later]`) is inserted before any message more than 12 hours after the previous one, and the triggering message is prefixed `→ (latest, respond to this)` so the model answers the newest turn, not an older one still in the window.

## Attachment turns — auto-file gating

Document extraction is owned by the deterministic auto-filers, not the bot turn:
`classifyAndAutoFileAttachment` (trips/flights/hotels, runs on any uploaded doc)
and `classifyAndProposeContent` (tasks/events/lists/saves, **images only**). When
the triggering message carries an attachment, `runBotTurn` looks up its
mime type and suppresses the matching tool families (`suppressedAutoFileTools`)
so the bot can't *also* create them — otherwise one upload yields a duplicate
(and a self-conflict on confirm). Trip tools are dropped for any attachment;
content tools additionally for images. The bot can still read/answer about the
file (and `start_form_fill` stays available — it's attachment-driven by design).
The system prompt tells the model the file is auto-filed and, if the user also
gave an instruction it therefore can't act on, to ask them to resend it without
the attachment.

## Tool protocol (text-fence fallback)

This is the fallback path for providers that report `supportsNativeTools = false`
(mock, text-only Ollama/vLLM). Native-tool providers go through `runNativeLoop`
instead (see above); both share `executeTool`.

Format (documented in `TEXT_FENCE_TOOL_PROMPT`):

````markdown
```chord-tool
{ "name": "create_task", "args": { "title": "Book rental car", "remindCue": "3 weeks before trip" } }
```
````

- The model may emit zero or more tool fences, interleaved with prose.
- `parseReply` (in `parser.ts`) runs a non-greedy regex `` /```chord-tool\s*([\s\S]*?)```/g `` across the complete post-stream text.
- Each fence is `JSON.parse`'d, then validated against the tool's zod schema in `tools.ts`. Invalid calls are dropped with a warning.
- Matched fences are stripped from the message body before persistence; the user sees only the natural-language reply.

## Executor (`services/bot/executor.ts`)

One switch statement, one case per tool. Each case:
1. Casts `call.args` to its validated shape.
2. Calls the corresponding service (`createTask`, `addItem`, `createSave`, etc.).
3. Broadcasts the matching SSE event so open mobile resource views update live without a refetch.

Special cases:
- `create_task` accepts `assigneeName` (string); the executor resolves it to `assigneeId` by searching `group_members` joined with `users` on `username`/`display_name` (case-insensitive).
- `add_list_item` uses `findOrCreateListByName` — the bot doesn't need to know whether a list exists yet.
- `record_rsvp` falls back to the most recent event in the group if `eventId` is omitted. When an `eventId` is provided, it must belong to the active group (same for trip-scoped tools).
- `send_briefing` runs the user's real daily briefing on demand, through the same `runDailyScanForUserNow` path the 07:00 scheduler uses — so the on-demand briefing cannot drift from the scheduled one. It **posts** the briefing itself and returns only a confirmation; the model is told not to restate it, because an improvised briefing is indistinguishable from a real one to the reader. Personal 1:1 only, and at most once per turn (the ADR 0005 loop would otherwise buy twenty). [ADR 0099](../notes/0099-asking-for-the-briefing-runs-the-briefing.md).
- `complete_task` resolves **positions**, not just ids and titles. A turn's tool results don't survive into the next turn (`buildConvo` replays prose only), so "mark 3-4-5-6 done" has no referent unless the server keeps one: `list_tasks` returns each row's `n` and records the ordered ids in `services/bot/enumeration.ts`, and `ordinals` resolves against that record — all-or-nothing, and the only way to address more than one task. At most one id/title-resolved task mutation runs per turn (keyed on `turnId`), so a set can't be fanned out into independent guesses. [ADR 0093](../notes/0093-ordinal-references-to-enumerated-tasks.md).
- `update_task` changes an existing task's title / details / due date / reminder / assignee — the tool ADR 0095 noted was missing (reschedules had to masquerade as `create_task`). Same selection rules as `complete_task` (`taskId` / `titleContains` single, `ordinals` for a set) and it **shares** the one-loose-mutation-per-turn budget. Omitted fields are left as-is; `dueAt` / `remindAt` take `null` to clear. Status is not touchable here — done / reopen / drop stay with `complete_task`. Reassignment is single-task only and goes through the same ADR 0026 trust gate as `create_task` (opens a permission request on failure). [ADR 0149](../notes/0149-the-mail-surface-is-bounded-to-coordination.md) sanctioned adding it.
- `suggest_external_action` builds a tappable deep-link card (OpenTable / Google Maps / Google Flights / Expedia / …) and never transacts — Chord answers, the provider books. `enrichExternalActionQuery` (`services/bot/external-actions-enrich.ts`) runs first and fills **blank** fields from the triggering group: `partySize` from the persona roster, a flight `origin` from a `home_airport` fact, and destination / dates / city from the soonest open trip. Never overrides what the model supplied; best-effort (a failure leaves the query as-is). A **named** restaurant links to its Google Maps place page, whose "Reserve a table" button routes to whatever system it actually uses (OpenTable / Resy / SevenRooms / Google); only an unnamed request falls back to an OpenTable search. [ADR 0153](../notes/0153-an-external-action-link-is-family-aware.md).

## Providers

Factory (`services/llm/factory.ts`) picks based on `LLM_PROVIDER`:

| Value | Implementation | Notes |
|---|---|---|
| `openai` (default) | `OpenAICompatService` | Also covers Ollama / vLLM — point `OPENAI_BASE_URL` at their `/v1`. Native tools. |
| `gemini` | `GeminiLlmService` | Uses `@google/generative-ai`; systemInstruction field handles the system role. Native tools. |
| `anthropic` | `AnthropicLlmService` | Claude via the Anthropic SDK. Native tools. |
| `mock` | `MockLlmService` | Regex-matched canned replies with 20 ms-per-word fake streaming. For demos / tests without a real key. Text-fence fallback. |

`providerKeyPresent()` prevents a real LLM call when no API key is configured; instead, we emit a canned "configure a key" bot message. Mock provider is always "available" (`true`).

Beyond the deploy-wide `LLM_PROVIDER`, each user can bring their own key (`getLlmForUser`, per-turn). Configuration examples for every provider — including OpenAI-compatible endpoints (OpenRouter, DeepSeek, Ollama, vLLM) — are in [`docs/ops/byok-providers.md`](../ops/byok-providers.md); key-failure behavior is [ADR 0044](../notes/0044-byok-failure-and-future-billing.md).

## What's deliberately simple right now — and what's still pending

These are *intentional demo boundaries* vs the long-form references — not unknown bugs.

- **Keyword retrieval, not embeddings.** Attachment pick is `selectExcerptsForTurn` (pinned cap + keyword/BM25 scoring + recency tie-break) — [ADR 0006](../notes/0006-keyword-retrieval.md), [ADR 0021](../notes/0021-fts5-attachment-index.md).
- **Group roster instead of an identity block.** The system prompt lists members and marks the sender with `(you)`; a dedicated triggering-user identity block was removed — [ADR 0007](../notes/0007-user-identity-in-turn.md).
- **Explicit document visibility.** Reads are gated by `document_permissions` (no silent cross-group prompt injection). Cross-group help is opt-in via `bot.share-offer` + `POST /api/v1/attachments/:id/share` — [ADR 0004](../notes/0004-group-scoped-agent.md).
- **No memory of its own past decisions.** Each turn reads from the DB fresh. Not planned to change in Phase 4.
- **Silent background extraction disabled.** Today Chord only reacts to `@Chord` in groups (always in personal). The demo flows' potluck silent-RSVP tracking is de-scoped — see D1 in [../tasks/README.md](../tasks/README.md).

## When to change context assembly vs. the prompt

- Need Chord to **know something new** (a calendar, a past decision, a document) → context assembly.
- Need Chord to **behave differently** (be silent, be verbose, ask questions, use a tool differently) → prompt.
- Need Chord to **do something new** (mutate state) → add a tool.
