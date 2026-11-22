# 0068 — Attention-weighted nested email map with inline magic cards

**Status**: accepted
**Date**: 2026-07-15

## Context

The AI email view (ADR 0061) rendered one treemap level at a time: tapping a
tile *replaced* the canvas with the next level, a leaf flipped to a full-screen
thread list, and breadcrumbs were the only way back. Reading one email meant
walking map → map → list → thread, and every tap conjured a fresh set of
rectangles with no persistent context.

Tile area was also proportional to **total thread count**, so a huge pile of
already-read newsletters dwarfed a small category holding today's unread
school mail.

Separately, email magics (ADR 0063) extract event/list suggestions from
classified threads and stage them as proposals — but they surfaced only in the
Catchup proposals list, far from the email that produced them. The "magic" was
invisible at the moment the user was actually looking at their mail.

## Decision

### One persistent nested map (supersedes the drill-down half of ADR 0061)

- `GET /me/email/tiles?deep=1` returns the whole subtree nested in
  `EmailTile.children`. The client renders parents as colored regions with
  their children squarified *inside* them — both levels visible at once, no
  navigation. The tiles contract and ingest path from ADR 0061 are unchanged.
- Tapping a tile slides a **bottom sheet** with that category's threads over
  the map (subtree expansion reuses the existing category-mode threads route).
  The map stays visible behind the dimmed sheet; closing it restores exactly
  the prior state. Breadcrumbs are gone. Maximum depth: map → sheet → thread.
- Deeper trees than two levels (the classifier can emit them) flatten into the
  tapped tile's sheet, ordered newest-first, rather than a third map level.

### Tile area ∝ attention, in both dimensions

- `EmailTile` gains `attention` (threads in the subtree that are **unread or
  carry a pending magic suggestion**, each thread counted once) and
  `magicCount` (pending suggestions in the subtree; a ✨ marker when > 0).
- The squarified treemap weights by `attention + floor` where
  `floor = 0.5 + 0.05 × Σ attention`. Area — width × height, not one edge —
  tracks attention; the additive floor keeps zero-attention categories small
  but visible and tappable (~1/20 of the parent each). When nothing needs
  attention the map degrades to roughly equal tiles.
- Pending-magic detection joins `proposals.provenance = 'gmail:<threadId>'`
  back to `email_threads` — that prefix is written only by the magics pass, so
  no schema link is needed. Expired-but-unswept proposals are excluded by
  `expires_at`.

### Magic suggestions dock beside their email

- `EmailThreadSummary` gains optional `magics: EmailMagicSuggestion[]`
  (`proposalId`, `kind: event|list`, `title`, `detail`, `targetGroupId`),
  attached by the threads list and thread detail routes via
  `pendingSuggestionsForThreads` in `magics.service.ts`.
- The sheet renders each suggestion as a card docked to the right edge of its
  row; the thread view pins the cards under the subject. Confirm/dismiss call
  the **existing** proposal routes (ADR 0009) — group-routed execution
  (ADR 0063 `targetGroupId`) is untouched. Catchup keeps showing pending
  proposals too; this adds a surface, it does not move one.

### Tab transition

`email/index` is registered in the root stack with `animation: 'none'` like
every other top-level tab (it previously fell through to the default
slide-from-right push, which reads as a drill-down it isn't).
`email/[threadId]` keeps the slide — that one is a real drill-down.

## Alternatives considered

- **Keep drill-down, just add magic badges** — doesn't fix the disorientation;
  every tap still replaces the whole canvas.
- **Size by total count (status quo) or unread only** — total count rewards
  volume, not urgency; unread-only hides read threads whose suggestion still
  needs a decision. Unread + pending-magic matches "needs my attention".
- **Multiplicative floor (`max(attention, ε)`)** — with large attention totals
  a fixed ε collapses to invisible slivers; the additive floor scales with the
  map.
- **A dedicated magic feed/tab** — moves the aha further from the email; the
  point is seeing the suggestion next to its source.
- **New `email_thread_proposals` link table** — redundant while provenance
  already encodes the source thread; revisit only if provenance gains other
  producers with the same prefix.

## Addendum (same day) — emoji tile icons

The classifier contract already carried an optional per-category `icon`
(string, emoji or icon name) that nothing populated or rendered. Tiles now get
one: `getTiles` falls back to a keyword-matched emoji
(`category-emoji.ts`) when the classifier assigned none, and the map renders
it in region headers, child tiles, and the sheet title. On tiles too small
for words, the emoji **is** the label. A classifier-assigned `icon` always
wins over the keyword fallback; unmatched titles render text-only.
Considered and deferred: LLM-emitted emoji (prompt fragility for marginal
gain over keywords), icon fonts (needs a curated-name contract), and
sender-logo images (outbound fetches + privacy posture — its own decision if
wanted).

## Addendum (2026-07-16) — tile previews + family-first weighting

Two extensions, one product intent: the map should read as "what needs me,"
not "what arrived."

**Previews in the tile.** Each `EmailTile` now carries up to 3 subtree
`preview` lines: pending magic titles first (they ARE the suggested to-dos),
then newest-unread subjects as filler; each line deep-links to its thread
(`/email/<id>`), skipping the sheet. No new LLM calls — magics reuse the
proposals `loadAttention` already fetched; unread subjects come from one
window-ranked query (`row_number() per category`) so a category whose unread
mail is old still gets its lines. Tiles render previews only when tall
enough; area ∝ attention means the tiles with the most to say are
automatically the biggest. "Most reply-worthy" ordering (an LLM judgment the
ADR 0072 briefing already computes) was considered and deferred — newest-first
is honest and free.

**Usefulness-scaled placement.** Attention is unread-driven, which let
newsletters/social mail dominate the map by sheer unread volume — the
opposite of a family app's priorities. The client scales each tile's
attention weight by a keyword usefulness factor (family/friends/school/kids
boosted ×1.75; newsletter/social/professional/promo damped ×0.35) before
squarify. Placement follows weight (heaviest = top-left), so this reorders
and resizes in one move. Client-side because it's presentation policy, and
the keyword approach matches the `category-emoji.ts` precedent. Considered
and deferred: a classifier-assigned usefulness score (prompt surface for
marginal gain), and **user-movable tiles** — free-form drag is meaningless in
a computed treemap, so the right shape is per-user pin/demote overrides;
those must survive the classifier's snapshot-replace (ADR 0066), which means
keying them by normalized title or making ingest preserve matched category
ids — its own small decision when wanted.

## Consequences

- The map is one API call (`deep=1`) instead of one per level; the tree is
  small (tens of nodes) so the rollup stays a single in-memory pass.
- `attention`/`magicCount` change when proposals resolve, so the client
  refreshes the map after the sheet closes; sizes can shift under the user —
  accepted (it is the point), softened by only refreshing on close.
- The thread-list response now embeds suggestion lookups (two extra indexed
  queries per page) — negligible at the 50-row page size.
- The narrow magic card truncates long titles at two lines; the full text is
  always one tap away in the thread view.
