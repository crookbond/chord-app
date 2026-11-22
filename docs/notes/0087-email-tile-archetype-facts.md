# 0087 — Email tiles carry archetype facts

**Status**: accepted
**Date**: 2026-08-17

## Context

Stage 1 ([ADR 0083](./0083-email-stage-1-shell-decisions-on-tiles.md)) made the
AI map a decision queue: tap opens pending proposals, badge/area follow open
decision count. Tile *faces* still showed magic snippets (ADR 0068 previews).
[`chord_email.md`](../tasks/chord_email.md) §12 wants a tile to render the
domain's **current answer** as well as badge the decisions that would change
it — Timeline, State board, Ledger — with a resolution rule so tiles shrink
on their own.

Finance extraction and shipping status did not exist. Building a ledger
chrome with invented amounts would be a worse Gmail. Action axis (ADR 0086)
is orthogonal (what you owe vs what the tile is about) and does not pick
the archetype.

## Decision

1. **`EmailTile.archetype` + `facts`** — a discriminated payload
   (`timeline` | `state_board` | `ledger`). `null` / omitted = unconverted;
   those tiles keep magic previews. Converted and unconverted coexist.
2. **Path-prefix map, not the LLM.** Category title path (root → leaf)
   chooses a hint: Deliveries → state board; Finance/Receipts → ledger;
   School/health/civic/kids/forms → timeline; Travel resolved at assemble
   time (dated events → timeline, else live status → state board).
3. **Assemble before inventing.** Timeline joins pending `create_event`
   proposals (`dueAt`) and confirmed `events` with `gmail:<threadId>`
   provenance. State board and ledger use **fail-closed** heuristics on
   subject+snippet (status keywords; `$`/`USD` amounts). No amount without
   a parsed number. Receipts/thank-yous without "due" are not debts.
   Facts are display claims — they do not auto-write To Do's.
4. **Resolution.** Timeline items drop when `at` is past. State rows drop
   when landed (delivered / arrived). Ledger never invents "paid"; a
   matching receipt is not a write, just omitted as a due line.
   Facts are **ordered before truncation** under a total order (timeline by
   instant, state exceptions first, ledger by soonest due) — the reads have
   no `ORDER BY`, so otherwise a tile face would show different lines per
   refresh. Instants are compared with `Date.parse`, never as strings: the
   sources mix `Z` with real offsets. A bare ledger due date takes the
   owner's offset per [ADR 0074](./0074-timezone-anchoring-and-invite-reconciliation.md).
5. **UI.** Converted faces show 2–3 fact lines instead of snippets. Tap
   still opens decisions (ADR 0083) with **Current state** above the batch
   cards and sources last. Badge remains open decision count.

Amends ADR 0068 previews **on converted tiles only**.

## Alternatives considered

- **One list component for every tile** — §12.1's stated mistake; rejected.
- **Finance-first ledger chrome** — impressive mockup, empty of extraction;
  rejected.
- **LLM picks the archetype** — path prefixes are stable and free; the
  classifier already chose the path.
- **Auto-create bill tasks from ledger facts** — would skip T2 consent;
  facts stay display-only.

## Consequences

- The extract read is scoped to categories whose path carries a hint, so the
  tiles request never scans the whole mailbox for regexes it can't use (a fact
  only reaches a tile from its own hinted path or a converted descendant).
- Digest / Roster / Dead letter stay unconverted until a later stage.
- Yield-based demotion (Stage 4) still governs rendering, not extraction.
- Stage 3 context/conflicts/tiers are unchanged.
