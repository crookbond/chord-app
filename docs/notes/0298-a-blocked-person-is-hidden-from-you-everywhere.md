# 0298 — A blocked person is hidden from you, everywhere

**Status**: accepted
**Date**: 2026-10-25
**Amends**: ADR 0067 (the `blocks` table gains a UI and a reader)

## Context

App Store guideline 1.2 asks an app where users post to each other for a way
to block abusive users (and to report content, below). Chord's group chats are
invite-only, but a member of a family or friends chat can still post something
another member does not want to see, and there was no Block button anywhere.
The submission packet (`docs/ops/app-store-submission.md`, Risks) names this as
a rejection risk.

A `blocks (blocker_user_id, blocked_user_id)` table already existed from ADR
0067, read only by `message_user`: a recipient who blocked the sender is not
messaged. Nothing wrote it outside tests, and no screen showed it.

The owner asked for Block from a chat: long-press a person's message, or tap
their name.

## Decision

**A block is one user's, across every chat, and only changes what the blocker
sees.** After A blocks B:

- **A no longer sees B's messages in any chat they share**, including ones
  sent before the block. The rule is added to `inViewOf(userId)` in
  `messages.service.ts` (ADR 0242's "is this in my view"), so the message
  list, both search paths and "delete the last N" follow it, and the same SQL
  is added to the chat list's preview, last-message time and unread count in
  `listGroupsForUser`. Messages arriving live over SSE are dropped by the chat
  screen, which loads A's block list when it opens: the hub fans one message
  to every subscriber of the group channel, and filtering per subscriber there
  would put a database read on every broadcast.
- **A gets no push for B's messages** (`selectRecipientTokens`).
- **Neither can start a direct chat with the other through `message_user`.**
  B → A was ADR 0067's rule (`reason: 'blocked'`); A → B is new
  (`reason: 'you_blocked'`), since any reply would be hidden from A anyway.
- **B is told nothing and sees nothing different.** B's own view, B's pushes
  and the chat for everyone else are unchanged. This is the norm for a block
  and the only version that does not tell an abusive person they were noticed.
- **The bot still reads B's messages.** It answers for the whole chat, as with
  ADR 0242's hides.
- **Blocking leaves nobody's chat.** A shared chat holds other people, and a
  two-person chat with B simply goes quiet for A. Leaving is a separate,
  existing action (ADR 0259), and the confirm text does not promise it.
- **Reversible.** Unblock removes the row and B's messages show again,
  including those sent while blocked (they were hidden, never deleted).
- **Only someone A shares a chat with can be blocked.** A stranger's id and an
  unknown id both answer `404 not_found`, so the route cannot be used to test
  whether an id exists. Blocking yourself is `400 self`. Unblock always works.

### Surfaces

- **Routes** (`me.ts`, paths in `kernel/src/api.ts`): `GET /me/blocks` lists
  `BlockedUser { userId, name, blockedAt }`, `POST /me/blocks { userId }`
  blocks, `DELETE /me/blocks/:userId` unblocks.
- **Chat screen**: on someone else's message (not the bot's, not in the
  personal chat), a long-press or a tap on their name opens an action sheet
  (`ActionSheet` from `email-reader-bar.tsx`, a modal, so the same on iOS,
  Android and web) with **Copy message** and **Block <name>**. Block asks
  through `confirmDestructive`, saying exactly what happens. Long-press on
  your own or the bot's message still copies, as before.
- **Settings → Profile → Blocked people**: the list, each with Unblock.
- **Chat**: `block_user { name }`, `unblock_user { name }`,
  `list_blocked_users {}`, personal 1:1 only, calling the same service
  functions as the routes (`blockMember`, `unblockUser`, `listBlockedUsers`).
  Names resolve exact-or-ask (ADR 0077/0094): an exact match on full name,
  first name, preferred name or username acts; two exact matches return
  `ambiguous` with candidates; none returns `not_found` with near misses.
  `block_user` looks only among people the asker shares a chat with,
  `unblock_user` only among people they blocked.

## Not covered

- **Reporting content.** Guideline 1.2 also asks for a way to report
  objectionable content and for the developer to act on reports. That is not
  built here. A report needs somewhere to go (an inbox someone reads) and a
  response promise, which is an owner decision, not a code one.
- **Bridged chats.** A message forwarded to WhatsApp or Telegram (ADR 0055) is
  delivered by that service; a Chord block does not hide it there.
- **Files and other records.** A blocked person's uploaded files, tasks, list
  items and events stay visible in the shared chat's tabs. The guideline is
  about user-to-user posts, which are messages.

## Rejected

- **Hiding the blocked person's messages from everyone, or removing them from
  the chat.** That is moderation, which belongs to a chat's owner or to
  reporting, not to one member's block.
- **Telling the blocked person.** Invites retaliation and is not what any
  mainstream chat app does.
- **Filtering live messages on the server per subscriber.** A database read
  per subscriber per broadcast to save a client-side filter the screen can do
  with a list it already has.
- **Leaving a two-person chat on block.** Leaving is already one tap away and
  a block that also leaves cannot be undone by Unblock.
