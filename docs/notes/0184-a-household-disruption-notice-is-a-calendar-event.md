# 0184 — Opening the email is the consent 0179's gate was approximating

**Status**: accepted — implemented (uncommitted, worktree `email-disruption-notice-adr`)
**Date**: 2026-09-17

## Context

ADR 0179 fixed real over-triggering: a coupon, a sale, or a venue's
unbooked schedule of events was showing up in email magics as a
`create_task` or `create_event`, even though nobody was waiting on the
recipient and ignoring it cost nothing. The fix, in `EXTRACT_SYSTEM`
([`magics.service.ts:166`](../../server/src/services/email/magics.service.ts)):

> Only emit a task or event when the recipient is ON THE HOOK: a specific
> person is waiting on them, they have already committed (a booking, a
> registration, a ticket, a payment owed), or a stated deadline has a real
> consequence. A coupon or sale they MAY use, and a venue's or club's
> schedule of events they have not booked, are discretionary — emit "none"
> even though there is a date.

Verified live in prod (`ownertest@gmail.com`, thread `emt_-uHBAWX7lev2`): an
email titled "Building Water Shut Off - Monday, September 21st, 2026" from
the co-op's property management ("Notice to Shareholders and Residents")
was extracted twice — once by the background magics sweep, once by the
ADR 0180 read-time pass when the thread was opened — and both times
resolved to `{"kind":"none"}`. No bug: the model applied 0179's rule
correctly, and the notice does have 0179's shape (a broadcast, no RSVP, no
personal commitment). It just doesn't have 0179's stakes: missing "$4 off,
redeem by Sep 16" costs a discount; missing "water will be off 10am–2pm,
leave your faucets closed" costs a flood, at the recipient's own residence,
regardless of anything they do.

A first pass at this proposal tried to name that stakes difference
directly — a three-signal "household disruption notice" test (operational
sender + stated interruption + one fixed window) carved out of 0179's
gate. Workable, but heavier than it needs to be: it asks the model to
classify sender relationship and notice type on every email, needs its own
negative fixtures (recurring maintenance schedule, holiday-party invite,
lobby repaint) to keep from drifting back toward over-firing, and is
enforced only in prose with no code-level check on the conjunction — three
new judgment calls to keep narrow forever.

**The simpler framing, from this conversation**: ADR 0180 already
distinguishes two callers of the extraction step — the unattended
background sweep (`runEmailMagics`) and the interactive read-time pass
(`runReadTimeEmailMagics`), which fires only when a person has the thread
open right now. 0180 already uses that distinction to bypass every
*background gate* (bulk deny-list, discretionary categories, archived,
unread/age window, the once-ever `magic` mark) on the read path, on the
reasoning that "none of those gates' reasoning holds once a person already
has the message open." 0179's "ON THE HOOK" test is the identical kind of
gate, just enforced one level deeper — inside the model's own decision
instead of in the code that decides whether to ask the model at all. It
should split the same way, for the same reason: a person deliberately
opening an email that turned out to be a coupon or a building notice has
already supplied the consent 0179 was trying to infer from the mail's
content. Opening it *is* "I think this is worth acting on if it turns out
to have something in it" — the exact judgment 0179's gate exists to
approximate for mail nobody looked at.

## Decision

Split `EXTRACT_SYSTEM`'s "ON THE HOOK" rule by which pass is calling,
using the distinction that already exists between `runEmailMagics` (sweep)
and `runReadTimeEmailMagics` (ADR 0180): thread an `interactive: boolean`
flag through `ExtractStageCtx` → `MagicThreadInput` (set `true` only by
`runReadTimeEmailMagics`'s call into `extractAndStage`, mirroring how
`icsDateHint`/`icsContext` are already sweep-only fields on the same
struct), and let the extractor's prompt-builder pick between two forms of
that one rule:

- **`interactive: false` (background sweep, unchanged)** — 0179's rule
  verbatim: suppress a coupon, sale, or unbooked schedule to `none` even
  with a date.
