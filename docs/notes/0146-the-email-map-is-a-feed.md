# ADR 0146 — The email map is a feed

**Status:** Accepted (2026-09-01)
**Related:** [0068](./0068-attention-weighted-email-map.md),
[0083](./0083-email-stage-1-shell-decisions-on-tiles.md),
[0086](./0086-email-action-axis.md),
[0087](./0087-email-tile-archetype-facts.md),
[0132](./0132-a-to-do-is-not-a-list-item.md),
[0134](./0134-a-count-is-a-place.md)

## Context

The owner didn't like the look of the AI tiles — the squarified treemap of
colored category boxes that has been the Email tab's default view since ADR
0068. Four candidate directions were sketched: restyle the treemap in place,
group by ADR 0086's action axis instead of by topic, flatten into a single
ranked list, or keep the map and just change its palette. The owner picked
the flat list.

## Decision

`EmailFeed` replaces `EmailTiles` under the "AI" toggle. It drops category
grouping entirely and renders every open decision as one urgency-ranked
list, reusing the same `decisions` prop the tile view already received —
the swap at the call site ([`email/index.tsx`](../../mobile/app/email/index.tsx))
is one line.

### Ranking

A due date is the clearest urgency signal there is, so `sortFeedUnits`
(`mobile/src/email-decisions.ts`) puts every dated item first, soonest due
first. Undated items follow, ranked by the same family-first / marketing-last
weighting the tile map used for area (`categoryUsefulness`, moved out of
`email-tiles.tsx` so both views rank off one function instead of two that can
drift apart).

### Batching stays, but narrower

List items that share a list name still batch into one "Add all to Costco"
card (`feedUnits`) — that affordance is worth keeping. But `batchDecisions`,
the sheet's original batcher, lumps *every* event across the sheet's whole
subtree into one card and *every* task into another, which was fine for a
per-category sheet and wrong for a flat, cross-category feed: it would
collapse "the flight is delayed" and "sign the permission slip" into one
undifferentiated events-card, erasing the very ordering the feed exists to
show. `feedUnits` treats every event and every task as its own row.

### A bug found on the way

`batchDecisions` never handled `kind: 'task'` (ADR 0132 added that kind
after this function was written) — a task-only decision fell through both
the `events` and `lists` filters and never appeared in any batch, so a tile
badge could read "1" over a sheet body saying "Nothing owed in this tile."
Fixed alongside, since the feed depends on the same function being correct.

## Consequences

- **"Unsorted" disappears as a concept.** The tile map needed it because an
  uncategorized decision had no tile to live on. A flat feed has no such
  gap — every decision renders regardless of `categoryId`.
- **Category browsing (the tile's "sources" sheet) has no feed equivalent.**
  Traditional is the general "browse everything in one category" surface
  now; the feed only shows what's *owed*.
- **The per-category "Current state" fact boards (ADR 0087, extended by
  0135's delivery lines and 0138's flight lines) have no home in the feed.**
  Those render an aggregated state — "3 packages in transit," a ledger of
  recent charges — for a *topic*, which a feed with no topics can't display.
  This is a real loss, not an oversight: `EmailTile.facts` and the server
  endpoints behind it are untouched, and `mobile/src/email-tiles.tsx` is
  left in the tree, unwired, rather than deleted, so the facts UI can be
  revived (in the feed, as its own section, or elsewhere) without
  reconstructing it from scratch. Whether to bring it back, and in what
  shape, is an open question for a follow-up — not resolved here.
- `BatchCard` moved out to `mobile/src/email-batch-card.tsx` so both the
  feed and (were it re-wired) the tile sheet can share it without either
  file owning the other.

## Rejected alternatives

- **Restyle the treemap in place.** Cheapest option, and still couples the
  view's layout to the category tree — the owner's objection was to the
  tile look specifically, and a re-skin doesn't change the shape.
- **Group by action instead of topic.** Fewer, calmer buckets than a dozen
  colored regions, but still a grouping — the owner asked for a flat list.
- **Delete `email-tiles.tsx` outright.** It's the only renderer for
  `EmailTile.facts`; deleting it would silently drop the state-board feature
  with no path back, which is a bigger decision than "I don't like this
  view's look" licenses on its own.
