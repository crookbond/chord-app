# 0117 — New mail can reach the phone

**Status**: accepted
**Date**: 2026-08-25
**Relation**: extends [ADR 0054](./0054-expo-push-notifications.md) past chat;
uses [ADR 0109](./0109-bulk-is-how-mail-was-sent.md)'s bulk signal; the first
half of Wave 5 in [`docs/tasks/email-parity-audit.md`](../tasks/email-parity-audit.md),
and provider-agnostic by construction per [ADR 0116](./0116-parity-is-what-a-mailbox-can-do.md).

## Context

Mail arrived and nothing told you. The audit filed this under "freshness" next
to Gmail `users.watch`, Graph subscriptions and IMAP IDLE — but those are about
*latency*, and this is about the notification not existing at all.

One line explains it. The push publisher hooks every `sseHub.broadcast` and
then:

```ts
if (event !== SSE.message) return;
```

`email.synced` is not `SSE.message`, so email has never pushed, on any
provider, regardless of how fast the sync noticed.

Doing this first is deliberate: it needs no public webhook, no Pub/Sub topic,
no IDLE connection management, and it works identically on all four mailbox
kinds. Real push (5b) makes it *sooner*; this makes it *happen*.

## Decision

**Notify from the mirror, not from the sync.**

The pass runs in `afterSync` and asks the database what is new, rather than
reading a sync's return value. That is what makes it provider-agnostic:
Gmail, Outlook and IMAP all land rows in the same table, so all three notify
identically with none of them special-cased. It also sidesteps a real trap —
`EmailSyncResult.inserted` counts *upserts*, which includes re-writing a
message that already existed, so notifying on it would announce mail that
arrived last week.

### The high-water mark

`users.email_notified_at` is the newest message already announced. Without it
the options are notifying off sync counters (wrong, above) or re-announcing the
same thread every tick (worse).

Three rules around it, each earning its place:

- **The first pass adopts the mark and stays silent.** A NULL mark means a
  mailbox that was just connected; announcing its backfill window would fire a
  push per message, which is how people learn to turn notifications off.
- **The mark moves even when nobody was notified** — pushes off, quiet hours,
  no device registered. Otherwise a user who enables notifications gets a
  backlog fired at them for mail they read days ago.
- **One push per pass, not per message.** A sync that pulls twenty messages
  must not buzz twenty times. One thread is named; several become a count with
  the newest sender, because a list of five names neither fits nor helps.

### What does not notify

Read, archived, and **bulk** mail. The last is ADR 0109's signal used for the
thing it is most useful for: a push per newsletter is indistinguishable from
spam to the person holding the phone.

### Its own toggle

`notify_email`, not a reuse of `notify_messages`. Wanting chat on your phone
and mail not (or the reverse) is an ordinary preference, and folding them would
make one switch silently govern two unrelated things. It respects quiet hours
for the obvious reason: mail is the category most likely to arrive at 3am.

### One eligibility rule, not two

`eligibleTokens` comes out of the group path so both callers share it. Quiet
hours is exactly the rule that would drift if a second caller reimplemented it,
and the drift would be invisible until 3am. Group membership and the per-group
mute stay on the group path, since email has neither.

### Above the entitlement gate

Same argument as ADR 0110's body backfill: being told your own mail arrived is
not the paid layer. The gate exists to stop the AI passes, and this is not one.

## Consequences

- New mail notifies on every provider, at the sync's cadence.
- The tap target differs by count: one thread opens the thread, several open
  the Email tab, because there is no one thread to open.
- A failed push is logged and swallowed — it must not fail the sync that
  produced it.
- 5b (watch / subscriptions / IDLE) now only has to make this *sooner*, which
  is a latency change rather than a feature.

## Alternatives rejected

**Pushing on the `email.synced` SSE event.** The one-line fix, and it fires on
every sync including the ones that changed nothing, with a payload of counts
that cannot tell new mail from an upsert.

**Enriching `EmailSyncResult` with the new threads.** Would work, and puts
notification concerns into a type the client uses for a progress spinner —
and still leaves every provider's sync responsible for populating it correctly.

**Reusing `notify_messages`.** One less column, and it makes turning off chat
notifications silently stop mail ones.

**Notifying per message.** Truthful and unusable.

**Waiting for real push before shipping any of it.** Conflates "the
notification is late" with "there is no notification", and the second is the
one users actually feel.
