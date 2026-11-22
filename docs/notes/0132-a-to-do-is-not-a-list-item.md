# 0132 — A to-do is not a list item

**Status**: accepted
**Date**: 2026-08-25
**Relation**: closes §3's "mail yields only two suggestion shapes" in
[`docs/tasks/email-parity-audit.md`](../tasks/email-parity-audit.md); connects
the magics extractor to [ADR 0092](./0092-closing-out-stale-todos.md)'s task
lifecycle and [ADR 0095](./0095-tasks-fold-instead-of-multiplying.md)'s dedup.

## Context

The magics extractor emits two shapes: `create_event` and `add_list_item`. So
when an email says *"sign and return the permission slip by Friday"*, the
prompt's own instruction was to file it as
`{"kind":"list","listName":"To-dos","item":"..."}` — a row on a list called
"To-dos".

That is a to-do in name only. A list item has no due date, no status, no
overdue handling, and exactly two exits: tick it, or delete it. Everything the
product knows about obligations lives on **tasks**: ADR 0092 gave them an
archive path and a briefing that orders by `due_at`, ADR 0095 gave them
folding, and the To Do's hub renders them in their own tab.

So mail — which is where most household obligations actually arrive, with
deadlines attached — was the one source that could not produce one.

## Decision

**Add a third suggestion kind: `task`, staged as `create_task`.**

### The boundary is what the thing IS, not where it came from

- **A list is a collection**: things to buy, things to bring. "Cupcakes for
  the bake sale" belongs on a list.
- **A task is an obligation**: return the form, pay the invoice, book the slot,
  reply to someone, renew the passport. It can have a deadline and it has a
  lifecycle.

The prompt says exactly that, with the bake-sale/permission-slip pair as the
worked example, because it is the case that separates them.

### `dueAt` only when the email states one

Most obligations arrive without a deadline, and inventing one is worse than
having none: ADR 0092 archives a dated task seven days past due, so a fabricated
date would quietly delete the to-do. An undated task is never auto-archived,
which is the correct home for "renew the passport".

### Staging dedup matches its list-item twin

`shouldStageTaskProposal` refuses a second pending card for the same title,
the way `shouldStageListItemProposal` already does. It compares **title only,
ignoring the due date**: the same obligation proposed twice with different
deadlines is still one obligation, and two cards asking to create it is the
duplicate problem ADR 0095 solved for the bot showing up in the one place a
person sees them side by side.

Once confirmed, ADR 0095's `createTaskWithDedup` folds anyway — so this guard
is about the *cards*, not the tasks.

### The card says which thing it is

"TO DO" rather than "LIST ITEM", "Add to-do" rather than "Add to list", and a
due date rendered as *"Due Sep 4"* — date only, since a task deadline is a day
and an event is an instant.

## Consequences

- An email with a deadline produces a to-do that the morning briefing will
  surface, that goes overdue visibly, and that can be dropped without being
  marked done (ADR 0092).
- Meeting-time requests move from the "To-dos" list to real tasks. The old list
  path still works; nothing migrates, because a list row someone already ticked
  is not worth rewriting.
- One more shape for the model to choose between, which is a real cost: the
  list/task boundary is a judgement, and it will sometimes get it wrong. The
  card is confirm-gated, so a wrong shape is a tap to dismiss rather than a
  wrong write.

## Alternatives rejected

**Add trip, save, reservation and RSVP-record too**, as the audit row lists.
Each is a judgement call the model would make from a subject line, and each
multiplies the ways a card can be wrong. A reservation with a time *is* an
event, and trips need dates, a destination and a lifecycle of their own — that
is its own ADR, not a line in this one. The same discipline as ADR 0131's
vocabulary: small on purpose.

**Keep filing to-dos as list items and give lists due dates.** That is
rebuilding tasks on the wrong table, and ADR 0092 already decided what an
obligation's lifecycle is.

**Migrate existing "To-dos" list rows into tasks.** They are someone's list,
some are already ticked, and rewriting them would move things the user filed
deliberately.