- **`interactive: true` (read-time pass)** — drop the ON-THE-HOOK
  suppression. Evaluate the email against the ordinary `kind` definitions
  only (an event still needs a concrete fixed date/time; a task is still
  "something the recipient must do"; a list is still "buy/bring") with no
  additional test for whether the recipient is personally on the hook.

Nothing else about the extractor changes: the JSON contract, the
timezone rules, the delivery/flight/receipt side channels, and the
phishing-advisory rule are identical on both paths. This is one bullet in
one prompt, gated on a flag that already has a natural home in the
existing per-pass context struct — no new `kind`, no schema or DB change,
no second LLM call.

A suggestion produced this way still goes through the **existing**
propose-before-commit flow (ADR 0009): it lands as a dismissable card, not
a write. That matters for the safety case below — a wrong suggestion on
mail the user is actively reading costs one dismiss tap while they're
already looking at the source, not a surprise card for mail they never
opened.

### Considered and reverted: reinstating the bulk/category gate on read

A first pass at this ADR read "junk / bulk" broadly and reinstated the ADR
0127 bulk deny-list and the ADR 0179 category exclusion
(Coupons/Newsletters) inside `runReadTimeEmailMagics`, so a bulk-flagged or
Coupons-categorized thread would stage nothing even when opened. **Reverted
on clarification**: "junk" meant literally *provider-classified Junk/Spam*
— mail the mailbox's own spam filter caught — not the `bulk` header/model
signal, which flags plenty of legitimate mail that simply looks like a
blast (a flight confirmation with a marketing footer, a school newsletter).
Two things follow from the correct scope:

1. **Real Junk/Spam needs no carve-out here at all.** It is never mirrored
   into `email_threads` in the first place — `junk.service.ts` (ADR 0080
   addendum) reads it live from the provider on demand, "NEVER mirrored,
   never classified, never fed to any AI pass." `runReadTimeEmailMagics`
   only ever operates on a thread ROW, so it is structurally unreachable
   for real spam regardless of any gate added or removed here.
2. **Mail that escaped the spam filter and reached the inbox is exactly
   the case this ADR is FOR.** If it's bulk-flagged, or classified under
   Coupons/Newsletters, and the user opens it anyway, that open is the
   same consent this whole ADR is about — the interactive rule should
   apply, same as any other opened email. Reinstating the bulk/category
   gate on read would have quietly reopened the "junk" it was asked to
   close, on mail that was never junk in the first place.

So the decision above stands as originally written: `runReadTimeEmailMagics`
bypasses the bulk deny-list and the discretionary-broadcast categories on
open, same as it bypasses the two staleness gates (archived, unread/age
window) — nothing about ADR 0180's original bypass list needed narrowing.

## Why this doesn't reopen the flood 0179 fixed

0179's flood was specifically from the *unattended* sweep silently staging
cards for dozens of promo/newsletter emails nobody had looked at — a
volume and a surprise problem. The read-time pass runs once, on demand,
only for the one thread a person is looking at right now, so:

- **Volume is bounded to 1** — it cannot flood anything; there is no batch.
- **Surprise is impossible** — the suggestion appears on the thread the
  user just opened, not ambient in a briefing or decision queue they
  weren't expecting mail from.
