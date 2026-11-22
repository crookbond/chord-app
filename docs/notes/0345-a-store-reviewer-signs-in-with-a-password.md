# ADR 0345 — A store reviewer signs in with a password

**Status:** Accepted (2026-11-17)
**Amends:** ADR 0014 (Google-only auth for real users)

## Context

Google Play rejected version code 5: its reviewer signed in with our Google
demo account and Google stopped them at "verify it's you", because the account
had never been used on that device. Play's own wording asks for "a dedicated
test bypass or standard login credentials that do not require your account to
be linked to our testing devices". Apple App Review has the same exposure
(the submission notes already warn about it). Chord has no login of its own:
Google, Apple and Microsoft all decide for themselves when to challenge a new
device, and we cannot turn that off.

## Decision

One email + password that opens one account, for store review only.

- `REVIEW_SIGN_IN_EMAIL` + `REVIEW_SIGN_IN_PASSWORD` (a secret, in Secret
  Manager). Off unless both are set and the password is 20+ characters.
- `POST /api/v1/auth/review` (`review-sign-in.service.ts`): both halves are
  compared with `secretsEqual` (hashed, constant time), one 401 for any wrong
  email or password, 404 while off. It sits under the existing
  `/api/v1/auth` limiter. Every success and refusal is logged with the IP.
- It opens the existing non-shadow account whose email is the review email
  (case-insensitive), else creates an empty one. The intended setup: the owner
  signs in to Chord ONCE with the demo Google account on their own device and
  connects its mail and calendar, so the reviewer lands in a full account
  without ever signing in to Google. Google's refresh token is already on the
  server; nothing about the device the reviewer uses matters to it.
- `/health.reviewSignIn` tells the app; the sign-in page then shows a small
  "App review sign-in" link that opens the email and password fields (all
  platforms, same component). Nothing shows while it is off.

## Consequences

- Anyone with the password reads the demo account, including its mailbox.
  That account must hold only demo data; the email must never be a real
  person's, since the password would open their account. This is the one
  rule the operator must keep, and the code cannot check it.
- Turn it off after review by emptying the password; the link disappears on
  the next app start.
- The session is an ordinary one: account deletion, sign-out, AI consent and
  the free allowance all apply as for any account.

## Rejected

- **A Microsoft/outlook.com demo account.** No code, but Microsoft challenges
  new devices too, so it can fail the same way.
- **Turning off the Google account's protections.** Not ours to turn off;
  2-Step off and prior sign-ins only make a challenge less likely.
- **Password accounts for everyone.** A new identity system (reset, breach
  handling) for a problem only reviewers have.
- **A hidden gesture instead of a visible link.** Reviewers follow written
  steps; a visible, plainly named link is easier to describe and honest.
