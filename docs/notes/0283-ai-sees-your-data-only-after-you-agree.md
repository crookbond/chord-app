# 0283 — The AI sees your data only after you agree

**Status**: accepted
**Date**: 2026-10-20

## Context

Apple's guideline 5.1.2(i) says an app must say where personal data is shared
with a third party, "including with third-party AI", and get explicit
permission before sharing it. Chord sends messages, email, calendar details
and files to a model provider (and to an embedding provider for meaning
search, ADR 0276). The privacy policy said so, but nothing in the app asked.
It was the most likely App Store rejection.

At the same time the owner widened who may use Chord: **any age, with a
parent's or guardian's consent**. Google requires a parent's approval before
a supervised (Family Link) child account can sign in to an app, so a child
under 13 reaches Chord only through an account a parent manages.

## Decision

- **One recorded decision per user**, `users.defaults.ai_consent`
  (`{ decision: granted | declined, at, recipient, ageConfirmed }`, ADR 0255's
  key-value store, no migration). `recipient` is the sentence the user was
  shown, kept so we can say later what they agreed to.
- **No AI without `granted`.** `hasAiConsent` is checked at the two choke
  points that pick a model (ADR 0257): `getLlmForUser` / `resolveTurnLlm`
  return a model that refuses every call (`AiConsentRequiredError`), and
  `getEmbedderForUser` returns null (keyword search only). That is the
  backstop; the main entry points also check first so they skip cleanly
  instead of logging failures: the bot turn, the email AI passes after a sync
  (the mirror keeps syncing), the embedding sweep, the morning briefing
  (sent as the deterministic no-model teaser, like ADR 0079's gate), the other
  proactive model kinds (skipped), the reply composer and the Findings chat.
  A call with no user (system work) is not affected.
- **Asked in the app, before anything else.** A signed-in user with no
  decision lands on `/ai-consent` instead of Action Items. It names who
  receives what (the real provider: e.g. "OpenRouter, which passes it to
  OpenAI (gpt-4.1-mini)", or the user's own key's provider), lists what is
  sent, says nothing is sold or used for advertising, and offers **Allow** or
  **Not now**. Allow needs the box "I'm 18 or older, or my parent or guardian
  agreed to let me use Chord" (the server refuses a grant without it, now or
  from an earlier answer); Not now never does, since saying no must always
  work. Not now keeps the app working without AI (mail, calendar, lists, chat
  between people). Settings → AI model shows the decision and turns it on or
  off; a first yes from Settings goes through the screen for the age box.
- **Asked in chat too**, for people who reach Chord only through WhatsApp or
  Telegram. Without consent a bot turn runs no model; it posts a fixed
  message explaining the same thing and saying to reply **AGREE** (or **NO**).
  Those two words, alone, are read in code and recorded. In a shared group
  the reply only says AI is off for that person and where to turn it on.
  Withdrawing in chat is a bot tool, `withdraw_ai_consent` (personal chat
  only), since a model can run while consent exists.
- **Existing users are asked too.** Nothing is backfilled: having used Chord
  before this screen existed is not permission. They see the screen on their
  next open, or the chat message on their next message; until then their AI
  passes pause.
- **`AI_CONSENT_REQUIRED`** (default `true`) switches the whole gate off. The
  test suite runs with it off so existing tests keep testing what they test;
  the consent tests turn it on.
- Privacy policy and Terms say any age with a parent's or guardian's consent,
  and that a child under 13 uses Chord only by signing in with a Google
  account a parent supervises (Family Link), where the parent approves the
  sign-in. Sign in with Apple is not named for under-13s: we have not checked
  that Apple asks a parent before a child's account signs in to an app. The
  privacy policy gains an "AI and your permission" paragraph.
- Text extraction and the keyword index of an uploaded file still run without
  consent (no model involved); the summary and the auto-filers do not.

## Consequences

- On deploy, every current user's AI stops until they agree (the briefing
  becomes the short teaser). That is the point of the rule, but tell the
  family testers first.
- A shared group's context can still contain messages from a member who
  never agreed, when someone else who did agree asks the bot. The gate is on
  the person who triggers the turn. Filtering other members' messages out of
  context is not done here.
- The age box is a statement, not verification. Under-13 use relies on the
  parent-managed account (Google Family Link's approval). COPPA's
  "verifiable parental consent" is a legal question this ADR does not settle.
- App Store age rating and the Play content rating now need answering for an
  all-ages app; the privacy labels are unchanged.

## Rejected

- **Consent implied by the privacy policy** — what Apple's rule says is not
  enough.
- **Backfilling consent for existing users** — records an agreement nobody
  gave.
- **Gating only in the app** — WhatsApp/Telegram users would never be asked
  and their data would still go to the model.
- **Only the choke point, no entry-point checks** — every sync and sweep
  would log a refused model call for each user who said no.
- **A bot tool to grant consent** — the model cannot run before consent
  exists; the words AGREE / NO are read in code instead.
