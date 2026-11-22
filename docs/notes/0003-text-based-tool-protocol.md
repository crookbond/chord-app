# 0003 — Text-based tool protocol, not native function-calling

**Status**: partially superseded by [0005](./0005-iterative-tool-use.md) and [0022 (quiet-mode)](./0022-quiet-mode-bot-replies.md) — UPDATED 2026-06-01. The text-fence protocol remains the documented fallback for providers without native function-calling (mock, Ollama in text-only mode, vLLM). See also [0009](./0009-consensus-before-commit.md): tool execution now flows through propose → confirm, independent of which protocol emitted the call.
**Date**: 2026-04-17

## Update — 2026-06-01

Two halves of this ADR have been superseded by shipped code; the original
decision below is kept as history:

- **Tool-call half** → [0005](./0005-iterative-tool-use.md): OpenAI and Gemini
  now use native function-calling in an iterative loop (`runNativeLoop` in
  `server/src/services/bot/bot.service.ts`, `supportsNativeTools=true`). Text
  fences remain only the mock / text-only fallback path (`parser.ts`).
- **Streaming half** → [0022 (quiet-mode)](./0022-quiet-mode-bot-replies.md):
  the LLM stream is buffered server-side rather than streamed token-by-token
  to the client.

## Context

The bot needs to create DB rows (tasks, list items, saves, events, RSVPs) in response to natural-language messages. Providers offer native function-calling (OpenAI "tools", Gemini "function declarations"), or we can use a text-based protocol in the model's output.

## Decision

Use a **text-based** protocol: the model emits fenced JSON blocks inside its reply:

````
```chord-tool
{ "name": "create_task", "args": { … } }
```
````

After the stream ends we extract fences with a regex, validate each against a zod schema, execute, and strip the fence from the persisted message body.

## Alternatives considered

- **OpenAI native `tools` param.** Cleaner, typed, and the model is trained for it. But: it only works with OpenAI (and its compatible shims — Gemini's shape diverges, Ollama support is incomplete, vLLM requires specific templates). Portability was a constraint.
- **Gemini `functionDeclarations`.** Same problem inverted.
- **XML tags** (`<tool>…</tool>`). Works similarly to JSON fences but is harder for users to read if they see the raw token stream mid-stream (JSON is ugly; XML is uglier).

## Consequences

- **Provider-neutral.** One prompt, same protocol, whether OpenAI, Gemini, Ollama, vLLM, or the mock provider.
- **No iterative tool-use loops today.** A real function-calling setup would let the model request results from one tool, receive them, and make another call. Our protocol is "emit all calls up front, then talk." If we need iterative use (e.g. "look up the event, then RSVP on it"), we'll need a round-tripping loop in `bot.service.ts`. Native function-calling would make that easier.
- **Users might glimpse JSON mid-stream.** Streaming delivers tokens as they arrive, including inside fences. When the final `message` event swaps the message to the parsed body, the flash is brief but visible. Acceptable for now; could be fixed by buffering tokens inside fences at the server before broadcasting.
- **Stripping is regex-based.** A truly malformed fence (e.g. unclosed triple-backticks) will leak. Parser warns but doesn't repair. Mock provider exercises happy paths only.
