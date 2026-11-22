# 0242 — A chat message can be deleted; in a shared chat, only for you

**Status**: accepted
**Date**: 2026-10-12

## Context

A message, once posted, stayed forever: there was no delete endpoint
(`docs/subsystems/chat.md` listed it as a known gap). The owner asked for a way
to delete messages by selecting them, with a "select all", and a way to clear a
chat.

The first version deleted for everyone in the chat and limited each member to
their own messages. The owner chose the other meaning: **deleting is for me
only**.

## Decision

- `POST /groups/:id/messages/delete` takes either `ids` (at most 500) or
  `all: true`. `all` is "clear chat": the whole chat as it stands now,
  including history the screen never loaded.
- **Personal chat: the rows are removed.** There is nobody else to keep them
  for, and removing them makes the bot forget the exchange. A directive turn's
  hidden bot reply (ADR 0022) goes with the message it answered. Open devices
  are told through a `messages.deleted` event.
- **Shared chat: the delete is for the caller only.** The messages leave their
  view and stay for every other member, so any message can be chosen, not only
  their own.
  - Selected messages are rows in `message_hides (user_id, message_id)`.
  - Clearing sets `group_members.cleared_at`; anything posted at or before it
    is out of that member's view. One value covers a whole history, and later
    messages show as usual.
  - Nobody else is told, and no event is broadcast. The caller's other devices
    catch up the next time they open the chat (below).
  - The bot still reads those messages: they are still part of the chat for
    everyone else, and its answers are for the group.
- **One rule for "is this in my view"**: `inViewOf(userId)` in
  `messages.service.ts`, used by the message list, both search paths, and (as
  the same SQL) the chat list's preview and unread count.
- Because the SSE hub has no replay (ADR 0002), the chat screen drops, on every
  open and reconnect, any cached message that falls inside the newest fetched
  page but is no longer in it.
- **In the app**: a **Select** button in the chat header puts a checkbox on
  each row and replaces the composer with Select all / count / Delete.
  **Clear chat** is also a button in the chat's settings. Long-press still
  copies.
- **In chat**: `delete_messages { scope: "last" | "all", count? }`, proposable
  (the user taps a card). "Last N" is resolved to ids when the card is staged,
  so a message arriving before the tap does not change what is deleted. The
  card records who asked and only they can confirm it, since in a shared chat
  it acts on one person's view.

## What it does not do

- **Files are kept.** A file posted in chat is also a row in Attachments with
  its own delete (ADR 0037) and may back a trip or a search answer.
- Tasks, events, list items and anything else a message created are kept.
- Nothing is unsent from WhatsApp or another bridged app.
- There is no undo, and no way to remove a message from someone else's view.
- A message every member has deleted for themselves is still stored.
- Push notifications are not affected.

## Rejected

- **Delete for everyone, own messages only** (the first version): not what the
  owner meant by delete.
- **Hiding in the personal chat too**: one meaning everywhere, but the rows
  would stay in the bot's context and on disk for a chat with one member.
- **A hide row per message for "clear chat"**: thousands of rows to say what
  one timestamp says.
- **A tombstone** ("message deleted") in place of the message.
- **Telling the caller's other devices live**: needs a per-user stream the chat
  screen does not open; the reconcile on open covers it.
- **Deleting the attachment with its message**.
- **Direct delete from the bot tool**: it cannot be undone, so a tap confirms
  it (the ADR 0215 posture for moving mail to Trash).
