# 0128 — A bulk action is still one write per thread

**Status**: accepted
**Date**: 2026-08-25
**Relation**: the last buildable mailbox work in
[`docs/tasks/email-parity-audit.md`](../tasks/email-parity-audit.md) §1.4;
bounded by [ADR 0107](./0107-chord-reads-and-answers-gmail-manages.md).

## Context

Three rows sat unbuilt in §1.4: multi-select with bulk actions, swipe actions,
and a long-press context menu on a row. Together they are one thing — **triage**
— and their absence is why the Traditional list is a reader rather than a
mailbox: forty threads, and the only way to deal with them is one at a time
through the thread view.

## Decision

**Selection, swipes, and a batch endpoint — for the two verbs Chord actually
performs.**

### The batch endpoint is not a batch write

`POST /me/email/threads/modify` takes up to 100 ids and **loops** over the same
per-thread path the single-thread route uses. Each thread is still its own
provider call, because that is what modifying a thread on Gmail, Graph or IMAP
costs. The endpoint saves round trips from the client; it does not pretend the
mailbox has a bulk API it does not have.

The cap is 100 for the same reason: this is N provider writes, and a request
that quietly fanned out to a thousand would be a denial-of-service against the
user's own mailbox quota.

### Partial failure is reported, never swallowed

The response is `{ updated, failed }`, and the client says so — *"7 done, 2
could not be changed."* One bad id must not fail the batch, and a batch that
half-worked must not read as a success. That is ADR 0107's rule applied to a
new shape: a write we did not really perform must not be reported as performed.

A thread belonging to someone else lands in `failed`, not in an error: the
batch continues, and the caller learns nothing about whether the id exists.

### The gesture set stops where ADR 0107 draws its line

Swipe left archives, swipe right toggles read. That is the whole set, because
those are the only two mailbox verbs Chord performs — trash, star, snooze and
move are *filing*, which ADR 0107 gave to the provider, and every thread
carries a link out to it.

A gesture for a verb we do not perform would be worse than its absence: it
would look like the mailbox changed.

### The root needed a gesture handler

`Swipeable` requires `GestureHandlerRootView` at the app root, and
`mobile/app/_layout.tsx` did not have one. Without it the swipes bind, render,
and **do nothing on Android** — the feature would look built and be inert,
which is exactly the failure this codebase keeps writing ADRs about. It is
wrapped now.

### Archive is optimistic; the refetch is the correction

An archived row leaves the list immediately, and the refetch that follows puts
it back if the provider refused. The alternative — wait for the round trip —
makes triaging forty threads feel broken. The alternative in the other
direction, drop it and never re-check, is how mail silently goes missing.

## Consequences

- Traditional becomes usable as a mailbox rather than a reader.
- Selection mode suppresses swipes on purpose: a half-swipe and a checkbox tap
  are the same gesture, and letting both live would archive things people were
  trying to select.
- **A test bug surfaced while building this, and it is worth recording**: the
  first fixture created threads with no messages, but every label write runs
  through `recomputeThread`, which *deletes* a thread that has none. The rows
  vanished mid-test, so `rows.every(...)` ran over an empty array and the
  archive test passed having proved nothing. Fixtures now insert a message and
  assert the row count before the predicate.

## Alternatives rejected

**A real bulk write per provider** (Gmail `batchModify`, Graph `$batch`). Fewer
calls, three provider-specific implementations, and a different failure mode
per provider to report honestly. Worth revisiting if quota ever bites.

**Return only a count.** Smaller response, and the client cannot then say
*which* threads did not change — so it would either lie or stay silent.

**Fail the whole batch on one bad id.** Simple contract, and it means one stale
row in a selection of forty loses the user all forty actions.

**Swipe-to-delete.** What every other mail client puts on that gesture, and
Chord does not delete mail (ADR 0107). Putting a delete gesture on a thread we
would not delete is the clearest possible version of the lie this codebase
keeps refusing to tell.
