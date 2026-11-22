# 0096 — The precise read tools follow the same scope boundary `search` does

**Status**: accepted
**Date**: 2026-08-22
**Relation**: applies [0004](./0004-group-scoped-agent.md)'s boundary — as
[0059](./0059-unified-search-tool.md) already implements it for `search` — to
`get_list`, `list_tasks` and `search_saves`; the enumeration in
[0093](./0093-ordinal-references-to-enumerated-tasks.md) had to widen with it.

## Context

A user saved a restaurant into a list in a shared group, then asked about it
from their personal 1:1 chat. The bot said it could not find the list. The list
existed, the user was a member of the group, and `search` would have found it.

`search` resolves scope from the group kind: personal 1:1 → every group the
user belongs to; shared group → that group only
([0059](./0059-unified-search-tool.md)). The precise tools did not — they read
the turn's group and nothing else:

| tool | scope before |
|---|---|
| `get_list` | `listLists(db, groupId)` |
| `list_tasks` | `listTasks(db, groupId)` |
| `search_saves` | `listSaves(db, groupId)` |
| `find_events` | already all the user's groups |
| `search` | already cross-group from personal |

`find_events` having the right behaviour is what makes this an inconsistency
rather than a design: the pattern existed and three tools missed it.

What turns the inconsistency into a user-visible failure is the `search` tool
description, which tells the model to **prefer** the precise tools when the
intent is precise ("`get_list` to enumerate ONE named list"). So for the most
common phrasing — "what's on my restaurants list" — the model does the
recommended thing and goes blind.

## Decision

**`get_list`, `list_tasks` and `search_saves` resolve scope the same way
`search` does.** From the personal 1:1 they read every group the user belongs
to via the existing `*ForUser` helpers; in a shared group they read that group
only. One helper, `isPersonalTurn`, and `search` now uses it too rather than
inlining the same query.

The cross-group read is bounded by `group_members`, exactly as in
`searchEverything`. It is never a global scan, so [0032](./0032-strict-per-group-scope.md)
holds unchanged: what widens is which of *the user's own* groups are visible
from their private chat, not whose data is reachable.

### Cross-group rows carry a group NAME, never an id

[0032](./0032-strict-per-group-scope.md)'s scrubber strips group ids from
anything the model sees, so a hit from another group has to name its home or
say nothing — the same resolution [0059](./0059-unified-search-tool.md) reached.
Rows gain `group` only on the cross-group arm; the shared-group shape is
untouched.

### `complete_task` had to widen with `list_tasks`

[0093](./0093-ordinal-references-to-enumerated-tasks.md) resolves "mark 3-4-5-6
done" against the ids `list_tasks` recorded. `complete_task` then looked those
ids up in `listTasks(db, groupId)` and skipped anything it did not find — so a
wider enumeration against a narrower lookup would have made ordinals
**silently** close nothing. Both now use the same scope, and the `taskUpdated`
broadcast goes to the task's own group rather than the turn's, or the group
actually holding the task would never hear about the change.

That coupling is the real cost of this change, and it is the kind that only
shows up as a silent no-op. It is pinned by a test that enumerates from the
personal chat and completes a task living in a shared group.

### `get_list` also answers from saves when no list matches

Scope was only half of why the restaurant was unfindable. It had been filed by
`save_place` — which the tool registry explicitly instructs the model to use
for "save X as a restaurant" — so it was a `saves` row, and the user asked
about their "restaurants list". `get_list` reads lists, found none, and
reported nothing.

The user does not know, and should not have to know, which container the bot
chose when it filed something. "What restaurants have I got?" is a question
about a *kind of thing*, not about a container. So when no list matches,
`get_list` also returns the saves whose title, note or tags contain any token of
the query, and the tool description requires the bot to answer from them:
"You have no Restaurants list, but you have saved Veeray and Rasika." Only an
empty list *and* empty saves means nothing was found.

This is a fallback, not a merge: a real list match still wins outright, and the
saves arm never fires when one exists.

## Consequences

**The personal chat is now a genuine cross-group console.** "What are my
tasks?" there answers for everything the user belongs to. That is what people
mean by the question, and it is the behaviour `search` already had — but it
does mean the personal chat surfaces shared-group content more readily than
before. Nothing new is *reachable*; it is reachable through more tools.

**Reads got wider, writes did not.** `add_list_item` and `create_task` still
write to the turn's group. Asking "what's on my restaurants list" from the
personal chat now finds the list in RDMS, but telling the bot to add to it from
there creates a personal-group list of the same name. That asymmetry is
deliberate for now — making writes follow the read is a scope decision of its
own, and it is the subject of the routing work in
[0097](./0097-email-routing-is-a-choice.md).

**`get_list` can answer a question it was not asked.** The saves fallback
matches on any query token, so "restaurants" surfaces anything tagged
`restaurant` — useful when that is what the user meant, noise when they wanted a
specific list that genuinely does not exist yet. Bounded to 20 rows, and the
`list: null` in the result keeps the bot from claiming a list exists.

**Three more queries on the personal-chat path.** Each tool now does one
`groups` lookup for the kind, plus a `groups` name lookup on the cross-group
arm. Both are indexed point lookups on a path that already runs an LLM call.

## Alternatives considered

**Leave the precise tools alone and lean on `search`.** No code change; the
capability already exists. Rejected: the tool descriptions actively steer the
model away from `search` for precise intents, and rewriting them to steer it
back would trade a correct-but-slow path for a fast-and-wrong one. The user's
framing — a personal query should look at everything — is also just right.

**Make the model pass an explicit scope argument.** Flexible, and the model
sometimes knows better. Rejected for the reason [0059](./0059-unified-search-tool.md)
gave: scope is a security-shaped decision, and "you do not choose" is the only
version of it that cannot be prompted wrong.

**Widen the writes at the same time.** Symmetric, and arguably what a user
expects. Rejected as a separate decision with a much larger blast radius: a
write that picks its own group is exactly the behaviour being reconsidered for
email routing, and it should not arrive as a side effect of a read fix.
