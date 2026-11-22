# ADR 0291 — A briefing says a thing once

**Status:** Accepted (2026-10-23)

## Context

The 2026-10-23 prod briefing repeated itself in two ways:

- **Email section** (`email/digest.service.ts`): "Waiting on you" listed
  *Wait for seller response about order cancellation* and *Decide whether to
  cancel phone order … request cancellation if needed*; "Worth a look" listed
  the same Microsoft notice twice (the same mail in two mailboxes). The digest
  is deterministic and had no notion of "the same thing" at all.
- **Heads-up**: "accommodation pending" for the same three trips, every
  morning. Many trips have no hotel on purpose (staying with family).

Matching words cannot catch the first pair: they share almost no phrasing.
Meaning (the embeddings ADR 0276 already turned on in prod) can, but measured
with the prod model (text-embedding-3-small, 512 dims), no single similarity
cut-off separates repeats from different things:

| pair | similarity | same? |
|---|---|---|
| "Pay water bill" / "Pay electric bill" | 0.76 | no |
| "Sign Nolan's permission slip" / "Sign Ben's permission slip" | 0.77 | no |
| "Pay water bill" / "Pay the water bill before Friday" | 0.73 | yes |
| the seller / phone-order pair | 0.55 | yes |

## Decision

**Email lines are one per thing, by meaning AND source**
(`briefing/near-duplicates.ts`, `keepDistinct`):

- identical wording (case and punctuation aside) is one line, with no model
  call, so it still works with meaning search off;
- two items from the SAME email that score >= 0.5 are one line;
- items from DIFFERENT emails must score >= 0.85;
- an email already shown under "Waiting on you" is not repeated under "Worth a
  look".

Hiding a real, different to-do is worse than showing one twice, so the
cross-email bar is the high one; the same-email bar can be low because one
email asking twice about one order is the common repeat. Vectors come from
`getEmbedderForUser` (the user's key, or Chord's metered as `embedding`, ref
`briefing_dedup`); no consent or no embedder = exact-wording only; a failed
call keeps everything.

**A missing hotel or ticket is said on two mornings in all**
(`briefing/trip-gaps.ts`): per trip and gap, the days it was mentioned are
kept in `users.defaults.briefing_trip_gaps_told` (at most two). A briefing
rebuilt the same morning (the render retries) does not use up a mention;
trips off the radar are dropped from the record. After two, the
`TRIP_INCOMPLETE` tag is left off and the prompt forbids inferring it.

Also fixed in the digest: a to-do's due date printed as raw ISO text
(`→ 2026-10-27T23:59:59-04:00`); it reads `→ due Tue, Oct 27`.

## Consequences

- Two genuinely different errands from ONE email that score 0.5 or more show
  as one line in the briefing - accepted, since the briefing points at the
  email and both still sit on its card in Action Items.
- The gap count is per user, so each family member hears it twice.
- An embedding call per briefing with 2+ email items (a few hundred tokens).

## Rejected

- A single similarity threshold (the table above).
- Asking the chat model which lines repeat: the section is deterministic on
  purpose (ADR 0072), and a model judging it per briefing is a new failure
  mode and cost for a list of at most ten lines.
- Word overlap / regex: misses the seller pair entirely.
- Never mentioning a missing hotel: sometimes it really is pending.
