# ADR 0318 — A chat invite is an email address

**Status:** Accepted, 2026-11-02
**Amends:** ADR 0047 (shareable join links), ADR 0101 (two-person chats)

## Context

To message someone new in Chord you had to create a group, open its settings,
copy a code or link, send it to them some other way, and have them paste it
into "Join by code". The owner's verdict: joining by code is the wrong thing
to ask people to do. What a person knows about someone they want to talk to is
their email address.

The pieces already existed: ADR 0237 matches an email to an account on proof
(sign-in email, connected mailbox), emails go out from the user's own mailbox
through the draft + outbox path (ADR 0113/0115), `ensurePairGroup` makes the
two-person chat, and ADR 0047's `/join/<code>` route survives sign-in.

## Decision

"Message someone" on the Messages screen (and "Invite" in a group's settings)
takes an **email address** and an optional first message.
`POST /api/v1/chat-invites` (`inviteByEmail`, `services/chat-invites.service.ts`)
does one of three things:

1. **Already connected** — the address belongs to someone on Chord, and either
   of them has accepted an invite from the other before (`areConnected`: an
   `accepted` row in `chat_invites` in either direction). They are added now:
   the direct chat (`ensurePairGroup`) or the named group. `status: added`.
2. **On Chord, not connected** — they get an invite (a row with
   `invitee_user_id`, plus a note in their personal chat) and nothing else
   changes until they answer. Invites show at the top of their Messages list
   with Accept / Decline (`GET /me/chat-invites`, `POST …/:id/accept|decline`).
   Accepting makes the chat, posts the inviter's message, and connects them.
   `status: asked`. (Owner choice: accept first, never dropped into a chat
   they did not agree to.)
3. **Not on Chord** — an email from the inviter's own mailbox carries their
   message and the chat's `/join/<code>` link. A direct invite makes its chat
   up front (named `Chat with <email>` until ADR 0101 shows the other person's
   name) so the link exists, and the message is posted in it so it is there
   when they arrive. **Following the link is accepting** (`noteJoinedViaLink`
   on the join route): they are connected and the chat becomes their pair chat
   (`pair_key`) unless one already exists. A direct chat's link went to one
   person, so whoever follows it is them even if they sign in with another
   address; a group invite matches the address. Someone who signs up with the
   address without following the link finds the invite waiting in the app
   (`claimChatInvitesFor`, at sign-in). `status: emailed`, with `email`
   `queued` | `no_mailbox` | `failed` and the `link`, so the app offers
   "Copy invite link" when nothing was sent.

So the code is still how a stranger gets in — it is just never typed (owner
choice "code stays hidden"). The link and code remain in group settings for
sharing with many people at once; the Messages screen keeps a small "Got an
invite code instead?" link.

Someone who has blocked the inviter (ADR 0298) gets nothing, and the inviter
sees the same `asked` answer, so a block is not revealed. Repeats do not stack: a second invite while one is pending refreshes its
message. Refused: a bad address, the inviter's own address (any address they
have proved), a chat they are not in, their personal chat, someone already in
the group.

`chat_invites` (migration `139`): inviter, email, invitee (null until known),
group (null = direct chat made on accept), `direct`, `message`,
`message_posted`, status. Cascades with users and groups.

**Chat:** `invite_to_chat { email, groupName?, message? }` — from the 1:1 a
direct chat unless `groupName` names one of the user's chats (exact-or-ask),
from a shared chat that chat; the address must have a source (ADR 0214
addendum). `respond_to_chat_invite { accept, from? }`, personal-only. Replies
say only what happened (`inviteOutcomeText` in kernel for the app).

## Rejected

- **Adding existing users straight away** (how family invites work) — a chat
  someone did not agree to is the thing a block button exists for.
- **Removing codes entirely** — the link is still the right way to invite a
  whole soccer team.
- **A separate signed invite token** instead of the chat's join code — a second
  way in to keep secure; the join code already survives sign-in (ADR 0047).
- **Texting non-users** — Chord has no SMS sender (ADR 0237).

## Consequences

- An emailed direct invite leaves a one-person chat in the inviter's list until
  the other person arrives.
- Connection is per pair and permanent; there is no "disconnect" short of
  blocking (ADR 0298).
- Matching is on email only here; a verified phone is not accepted as the
  invite address.
