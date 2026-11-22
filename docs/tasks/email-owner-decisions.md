# Three decisions the email work was waiting on

**Date**: 2026-08-25
**Status**: **decided 2026-08-25** — all three answered by the owner
**Relation**: Waves 1–5 of [`email-parity-audit.md`](./email-parity-audit.md)
are complete (ADRs 0107–0126). These were the three questions whose answer
depended on what the product should be rather than on what the code could do.

| Decision | Call | Against my recommendation? |
|---|---|---|
| Bulk-mail gate | **Deny-list, behind `EMAIL_BULK_GATE`** | no |
| Default install | **All four flags ON** | yes — I recommended reader + classifier only |
| Snooze | **Build it as a mailbox state** | yes — I recommended deferring |

Each section below is kept as it was written *before* the call, so the reasoning
that was weighed stays readable, with the decision recorded at the end of it.

**Two things were never owner calls and are simply unbuilt engineering**: bulk
triage in Traditional (multi-select, swipe actions, a long-press row menu) and
send-as / alias. The first is now scheduled; the second is not.

---

## 1. The bulk-mail gate

**The decision:** should the AI passes (magics, person extraction, attachment
import) stop running on mass mail — and if so, on what signal?

**What is already true.** ADR 0109 captures `List-Unsubscribe` / `List-Id` /
`CATEGORY_PROMOTIONS` and derives `email_threads.bulk`, ADR 0110 has the
classifier return `bulk_inferred` as a second opinion, and as of ADR 0122
`email_unsubscribes` records which senders a user actually asked to stop. The
signals exist and cost nothing per message. Nothing acts on them as a gate.

The governing constraint, inherited from ADR 0109: `List-Unsubscribe` is a
**strong positive and a weak negative**. Transactional mass mail omits it by
design, and Evite / Eventbrite / ParentSquare all set it — so the header can
never be a verdict on its own, and `action IN (to_do, reply_needed)` overrides
it everywhere.

**The one question the other nine follow from** (backlog §11 q6): **deny-list
or allow-list?** Extract on everything except what is flagged — safer recall,
most of the cost stays — or extract only on non-bulk, which is much cheaper and
silently drops whatever the signal mislabels. The transactional carve-out cuts
toward deny-list: the highest-value mail (the flight confirmation, the invoice)
carries no header.

The remaining nine are real but downstream: whether an address-book hit exempts
a thread outright, per-pass thresholds, what becomes of `NOREPLY_RE`, whether
engagement-based promotion ships in the same slice, stickiness across syncs,
and whether it lands behind `EMAIL_BULK_GATE`.

**Cost of not deciding:** roughly 4× on the AI passes versus a gated version
(ADR 0110 measured ~$0.78 → ~$2.01 per user per month for the deep-read
change). Not urgent at current volume; it compounds with users.

**Recommendation:** deny-list, gated behind `EMAIL_BULK_GATE`, shipped without
engagement-based promotion, and revisit once there is a month of
`email_unsubscribes` data — which is a far better signal about what a user
wants than any header.

> **DECIDED: deny-list, behind `EMAIL_BULK_GATE`.** Building as ADR 0127. The
> gate requires the header signal and the classifier's opinion to **agree**,
> because ADR 0109's rule is that nothing demotes on the header alone; the
> ADR 0086 action axis overrides it everywhere, and an address-book sender is
> exempt outright.

---

## 2. What the default install looks like

**The decision:** four flags ship **off**, so a fresh install has no email
feature at all:

| Flag | Default | What it gates |
|---|---|---|
| `GMAIL_ENABLED` | `false` | the entire email layer |
| `EMAIL_CLASSIFIER` | `''` | the category tree |
| `EMAIL_MAGICS_ENABLED` | `false` | suggestions from mail |
| `EMAIL_PERSONS_ENABLED` | `false` | people/facts from mail |

(Two more sit alongside them: `PUSH_ENABLED` and `MAIL_PUSH_ENABLED`, the
latter deliberately off because ADR 0118 is unverified end-to-end without a
public URL and provider setup.)

