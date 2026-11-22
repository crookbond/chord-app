# 0058 — Lists render per-list; no cross-list consolidation

**Status**: accepted
**Date**: 2026-06-30
**Relates to**: catchup Lists view (`mobile/app/catchup/[tab].tsx`), `kernel/src/list-kind.ts`

## Context

The catchup **Lists** tab used to *consolidate* lists before rendering, via
`bucketLists` in `kernel/src/lists-bucketing.ts`:

- **Store/name merging** — every grocery-type list (Walmart, Costco, Trader
  Joe's, Safeway, Pantry, …) collapsed into one **"Grocery"** card; non-grocery
  lists fuzzy-merged by name (edit-distance / prefix).
- **Grocery cross-pull** — items that *looked* like groceries (a hardcoded
  keyword list — milk, eggs, potatoes, …) were pulled out of other lists
  (e.g. "Errands") and surfaced under the Grocery card.
- **Dedup / move / hide** — identical item text merged across lists into one
  row; pulled grocery items were hidden from their source list; fully-checked
  items were hidden; emptied cards were dropped.

The stated rationale was "'potatoes at Walmart' and 'potatoes at Costco' are
the same logical item; separating by store is noise."

In practice that assumption is wrong for how people actually shop: they keep a
separate list per store *on purpose* and buy different things at each. Merging
them — and silently relocating "grocery-looking" items out of the list the user
wrote them on — loses the per-store intent and makes the list the user created
not match what they see.

## Decision

Remove list consolidation entirely. The Lists tab renders **one card per
list**, exactly as stored:

- No Grocery super-bucket, no store/name merging, no fuzzy name-matching.
- No keyword-based grocery cross-pull; an item stays on the list it was added
  to.
- No cross-list item dedup; each list shows its own items, checked or not.
- Toggle / edit / delete act directly on that one list's `list_item` row — the
  old "fan out across every merged source" logic is gone.

`bucketLists` and its supporting machinery (grocery keyword classifier,
`normalizeListKey`, edit-distance fuzzy matcher, `ListBucket`/`BucketItem`
types) are deleted. The only survivor from the old module is `listKindLabel`
— a name→kind classifier used purely to pick the card's icon (🛒 / 🧳 / ✅ /
📋); it groups nothing. It now lives in `kernel/src/list-kind.ts`; the generic
`normalizeText` helper (still used for task/list de-dup elsewhere) moved to
`kernel/src/text.ts`.

## Consequences

- A user with "Walmart" and "Costco" lists sees two cards, each with its own
  items — the per-store separation they intended.
- This is a **view-layer change only.** The `lists` / `list_items` tables are
  untouched; no migration. Reverting would be re-introducing the transform.
- The grocery keyword list and fuzzy-merge heuristics (a maintenance burden and
  a source of surprises — items teleporting between cards) are gone.
- If a future product direction wants opt-in consolidation, it should be an
  explicit, user-controlled grouping (a real saved view), not an implicit
  name/keyword heuristic. Out of scope here.
