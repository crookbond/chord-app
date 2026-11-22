# 0018 — Listening modes (invocation / passive / active)

**Status**: accepted — runtime wired 2026-05-05 (PR-D.2). Active mode still reserved.
**Date**: 2026-05-05

## Context

Today the bot reacts to a message in three cases:

1. The message contains `@Chord` — explicit invocation.
2. The proactive scanner fires on a timer (ADR 0012).
3. A file upload triggers the classifier (PDFs, screenshots).

The product wants a per-user **"always listening"** toggle in
Settings. The natural reading — bot replies to every message in
every group — is wrong on two counts:

- **Cost.** A family group with 50 messages a day across four
  members would generate 50 LLM calls per user per day, most of
  which produce no useful reply.
- **Noise.** Other group members didn't opt into the bot
  reacting to their messages just because *one* member flipped a
  switch in their own settings.

The intent of the toggle is different: the user wants the bot to
**learn from every message they're in**, not to *reply* in every
message. The reply behavior should stay invocation-driven.

## Decision

Three modes, per-user, set in Settings:

| Mode | Reply | Memory / About-Me extraction |
|---|---|---|
| `invocation` (default) | only on `@Chord` | only when the bot replies |
| `passive` | only on `@Chord` | every message the user sends or @-mentions in |
| `active` (premium, future) | reacts to messages it has high-confidence opinions on | every message |

`passive` is what the user means by "always listening." The bot
reads every message the user wrote in any group they're in, runs the
existing memory-extraction pipeline (`memories.service.ts`) and the
about-me curator (future), but **does not produce a chat reply** and
does not consume a tool turn. No other group member sees a difference.

`active` is reserved — Phase 6 territory. Probably involves a
classifier deciding "is this a question I can usefully answer" and
gating LLM calls on a confidence threshold. Out of scope for now.

### Storage

```sql
ALTER TABLE users ADD COLUMN listening_mode TEXT NOT NULL DEFAULT 'invocation';
-- 'invocation' | 'passive' | 'active'
```

### Where the mode is checked

- **Reply path** (`bot.service.ts` `shouldReact`): unchanged for
  `invocation` and `passive`. `active` adds a confidence gate.
- **Memory extraction**: a post-message hook runs whenever the
  sender has `passive` or `active`. The hook is async, off the
  request path, and never blocks message broadcast.
- **About-me curator** (future): same hook surface.

### Per-group override (AI Mode slider)

Chats UI ships an "AI Mode" slider per group (placeholder in PR-A,
real in PR-D). It overrides the per-user mode for that group only:
- If user is `invocation` and group AI Mode is on → `passive` for that group.
- If user is `passive` and group AI Mode is off → `invocation` for that group.

Per-group override stored on `group_members(listening_mode_override TEXT)`.

## Alternatives considered

- **Single boolean "always listening"**, where on means active.
  Rejected — see Context. The cost and noise costs are unacceptable
  and the user's intent is "learn from me," not "reply more."
- **Group-level toggle, not user-level**. Rejected — one user opting
  in shouldn't change behavior for every other member of the group.
- **No persistence; in-memory only**. Rejected — toggle should
  survive sign-out and reinstall.

## Consequences

- New column on `users` and `group_members`. Forward-only migration.
- New `extract_memory_passive` worker that runs against messages from
  `passive`-mode users.
- Bot reply gating logic stays simple: `mode !== 'active'` keeps the
  current `@-mention only` rule.
- Settings UI now needs a three-way control, not a toggle. Probably
  segmented control: "Only when I @Chord" / "Listen passively" /
  "Active (coming soon)".
- The "Active" tier becomes one of the gates we charge for later
  (alongside multi-device sync from ADR 0017).
