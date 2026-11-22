# 0329 — An email is read by the model once

**Status**: accepted
**Date**: 2026-11-10
**Amends**: ADR 0180, ADR 0219, ADR 0221, ADR 0205 addendum (prefetch)

## Context

In prod, over 10 days, `email_magics` was the biggest token source: 1,843
model calls, 9.03M prompt tokens, about 4.9k per call. The owner's account
made about two calls per new email.

Two passes read the same email and neither looked at the other's mark:

- The background sweep (`runEmailMagics`) wrote a `magic` mark.
- The read-time pass (ADR 0180) wrote a `read` mark and only checked for a
  `read` mark (`runReadTimeEmailMagicsNow`). Its speculative doors, the
  warm-up after each sync (`preprocessReadTimeMagics`, ADR 0219) and the
  reader's prefetch (`prefetchReadTimeMagics`, ADR 0205 addendum), found
  candidates through `warmUpCandidates`, which also checked only for `read`.

The warm-up runs right after the sweep in the same after-sync step (ADR
0244), so an email the sweep had just read was read again seconds later.
1,258 `magic` marks and 459 `read` marks in those 10 days; 382 emails had
both.

What the read-time pass adds over the sweep is small: the sender facts block
(ADR 0294 `senderContextBlock`) and the advisory it can raise, plus the
"the user opened it" rules (ADR 0184). Both passes already share
`extractAndStage`, the invite read (ADR 0074) and the trip short-circuit
(ADR 0244), and `extractAndStage` stores an advisory whichever pass called it.

## Decision

- **The sweep's one call is also the read-time read.** It passes the same
  `senderContextBlock`, so it can raise and store the advisory
  (`read_advisory_json`) exactly as the read-time pass does.
- **Whoever reads an email first writes both marks** (`markEmailRead`), with
  the same timestamp, so both go stale together when a new message arrives
  (ADR 0315's `markStillCurrent`). The read-time pass writes `magic` only when
  the thread is already sorted: the travel short-circuit keys on the
  category, so an email opened before it was sorted is still read by the
  sweep once sorted.
- **The warm-up and the prefetch skip an email with a current `magic` mark**
  (this mailbox's or another mailbox's copy, bug 12).
- **Opening an email re-serves the stored result when either mark is
  current**, advisory included, instead of asking the model.
- **Unchanged**: opening an email the sweep never read (archived, bulk, old
  and read, Coupons/Newsletters, unsorted) still runs its own read with
  ADR 0180/0184's rules. A new reply still reopens the email once.

## Consequences

- Each sweep call grows by the sender block: about 106 tokens for an
  ordinary sender, about 180 with findings (measured on the block's own
  template). Each saved call is a whole extraction, about 4.9k prompt tokens.
  On the prod numbers: about 1.87M prompt tokens saved per 10 days (382
  second reads), about 0.14M added (1,258 sweep calls), net about 1.7M, or
  roughly a fifth of `email_magics`. The block pays for itself if more than
  about 2% of swept emails would have been read again; it was 30%.
- An email the sweep read gets the SWEEP's rules, not ADR 0184's "the user
  opened it" rules. A discretionary coupon or club schedule the sweep chose
  not to suggest stays without a card when the user opens it. Coupons and
  Newsletters were never swept (ADR 0179), so they still get the open's own
  read.
- Emails swept before this change carry only a `magic` mark from a read with
  no sender block. Opening them re-serves that result, so they get no model
  advisory. The reader's code-level sender warning (ADR 0294) still shows,
  and a dangerous sender is still suppressed in code before any read.

## Rejected

- **Keep two passes, skip the warm-up only.** The open would still pay a
  second read for every swept email a person opens.
- **Make the sweep use the open's rules.** It would stage coupons and
  schedules nobody looked at, which is what ADR 0179 stopped.
- **Re-read legacy `magic`-only emails on open for the advisory.** It keeps
  most of the double spend for the next weeks of mail, for a warning the
  code-level check already gives.
