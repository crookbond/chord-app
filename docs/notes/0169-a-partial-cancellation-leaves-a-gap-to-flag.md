# 0169 — A partial cancellation leaves a gap to flag

**Status**: accepted
**Date**: 2026-09-14
**Relation**: extends [0168](./0168-a-cancelled-trip-is-cancelled-not-silent.md)
(`applyCancellation`); reuses the proactive-nudge machinery
[0042](./0042-proactive-calendar-reconnect-nudge.md)/[0137](./0137-a-proactive-message-is-not-always-the-briefing.md)
already built and hardened.

## Context

ADR 0168 makes `applyCancellation` mark the SPECIFIC leg or accommodation a
cancellation email names, and derives `trips.cancelled_at` only when
*everything* on the trip is cancelled. That's correct as far as it goes, but
it stops at "record the fact" — owner's own framing of the gap: cancelling
only the hotel for a trip that still has flights booked (or cancelling one
leg while the hotel stands) is a real, common shape a cancellation takes,
and nobody is told. A family who cancels a Vail hotel because plans changed
but never rebooked it would have their flights sail past with nowhere to
stay, and Chord would have known — the row says so — and said nothing.

The asymmetry is exactly what ADR 0168 leaves to "the Trips tab, next time
someone opens it." That's fine for the *fact* (the row is there, searchable,
badged) but not for a *gap that needs a decision*: rebook the hotel, drop
the flights, or do nothing on purpose. Nobody opens the Trips tab to notice
something didn't happen.

## Decision

**A cancellation that leaves the trip partially intact enqueues a proactive
nudge**, reusing the exact machinery ADR 0042/0137 already built and
hardened (rate limiting, staleness cutoff, WhatsApp-window gating,
`is_proactive`/`proactive_kind` bookkeeping) rather than posting a bare chat
message the way `postIndexed` does for attachment auto-filing — this is
genuinely proactive (fired from a background magics pass, no user turn
triggered it), so it needs the same gating `event_created_nudge` and the
reconnect warnings already get, or it repeats the exact mistake ADR 0137
was written to fix (an unprompted message landing outside WhatsApp's
window, or at 9pm past quiet hours).

New `ProactiveMessageKind` value `trip_cancellation`, with its own payload
(`TripCancellationPayload`: trip id/name/destination, `cancelledItems`,
`remainingItems` — both pre-formatted strings, not raw rows) and its own
**deterministic** renderer, `renderTripCancellationNudge` — no DB read, no
LLM call, because everything the message needs was already known the moment
`applyCancellation` ran. This follows `renderEventConflictNudge`'s template
(interval math, no LLM) rather than `event_created_nudge`'s trip half
(still LLM-rendered) — a coordination gap is a plain fact ("X cancelled, Y
still booked"), not a judgment call the model needs to phrase, and an LLM
call here would be pure cost for the same answer every time.

`applyCancellation` (ADR 0168) now, after marking the match cancelled and
running `maybeCancelTrip`, re-reads the trip's current legs + accommodations
and enqueues the nudge unconditionally — `remainingItems` may be empty
(the trip just fully cancelled) or not (a gap):

- **Empty** → *"Your Vail trip (Residence Inn) is now cancelled — Residence
  Inn by Marriott Vail (2027-02-11–2027-02-15) came back cancelled."* A
  full-trip cancellation is still worth a heads-up on its own — the family
  might not open the app for days — even though there's no decision left to
  make, only an FYI.
- **Non-empty** → *"Heads up — Residence Inn by Marriott Vail
  (2027-02-11–2027-02-15) for your Vail trip was cancelled, but you still
  have UA123 JFK→DEN (2027-02-11) and UA456 DEN→JFK (2027-02-15) booked for
  the same trip. Want me to update anything?"* Names what's gone AND what's
  still standing, and ends with an open question — the point isn't to guess
  what the user wants (rebook, drop the flights, do nothing on purpose),
  it's to make sure they're the one deciding, per the owner's own framing
  ("user can act as they want").

Gating, reusing ADR 0137's existing rules directly (no new logic to get
wrong):

