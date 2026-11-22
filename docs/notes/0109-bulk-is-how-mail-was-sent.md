# 0109 — Bulk is how mail was sent, not what it is about

**Status**: accepted
**Date**: 2026-08-25
**Relation**: adds a third axis beside [0086](./0086-email-action-axis.md)'s
action, on the same reasoning. Feeds the classifier of
[0066](./0066-in-repo-llm-email-classifier.md) and, once its consumers land, the
tile weighting of [0068](./0068-attention-weighted-email-map.md). Inherits the
header rule worked out in `docs/tasks/Email-bugsandbacklog.md`.

## Context

Reported as a classification question: *"there is an email which says 'Like
getting this newsletter? Subscribe to Bloomberg.com' — clearly a newsletter. One
from Christy Sports — clearly a mass email about rentals. Why are they not
classified as newsletter / coupon / mass?"*

Checking prod, **they are classified, and correctly** — both under
`Newsletters`, both `informational`. The premise was wrong in a way that
mattered: the problem is not detection, it is that being a newsletter has almost
no consequence, and that the one axis available was being asked a question it
cannot answer.

Three findings.

**Bulk-ness is not a subject.** The prompt offered
`"promotions" → "Coupons" or "Newsletters"`, then gave Newsletters six topic
leaves and Coupons none. The model took the easier branch: Coupons held **three
threads in the entire database** against 75 for Newsletters, and retail promos
that landed in Newsletters then had to pick a topic, producing nonsense —
`Your summer picks + up to 50% off` from a ski retailer filed under
**Newsletters › Recipes & food**. The mistake is structural rather than a
wording bug. *Money Stuff* genuinely **is** about finance **and** is a blast.
Forcing one axis to carry both makes every promo pick a wrong topic.

**The two real signals were thrown away.** `List-Unsubscribe` — which Gmail and
Yahoo have required of high-volume senders since Feb 2024 (RFC 8058), so the
large senders do set it — was never fetched: Gmail's metadata format returns
only the headers you name, and the allow-list named eight, none of them this.
`CATEGORY_PROMOTIONS` was fetched and stored, but fed to the model as an
advisory hint that nothing gated on. So bulk detection rested entirely on the
model's read of a subject line.

**A newsletter cost the same attention as a bill.** Nothing keyed off a
classification signal; the only suppression anywhere was a regex over the tile
*title* and four hard-coded root titles in the digest — both hostage to whatever
title the model invented that batch.

## Decision

Carry bulk-ness as its own axis, orthogonal to both the category tree and the
action.

`email_threads.bulk` (integer 0/1, ADR 0038) is derived on **thread recompute**
— the one choke point every provider funnels through — from per-message signals
stored on `email_messages`:

- `List-Unsubscribe` present → bulk. The strong signal.
- else `List-Id` (RFC 2919) present → bulk. Rarer, and only list software writes
  it.
- else `CATEGORY_PROMOTIONS` on the message → bulk. Gmail's own verdict, and
  what covers the small senders who set no header at all.

`Precedence: bulk` is **not** captured. It can only corroborate a decision one of
the three above has already made, so storing it would be storing a field that
changes no outcome.

**A thread is bulk only when every message in it is.** One ordinary message
makes it a conversation, and a conversation is never demoted: the user's own
reply to a newsletter is engagement, and a person writing into a list thread is
a person waiting.

The classifier is then **told** how a thread was sent instead of being asked to
infer it. The `promotions` fork comes out of the prompt, `Coupons` gets real
leaves (Retail | Grocery & dining | Travel | Home & services) so it stops being
a dead end, and a `bulk` field rides each thread in the user payload — present
only when true, since a key repeated across every thread in the batch is paid
for on every pass. Newsletters is redefined as *editorial writing someone
subscribed to*; a retailer selling something is Coupons however
newsletter-shaped it looks.

### The rule every consumer must obey

`List-Unsubscribe` is **a strong positive signal and a weak negative one**.
Present → almost certainly bulk-sent. Absent → tells you very little. Two
consequences shape every gate built on this column:

- **Transactional mass mail carries no unsubscribe header, by design.** Order
  confirmations, shipping notices, receipts and itineraries are exempt from the
  RFC 8058 mandate and arrive from the same retailers on the same
  infrastructure. That is precisely the mail the AI passes *should* mine, so its
  absence must never be read as "not bulk, therefore interesting".
- **Evite, Eventbrite, Meetup, ParentSquare and Remind all set the header.** A
  bulk-alone gate would demote exactly the invitation ADR 0088 fought to keep.

So `bulk` is stored as a **signal, never a verdict**. Nothing demotes, skips or
hides on `bulk` alone: every consumer pairs it with a second condition, and
`action IN (to_do, reply_needed)` overrides it everywhere.

## Consequences

- Migration `047` adds the columns and backfills `bulk = 1` from the
  `CATEGORY_PROMOTIONS` label already stored on every thread, so the column is
  useful on day one without a re-sync. The backfill is deliberately looser than
  the runtime rule — it reads the thread's union of labels rather than requiring
  every message to be bulk — and the next recompute corrects it either way.
- Gmail and IMAP capture the headers; **Outlook does not**. Graph exposes
  `internetMessageHeaders` only as a heavy per-message property outside the
  delta `$select`, so Outlook threads carry `bulk = 0` until that changes. This
  fails in the safe direction: nothing is wrongly demoted, some bulk mail simply
  keeps full weight.
- Nothing user-visible changes yet, on purpose. The distribution wants looking
  at before anything acts on it, and the consumers are a separate change.
- The prompt now states that bulk is not a measure of importance, because the
  model will otherwise read a blast as unimportant — which is the same mistake
  in a different place.

## Alternatives rejected

- **A taxonomy allow-list.** Titles stay free-form. Once weighting keys off
  `bulk` rather than a title regex, an invented title is no longer load-bearing,
  and pinning the vocabulary would fight `buildTreeFromPaths` for no gain.
- **Deriving bulk at write time**, on each provider's insert path. Three
  implementations to keep honest, and it would not survive the classifier's
  snapshot-replace. `recomputeThread` is the one place all three meet.
- **A per-message `is_bulk` column** instead of the raw headers. It would answer
  "is this bulk" and nothing else — the raw `List-Unsubscribe` value names the
  sending platform, which is what makes the distribution worth inspecting before
  Piece 4 acts on it.
- **Reading `bulk` as a verdict** — the tempting simplification, and the one
  that quietly loses a school blast. See the rule above.
