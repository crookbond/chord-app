# 0179 — A discretionary broadcast is not a to-do

**Status**: accepted
**Date**: 2026-09-10

## Context

Two pieces of real mail, both staged as Action Items nobody asked for:

- A **CVS coupon** — "$4 off your entire purchase, redeem through Wednesday,
  September 16" — became a `create_task` with `dueAt: 2026-09-16`.
- A **New York Athletic Club member newsletter** — a page of dated club
  happenings ("Main Dining Room reopens Sept 23", "An Evening with Dave
  Winfield, Sept 15 6pm", "Thanksgiving reservations open Sept 14") — would
  stage a `create_event` for the nearest happening, or a `create_task` to
  book a reservation.

Neither is an obligation. Nobody is waiting on the reader, the reader opted
into nothing, and ignoring either costs nothing. They are **broadcasts of
opportunities**, and the "action" in them is entirely discretionary.

The magics pipeline could not tell the difference, for two composed reasons:

1. **The bulk gate (ADR 0127) was bypassed.** It suppresses a blast only when
   BOTH bulk signals agree AND the ADR 0086 `action` axis is not
   `to_do`/`reply_needed`. The classifier's `to_do` definition ("an
   appointment to book, an RSVP") is loose enough to catch a time-boxed
   coupon or a "reservations recommended" line, and `to_do` overrides the
   gate by design (ADR 0109's own rule — a school form that is also a blast
   must still be mined). `Events & invites` is likewise mined unconditionally
   (`ALWAYS_MINE_CATEGORY`), and a club events digest is a false positive for
   that carve-out.

2. **The extractor had no concept of "solicited".** `EXTRACT_SYSTEM` defines a
   task as "something the RECIPIENT must do — return a form, pay an invoice,
   book a slot, renew something" and an event as "reservations … anything
   with a CONCRETE date AND time that is already FIXED". A coupon expiry is a
   date; a club's dinner series has fixed times. Every negative rule in the
   prompt was about something else (don't restate the sender's wants, don't
   append filler, don't invent dates, don't twin a calendar item). Nothing
   said an offer you may ignore is not an obligation, or that an event
   happening in the world you were merely *told* about is not an event you
   are committed to.

ADR 0132's own worked example is the tell: "sign and return the permission
slip by Friday" is a task *because* a person is waiting and there is a
consequence. "Bring cupcakes to the bake sale" is a list item. Neither axis
was ever "is there an imperative and a date" — but that is all the prompts
tested.

## Decision

The distinguishing signal is **solicited obligation vs. discretionary
broadcast**, and it is enforced the way ADR 0100 and ADR 0102 enforce their
rules: a strict prompt instruction *plus* a deterministic server-side choke
point, because "the instruction alone was not enough" is the standing
precedent (ADR 0100's `normalizeDatetimes`, ADR 0102's `INTERNAL_TOOL_FIELDS`).

**1 — The classifier's `to_do` axis excludes discretionary broadcasts.**
`classifySystemPrompt`'s `to_do` bullet now says a coupon, a sale, or a
broadcast of events the user has not registered for is `informational` —
there is nothing they must do. This makes the ADR 0127 gate work as designed
for these threads (no `to_do` bypass) and stops the ADR 0086 row badge
claiming a promo needs action.

**2 — The extractor emits `none` for a discretionary broadcast.**
`EXTRACT_SYSTEM` gains an explicit rule: only emit a task or event when a
specific person is waiting on the recipient, the recipient has already
committed (a booking, a registration, a ticket, a payment they owe), or a
stated deadline carries a real consequence. A coupon they *may* redeem, a
sale, and a venue's calendar of events they have not booked are `none`. The
list/task contrast line carries the two new worked examples.

**3 — A deterministic backstop keyed on the category.**
`runEmailMagics` resolves each thread's **top-level** category (walking
`email_categories.parent_id`) and excludes from the pass any thread whose
top-level is `Coupons` or `Newsletters` — the two buckets the classifier
already routes discretionary, subscribed-to, editorial and promotional mail
into. Excluded threads are not marked mined (ADR 0143's rule — a policy
change must be able to revisit them). The prompt can regress; this cannot.

**4 — The sweep retracts what is already staged.**
`retractDiscretionaryBroadcastProposals` runs in the same per-pass
consolidation block as `retractPastEventProposals`: it expires pending
`gmail:`-provenance `create_task` / `create_event` / `add_list_item`
proposals whose source thread's top-level category is `Coupons` or
`Newsletters`. This makes the fix retroactive with no migration, and
self-heals if the classifier later moves a thread into one of those buckets.

## Alternatives considered

- **Prompt-only, in `EXTRACT_SYSTEM`.** Rejected on the ADR 0100 precedent:
  the timezone rule was also "obviously" expressible as a prompt instruction
  and still needed `normalizeDatetimes` as a server choke point. A prompt
  the model can regress against is not a guarantee, and a wrong to-do costs
  trust (ADR 0133's asymmetry).

- **Suppress `Coupons` / `Newsletters` in the query but keep running the
  extractor to capture delivery/flight facts.** Rejected: the extractor call
  is the cost the bulk gate exists to avoid, and a retailer's shipment is
  classified `Deliveries`, not `Coupons` — there is nothing to capture on a
  thread the classifier already called a coupon or a newsletter.

- **Also blanket-suppress `Events & invites`.** Rejected: a personally
  addressed Evite genuinely lives there and is genuinely actionable (an
  RSVP). The classifier already routes newsletter-shaped promotion to
  `Coupons` / `Newsletters` ("a retailer selling something is Coupons however
  newsletter-shaped it looks"), so the NYAC-style club digest is caught by
  part 3. A promo that slips into `Events & invites` is left to parts 1 + 2 —
  an accepted residual.

- **A new `basis` field on every suggestion** (`committed` / `awaited` /
  `deadline` / `opportunity`), discarded server-side when `opportunity`.
  Rejected as more model burden than the two-line prompt rule buys; the
  category backstop is deterministic and needs no model cooperation.

- **A sweep of the whole existing pile** (beyond `Coupons` / `Newsletters`).
  Rejected on ADR 0143's reasoning — retro-retiring proposals whose source
  mail still exists has no signal to act on. Part 4 is narrow: the signal is
  the stored category, not age.

## Consequences

- Discretionary marketing and membership blasts stop minting obligations,
  and stop costing an LLM call in the magics pass.
- The `to_do` action badge (ADR 0086) no longer appears on a coupon row.
- A genuinely actionable message misfiled by the classifier under `Coupons`
  or `Newsletters` (a payment-failure notice styled as a newsletter, say)
  is now skipped by the magics pass. This is the safe direction — the
  classifier does not route transactional mail there — but it means the
  backstop is only as good as the top-level classification.
- Part 3 walks the category tree once per pass in JS. Cheap (a user has tens
  of categories), and it keeps `LIMIT` correct by resolving the blocked id
  set before the query rather than filtering the page afterwards.
- A promo landing in `Events & invites` is still exposed to the extractor;
  parts 1 and 2 are the only defense there.
