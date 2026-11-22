# 0159 — The pipeline runs as mail arrives, not when you look

**Status**: accepted
**Date**: 2026-09-11
**Relation**: deepens [0144](./0144-the-mirror-goes-stale-when-nobody-is-looking.md)'s
background sweep past the depth it deliberately chose; extends
[0158](./0158-email-body-through-the-trip-classifier.md)'s "nothing past ever
surfaces" rule from trips to every proposal kind, mirroring
[0137](./0137-a-proactive-message-is-not-always-the-briefing.md)'s
`retractPastEventProposals`.

## Context

ADR 0144 fixed the mailbox *mirror* going stale between app opens, but
deliberately stopped short of the AI layer: "a background sweep would
multiply LLM spend by however often it runs," so `sweepMailboxes` ran at
`mirror` depth and the trip/task/person pipeline still only ran when the
Email tab got focus or the 7am briefing fired. A user whose mail only gets
opened once a day — or who reads mail elsewhere and rarely opens Chord —
could have a real, actionable email sit unmined for a day or more.

The rejected reasoning does not hold up. Every AI pass below the sweep line —
`runLlmClassifier`'s `selectBatch`, `runEmailMagics`'s and
`runPersonExtraction`'s `NOT EXISTS (extraction mark)` queries — returns
empty and makes **zero LLM calls** on a tick with nothing new to do. Sweep
frequency was never the multiplier a tighter cadence would trip; the
per-thread one-time extraction mark already is. Running the AI layer on every
sweep tick doesn't process a thread more than once — it only decides *when*
that one-time pass happens: within the sweep's cadence instead of at the next
app-open or briefing.

## Decision

**`sweepMailboxes` (ADR 0144) now opens its round at `full` depth**, not
`mirror`. The trip/task/person/attachment pipeline runs continuously as mail
syncs — mirroring, classifying, and mining every account the sweep touches,
same batch size and 5-minute cadence as before, still stopping at the ADR
0079 entitlement gate. Nothing about *what* each pass does changes, only
*when* it gets a chance to run.

### Ignore only what's actually gone

The only reason a message should not enter the pipeline is that it no longer
exists at the source — deleted or trashed there converges the same way ADR
0073/0108 already handle it (reverse-delete on re-backfill, archived mail
stays out of the AI passes). The two mining filters that were already in
place stay: ADR 0127's bulk/marketing deny-list (a header-and-classifier
signal, not a focus-state gate) and ADR 0143's unread-or-recent window (a
90-day fresh-connect backfill mined unconditionally would flood a new
account's obligations with settled history). Both exist to keep what's
mined *relevant*, which is a different question from *when* mining runs —
and stay exactly as they were.

### Nothing past ever surfaces — everywhere, not just trips

ADR 0158 discarded a past trip before it was ever staged. Two more producers
needed the same rule, one of them a live prod bug:

- **`create_task`** (magics) had no past-date guard at all —
  `shouldStageTaskProposal` only deduped by title. Prod: "Confirm attendance
  for the Sede Mexico reservation on Sep 5" surfaced on Sep 11. Fixed the
  same way ADR 0137 fixed events: refuse a `dueAt` already past
  (`shouldStageTaskProposal` now takes it, mirroring
  `shouldStageEventProposal`). Undated tasks are untouched — an absent
  deadline was never a lapsed one (ADR 0092's same reasoning for
  auto-archive).
- **Trip bundles can go stale between staging and confirm** — a flight
  proposed yesterday, still sitting unconfirmed today. New
  `retractPastTaskProposals` / `retractPastTripProposals`
  (`event-convergence.service.ts`, run every magics pass alongside
  `retractPastEventProposals`) sweep the ones already staged. The trip sweep
  is **bundle-aware**: when every leg/stay in a bundle is past, the whole
  bundle — including its `create_trip` lead — retracts, so confirm never
  offers an accommodation with no trip left under it; when only some are (a
  straddling itinerary drifting into its outbound date), only the stale
  members drop and the bundle keeps what's still ahead, the same rule
  `stageEmailTripProposal` applies at staging time.

## Rejected

- **Widen the mining filters too** (mine bulk/marketing mail, drop the
  90-day recency window). Owner call: those filters answer *what's worth
  proposing*, not *when the pipeline runs* — conflating them would flood a
  fresh connect with settled history and put sale blasts back in front of
  users, undoing ADR 0127/0143 for a reason that has nothing to do with why
  they exist.
- **A separate, lighter "just check for new mail" tier between `mirror` and
  `full`.** The AI passes are already that tier — self-gating on new/unmarked
  rows — so a third depth would duplicate the mark-based gating the passes
  already do, for no additional bound.
- **Retracting stale trip bundles asymmetrically** (drop the whole bundle
  even when only one leg is stale). Loses a still-ahead return leg the
  moment its outbound date passes, for round trips that are exactly the
  common case.

## Consequences

- The sweep now costs a few extra empty-result queries per user per tick
  when there is genuinely nothing new (classifier `selectBatch`, magics'/
  person-extraction's `NOT EXISTS` scans) — cheap, indexed, no LLM spend.
- A trip/task proposal is waiting in Action Items within the sweep's cadence
  of the email arriving, not the next time the app happens to be opened.
- `create_task`'s dueAt guard and the two retraction sweeps are general —
  they protect every `gmail:`-provenance proposal of their kind, not only
  ones ADR 0158's pass produces.
