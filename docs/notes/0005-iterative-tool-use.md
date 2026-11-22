# 0005 — Iterative tool use via native function-calling (XML fallback)

**Status**: accepted — shipped fully (OpenAI 2026-04-18, Gemini 2026-05-01)
**Date**: 2026-04-17
**Covers**: D4
**Relation**: supersedes [0003](./0003-text-based-tool-protocol.md) for the OpenAI and Gemini paths. The text-fence protocol from 0003 remains as the fallback for providers that don't expose native tool-calling — today only the mock provider. See also [0009](./0009-consensus-before-commit.md): write-side tools dispatched by this loop default to propose-mode; read-side tools are unaffected.

## Context

ADR 0003 committed to a text-based JSON-fence protocol for tool calls. It's portable but caps sophistication: we cannot express "the bot calls a tool, reads the result, and decides what to say next."

D4 (in `tasks/README.md`) accepted that iterative tool-use is required — flows like "look up the Miami trip saves, then answer which restaurants are already saved" need a round-trip.

## Decision

**Two-protocol strategy**, chosen per provider at runtime:

1. **OpenAI-compatible + Gemini** → use the provider's native function-calling.
   - OpenAI: `tools: [...]` + `tool_choice: 'auto'`, model responds with `tool_calls`, we append `role: 'tool'` messages with results and re-call.
   - Gemini: `functionDeclarations` + `parts` with `functionCall` / `functionResponse`.
2. **Mock + unsupported (Ollama without tool-aware templates, vLLM in text-only mode)** → keep the ADR 0003 text-fence protocol.

Bot loop (per turn):

```
append_user_context()
loop up to MAX_ITERATIONS (e.g., 6):
    stream completion
    if model produced tool_calls:
        execute each tool
        append tool results as tool-role messages
        continue
    else:
        break
persist + broadcast the final assistant message
```

Both paths share a **tool registry** keyed by name. Today's write-side tools stay; read-side tools (`lookup_contact`, `search_saves`, `get_group_members`, `get_task_status`) get added so the bot has something to read in between calls.

## Alternatives considered

- **Keep the text-fence protocol only, add a loop on top of it.** Possible — the model would emit a fence, we'd execute, inject a "tool-result" message with role=user, loop. Works but: (a) the "tool result as user message" hack confuses the model about turn ownership, (b) doesn't leverage the native training for function calling on modern providers.
- **XML-agent pattern from `webapp-start`.** Uses XML tags and a parser to drive the loop. Same architectural shape as what we're proposing; XML tags instead of provider tools. We pick native where available because fine-tuned models do noticeably better at structured tool calls in their native format.
- **LangChain / provider SDK agents.** Too heavy for our scope and introduces a third-party abstraction over the thing we want to understand clearly.

## Consequences

- `LlmService` interface grows a streaming-tool-call abstraction. Shape roughly:
  ```ts
  interface LlmService {
    stream(messages, { tools? }): AsyncIterable<
      | { type: 'text'; delta: string }
      | { type: 'tool_call'; id: string; name: string; args: unknown }
      | { type: 'done'; reason: 'stop' | 'tool_calls' }
    >;
  }
  ```
- Tool registry gains read-side entries: `lookup_contact`, `search_saves`, `list_tasks`, `get_event_status`. They return structured JSON that gets appended to the transcript as a tool-result message.
- Bot turn logic moves to a loop in `bot.service.ts` with a max iteration guard.
- SSE: `bot.token` continues for visible tokens. Tool calls between iterations emit a new `bot.tool` event (`{ messageId, name, args, result }`) so the UI can optionally surface "Chord is looking up…" affordances.
- Mock provider needs to emit structured tool-call chunks too (not just text). Easy — regex match, then fake a `tool_call` chunk.
- Deprecate (but don't remove) the text-fence protocol. Keep it as the documented fallback. Update ADR 0003 status when this lands.
