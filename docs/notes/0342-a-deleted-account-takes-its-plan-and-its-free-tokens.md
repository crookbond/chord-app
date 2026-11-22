# ADR 0342 — A deleted account takes its plan and its free tokens with it

**Status:** Accepted, 2026-11-16. Amends ADR 0043 (account deletion) and
ADR 0325 (free allowance).

## Context

Asked "if a subscriber deletes their account and comes back, are the credits
restored?", the code answered worse than no:

- `deleteAccount` deletes the user row and never calls Stripe. The
  subscription keeps renewing; each `invoice.paid` finds no user (the customer
  link and the user id in its metadata both pointed at the deleted row), the
  webhook answers 500, Stripe retries and gives up. **The person is charged
  every month and nothing is granted.**
- Coming back is a new account, and ADR 0325 counts the free allowance from
  sign-up, so it starts with a fresh 10M free tokens: delete-and-return resets
  the free allowance.
- The delete box said nothing about a plan; an App Store plan, which only the
  device can cancel, was never mentioned.

## Decision

1. **Deletion cancels a Stripe plan first, or does not happen.** Before the
   teardown, a user with a Stripe subscription that is still live has it
   cancelled immediately (`cancelSubscriptionNow`; no proration refund). If
   Stripe cannot be asked or refuses, the deletion is refused (502, "your plan
   could not be cancelled, nothing was deleted") — deleting anyway is the bug
   above. A subscription Stripe already reports ended is left alone. A family
   owner's plan is cancelled the same way; the members lose cover at once,
   which they already did when the owner row went.
2. **The delete box says what happens to the plan** (`deleteAccountPlanNote`,
   kernel): your Stripe plan is cancelled now with no refund; an App Store plan
   must be cancelled in iPhone Settings (Chord cannot); a family owner's
   members lose the plan too. A member covered by someone else's plan is told
   nothing — it is not theirs.
3. **A deleted account's free tokens stay spent.** Deletion writes one-way
   fingerprints of the account's sign-in identities to `spent_free_allowances`:
   the email, `google_sub`, `apple_sub`, `microsoft_sub`, and the verified
   phone's `phone_hash`, each as SHA-256 of `v1:<kind>:<normalised value>`.
   `getEntitlement` reaches the free allowance only when no plan applies; there
   it checks the account's own identities against that table and, on a match,
   the free allowance is 0. Checked at entitlement time, not at sign-up, so an
   identity linked later (connect Google after signing in with Microsoft) also
   counts. Paid plans, grandfathering and BYOK are untouched.

## Consequences

- The fingerprints are kept after deletion on purpose and indefinitely. They
  are one-way but not anonymous to someone who already holds the address
  (anyone can hash a guessed email); the privacy policy says Chord keeps them
  to stop free tokens being claimed twice.
- A person who comes back with only new identities (a new email, no phone
  shared with the old account) gets a free allowance again. Accepted: closing
  that needs identity proof Chord does not ask for.
- An attached mailbox address is not fingerprinted (it may be a child's or a
  shared one; ADR 0293's reasoning).

## Rejected

- **Deleting without cancelling and relying on Stripe's retries to give up** —
  the person keeps paying.
- **Cancelling at period end** — the account is gone, so nothing could use the
  rest of the period; it would only be billed again if anything failed.
- **Checking at sign-up and storing a flag** — six creation paths to remember,
  and it misses an identity linked afterwards.
- **Plain addresses instead of fingerprints** — keeps more than the purpose
  needs.
