# 0007 — Triggering user identity in bot turn context

**Status**: accepted
**Date**: 2026-04-17
**Covers**: D6

## Context

In a multi-person group, "@Chord what's my Global Entry number?" requires Chord to resolve "my" to the speaker. Today the bot sees conversation turns prefixed with display names (`John: @Chord what's my GE number?`) but that's a convention the LLM may or may not pick up on reliably.

## Decision

Pass a **structured identity block** as part of the system prompt for every bot turn:

```
The user who triggered this turn is:
  display name: John Doe
  username: john
  user id: u_W6OCnU7gYwLI
When they say "my", "me", "I", "mine", resolve to this user.
```

This is separate from the per-message prefixes in the conversation history. Both continue — the prefix helps the model attribute past turns; the structured block disambiguates the current speaker.

Attachment visibility is handled separately via `document_permissions` + `selectAttachmentsForTurn` (see ADR 0004 / 0006) — the identity block is only about resolving *"my"* to a concrete user id.

## Alternatives considered

- **Just keep the name prefix.** Implicit; relies on the model making the right inference. Works most of the time but fails subtly on "my" vs. "your" resolution in edge cases.
- **Per-user side-channel via tool calls.** "When someone says 'my', call `get_triggering_user`." Wasteful (one extra round-trip every turn) and brittle.
- **Multiple system messages.** OpenAI allows them; Gemini does not. Portability argues for one combined system block.

## Consequences

- `buildLlmContext` takes `triggeringUserId`, looks up the user row, and composes the identity block (`services/bot/context.ts`).
- Bot context is sensitive to *who* triggered it — the same message triggered by a different user can produce a different reply (different "my"). This is desirable but a behavioural change; noted in subsystem docs.
- Personal vs shared groups still change *tone* (`isPersonal`), but they do not change how attachments are selected — permissions do.
- The prompt grows by roughly 5 lines. Negligible context cost.