**Why it matters now.** Every wave of this work shipped behind those defaults.
The mail surface is complete and nobody who installs Chord sees any of it. That
is the correct posture while it is unfinished, and it stopped being the
question "is it ready" some time ago.

**The real question is not on/off, it is *which*.** These four are not one
switch: `GMAIL_ENABLED` is *read my mail*, and the other three are *reason
about my mail*. Turning on the reader alone is a defensible default; turning on
the AI passes by default is a different promise, and it is the one that costs
money per user and interacts with decision 1.

**Recommendation:** `GMAIL_ENABLED=true` and `EMAIL_CLASSIFIER=llm` on by
default; magics and persons stay opt-in until the bulk gate lands. Leave
`MAIL_PUSH_ENABLED` off until someone can verify it against a real Pub/Sub
topic — that one is not a product call, it is an unverified feature.

> **DECIDED: all four ON**, which is more than I recommended. The consequence
> to hold in view: per-user AI cost is real from the first sync, bounded by
> ADR 0079's entitlement gate (an unentitled user skips the AI passes) and by
> the ADR 0127 bulk gate landing alongside it. `MAIL_PUSH_ENABLED` stays off —
> that was never a product call, it is an unverified feature.

---

## 3. Does Traditional owe snooze?

**The decision:** the AI view deliberately has no snooze (`chord_email.md` §5,
alongside unread badges and per-message triage gestures). Traditional is a
complete mailbox view, and the exclusion says nothing about it.

**What is already true.** There are zero occurrences of `snooze` in `server/`.
ADR 0107 put filing on the provider's side — trash, star, move, folders — and
snooze is the one item on that list that is *not* obviously filing: it is a
statement about **when you want to deal with something**, which is much closer
to the to-do surface Chord already owns than to a mailbox folder.

That cuts both ways:

- **It is ours.** Chord has tasks with `remind_at`, a briefing that reads them,
  and a decision queue. "Snooze until Tuesday" is a to-do with a date, and we
  would be building on something that exists.
- **It is theirs.** Gmail has snooze; using ours means a thread that reappears
  in Chord and not in Gmail, which is the two-writers problem ADR 0107 exists
  to avoid — in the one place where the provider's version is invisible to us
  (there is no API for Gmail snooze).

**Cost either way is small.** A Chord-side snooze is a `snoozed_until` column
and one predicate in the folder rules — a day, maybe two. The reason it has not
been built is that nobody has said whether it should exist, not that it is
hard.

**Recommendation:** defer. ADR 0092 already gives a to-do an exit and a due
date, and the honest version of "deal with this Tuesday" today is *make it a
to-do*, which one tap on a suggestion already does. If snooze keeps coming up
after real use, build it — but build it as a to-do with a date, not as a second
mailbox state.

> **DECIDED: build it as a mailbox state**, against that recommendation.
> **Shipped 2026-08-25** as ADR 0129, with the cost stated there rather
> than discovered
> later: Gmail's own snooze has no API, so a thread snoozed in Chord stays
> visible in Gmail — the two-writers problem ADR 0107 exists to avoid, in the
> one place we cannot see the other writer.

---

## What is *not* on this list

Every other MUST BUILD row in the audit is built, deliberately deferred with a
written reason, or belongs to the AI roadmap in `chord_email.md` §15 (Stage 3b
reconcile-to-delta, 3c tier policy, 4 signals, 5 suggestion), which this
document does not re-sequence — except **send-as / alias**, which is buildable
and simply unbuilt.

Mark-as-spam, permanent delete and block-sender were re-verdicted to
**DELIBERATE (ADR 0107)**: each is managing a mailbox, which that ADR gave to
the provider, and every thread links out to it. That applies an existing
decision rather than making a new one.

Three items were already DELIBERATE and stay that way: trash/delete, star/flag,
and move-to-folder — all filing, all ADR 0107.
