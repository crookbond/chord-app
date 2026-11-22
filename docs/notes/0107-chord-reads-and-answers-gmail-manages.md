# 0107 — Chord reads and answers; the provider manages

**Status**: accepted
**Date**: 2026-08-24
**Relation**: settles the fork left open by
[`docs/tasks/email-parity-audit.md`](../tasks/email-parity-audit.md); narrows the
"complete mailbox" promise in [`chord_email.md`](../tasks/chord_email.md) §5;
scopes the three mirror bugs the audit found.

## Context

The mail surface was being held to a parity standard — *it should do everything
any other mail app can* — and an audit against that standard found ~35 gaps.
Sized honestly, closing them is most of a year: compose, forward, drafts,
attachments on send, trash, star, flag, snooze, folder browsing, arbitrary
labels, bulk selection, swipe actions, server-side search, real-time push.

That work competes with Gmail. Gmail is free, excellent, and already installed on
the same phone. Winning it back buys us a user who does their filing in our app
instead of theirs — which is not a thing anyone has asked for, and not what makes
Chord worth having.

It also costs more than the build. Every management verb we implement is a second
writer against a mailbox the provider also writes, and the audit found we are
already losing that fight in three places:

- IMAP archive never reaches the server — `applyImapThreadModify` puts only
  `setSeen` on the wire and routes the INBOX label change to the local mirror.
- Outlook un-archive is local-only — `archive === true` moves the message,
  `archive === false` moves nothing.
- `addLabelIds` / `removeLabelIds` are accepted by the route and **silently
  dropped** for Outlook and IMAP (`accounts.service.ts`).

Three divergences from four providers, in the small slice of management we
already shipped. The rate is not going to improve as the slice grows.

Meanwhile the half that *is* differentiated needs none of it. Classification,
magics, tile facts, invite reconciliation, RSVP, the briefing, search across
everything — none of these want a trash verb. They want context, and the context
is what we have that Gmail does not: the family, the calendar, the prior
correspondence.

## Decision

**Chord reads mail and answers it. The provider manages it.**

Two verb sets, one line between them:

- **Answering — ours.** Read, thread view, reply, reply-all, RSVP, forward,
  compose, search, mark read/unread. These are where our context makes the answer
  better than the one Gmail would help you write.
- **Managing — theirs.** Archive, trash, delete, star, flag, snooze, move,
  arbitrary labels, folders, filters. One tap out to the provider, per thread.

The audit's Wave 2 (outbound) and Wave 3 (finding things) stay. Wave 1's
mailbox verbs — trash, star, snooze, bulk triage — come off the roadmap.

**The mirror stays complete.** This is not a decision to sync less. Layer 0 keeps
mirroring everything, because durability, provenance and being the fallback when
the AI is wrong all depend on it, and because search over mail we cannot see is
worthless. Reading is unrestricted; only *writing* is narrowed.

**The three bugs get fixed, not deleted.** The tempting move is to delete archive
and the label pass-through, since they are management and management is leaving.
Rejected: archive is the one management verb that is load-bearing for
*answering* — ADR 0073's convergence, the decision queue's "handled" state and
`markSourceThreadsRead` all sit on it, and mail archived in Chord already
disappears from every listing. A verb the product depends on must be correct.
So archive becomes real on IMAP and symmetric on Outlook, and labels stop being
silently dropped: a provider that cannot apply one now says so instead of
returning success.

That is the general rule this ADR sets, beyond the verb list: **a mailbox write
we do not really perform must not report that we performed it.** Silence is the
bug, not the missing capability.

## Consequences

- ~20 of the audit's 35 must-builds are never built. The roadmap shortens to
  outbound, search, and the AI layer.
- Every thread needs an out — a deep link to the message in its provider, so
  "archive this" has a one-tap answer rather than a missing button.
- We inherit a support answer: *"filing lives in Gmail."* It has to be stated in
  the product, not just true in the code, or it reads as an unfinished app.
- The Traditional view's promise in §5 narrows from *the complete mailbox* to
  *every message, readable and answerable*. Folder **browsing** (Sent, Archive,
  Trash, labels) stays in scope under Wave 3 — reading what is in a folder is
  reading, and archived mail being unfindable is a real gap. What leaves is
  *moving* things between them.
- The falsification test is unchanged and now sharper: if users still open Gmail
  daily *to read*, we failed. If they open it occasionally to file, that is the
  design working.

## Rejected

- **Full parity.** A year against a free incumbent, to win filing, while the
  differentiated half waits.
- **Delete archive along with the rest of management.** It is depended on by
  convergence, read-state and the decision queue; removing it would break
  ADR 0073 to save three days.
- **Keep the silent drops.** The cheapest option and the worst: it is the same
  failure as ADR 0102 — reporting a success the system did not achieve.
- **A read-only mirror with no writes at all.** Mark-read has to be real, or the
  decision queue and the user's own mailbox disagree about what has been dealt
  with — which is the exact failure `Email-bugsandbacklog.md` bug 9 exists to
  prevent.
