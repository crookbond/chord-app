# 0187 — A confirmed suggestion does not get a second chance

**Status**: accepted — implemented (uncommitted, worktree `insurance-cards-file-link-bug`)
**Date**: 2026-09-18

## Context

ADR 0180 made re-opening an email run its own read-time extraction pass, and
that pass is marked per-thread so it only ever runs once (the `read` kind,
independent of the background sweep's own `magic` mark). Asked directly:
if a user already confirmed an email-magic suggestion — the task or event is
already real — and later re-opens that same email, does taking the "Add"
action again create a duplicate, or does anything check?

Traced against the actual dedup code, not the ADRs describing it. Every
staging-time guard that exists — `threadAlreadyProposed`,
`shouldStageEventProposal`, `shouldStageTaskProposal`,
`shouldStageListItemProposal` (`event-convergence.service.ts`) — filters on
`status = 'pending'` only. None of them know a `confirmed` proposal from that
thread exists. Under normal operation this is harmless: the `read`/`magic`
extraction marks are never cleared (ADR 0110/0158), so a given thread's
extraction genuinely runs once, ever, and there is no second run to produce
the duplicate. But the guards are supposed to be the actual safety net, not
"safe because nothing calls them twice" — and there are real paths that DO
call them twice: an operational extraction-mark wipe (ADR 0158/0167 both
needed one, as a follow-up, for stale-mined threads), a second server process
racing the same thread, or a future pass added without remembering this one.
In every one of those, the guard would see zero *pending* duplicates (the
real one is now `confirmed`) and stage a fresh proposal for an obligation
that's already met — confirming it again is a genuine duplicate task/event.

Separately, and more visibly: `pendingSuggestionsForThreads` (the query that
docks the suggestion card beside a thread, ADR 0068) also filters on
`status = 'pending'`. The moment a suggestion is confirmed, the card just
silently disappears from the thread — indistinguishable from a rejected or
expired one, and indistinguishable from a thread that was never mined at
all. Re-opening a handled email today tells the user nothing about what
happened to it.

## Decision

**1. `threadAlreadyProposed` treats `confirmed` the same as `pending`.**
This is the one guard every staging site calls first, keyed on exact
provenance + tool name (not the fuzzy title matching the other guards do for
cross-thread dedup), so it's the precise fix for "this exact thread, this
exact obligation, already handled." `.where('status', '=', 'pending')`
becomes `.where('status', 'in', ['pending', 'confirmed'])`. `rejected` and
`expired` are deliberately left out — "not now" and "too late" both leave
the obligation open, unlike "done," and re-staging after either is existing,
correct behavior this ADR doesn't touch.

**2. `pendingSuggestionsForThreads` also returns a confirmed suggestion**,
with no `expires_at` check (a confirmed proposal is a settled fact, not a
live offer that ages out). `EmailMagicSuggestion` gains an optional
`status?: 'pending' | 'confirmed'`, set from the proposal row. The
digest/briefing (`pendingSuggestionsForUser`) and the AI-shell decisions
queue (`EmailDecisionsResponse`) are untouched — both are pending-only by
construction on purpose (a briefing shouldn't nag about something already
done), so their queries keep the original `status = 'pending'` filter and
never populate `status` on the suggestions they build.

**3. The client renders "already added" by reusing the state a fresh confirm
already produces**, rather than inventing a new visual state.
`MagicCard` (`email-magic.tsx`) already has a local `'added'` state — shown
as "✓ Added to calendar/to-dos/list" with the Confirm/Dismiss buttons
replaced by nothing, entered after a successful in-session confirm. Seeding
`useState`'s initial value from `magic.status === 'confirmed'` instead of
always `'idle'` makes a re-opened, already-confirmed thread render exactly
the same card a fresh confirm just produced — no new component, no new
styling, and no way to tap Confirm again because that button simply isn't
rendered in the `'added'` state.

## Alternatives considered

- **A distinct "already added" banner separate from the post-confirm
  state** — rejected: the post-confirm `'added'` state already says exactly
  the right thing ("✓ Added to calendar"), and a second visual for the same
  fact is the kind of two-copies-of-one-truth ADR 0085 keeps calling out.
- **Widen the fuzzy cross-thread title-matching guards
  (`shouldStageEventProposal` etc.) to also check confirmed proposals** —
  rejected as broader than the question asked. Those guards catch two
  *different* emails describing the same booking; the scenario here is one
  thread re-mined against itself, which `threadAlreadyProposed`'s exact
  provenance match already covers precisely. Widening the fuzzy matchers too
  is a reasonable follow-up but a separate decision with its own edge cases
  (e.g. a genuinely new, later obligation that happens to share a title).
- **Also treat `rejected` as "don't restage"** — rejected: a user dismissing
  a suggestion is saying "not now," not "never," and the obligation is still
  open. Silently refusing to ever offer it again would be a worse failure
  than the one being fixed.
- **Fix only the display (show "already added"), skip the dedup guard
  change** — rejected: the display fix makes the common case honest but
  does nothing for the actual duplicate-creation risk if extraction ever
  does run twice, which is the concrete failure mode a wiped extraction mark
  or a second process produces.
- **Fix only the dedup guard, skip the display** — rejected: leaves the
  original complaint unaddressed — a re-opened, already-handled email still
  looks exactly like a never-mined one, which is what prompted the question.

## Consequences

- Zero schema change — `proposals.status` already carries `confirmed`; this
  only widens which values two existing queries accept.
- `EmailMagicSuggestion.status` is optional and additive; every existing
  caller that doesn't set it (digest, decisions queue) is unchanged.
- A confirmed suggestion now has no expiry — it will keep showing "✓ Added"
  on that thread indefinitely, which is correct (it's a record of what
  happened, not a live offer).
- Does not address the fuzzy cross-thread matchers noted above; left as a
  narrower, separate concern if it comes up in practice.
- New tests: `event-convergence.service` gains a case asserting
  `threadAlreadyProposed` returns true for a `confirmed` row of the same
  provenance+tool; `magics.service` gains a case asserting
  `pendingSuggestionsForThreads` returns a confirmed suggestion with
  `status: 'confirmed'` and no `expires_at` gate.
