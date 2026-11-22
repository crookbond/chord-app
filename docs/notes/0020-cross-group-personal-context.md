# ADR 0020 — Cross-group personal context (opt-in, default ON)

Date: 2026-05-05
Status: superseded by [ADR 0032](./0032-strict-per-group-scope.md) (behaviorally) — UPDATED 2026-06-01

## Update — 2026-06-01

[ADR 0032](./0032-strict-per-group-scope.md) reversed the core of this
decision: the bot no longer fans out across a user's sibling groups, enforcing
strict per-group scope via SQL pre-filter + a `scrubCrossGroupLeak`
post-filter. The user-facing opt-in toggle described below is left in place but
no longer affects bot context. Kept as history.

## Context

ADR 0004 says the agent is **strictly group-scoped**: when @Chord answers a
question in group G, it sees only G's messages and entities. Cross-group
sharing requires explicit per-entity sharing.

In practice users hit this wall constantly. John asks "@Chord, am I free
Saturday afternoon?" in the *family* group. Chord knows the answer — John's
calendar and tasks are right there in the database — but the strict
group-scope cuts it off because the family group as a *group* doesn't have
access to John's personal data.

This is not a security problem. The data is **John's own**. He is the
*requester* of the answer. The decision of whether his data is woven into
Chord's reply is his to make, not the group's.

## Decision

Add a per-user setting `cross_group_personal_context` (default **on**) that
governs whether the bot may use the **triggering user's own** personal data
when answering an @-mention in any group:

- ON: when user U @-mentions Chord in group G, `context.ts` appends a
  `TRIGGERING_USER_PERSONAL_DATA` block to the system prompt containing U's
  open tasks, lists, upcoming events, and important days. Chord uses these
  to compose a natural-language reply (e.g. "yes, you're free after 3pm").
- OFF: behavior is unchanged from ADR 0004.

This **extends** ADR 0004; it does not replace or contradict it. ADR 0004
still governs:
- everyone *else's* data (no other member's personal data crosses into G via
  this path),
- shared entities (still need explicit `share_attachment` or similar).

## Implementation

- Migration `023_cross_group_personal_context` adds
  `users.cross_group_personal_context INTEGER NOT NULL DEFAULT 1`.
- New `MeSettings.crossGroupPersonalContext` field on the `/me/settings`
  response, plus PUT `/me/cross-group-context`.
- `buildLlmContext` reads the flag from `users` for `triggeringUserId`. When
  set and the conversation is a non-personal group, it pulls the four lists
  (`listTasksForUser`, `listListsForUser`, `listEventsForUser`,
  `listImportantDayOccurrences`) and inlines them into the system prompt
  with a discipline preface: "weave only what's needed; don't dump verbatim."
- Settings UI exposes a single switch.

## Tradeoff (the one limit)

The discipline rule ("don't echo private items wholesale into the room") is
**LLM-best-effort**. A determined or careless model could still parrot exact
list contents. If that ever matters, the fix is server-side redaction of the
bot's outgoing message against the personal-data block before broadcasting.
Deferred until we see misbehavior.

## Why default ON

The user-facing benefit is large and the access model is symmetric: the
person whose data is involved is the same person who chose to invoke the
bot. A user who finds it surprising can flip it off in one tap. Default-ON
matches the demo flows in `docs/references/chord_demo_flows.html`.

## What this does NOT do

- Does not give the bot access to *other* users' personal data when they're
  the asker (only the @-mentioning user's own data flows in).
- Does not change `share_attachment` or any other explicit-share path.
- Does not remove the membership gate on `groups/*` API routes.
