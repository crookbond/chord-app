# ADR 0086 — The email action axis, orthogonal to the category tree

**Status:** Accepted · 2026-08-13
**Extends:** [0066](./0066-in-repo-llm-email-classifier.md) (the LLM classifier),
[0068](./0068-attention-weighted-email-map.md) (the attention-weighted map),
ADR 0061 (the classifier ingest contract — no ADR file; it is specified in
[`docs/tasks/email-reader-plan.md`](../tasks/email-reader-plan.md) and in the
`kernel/src/types/email-classification.ts` header)

## Context

Chord classified every thread on exactly one axis: a recursive **category
tree** saying what a thread is *about* (`Travel/Flights`, `Friends & family/
School notes`). Whether a thread wanted anything *from the user* was never
recorded.

That question was answered elsewhere, by a different subsystem: the ADR 0063
magics pass stages proposals from mail it can act on, and those surface under
To Do's → Action Items (ADR 0070). The gap that leaves:

- **A thread that needs a human reply produces no proposal**, so it was
  invisible as an action. Nothing in the product could say "these six need an
  answer from you."
- **The map could not be filtered by what needs doing.** Tile area follows
  *attention* (unread + pending magics), which is a decent proxy but conflates
  "I haven't read this" with "this wants something".
- **"Needs action" was not a property of the email at all** — it was a property
  of whether our extraction happened to fire on it.

The owner's framing: classify mail twice, on two independent questions. What is
it about, and what does it want from me.

## Decision

Add an **action axis**: exactly one value per thread, independent of its
category path.

| Action | Meaning |
|---|---|
| `to_do` | Something concrete to do or schedule: a form, a payment, an RSVP, a booking |
| `reply_needed` | A human is waiting on a written reply |
| `informational` | Worth reading, nothing to do: statements, receipts, shipping, newsletters |
| `other` | Genuinely none of the above |

**Flat, not nested.** The original sketch nested "suggestions / reply needed /
informational" *under* a "needs action" parent while also listing `reply` and
`to do` as peers, so `reply` appeared at two levels and `to do`/`other` each
appeared twice. A four-value flat enum says the same thing without a value
being reachable by two paths, and it keeps the storage a single column and the
filter a single `IN` clause.

**Stored on `email_threads.action`, nullable.** Null means *not classified
yet*, which is a genuinely different state from an explicit `other` — the
difference between "we haven't looked" and "we looked and it wants nothing".

**Judged separately from the category, in the same LLM call.** One call keeps
the cost identical to before; the prompt states the independence explicitly
("one school email can be `reply_needed` and the next `informational`; both
still sit under Friends & family") because the obvious failure mode is the
model deriving one axis from the other — answering "it's a receipt, so
informational" as a category lookup rather than reading the mail.

## Consequences

- **The seam stays compatible.** `ThreadAssignment.action` is *optional* in the
  kernel contract, so the external classifier (ADR 0061 is an integration seam
  owned by another team) keeps validating without shipping in lockstep. Ingest
  lands `'other'` for a missing action rather than null, so "classified" and
  "has an action" remain the same state and a filter can never hide a
  classified thread.
- **Snapshot-replace would wipe the axis**, since ingest clears and rewrites the
  user's whole tree. `loadBaselinePaths` therefore carries each thread's
  existing action forward, so a thread absent from the current batch keeps its
  value instead of being reset to `'other'`.
- **Bulk senders skip the LLM on both axes.** `deterministicPathFor` already
  routed LinkedIn/job-boards/social by domain; those are `informational` by
  definition, so proving it with a model call would be waste.
- **An unknown action is dropped, not persisted.** A model that invents
  `"URGENT!!"` yields `undefined`, which ingest defaults to `other` — the
  thread still classifies rather than failing the batch.
- **Filtering is `?action=to_do,reply_needed` on the thread list**, composing
  with both traditional and category modes since the axes are independent.
  Unknown values are dropped rather than 400'd, so a stale client degrades to
  "no filter".
- **The UI badges only the two actions that ask for something.**
  `informational` and `other` render no badge: a marker on every row is noise,
  and the point of the axis is to make the few rows that want something stand
  out.

## Alternatives considered

- **Derive the action from whether a magic proposal exists.** Free, but it
  defines "needs action" as "our extractor fired", which is exactly the bug —
  a reply-needed thread produces no proposal and would read as informational.
- **A second tree rather than a flat enum.** More expressive, and immediately
  more expensive: another adjacency table, another rollup, another ingest path,
  for an axis whose whole value is that it has very few values.
- **A separate classifier pass.** Cleaner separation, double the LLM cost, and
  it splits a judgement the model is better at making with the full thread in
  front of it once.

## Not done here

Tile **area** still follows attention, not action. Weighting the map by
`to_do`/`reply_needed` density is the obvious follow-on, but it changes the
meaning of the headline visual and deserves to be judged against a real
mailbox first. (Family-first *placement* already exists and is unrelated —
`usefulness()` in `mobile/src/email-tiles.tsx`, since `e007cdf`.)
