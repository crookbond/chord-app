# 0039 — External-action deep links

**Status**: accepted — server + mobile wired 2026-05-05 (PR-F). Renumbered from 0022 → 0039 on 2026-06-01 to resolve a duplicate-number collision with the quiet-mode ADR (which had code references to "ADR 0022").
**Date**: 2026-05-05

## Context

Chord can record bookings (events, reservations, accommodations) but can't
*make* them. When the user says "book us a table for four at Antico
Saturday at 7," the bot has nothing actionable to offer beyond writing it
into a task. The product wants a tappable card that drops the user into
OpenTable / Google Flights / Expedia / Viator pre-filled with whatever
context the bot has.

A "proposal" with deep link URLs was on the Phase 4 list as PR-F. The
proposal table (ADR 0009) is more machinery than this needs — there's
nothing for the user to confirm, just a link to follow.

## Decision

Add a single read-only tool, `suggest_external_action`, that takes a
`kind` ∈ {`restaurant`, `flight`, `hotel`, `activity`}, a user-facing
`label`, and a structured `query`. The tool returns a `BotCard` of a new
`action` kind carrying a `url` field. Mobile renders the card as a
`Pressable` that opens the URL via `Linking.openURL`.

URL construction is centralized in `services/bot/external-actions.ts` —
one builder per kind, pure functions. Providers chosen for breadth, not
affiliate revenue:

| kind | provider | URL surface |
|---|---|---|
| restaurant | OpenTable | `opentable.com/s?term=…&covers=…&dateTime=…` |
| flight | Google Flights | `google.com/travel/flights?q=Flights from X to Y` |
| hotel | Expedia | `expedia.com/Hotel-Search?destination=…&startDate=…&endDate=…` |
| activity | Viator | `viator.com/search?text=…` |

The bot never assembles URLs itself — it only fills `query` fields. This
keeps the trust boundary tight (the LLM can't smuggle arbitrary `javascript:`
URLs through) and makes provider swaps a single-file change.

## Alternatives considered

- **Reuse the proposals table.** Adds a confirm/reject UI burden when
  there's nothing to confirm. The card is the action.
- **LLM emits the URL directly.** Lets the LLM pick the provider but
  invites prompt-injection: a malicious file could coax `javascript:` or
  `data:` URLs into a bot message. Builders eliminate the attack surface.
- **Affiliate codes baked in.** Out of scope for the demo. One-line
  change per builder when revenue matters.

## Consequences

- One new tool name, one new BotCard kind (`action`), one new optional
  `url` field on `BotCard`.
- Mobile `cardIcon` adds `↗` for action cards; tapped cards open in the
  system browser. No in-app webview yet.
- The bot can now answer "book us a hotel in Tokyo Sept 10–15" with an
  Expedia card pre-filled with destination + dates.
- Adding new providers (Resy, Airbnb, GetYourGuide) is a one-builder
  change with no schema or kernel-type churn — only the `kind` enum
  grows.
- Out of scope: in-app webview, tracking which suggestions the user
  tapped, server-side bounce/affiliate links, deep-link-back ("the user
  completed the booking"). These are downstream PRs if/when warranted.
