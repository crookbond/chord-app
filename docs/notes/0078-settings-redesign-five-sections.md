# 0078 — Settings redesign: five sections, collapsed cards, less jargon

**Status**: accepted
**Date**: 2026-07-19

## Context

Settings had grown to 16 flat cards — account, name, Listening,
IM mirroring, cross-group data, credits, LLM model, People, About me,
Google Calendar, Phone, Gmail, Calendars, assignment trust, Notifications,
Nudges — exactly the "intimidating settings" F&F pain point (Workstream
I1): a family member met "Listening: invocation/passive/active" and a
toggle warning about "leakage" before anything they'd actually use.

## Decision (owner-approved 2026-07-19)

**Five sections** with collapsed-by-default `Disclosure` cards (title +
one-line status summary; `openWhen` forces open on attention — a reconnect
deep link or a disconnected account — so problems never hide behind a
fold):

1. **Profile** — name · phone · about me · a compact People & birthdays
   link (People is content, not configuration).
2. **Plan & AI** — Chord credits (billing deploys; the buy surface) and
   the **AI model** card collapsed to a one-line summary ("Using your own
   key" / "System default") — the BYOK provider/model/URL/key form is
   power-user territory nobody meets uncollapsed.
3. **Connected accounts** — **one Google card** owning Calendar + Gmail:
   one grant, one summary line ("Connected · calendar ✓ · email ✓"), both
   connect flows, and the ADR 0072 Calendars list nested inside as
   sub-blocks. "Connected apps" (the renamed IM-bridge card) sits beside
   it; per-group mirroring stays only in each group's settings.
4. **Assistant** — assignment trust · Notifications · Daily briefing ·
   an **Advanced** disclosure holding the cross-group context toggle with
   rewritten plain copy (the old copy warned users about "leakage").
5. **Account** — signed-in-as, sign out, delete.

**Retired: the Listening card.** `active` was a greyed "coming soon" and is
effectively superseded by the ADR 0051 follow-up window; `passive` learning
runs server-side. `listening_mode` stays in the schema and the bot decision
logic — only the picker UI is gone (revisit if a real user asks to change
modes; the chat path via settings tools could return cheaply).

## Rejected

- Nested navigation (separate routes per area) — more plumbing than the
  problem needs; disclosures keep everything one tap deep with state.
- Phone-first auth — Google login stays the anchor (ADR 0014/0064: the
  Calendar + Gmail grants depend on it). The owner's underlying ask lands
  as onboarding work instead: phone verification + contacts permission
  move into the sign-up flow (Workstream I follow-up), settings just shows
  status.

## Consequences

- View-layer only: no server or kernel changes; all handlers/state kept.
- The Gmail reconnect deep link (`?reconnect=gmail`) now also force-opens
  the Google disclosure before scrolling to it.
- Verified: mobile tsc, web export, and live web render (all five sections,
  summaries, expand/collapse, Google sub-blocks).

## Addendum: People screen shows what Chord has learned

Same redesign wave (owner ask): People & birthdays is the person-centric
view of Chord's knowledge, not just a manual roster.

- **Learned facts per person**: `learnedFactsForPeople` attaches the
  owner's **confirmed** persona memories that mention the person
  (case-insensitive first-name containment, ≥3 chars, capped at 6) —
  rendered as chips under each person, alongside the ADR 0076 `email`
  anchor. Proposed memories never surface here; the Memory tab stays the
  consent surface.
- **Pending suggestions strip**: `GET /me/people/pending`
  (`listPendingPersonSuggestions`) lists undecided `add_person` /
  `add_important_date` proposals (chat- or email-derived) at the top of
  the screen with Add/✕ through the standard proposal routes — the same
  decision, one more natural place to make it.
- Wire changes are additive (`PersonWithDates.email?/facts?`, new
  endpoint) so older app builds keep working.
- **About-Me consistency (owner ask)**: facts typed into About Me follow
  the exact same shape as email-derived ones. Memory proposals were already
  the case (`extractMemoriesFromAboutMe` stages `proposed`); now relation
  facts (`spouse_name`, `kid_name`, …) ALSO stage `add_person` proposals via
  the shared `stagePersonProposal` helper (dedup against known people +
  pending proposals; notes read "spouse (from About Me)"). One consent
  format everywhere: typed, chatted, or emailed → proposal → ✓/✕.
- Trade-off: name-containment matching can over- or under-attach a memory
  to a person (two people sharing a first name; a fact not naming anyone).
  Accepted for v1 — facts are display-only here and always editable in the
  Memory tab. Test: `people-screen.integration.test.ts`.
