# 0115 — A queued message is a draft with a time on it

**Status**: accepted
**Date**: 2026-08-25
**Relation**: builds directly on [ADR 0113](./0113-unsent-mail-is-ours.md);
completes Wave 2 in [`docs/tasks/email-parity-audit.md`](../tasks/email-parity-audit.md).

## Context

Undo send is the last Wave 2 item, and the one I expected to argue against.
Sending goes straight to the provider API, so "undo" means the message must not
have gone yet — which needs a hold, and a hold needs somewhere durable to hold
it.

The tempting version is a timer in the composer: show "Sending… Undo" for eight
seconds, then call the API. No server change, one afternoon.

It is wrong for one reason. **An app killed during the window never sends at
all**, and the sender is never told. They tapped Send. Nothing said otherwise.
That is precisely the failure ADR 0107 named — a thing we did not do, presented
as done — and putting it on the *outbound* path makes it worse than the mailbox
writes that ADR was about.

## Decision

**The hold is server-side, and a queued message is a draft with a time on it.**

`email_drafts` gains `send_after`. That is the whole model, and it earns its
keep three times over:

- **Undo is clearing one timestamp.** Which is also exactly what undo *means*
  to the user: put it back where I was writing it.
- **A failed send does the same thing**, plus a `last_error`. So a message that
  cannot go lands back in Drafts with the reason attached, where the user is
  already looking — rather than vanishing, or retrying forever.
- **The content is already there.** Recipients, body, and attachment *ids*
  (ADR 0111) are the draft's own columns, autosaved before Send was ever
  tapped. An outbox table would have been a second copy of all of it.

A row with `send_after` set is **absent from the Drafts list**: it is on its way
out, not something to pick up and edit, and showing it there would invite
exactly that.

### Attachments resolve at send time, not queue time

A file deleted during the undo window should fail loudly when the message goes,
not send bytes captured from something the user has since removed.

### The row is claimed before the provider is called

Two overlapping ticks — a slow provider on the previous pass — would otherwise
send the same message twice, and **a duplicate email is not something an
apology fixes**. The flush clears `send_after` first, conditionally on it still
being set, and only sends if that update returned a row.

### Failure does not retry

`last_error` is recorded and the message becomes a draft again. ADR 0103 had a
retry loop re-push the same failing event on every pass for two months; the
same loop on an outbound mailbox would mail the same thing five times the
moment a transient error cleared.

### Undo that loses the race says so

Cancelling a message already sent returns **409**, not 404, and the client says
"already sent" — rather than closing the bar and implying it stopped something
it did not.

### The countdown is cosmetic

The deadline lives on the server; the bar renders it. Worth stating in the
component, because a bar that *looks* like it is driving the send invites
someone to make it drive later, which is the design this ADR rejected.

`EMAIL_UNDO_SECONDS = 0` sends immediately and turns the scheduler off, and the
client then offers no Undo button at all rather than one that does nothing.

## Consequences

- A message survives the app being killed mid-window. It goes.
- Undo works from any device, because the state is server-side.
- Sends are delayed by the window. That is the feature, and it is why the
  default is 8s rather than 30.
- The outbox needs its own 2s tick: the ADR 0013 proactive scheduler runs every
  15s, which would make an 8-second window mean anywhere from 8 to 23 seconds.
- One more place a message can be un-sent, which is why `listDrafts` filters
  and the flush claims. Both have tests.

## Alternatives rejected

**A client-side timer.** The one worth naming, because it is the obvious build:
it silently loses messages when the app dies, and the sender has no way to
find out.

**A separate `email_outbox` table.** Clean separation, and a duplicate of every
content column plus a second place a message can be unsent. The draft already
holds all of it.

**Retrying a failed send.** Turns one provider hiccup into several identical
emails.

**Gmail's own undo.** It is a feature of Gmail's client, not of the API. There
is nothing to call.

**A per-user setting.** Better, and it needs a Settings surface this change does
not otherwise need. The env default is the smaller step; the column can follow
if anyone asks for 30 seconds.
