# 0237 — An invite to someone already here just seats them

**Status**: accepted
**Date**: 2026-10-10

## Context

The owner added his wife to the family plan with a Yahoo address and her phone
number. Two things were wrong, and they were two halves of one misunderstanding
of what an invite is for:

1. **Nothing was sent.** `inviteFamilyMember` reserved a seat, minted a link and
   returned the wording as a string. Delivery was the owner's job: the app opened
   a share sheet, and the bot was told to stage a `compose_email` card. Neither
   happened, so no email and no text ever existed.
2. **Her plan did not change.** A seat only became real when the invitee opened
   the link and accepted. She already had a Chord account — signed in with Gmail,
   phone verified, even a WhatsApp identity linked — and the plan still waited on
   her finding a message that was never sent.

The account was found by the verified phone alone: the typed Yahoo address
matched nothing, because her account signs in with a different address.

## Decision

**An invite to someone who is already on Chord seats them immediately; the
messages are a courtesy on top, not the mechanism.**

- **Match on proof, never on a name** (`family-contact-match.ts`). A contact
  point counts when the account itself demonstrated control of it: its sign-in
  email, a mailbox it connected (OAuth or an app password), or a phone it
  verified by code (ADR 0064). A bare 10-digit number is read as +1 (Chord signs
  up from North America today). Shadow accounts and unverified numbers never
  match. If the email and the phone point at *different* accounts, nobody is
  seated — the invite stays a link — because guessing wrong puts a stranger in
  the family chat.
- **Seating is the same act as accepting** (`seatInvitee`, shared with
  `acceptFamilyInvite`): the roster row goes `active`, the Chordinator grant the
  owner chose is applied, the person lands in the family chat (ADR 0234). So are
  the refusals (`seatBlocker`): already on another family plan, or paying for
  their own. Coverage still comes from the owner's plan every call (ADR 0231),
  so a lapsed plan covers nobody and nothing here changes that.
- **An invite sent before they had an account claims itself.**
  `claimFamilyInvitesFor` runs at sign-in and when a phone is verified — the two
  moments an account gains a provable contact point — so nobody has to find a
  link. Re-sending an invite also re-checks.
- **Chord emails, from the owner's mailbox** (`family-invite-delivery.ts`),
  through the same draft + outbox path as any message they compose (ADR
  0113/0115/0214): it comes from them, shows in their Sent, and has the chat
  undo window. The outcome is returned (`delivery.email`: `queued`,
  `no_email`, `no_mailbox`, `failed`) so the app and the bot say what happened
  instead of implying a send. The seated person also gets a message from Chord
  in their personal chat, which the existing push publisher turns into a push.
- **Chord does not send texts.** It has no SMS sender (Twilio is used only to
  verify numbers), and a WhatsApp message to a number that has not written to us
  needs an approved template. A text still comes from the owner's phone — the
  share sheet and the `sms:` card — which is also who the recipient expects it
  from. The card now appears whenever there is a phone and the person is not
  already seated.

## Consequences

- A person can be added to a family chat by someone else's typing. That is the
  owner's explicit intent and the account has proved the contact point, but it is
  a change from "you must accept". They are told, can leave the plan in Settings,
  and a mistyped address that happens to be another Chord user's sign-in email
  would seat that user — the reason matching requires the contact point to be
  *theirs* and refuses ambiguity.
- A person who joins the roster before the owner has an active family plan is
  seated but not covered until the plan is bought, as before.
- `FamilyInviteResult` gains `joined` and `delivery`; the bot tool's old
  `deliver` field is gone.
- Not covered: an email address connected to an account *after* the invite was
  sent does not trigger a claim (sign-in and phone verification do).

## Rejected

- **Sending the text from Chord** — no sender, and Meta's template rules for a
  first contact. Building one is a product decision, not a fix.
- **Matching on name** — "Alice" is two people in many families.
- **Keeping accept-by-link and just emailing it** — fixes the missing message
  and leaves the second complaint: someone already in the app still has to find
  and tap a link for a plan the owner already gave them.
- **Seating without telling them** — silent membership in a group chat is worse
  than either alternative.
