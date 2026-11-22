# 0124 — The vacation responder is ours

**Status**: accepted
**Date**: 2026-08-25
**Relation**: last item of Wave 4 in [`docs/tasks/email-parity-audit.md`](../tasks/email-parity-audit.md);
sits inside [ADR 0107](./0107-chord-reads-and-answers-gmail-manages.md)'s split
and follows [ADR 0116](./0116-parity-is-what-a-mailbox-can-do.md)'s parity rule.

## Context

A vacation responder looks like the most provider-native feature on the list,
and each provider does have one:

| Provider | Mechanism | Scope we would need |
|---|---|---|
| Gmail | `users.settings.updateVacation` | `gmail.settings.basic` — **new** |
| Graph | `mailboxSettings.automaticRepliesSetting` | `MailboxSettings.ReadWrite` — **new** |
| IMAP | none | — (Sieve is a different protocol) |

So the native route means asking every Gmail and Outlook user to re-consent to
a **new OAuth scope**, writes three implementations, produces three slightly
different behaviours, and still leaves IMAP with nothing. ADR 0116 says parity
is about what a mailbox can **do**; here the thing it can do is *reply while
you are away*, and the provider's settings page is just one way to arrange
that.

Answering is also squarely on our side of ADR 0107's line. An auto-reply is a
reply.

## Decision

**Chord sends the replies, off the mirror, on every provider.**

One implementation, no new consent, identical on Gmail, Outlook and IMAP. It
runs in `afterSync` beside ADR 0117's notifier, for the same reason: every
provider lands rows in one table, so none of them is special-cased.

### The rules live in the kernel

RFC 3834 is mostly a list of things an auto-responder must **not** answer,
because each one is a way to start a loop or to tell a mailing list about your
holiday. `autoReplySkipReason` refuses: mail from yourself, anything already
automatic, list mail (`Precedence:`, `List-Unsubscribe`, or ADR 0109's derived
`bulk`), no-reply and `MAILER-DAEMON` addresses, mail not addressed to you, and
a sender already told.

It returns the **reason** rather than a bare false, because "why did nobody get
my auto-reply" is otherwise unanswerable.

### One reply per sender per holiday is the loop guard

RFC 3834 wants an `Auto-Submitted` header check, and we do not capture that
header. We could — but ADR 0109 already declined `Precedence: bulk` on the
grounds that a signal which "can only corroborate a decision already made"
changes no outcome, and the same reasoning applies here with more force: the
once-per-sender rule caps any exchange with a non-compliant responder at
**one** message, which is the mail storm the RFC exists to prevent. The kernel
function accepts the header today, so capturing it later is a drop-in.

Turning the responder **on** starts a fresh holiday: `vacation_since` bounds
what gets answered, and the record of who has been told is cleared. Without the
first, switching it on would reply to a backfill window of already-read mail.
Without the second, a second trip would tell nobody.

### An auto-reply is not reading

`sendReply` marks its thread read, because a person replying has read it.
Nobody read this one. Marking it read would hide the thread from the decision
queue and from the ADR 0117 notification — the mail would be silently dealt
with by a machine while the user was away.

So the reply paths gained `markRead`, defaulting to true. That is four call
sites rather than a clever local workaround, and it is the honest shape.

### The sender is claimed before the provider is called

Same rule as ADR 0115's outbox: a send that throws must not be retried into a
second copy on the next tick. A transient failure costs one person their reply,
which is recoverable; sending someone four copies of "I'm away" is not.

`MAX_PER_TICK` is a burst cap, not a budget — switching the responder on
mid-holiday means a full inbox, and answering all of it at once looks like a
mail storm to every receiving server.

## Consequences

- Every mailbox gets a responder, with no new OAuth scope on any of them.
- Replies ride the sync, so they are not instant. With ADR 0118's push
  enabled they are close; without it, they arrive within a poll. A native
  responder would answer in seconds — this is the real cost of the decision.
- **If Chord is not syncing, no reply goes out.** A provider-side responder
  keeps working when we are down; ours does not. Worth stating plainly.
- The reply lands in the thread, so the conversation stays in one place, and
  the user can see on return exactly who was told.
- Someone on holiday with the responder off in Gmail and on in Chord gets one
  reply, not two — but nothing stops both being on, and Chord cannot see the
  provider's setting to warn about it.

## Alternatives rejected

**Use each provider's native responder.** Best fidelity, and it works when
Chord is down. It costs two new OAuth scopes — a consent prompt every existing
user would have to answer — for a feature this size, produces three
implementations with three behaviours, and still leaves IMAP unserved. That
last part is what settled it: a "parity" feature that structurally cannot reach
one of the four mailbox kinds is not parity.

**Native where possible, Chord-side for IMAP.** The worst of both: the scopes,
the three implementations, *and* the fallback, plus a user-visible difference
in behaviour depending on which mailbox they connected.

**Capture `Auto-Submitted` first.** Correct by the letter of RFC 3834, and it
changes no outcome the once-per-sender cap does not already bound. Left as a
drop-in.

**Reply to everything, including lists.** What a naive implementation does, and
it is how an auto-responder gets a domain blocked.