- **Not** a scheduled briefing (`isScheduledBriefing` doesn't list it) —
  nobody asked for this at a specific moment, so it's WhatsApp-window-gated
  and NOT exempt from push quiet hours, same posture as `event_created_nudge`
  and the reconnect warnings.
- Bypasses the cross-kind 24h proactive rate limit (`skipRateLimit`), same
  reasoning as `event_created_nudge` (ADR 0012) — a cancellation is as
  real-time-triggered as a create, and suppressing it because some other
  proactive nudge fired an hour ago would silently drop it.
- **Not** gated behind ADR 0079's billing entitlement — zero LLM cost, so
  it costs nothing to send even to an unentitled persona, the same
  reasoning ADR 0117 applied to "your mail arrived" and ADR 0135/0138/0160
  applied to stored (never proposed, never LLM-rendered) facts.
- 2-hour staleness cutoff, matching `event_created_nudge` — a cancellation
  nudge that didn't fire within a couple hours has had its moment eclipsed
  by whatever the family already noticed or did about the Trips tab.

Posted to the **trip's own group** (`trip.groupId`), not necessarily the
actor's personal group the way `enqueueEventNudge` always does — an
email-derived trip already lives in the personal group by construction
(ADR 0084), so in the common case these are the same place, but a
bundle-confirm can route a trip to a shared family group (ADR 0097), and
the cancellation gap belongs wherever the trip itself is visible.

## Consequences

- The nudge is best-effort: `applyCancellation` catches an enqueue failure
  and logs a warning rather than letting it fail the cancellation itself —
  the row is already correctly marked cancelled regardless of whether the
  family gets told promptly.
- A cancellation whose remaining items span BOTH a still-live leg and a
  still-live accommodation lists both in one message rather than firing
  twice — one cancellation, one nudge, matching ADR 0137's "one thread, one
  outcome" discipline applied to notifications instead of proposals.
- Doesn't (yet) offer a one-tap action on the nudge itself ("drop the
  flights" / "keep everything") — it's plain text, same as
  `renderEventConflictNudge`'s conflict nudge, which also just describes the
  situation and lets the user reply in chat. A buttoned card is a real
  future improvement but a bigger surface (ADR 0042's action-card shape) for
  a first cut of "at least tell someone."
- Rides the exact same publisher path (`fireOne`) as every other proactive
  kind, so a bug fixed there (ADR 0137's `is_proactive`/`proactive_kind`
  confusion, the WhatsApp-window skip-not-park behavior) is fixed here too,
  automatically — no separate WhatsApp/push code to maintain per kind.

## Rejected

- **A bare chat message via `postIndexed`-style direct insert** (no
  proactive-message row) — skips every gating rule ADR 0137 exists because
  of: no WhatsApp-window check, no quiet-hours exemption logic, no rate
  limiting. `postIndexed` is safe precisely because it fires synchronously
  inside a live user action (an upload); this fires from a background pass
  with nobody watching, which is the exact shape ADR 0042/0137 built the
  queue for.
- **LLM-rendered nudge text** (matching `event_created_nudge`'s trip-create
  path) — the underlying fact is fully structured and known in advance
  (what got cancelled, what remains); an LLM call would add cost and latency
  to restate data already in hand, the same reasoning that kept
  `renderEventConflictNudge` deterministic.
- **Silence on a full-trip cancellation** (only nudge the partial case) —
  considered narrower scope matching the reported problem exactly, but a
  fully-cancelled trip is still news a family might not see for days; the
  incremental cost of also covering it is one branch in the same renderer,
  not a second mechanism.
- **A buttoned action card** ("Drop flights" / "Keep as is") — real value,
  but a bigger surface than this fix needs; noted as a follow-up rather
  than bundled in.
