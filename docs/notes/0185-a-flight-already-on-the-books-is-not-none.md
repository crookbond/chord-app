# 0185 — A flight already on the books is not `'none'`

**Status**: accepted
**Date**: 2026-09-18

## Context

Prod (`ownertest@gmail.com`, 2026-09-18): three forwarded Air India emails
("Air India Web Booking eTicket (7CTFHU) - SIMON", "... - KATE", and
"Fwd: Change in Itinerary") for one round-trip flight shared by two
passengers. The PDF/`.ics` attachment path (`classifyAndAutoFileAttachment`,
ADR 0071/0158) correctly auto-committed one trip with two `travel_legs`
(AI105 DEL→EWR, one row per passenger) and synced two calendar events — the
user confirms this half worked as intended. But each of the same three
threads *also* produced a standalone `create_event` proposal via the general
email-magics extractor (`event`/`task`/`list` vocabulary, ADR 0132), all
three confirmed by the user, minting three more calendar events for the same
flight — `e_jsaJQNzofVhW`, `e_TIDCH_6x9-d4`, `e_11P_bCvUhHpe`, each a few
minutes apart in start/end time from LLM extraction variance across the
three emails. Five calendar entries for one flight, and the near-duplicate
start times are exactly what trips ADR 0042's conflict-nudge machinery.

Tracing the code: `runEmailMagics` short-circuits any `travel/*`-categorized
thread into `stageEmailTripProposal` (ADR 0158) *before* the general
extractor ever runs, and only falls through to that general extractor when
`stageEmailTripProposal` returns `'none'` — the sentinel that's supposed to
mean "the classifier didn't recognize this as travel content." But
`stageFlight`'s matched-existing-trip branch overloads that same sentinel for
a second, unrelated meaning: `findTripByDateRange` matches the trip the
attachment path already created (same date window), then `findExistingLeg`
matches every leg in the email against a leg that already exists on it
(same route, same day, same flight number) — so nothing new gets staged, and
the function returns `'none'` because `staged === 0`. `stageHotel`'s
matched-accommodation branch has the identical shape. Both readings of
`'none'` — "not travel" and "travel, but already on the books" — are
indistinguishable to the caller, and only the first one is supposed to fall
through.

The attachment path's auto-commit also leaves `travel_legs.source_raw_context`
empty (it isn't threaded through `classifyAndAutoFileAttachment` the way
ADR 0158's staged path sets it), so there's no cheap provenance join the
general extractor could use to notice "this thread already produced a leg" —
the only place that fact is visible is inside `stageFlight`'s own
`findExistingLeg` dedup, which already ran and already knew.

## Decision

**Report the classification kind, not `'none'`, when a matched leg or stay
already exists.** `stageFlight`'s existing-trip branch now returns `'flight'`
unconditionally (whether or not anything new was staged this pass);
`stageHotel`'s equivalent branch returns `'hotel'` on a duplicate match
instead of `'none'`. This mirrors the pattern the file already uses one
level up, at `stageEmailTripProposal`'s own "already pending" dedup
(`if (already) return result.kind;`, ADR 0137's one-outcome-per-thread rule)
— a thread that *was* recognized as travel and is *already handled* is not
the same outcome as a thread that was never travel at all, and only the
latter should hand off to the general extractor. `runEmailMagics` needs no
change: it already treats any non-`'none'` result as "handled, mark the
thread extracted, skip the general extractor" (and non-`'cancellation'` results
increment its `trips` counter, which is a log/metrics count of threads the
trip classifier resolved, not a count of new proposals — reporting 0-new
duplicates under it is consistent with what the counter already means).

## Alternatives considered

- **Teach the general email-magics extractor about `travel_legs`/`trips`,
  and have it skip staging a `create_event` that overlaps one.** Duplicates
  ADR 0158's own reasoning for why a *second* trip vocabulary was rejected in
  the first place: two independent passes reading the same ambiguity is how
  ADR 0085's matching-parity promise broke once already. The travel/*
  short-circuit already exists specifically so the general extractor never
  has to know about trips; fixing its dedup at the wrong layer papers over
  the sentinel bug instead of fixing it.
- **Thread `source_raw_context` through the attachment auto-commit path
  too, and have the general extractor check it.** Real gap (ADR 0158's own
  addendum notes the staged path sets it and calls out that the link is
  "most of why this was built once instead of twice") but doesn't fix this
  bug on its own — the general extractor still has no reason to look at
  `travel_legs` at all, and would need the same new cross-table dedup check
  as the previous alternative. Worth doing separately; left as a follow-up.
- **Make `'none'` carry a reason (`'none:not-travel'` vs `'none:duplicate'`)
  instead of reusing an existing kind.** A real option, but wider than the
  bug needs: every caller of `StageEmailTripResult` would need updating for
  a distinction only one caller (`runEmailMagics`'s fallthrough check) acts
  on, and `'flight'`/`'hotel'` already mean exactly "recognized as this kind
  of travel, thread handled" everywhere else the type is used.

## Consequences

An itinerary email whose flight or stay is already represented on the trip
the attachment path (or a prior staged bundle) created no longer produces a
rival standalone calendar event — the thread is marked extracted and the
general extractor never runs on it. Doesn't retroactively remove the five
already-created prod events from this incident (a one-off cleanup, not a
migration — the same posture ADR 0167/0168 took for their own already-burned
threads). Doesn't address the attachment path's own missing
`source_raw_context` (noted above as a follow-up, not required for this fix).
