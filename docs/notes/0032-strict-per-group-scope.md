# 0032 — Strict per-group scope for bot reads

**Status**: accepted
**Date**: 2026-05-18
**Supersedes**: [ADR 0020 — Cross-group personal context](./0020-cross-group-personal-context.md) (behaviorally — the user-facing toggle is left in place but no longer affects bot context)
**Refines**: [ADR 0004 — Group-scoped agent](./0004-group-scoped-agent.md), [ADR 0030 — Group-chat calendar scope](./0030-group-calendar-scope.md)

## Context

ADR 0030 closed the *calendar* leak in a group chat by filtering the
triggering user's Google events to a single Chord-target calendar. That
fixed the worst case (work / personal calendar contents in a family
chat) but left several adjacent leaks:

1. **Cross-group personal data block.** When ADR 0020's cross-group
   flag was on, `personalContextBlock` joined `tasks`, `lists`, and
   `saves` across every group the user belonged to and inlined them
   into the system prompt of the current group. Members of group B
   could be answered with data from group A.
2. **`find_events` tool.** The tool joined `events` against
   `group_members WHERE user_id = actor` — i.e. every group the user
   was in. Calendar items the user had created or synced into another
   group were reachable from this one. The ADR 0030 calendar-id filter
   was applied only to the prompt-inlined view, not to this tool.
3. **No post-call safety net.** A future read tool that forgot to scope
   would silently leak across groups; nothing watched the result on the
   way out.

The user-stated invariant is now: *every user-created item is tagged
with the group it was created in; if it's not tagged with the current
group, the bot doesn't see it.* No prompt-side mitigation; no opt-in
override.

## Decision

Strict per-group scope at two layers.

### Pre-filter

The bot's view of group data comes from the group-scoped helpers only:
`listTasks(db, groupId)`, `listLists(db, groupId)`,
`listSaves(db, groupId)`, `listEvents(db, groupId)` (already used by
`groupSnapshotBlock` + `eventsBlock`). The `personalContextBlock`
cross-group fan-out is removed entirely.

`find_events` adds `WHERE events.group_id = ?` to its SQL — the
`group_members` join stays as the membership gate, but the new
predicate keeps the tool from returning events from sibling groups.

### Post-filter

Every `applyToolCall` return value goes through `scrubCrossGroupLeak`:
a deep walk over `result.data` that drops any object carrying a
`groupId` field whose value isn't the call's `groupId`. This is
belt-and-suspenders — if any future tool, service helper, or query
forgets to scope, the leaking entries are still stripped before the
result reaches the LLM (or any caller).

The scrubber is intentionally generic. It doesn't enumerate tools or
entity shapes; it keys on the field name `groupId`, which is the
convention used by every kernel entity that's group-tagged. Items
without a `groupId` field are unaffected — they're either already
user-scoped (e.g. memories filtered by `queryForTurn`) or globally
safe (summaries, counts).

### What this gives up

- ADR 0020's friendly "ask about your stuff from any group" behavior
  is gone. A user in group B asking "what's on my list?" sees only
  the lists tagged with group B. Lists they created in group A are
  not surfaced.
- Items with no `group_id` column at all — currently `important_dates`
  and `people` (owner-scoped) — never appear in **group** context.
  They are inlined in the user's **personal (1:1) chat** via
  `personalProfileBlock`, since there's no one else in the room and
  the data belongs to the asker. Re-introducing them to group context
  would require either tagging them with an origin group or an
  explicit opt-in scope — out of scope for this ADR.
- The `cross_group_personal_context` user setting in
  `routes/me.ts` is left in place to avoid an API break, but it no
  longer influences bot behavior. A follow-up can remove the column,
  the route handlers, and the mobile setting once we're confident
  nothing depends on it.

## Alternatives considered

- **Tag every entity with the originating group + filter by origin
  on read.** Equivalent to what we already do — `tasks.group_id`,
  `lists.group_id`, etc. already carry the originating group, so the
  fix is to *use* that column rather than the user-wide helper. The
  pre-filter is exactly that.
- **Prompt-side instruction ("don't leak across groups").** Same
  reasoning as ADR 0030 — soft instruction, not a boundary.
- **Per-tool scrubbing.** Touching each tool handler is bigger and
  easier to forget on the next tool added. A generic post-filter on
  `groupId` is a structural guarantee with one place to update.
- **Drop ADR 0020 entirely (column + route).** Tempting; deferred so
  this change is a surgical privacy fix, not a settings-surface
  refactor.

## Consequences

- Cross-group "answer from my other group's data" is no longer
  available. If users complain, the right answer is either (a) an
  explicit, audited share rather than a silent global flag, or
  (b) ask them in their personal chat where the data is naturally
  in-scope.
- The privacy boundary is now structural in two places: SQL scoping
  for the in-prompt view + the post-filter for tool results.
- Future read tools don't need to remember the privacy rule as long
  as they put `groupId` on cross-group-shaped result entries — the
  scrubber catches mistakes. Tools that return shapes *without* a
  `groupId` field need to do their own scoping (they already do).

## Implementation

- `server/src/services/bot/context.ts` — `personalContextBlock`
  removed; cross-group flag no longer consulted; new
  `personalProfileBlock` inlines owner-scoped people +
  important_dates only when `isPersonal=true`.
- `server/src/services/bot/executor.ts` — `find_events` scopes to
  `events.group_id = groupId`; `applyToolCall` wraps
  `applyToolCallImpl` in `scrubCrossGroupLeak`.
- `server/src/services/bot/__tests__/cross-group-scope.integration.test.ts`
  — covers (a) `find_events` returning only the calling group's
  events when the user is in two groups, (b) the scrubber dropping
  out-of-group entries from array/object payloads, (c) identity for
  payloads without `groupId` fields.
