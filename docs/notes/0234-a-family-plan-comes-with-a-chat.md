# 0234 — A family plan comes with a chat

**Status**: accepted
**Date**: 2026-10-09

## Context

ADR 0231 built the family plan's roster: who is seated, who is a Chordinator.
It is a billing fact, and it left the people on it with nowhere to meet. ADR
0232/0233 then made events and trips personal by default with sharing an offer
to "a group" — but a family that had just joined had no group to be offered,
so the offer fell back to whatever groups the owner happened to be in (often
none, or several, which offers nothing).

The owner's ask: family members who are Chordinators get a group right away,
and the user can forward or share things to it.

## Decision

**Accepting a family invite lands the person in the family's chat.** The first
acceptance creates it (named "<Surname> Family", marked deliberate so a
two-person chat keeps its name — ADR 0101 — and greeted by one bot message);
every later acceptance is added to the same chat. It is an ordinary
`kind='group'` group, marked only by `groups.family_owner_id` (migration 102,
partial-unique, one per owner), so fan-out, the bot, per-member mute and trip
sharing all work with no special case. Members get personas on arrival (ADR
0151's roster), so "assign it to Priya" resolves.

- **Created on first acceptance, not on first add.** A roster of profiles and
  unanswered invites would otherwise be a one-person group nobody can use.
- **The seat and the chat move together.** Removing a member or leaving the
  plan takes the person out of the chat (`leaveGroup`, so ownership and the
  3-to-2 name rule keep working); the reverse is not true — leaving the chat
  does not end a seat, and nothing about coverage is decided here.
- **Chordinator is unchanged** (the trust grant of ADR 0026, applied on
  acceptance): the chat is for everyone seated, the grant is a separate
  decision the owner makes per person.
- **The family chat is offered first.** `suggestTripShareGroups` prefers it
  when the asker has one, even beside other groups; with none, the old rule
  (a name match, else the single shared group) stands. Events keep their
  deterministic name match — roster personas make a family member's name hit
  the chat without a new rule.
- **Forwarding is a post, and a deliberate one.** `message_group` (text) and
  `share_email_with_group` (an email thread) post into a group the user is in;
  no name means the family chat, and a name goes through the exact-name-or-ask
  resolver (ADR 0077/0164). `POST /me/email/threads/:id/share` and a "Share to
  family chat" row in the reader's More menu do the same from the app. An
  email is shared as text — sender, subject and the newest message with quoted
  history folded away (ADR 0121), capped at 1,500 characters; attachment names
  are listed, files are not copied, and the rest of the mailbox is untouched.
  Both tools are personal-only (they act across groups, and one reads private
  mail — ADR 0084), and neither asks for a second confirmation: the user's own
  words are the confirmation, as for `message_user`.
- **The app lands people in it.** The join screen opens the chat after a family
  invite; the Family card has an "Open family chat" button for owner and member.

## Alternatives rejected

- **A pair group per member.** Several one-to-ones leave the owner with N
  groups, so ADR 0233's "exactly one shared group" fallback never fires and
  "tell the family" has no single target. A pair group already exists between
  any two Chord users (ADR 0067) for the one-to-one case.
- **Creating the chat when the plan is bought.** Nobody is in it yet.
- **Sending the email itself.** `forward_email` already stages a real forward
  to an address (ADR 0214); a family member is in Chord, and a chat post keeps
  the discussion beside the thing being discussed.
- **Confirming each post.** The user asked for it in words or tapped a labelled
  row; a second yes is friction on an act they just performed.
- **Copying attachments into the chat.** Files are the family's own business to
  re-share deliberately (`send_file`); copying them by default is the sort of
  quiet widening ADR 0032 exists to prevent.

## Consequences

- A profile-only member (a young child with no account) has no seat in the chat;
  the roster still lists them, and ADR 0151's managed personas are how a kid
  gets tasks without an account.
- Members of an existing family plan seated before this ships have no chat until
  the next acceptance; the plan is unreleased, so no backfill was written.
- Removing a member leaves their past messages in the chat, as leaving any group
  does.
- Not verified on a device: the join screen's link to the chat and the reader row
  were checked only by typecheck.

## Addendum 2026-11-10: the bot asks before it posts to a group

`message_group` and `share_email_with_group` posted straight into the group.
The bot picks the group from a spoken name (or defaults to the family chat)
and writes the text, so a wrong guess about either was already in front of the
whole family, and deleting a message in a shared chat only hides it for the
poster (ADR 0242). Owner decision: confirm first, like `compose_email` and
`trash_email` (ADR 0214). This reverses the "Confirming each post" rejected
alternative above: these two tools were direct on purpose when this ADR was
written, so the "nothing goes without a tap" rule (ADR 0107/0214) had only
ever covered mail leaving Chord. `message_user` (ADR 0067) stays direct by
owner decision (2026-11-10): a message to one named person is fine without a
card.

- Both are in `PROPOSABLE_TOOLS`. Staging (`resolveGroupPostTarget`) resolves
  the group exactly or asks (unchanged rules), checks the email is the asker's,
  and pins on the card, in fields the model never sees (`INTERNAL_TOOL_FIELDS`,
  ADR 0102): the group id and name, `forUserId` (only the asker's tap counts),
  and for an email its subject, sender, date, the opening of the message and
  the attachment names. Anything the model put in those fields is dropped.
- The card shows exactly what goes where: "Post to Doe Family" with the whole
  text, or "Share with Doe Family: <subject>" with the sender, the message and
  the files that are only named. Buttons are **Post** / **Share** + Cancel, so
  WhatsApp and Telegram can answer it too (ADR 0296).
- The tap shares the message the card showed (`messageDate`), not a reply that
  arrived in between.
- A call that reaches commit without a pinned group posts nothing
  (`needs_confirmation`); a bot turn always stages.
- The tool descriptions say nothing is posted until the tap: the bot says the
  card is waiting, never that it was posted.

The app's "Share to family chat" row in the email reader
(`POST /me/email/threads/:id/share`) is the user's own tap and still posts at
once.
