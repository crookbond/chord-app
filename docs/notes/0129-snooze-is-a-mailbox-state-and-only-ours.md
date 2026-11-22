# 0129 — Snooze is a mailbox state, and only ours

**Status**: accepted
**Date**: 2026-08-25
**Relation**: owner decision recorded in
[`email-owner-decisions.md`](../tasks/email-owner-decisions.md) §3; extends
[ADR 0108](./0108-a-folder-is-a-predicate-not-a-sync.md)'s predicate model and
sits against [ADR 0107](./0107-chord-reads-and-answers-gmail-manages.md)'s line.

## Context

`chord_email.md` §5 excludes snooze from the AI view deliberately. It says
nothing about the Traditional mailbox, which is a complete mail client and in
which "not now" is the most common thing a person wants to say about a message.

Snooze is also the one item on ADR 0107's *filing* list that is not obviously
filing. Trash, star and move are statements about **where mail lives**, which
that ADR gave to the provider. Snooze is a statement about **when you want to
deal with it** — much closer to the to-do surface Chord already owns.

Two shapes were on the table: a snooze that creates a dated to-do, or a real
mailbox state. **The owner chose the mailbox state**, against a recommendation
to defer. This ADR records the choice and its cost.

## Decision

**`email_threads.snoozed_until` — a real state, local to Chord.**

### It is a predicate, like every other folder

ADR 0108's model holds: inbox becomes `is_archived = 0 AND (snoozed_until IS
NULL OR snoozed_until <= now)`, and `snoozed` is the complement. No second
sync, no second source of truth, and the "is it back yet" question is answered
by a comparison rather than by a job that has to run on time.

Timestamps compare as ISO text, which sorts correctly and needs no clock on the
database.

### Two columns, because waking is not the same as touching

`snoozed_at` exists so that a **new message** wakes the thread and an ordinary
label change does not.

This is the part that would have been a bug. `recomputeThread` is the choke
point every provider crosses — which is exactly why the wake belongs there
(ADR 0106/0109's precedent) — but it also runs for a plain mark-read. Clearing
the snooze whenever it runs would mean any touch un-snoozed the thread, and the
feature would look flaky rather than broken. So the wake is conditional:
`snoozed_at < lastMessageAt`, i.e. a message arrived *after* you put it aside.

A message *older* than the snooze does not wake it either — a backfill can
insert old mail into a thread, and that is not new mail. Both cases have tests.

### The cost, stated rather than discovered

**Gmail's own snooze has no API.** So this is local: a thread snoozed in Chord
stays visible in Gmail, and a thread snoozed in Gmail is invisible to us. That
is the two-writers problem ADR 0107 exists to avoid, in the one place we cannot
see the other writer.

The mitigation is honesty, not cleverness: the Snoozed folder says *"Snoozed in
Chord only — your mail app still shows these."* The alternative was to hide the
divergence and let someone discover it when a thread they had dealt with came
back.

### The choices are coarse on purpose

Later today, tomorrow, next week. A date-and-time picker is a bigger UI than
"not now" deserves, and every mail client that offers one buries it behind the
same three presets anyway.

## Consequences

- Traditional gets the verb people reach for most, and it composes with the
  ADR 0128 selection bar: snooze a pile at once.
- A thread can be snoozed and archived independently; `snoozed` excludes
  archived mail so a filed thread does not reappear in two places.
- The index is partial (`WHERE snoozed_until IS NOT NULL`), because almost no
  thread is snoozed and the inbox predicate must stay cheap.
- Chord and Gmail can now disagree about what is in the inbox. Bounded, visible
  in the UI, and the direct consequence of the shape chosen.

## Alternatives rejected

**Snooze as a dated to-do** (the recommendation). ADR 0092 already gives a
to-do an exit and a due date, so nothing new is stored, nothing can drift from
Gmail, and "deal with this Tuesday" is what a to-do *is*. Rejected by the owner
in favour of the mailbox state, which keeps the thread in the mailbox where it
was read.

**Defer entirely.** Cheapest, and it leaves the most-wanted triage verb absent
from a view that is otherwise a complete mailbox.

**Write it through to the provider.** There is no API for Gmail snooze. The
closest approximation — archive now and re-label later — would move mail in
someone's real mailbox on a schedule, which is a much larger promise than the
one being made.

**A single `snoozed_until` column with an unconditional wake.** Simpler, and
any label change would wake the thread.
