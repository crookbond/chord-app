# ADR 0147 — Let people choose their email view

**Status:** Accepted (2026-09-01)
**Related:** [0146](./0146-the-email-map-is-a-feed.md),
[0068](./0068-attention-weighted-email-map.md)

## Context

ADR 0146 replaced the treemap tiles with a flat, urgency-ranked feed because
the owner didn't like the tiles' look. But "I don't like this one" and "this
is the right one for everybody" are different claims, and the four layouts
sketched while deciding — Map (the original treemap), Cards, Sections, and
Feed — are all legitimate readings of the same data with real trade-offs
against each other (Cards keeps topic grouping without the treemap's packed
rectangles; Sections is coarser and calmer; Feed is flattest and most
urgency-driven; Map keeps the per-category state boards ADR 0146 had to drop).
Rather than guess which one the household actually prefers, keep all four and
let each person pick.

## Decision

A picker row (four chips: Feed / Cards / Sections / Map) sits under the
Urgent Strip whenever the "AI" tab is active. The choice is a per-device
`AsyncStorage` preference (`email.aiViewStyle`), the same mechanism already
used for the AI/Traditional toggle — this is a personal reading preference,
not something that needs to be the same across a family's devices.

Two new views were built to make the choice real rather than three stubs and
one real option:

- **Cards** (`email-cards.tsx`) — one card per category, ranked the same way
  the treemap ranked tile area (`groupByCategory`, sharing `categoryUsefulness`
  with the feed). Tapping a card expands it in place; no bottom sheet, no
  drag gesture, no squarify math.
- **Sections** (`email-sections.tsx`) — grouped by decision *kind* (To-dos /
  Events / Lists) rather than topic. This is a deliberate substitution for
  what the original mockup showed as "Reply needed / To-dos / FYI" (ADR
  0086's action axis): that axis lives on `email_threads`, not on a decision,
  and a decision only exists once a magic proposal was staged — there's no
  "reply needed" or "FYI" bucket among decisions to group by. Grouping by
  kind uses data the feed already has instead of asking the server for a
  field decisions don't carry.
- **Feed** and **Map** are unchanged from ADR 0146 and the original ADR 0068
  build, respectively — Map's per-category fact boards (delivery/flight/
  ledger, ADR 0087/0135/0138) are reachable again simply by picking it.

All four consume the identical `{ decisions, onDecisionsChanged }` props, so
none of them owns data-fetching beyond what the screen already passes down
(Map is the one exception — it still fetches its own category tree, unchanged
from before).

## Consequences

- Four view components now exist for one screen, which is more surface to
  keep working than committing to one. Accepted deliberately: the four share
  their two expensive pieces (`BatchCard`, the ranking helpers in
  `email-decisions.ts`), so a fix to confirm/dismiss or to the ranking rule
  lands in all four at once rather than four times.
- No usage telemetry was added. "See which one users like" is answered by
  each person settling on a preference over time, not by measuring it — this
  is a two-or-three-person household demo, not a product with a metrics
  pipeline, and building one to answer a question this small would cost more
  than the question is worth.
- "Sections" groups by kind, not by the ADR 0086 action axis the original
  mockup showed. If a true reply-needed/to-do/FYI view is wanted later, it
  needs the server to join a decision back to its thread's `action` — not
  built here.

## Rejected alternatives

- **Pick one and ship it.** The premise of this ADR — the owner explicitly
  asked to keep the options and let usage decide, rather than have the
  session choose on their behalf a second time.
- **A server-side preference.** The AI/Traditional toggle is already
  per-device; matching that is more consistent than introducing a synced
  setting for a preference this hard to imagine sharing across two people's
  phones.
- **Instrumenting which view gets used.** Real for a multi-user product;
  overbuilt for a household deciding what it likes by using it.

## Addendum 2026-10-02 — three views, and what orders them

- **Sections is removed** (owner: "useless"). It grouped open decisions by
  kind, which the Feed already does for its undated half. A stored
  `sections` preference falls back to Feed.
- **Cards are ordered by mail, not by category weight**: categories holding
  unread mail first (most unread on top), then whichever received mail most
  recently. `EmailTile` gains `unread` and `lastMessageAt` for this, because
  `attention` also counts read threads with a pending suggestion and so
  cannot answer "is there unread mail here".
- **Feed keeps the mail under the to-dos.** The per-category recent lines
  used to appear only when there was nothing to decide; they now always
  follow the decisions, unread lines in bold, same order as Cards.
