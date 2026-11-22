# 0259 — A chat can be cleared, left or deleted from the Messages list, and by asking

**Status**: accepted
**Date**: 2026-10-16
**Extends**: ADR 0242 (deleting messages), ADR 0045 (leaving a group)

## Context

Clearing, leaving and deleting a chat all existed, but only three taps deep inside
each chat's settings. The Messages list, where a person actually looks at the pile of
chats they want gone, had no swipe, no long-press and no menu. And there was no way to
say it: `delete_messages` could clear a chat's messages, but nothing could leave or
delete the chat itself, against the rule that every UI capability needs a bot tool.

## Decision

- **Messages list.** A long press on a row, or its **⋯** button (the long press is
  invisible and a mouse has none), opens a sheet: *Clear chat* for every chat, *Leave
  group* for a shared chat, *Delete group* only on a chat the user owns. Each still
  asks first, in the same words the chat's own settings use (`group-actions.ts` holds
  the sentences, so the two places cannot promise different things). A personal chat
  can only be cleared; the server refuses the rest anyway.
- **The rules live in the service, once.** `leaveGroupAs` / `deleteGroupAs`
  (`groups.service.ts`) carry what used to be inlined in the routes — you must belong,
  only the owner deletes, a personal chat is neither left nor deleted — and the routes,
  the bot and anything later call them. The routes return exactly the statuses and
  messages they did before.
- **Two bot tools, `leave_group` and `delete_group`, both confirm-by-tap.** They are
  proposable like `delete_messages` (ADR 0242): saying it only stages a card, and the
  assistant must not claim it happened. They are personal-1:1 only
  (`PERSONAL_ONLY_TOOL_NAMES`, and the executor refuses anyway), because one member's
  sentence inside a shared chat must not be able to remove the chat everyone is in.
- **The chat is fixed before the card exists.** The name goes through the same
  exact-name-or-ask resolver as `withGroupName` (ADR 0164) — anything short of one
  exact match comes back as a question with near-miss candidates — and the card carries
  the resolved id and the real name, plus `forUserId`, so a later tap acts on the chat
  the card named and only the asker's tap counts. A delete by someone who does not own
  the chat is refused up front (`not_owner`) rather than staged for a tap that cannot
  work. The ids are stripped from the model's schema, which sees only `groupName`.
- **Re-checked at the tap.** The same shared rules run at confirm time, so a card
  tapped after ownership moved on is refused like the route would.

## Consequences

- Leaving as the last member, or deleting, closes open streams (`group_deleted`), as
  the routes did.
- Deleting is permanent for every member, so it is owner-only in the list and in chat,
  and its confirm text says so. Clearing a shared chat stays "for you only" (ADR 0242).
- A Messages list row now carries a long press, so a future swipe-to-archive would need
  to coexist with it.

## Rejected

- **Swipe actions.** Hidden on web, collide with list scrolling, and a long press plus
  a visible button already covers phone and desktop.
- **Letting the bot leave or delete the chat it is in.** A shared chat has other
  members who did not ask.
- **Deleting without a card.** The model picked the chat from a spoken name; the user
  sees which one and taps.
