# 0095 — A restated to-do folds into the one that already exists

**Status**: accepted
**Date**: 2026-08-22
**Relation**: the creation half of [0092](./0092-closing-out-stale-todos.md)'s
retirement problem; applies to tasks the rule
[0094](./0094-symmetric-list-name-resolution.md) applies to list names, and the
one `saves` and `list_items` already had.

## Context

To-dos multiplied. The daily briefing read back a pile that grew every week,
most of it the same handful of intentions in slightly different words.

The cause was not email. Email magics only ever emit `create_event` and
`add_list_item` — never a task — and both are deduped at staging plus swept by
`consolidateDuplicate*Proposals`, on threads mined once ever
([0076](./0076-email-derived-people-and-family-facts.md) marks). It was not
proposals either; those expire after 72h.

It was that `create_task` had **no dedup at all**. `createSaveWithDedup` exists,
`addItem` compares normalized text, and `tasks` just inserted. Every restatement
of the same intention was a new row.

Two things amplify it into a weekly pile rather than an occasional twin:

- The [0051](./0051-post-invocation-followup-window.md) follow-up window means
  the bot acts on the group's next several messages with no re-mention, so
  ordinary chatter after one question can mint tasks.
- The briefing surfaces open tasks daily, which prompts exactly the restatement
  that mints more. The pile fed itself.

## Decision

**`createTaskWithDedup` — an open task with the same title and assignee in the
same group absorbs the call instead of spawning a sibling.**

### The match is narrow on purpose

Same group, same assignee, `normalizeText`-equal title, and status `open` or
`active` with `archived_at IS NULL`.

**Done and archived tasks are not duplicates.** Saying "book dentist" a month
after finishing one means a new appointment, and folding onto the completed row
would both lose the new intention and corrupt the completion signal
[0092](./0092-closing-out-stale-todos.md) protects. Same reasoning for
assignee: "call the vet" for John and for Alice are two tasks.

### A duplicate is folded, not dropped

There is no `update_task` tool. So "actually make that Friday" arrives as
another `create_task` with the same title and a new `dueAt`. Dropping it as a
duplicate would silently lose the reschedule — a quieter failure than the
multiplication we are fixing, and harder to notice.

So the fold **updates**: a field the caller supplies that the existing task
lacks is filled in, and a *different* due/remind time replaces the old one.
Fields the caller omits are never cleared, so a bare restatement can't wipe a
due date someone set earlier.

`created` and `updated` come back with the result, the tool description
requires the bot to say which happened, and SSE fires only when something
actually changed — an exact restatement is not a state change.

### Why not extend it to the REST route

`POST /groups/:id/tasks` still creates unconditionally. A person typing the same
title twice in the app is looking at their list while they do it; the LLM firing
`create_task` twice is not. The failure being fixed is specific to the bot path,
and silently refusing a user's explicit tap is a worse bug than the one it would
prevent.

## Consequences

**Two genuinely distinct tasks with identical titles now collapse.** "Call the
vet" meaning the cat and "call the vet" meaning the dog become one row unless
the assignee or wording differs. Judged acceptable: the user can see the fold
happened (the bot says so) and can reword. The reverse error — silently
multiplying — is the one that was actually hurting.

**A reschedule is now indistinguishable from a correction.** Both replace the
due date, and there is no history of what it was. Acceptable while there is no
`update_task`; if one is ever added, that is where an audit trail belongs.

**Dedup reads every open task in the group.** One indexed query per
`create_task`, filtered in memory because `normalizeText` is not a SQL
expression. The set is bounded by [0092](./0092-closing-out-stale-todos.md)'s
archiving; if it ever isn't, this wants a normalized-title column and an index.

## Alternatives considered

**A unique index on `(group_id, lower(title), assignee_id)` where open.**
Enforces at the database, no read needed. Rejected: it turns the second
statement into a 500 mid-turn, and it cannot express the fold-and-update
behaviour a reschedule needs.

**Fuzzy title matching (edit distance / embeddings).** Catches "book the
dentist" vs "book dentist". Rejected as premature and risky in the same
direction as ADR 0094's stemmer: the observed multiplication is exact
restatement, and a fuzzy matcher that folds two real tasks loses data with no
signal to the user.

**Let the model check `list_tasks` first and decide.** No server change, and the
model can see the existing list. Rejected — this is exactly the class of
judgement [0093](./0093-ordinal-references-to-enumerated-tasks.md) found the
model gets wrong under pressure, and the failure is silent. A deterministic
rule the tool description explains is more reliable than an instruction to
remember to look.

**Auto-archive aggressively instead.** [0092](./0092-closing-out-stale-todos.md)
already retires dated work 7 days past due. Rejected as the whole answer:
retirement bounds the pile, it does not stop three rows appearing for one
intention, and undated tasks are deliberately never auto-archived.
