# 0023 — Richer trigger context (group roster + snapshot)

**Status**: accepted — server wired 2026-05-05 (PR-G).
**Date**: 2026-05-05

## Context

Before this change the system prompt knew, for the bot's group:

- The last 30 messages.
- Memories (passive + extracted facts).
- Upcoming events.
- Per-attachment FTS excerpts (ADR 0021).
- The triggering user's About-Me + cross-group personal data (when opted in).

It did *not* know:

- Who else is in the group. The bot had to grep the 30-message window to
  find names, which fails for quiet members and for `@-mention` style.
- That the group already has a "Costco" list, an open "book dentist"
  task, or three saved ramen links — unless the model speculatively
  called `list_tasks` / `search_saves` on every turn.

ADR 0005 (iterative tool use) makes follow-up tool calls cheap, but the
bot still has to *know what to ask for*. Without a hint that anything
exists, the model defaults to inventing or asking the user to repeat.

## Decision

Add two short blocks to the non-personal-chat system prompt:

1. **`Members of this group:`** — every `group_members` row joined to
   `users`, marked with `(you, the speaker)` for the triggering user
   and `[owner]` for the group owner. Includes shadow users — they're
   real participants in the bridged conversation.
2. **`Group's record:`** — a one-line-per-bucket summary:
   - Tasks (N open): "title1", "title2", "title3"
   - Lists (N): …
   - Saves (N): …
   - Trips (N): "name" (start→end), …

   Counts use the full set; only the three most recently created are
   inlined. Titles are clipped to ~60 characters. The block is omitted
   entirely when every bucket is empty.

Personal chats skip the roster (one user) but keep the snapshot.

## Alternatives considered

- **Inline full lists.** Rejected — token cost grows with history; the
  iterative tool loop already handles deep lookups.
- **Recent-activity feed (last N entity changes).** Rejected for now —
  the existing 30-message window plus the snapshot already give the bot
  continuity. Add later if real-world traces show recall gaps.
- **Materialized "group summary" cache.** Rejected as premature —
  per-turn the four queries (tasks/lists/saves/trips) are already cheap
  on SQLite. Cache when the cost shows up in a profile.

## Consequences

- Four extra reads per turn (tasks, lists, saves, trips). All indexed
  by `group_id`. Negligible at the demo scale; revisit if turn latency
  changes.
- Bot can now address members by name without prior history, and can
  decide whether a deeper read is worth the iteration.
- Roster intentionally lists shadow / guest-tier users — they're
  participants the bot will see speaking via bridges. Privacy implications
  are the same as existing memory disclosure (ADR 0007).
- Out of scope: per-member presence, per-member recent-activity
  attribution, "you've talked to X most recently"-style hints.