- **The false-positive cost is a dismiss tap, not lost trust** — the ADR
  0133 asymmetry ("a missed suggestion costs a search, a wrong one costs
  trust") is about *unattended* suggestions arriving unasked; it doesn't
  hold the same way for a suggestion attached to an email the reader chose
  to open, where they can judge relevance in the same glance.

The background sweep's rule is untouched, so a coupon that's never opened
still never becomes a task — the discretionary-broadcast deny-list
categories (Coupons/Newsletters, ADR 0179 part 3) and the bulk deny-list
still exclude those threads from the *unattended* pass entirely. They just
don't apply once a person deliberately opens the thread themselves.

## Alternatives considered

- **The three-signal "household disruption notice" test** (this
  conversation's first draft) — rejected in favor of the simpler rule
  above: it requires the model to correctly classify sender relationship
  and notice type on every email, needs its own growing set of negative
  fixtures to stay narrow, and only ever covers the one shape it was
  named for (operational notices) — a subscription renewal reminder, a
  "last day for early registration" email, or any other discretionary
  item a person opens because they suspect it matters would still be
  suppressed. Splitting on interactive-vs-sweep covers all of those for
  free, with less prompt surface.
- **Widen the general "ON THE HOOK" test for both passes** — rejected:
  this is exactly how the original coupon/sale flood would return, since
  it would loosen the unattended sweep too.
- **Only relax the rule for specific categories on read** (e.g. only
  `events-invites`) — rejected: adds a second axis (category × pass) to
  reason about, when the pass alone is the signal that matters. A person
  opening a coupon in the Coupons category still supplied the same
  consent as one opening a building notice in Events & Invites.
- **Leave 0179's gate as-is and only fix the specific "operational
  notice" case** — the first draft's approach; rejected on simplicity
  grounds above, though it remains the more surgical option if the
  interactive-pass relaxation is found to over-suggest in practice.
- **Reinstate the ADR 0127 bulk deny-list and the ADR 0179 category
  exclusion inside `runReadTimeEmailMagics`** — tried, then reverted (see
  "Considered and reverted" above): it was built to answer a "keep junk
  mail magics-free" request that, correctly scoped, turns out to already
  be true by construction (real Junk/Spam is never mirrored) and would
  otherwise have suppressed exactly the mail — bulk-flagged or
  Coupons-categorized, but opened anyway — that this ADR exists to reach.

## Consequences

- Zero schema, DB, or route changes. Confined to a boolean threaded through
  `ExtractStageCtx`/`MagicThreadInput` and one conditional bullet in
  `EXTRACT_SYSTEM`'s prompt-building — a correctness refinement to
  something already shipped (ADR 0180), under ADR 0149's mail-surface
  gate, not new scope.
- Broader than the water-shutoff case by design: ANY discretionary item —
  a coupon, a "reservations recommended" notice, an unbooked event — now
  surfaces a suggestion if the user opens that specific email, where
  before only the background sweep's stricter rule applied everywhere.
  This is the intended trade (opening it is the consent), but it should be
  named explicitly before shipping, since it's a wider behavior change
  than "fix the utility-notice case."
- New fixtures added in
  [`read-time-on-the-hook.integration.test.ts`](../../server/src/services/email/__tests__/read-time-on-the-hook.integration.test.ts),
  mocking `@/services/llm/factory.js` the same way `bulk-hint.integration.test.ts`
  pins ADR 0109's own prompt fork: one test asserts the sweep still sends
  ADR 0179's "ON THE HOOK" text, one asserts the read-time pass sends the
  interactive rule instead, and one pins the specific sentence that lets a
  fixed household-outage window count as an "event" without requiring the
  recipient to be personally on the hook.
- [`read-time-magics.integration.test.ts`](../../server/src/services/email/__tests__/read-time-magics.integration.test.ts)
  gained two cases pinning the corrected scope: a Coupons-category thread
  and a `bulk`+`bulk_inferred` thread each still stage a suggestion when
  opened (`ranNow: true`, one proposal) — proving the bulk/category gates
  stay bypassed on read, the same as ADR 0180 originally decided. (An
  earlier version of these tests asserted the opposite, from the
  reinstate-then-revert detour above; superseded.)
- Full `server/src/services/email` suite: 69 files, 573 tests, all passing.
- Not retroactive: does not re-mine the "Building Water Shut Off" thread
  already marked extracted under the `read` kind (mirrors ADR 0167/0177's
  "does not retroactively fix already-burned threads" precedent) — this
  earns a fresh read-time pass only the next time a matching email is
  opened, or after a manual clear of that thread's `read` extraction mark.
