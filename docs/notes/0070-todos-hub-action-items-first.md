# 0070 — "To Do's" hub: Action Items first, Finance scaffold, Files → Attachments

**Status**: accepted
**Date**: 2026-07-15

## Context

The Catchup tab collected everything the user might act on (tasks, lists,
saves, trips, files), but the highest-signal items — email-derived suggestions
(ADR 0063 magics) — were scattered as "Proposed" sub-blocks inside whichever
section matched their tool (an event suggestion under Calendar, a list item
under Lists). The tab's name also described the mechanism ("catch up on what
happened") rather than the user's job ("what do I need to decide/do").

## Decision

- **Rename Catchup → "To Do's"** (bottom-nav label, screen titles, bot prompt
  language). The **route segment stays `/catchup/*`**: ADR 0059 search-card
  hrefs, deep links, and the server's catchup-folder tables all reference it,
  and a URL rename buys nothing user-visible.
- **Sub-tab order: Action Items · Tasks · Lists · Saves · Trips · Finance ·
  Attachments.** Landing tab is **Action Items**: every pending proposal whose
  `provenance` starts with `gmail:` (the email-magics marker), with one-tap
  confirm/reject and the standard audit trail. The same suggestions still dock
  beside their email rows (ADR 0068) — resolving in either place resolves both,
  since both go through the proposal routes.
- **Finance is a scaffold** — the chip exists with a placeholder; content
  (bills/statements/receipts surfaced from the email classifier) is a
  follow-up decision, deliberately not guessed at now.
- **Files → Attachments** (label only; tab key + `/catchup/files` href stay).
  Pairs with ADR 0071: attachments now also arrive from email, so "Files"
  under-described the surface.

## Alternatives considered

- **Rename the route to `/todos/*`** — breaks stored search-card hrefs and
  adds a redirect layer for zero user value.
- **Action Items as a merged view of ALL pending proposals** (bot-proposed
  tasks from chat too) — chat proposals already surface as pills in the chat
  itself; duplicating them here dilutes the email-triage purpose. Revisit if
  users ask.

## Consequences

- `CatchupTab` gains `actions` + `finance`; deep links to `/catchup/tasks`
  etc. keep working; `/catchup/actions` is the new default landing.
- Internal identifiers (tables `catchup_folders`, API paths, component names)
  keep the catchup name — rename is presentation-layer only.
