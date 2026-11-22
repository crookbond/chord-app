# 0230 — Google sign-in asks for mail and calendar together

Status: accepted (2026-10-11).

## Context

Google sign-in asked for Calendar only. Gmail was a second consent the user had
to find in Settings (ADR 0062), on the reasoning that a restricted scope on the
first screen costs sign-ups and that Google prefers incremental consent.

The site now presents Chord as a mail reader. A new user signs in and lands in
a product with no mail connected, and the "Getting started" steps promise mail
"within a minute or two" of a step they have not been shown.

## Decision

The sign-in consent requests `gmail.modify` alongside `calendar`, when the
server reads Gmail (`/health` → `gmail`, which is `GMAIL_ENABLED`; an older
server that omits the field is treated as on). After a successful sign-in the
client starts a mail sync straight away instead of waiting for the background
pass.

No server change to the sign-in route: it already stores whatever scopes Google
reports as granted.

## Alternatives considered

- **Keep two consents, prompt for mail as the first screen after sign-in** —
  the policy-friendly shape, and the first recommendation. Owner chose the
  single consent: one popup, no second step to lose people at.
- **Always ask, ignoring `GMAIL_ENABLED`** — asks for a restricted scope the
  deployment would never use.

## Consequences

- Google shows a checkbox per scope, so a user can still sign in with Gmail (or
  Calendar) unticked. The Settings connect flows stay; they are how that user
  adds it later, and how an Apple-only user connects Google at all.
- Every Google sign-in now counts towards the 100-user cap on an unverified app
  with sensitive or restricted scopes. Before this, only users who connected
  Gmail were asked for the restricted one.
- The verification demo video shows one consent screen with both permissions.
- The post-sign-in sync fails quietly when Gmail was left unticked.
- Native apps pick this up with the next JS update; no new build.
