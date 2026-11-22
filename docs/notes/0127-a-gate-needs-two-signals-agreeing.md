# 0127 — A gate needs two signals agreeing

**Status**: accepted
**Date**: 2026-08-25
**Relation**: settles the bulk-mail gate left open by
[ADR 0109](./0109-bulk-is-how-mail-was-sent.md) and
[`Email-bugsandbacklog.md`](../tasks/Email-bugsandbacklog.md) backlog §11.
Owner decision recorded in [`email-owner-decisions.md`](../tasks/email-owner-decisions.md).

## Context

ADR 0109 captured `List-Unsubscribe` / `List-Id` / `CATEGORY_PROMOTIONS` into
`email_threads.bulk`, and ADR 0110 had the classifier return a second opinion
into `bulk_inferred`. Both are free per message. Neither did anything: the AI
passes — magics, person extraction, attachment import — ran on every classified
thread, including every newsletter and every retail blast.

Ten questions were written up. Nine of them follow from one: **deny-list or
allow-list?**

## Decision

**Deny-list**: mine everything *except* what looks like a blast, behind
`EMAIL_BULK_GATE`.

The allow-list is much cheaper and drops the wrong mail. Transactional mass
mail — the flight confirmation, the invoice, the appointment reminder — omits
`List-Unsubscribe` by design, so it is not what the header catches; but it is
exactly the mail the extraction passes exist for. An allow-list keyed on "not
bulk" would silently lose whatever the signal mislabels, and the loss is
invisible: nobody notices a suggestion that was never made.

### Skipping requires both signals to agree

This is the load-bearing part. ADR 0109's own governing rule is that
`List-Unsubscribe` is *"a **signal, never a verdict**: nothing demotes on it
alone"*. A gate keyed on the header by itself would contradict the ADR that
produced the header.

So a thread is skipped only when the **header** says bulk **and** the
**classifier** says bulk. Two independent signals agreeing is not "alone" — one
reads how the mail was sent, the other reads what it looks like, and a
disagreement between them is exactly the ambiguous case that should stay mined.

### Three things outrank the gate

- **`action IN ('to_do','reply_needed')`** (ADR 0086). Mail that wants
  something from you is never a blast, whatever its headers say. This is 0109's
  stated rule, applied.
- **A sender in your own `people` rows** (ADR 0076's `people.email` anchor). A
  person you know is never suppressed. One stale row re-opens the firehose for
  that one sender, which is bounded and visible.
- **`Events & invites`**, by category title, on the magics pass. Evite,
  Eventbrite and Meetup are bulk by construction and are precisely the mail ADR
  0088 was worried about losing.

`contact_links` is **not** part of the address-book exemption, and cannot be:
ADR 0065 stores phone hashes there and deliberately never uploads raw contacts,
so it has no way to answer "is this sender someone I know". The exemption is
`people.email` only.

### Stickiness is structural

Backlog §11 q9 asked that a thread not be mined on Tuesday and skipped on
Wednesday. Every input is a stored column already carried forward across the
classifier's snapshot-replace, so the verdict cannot drift between syncs. No
new column, nothing to backfill, nothing to keep in sync.

### The rule exists twice, and is pinned

The passes filter in SQL; the reasoning needs to be testable. `isMinable` and
`minablePredicate` are two expressions of one rule, so they are tested against
one table of all twenty input combinations. Two copies of a predicate is how
ADR 0085's identical-matching promise stopped being true once already.

## Consequences

- The AI passes stop spending on mail nobody asked for, which is most of the
  ~4× cost increase ADR 0110 measured.
- A newsletter the user *wants* goes quiet unless it asks something. That is
  the real cost of this shape, and the mitigation is engagement-based
  promotion, deliberately not in this slice.
- `EMAIL_BULK_GATE` can be turned off in prod without a deploy. That matters
  because a missing suggestion is otherwise indistinguishable from a model that
  declined — the flag is how you tell.
- `email_unsubscribes` (ADR 0122) is now the obvious next input, and a far
  better one: it records senders a user actually rejected rather than senders
  who bought bulk-sending software.

## Alternatives rejected

**Allow-list (mine only non-bulk).** Cheaper, and it loses transactional mail
that carries no header — the highest-value mail we extract from. The loss is
silent.

**Gate on the header alone.** One signal, no classifier dependency, and it
directly contradicts ADR 0109's "nothing demotes on it alone".

**Gate on `Precedence: bulk` as a third signal.** ADR 0109 already declined to
capture it, on the grounds that it can only corroborate a decision already
made. Still true.

**Ship engagement-based promotion in the same slice.** It is what keeps this
from being blunt, and it needs real `email_unsubscribes` data to be anything
but a guess. Ship the gate, watch, then build it.

**Bundle the image work** (`Content-ID` parts, a higher `MIN_IMAGE_BYTES`).
Orthogonal: it is about what a message contains, not who sent it.
