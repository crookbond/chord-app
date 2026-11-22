# 0247 — A suggestion can go to several groups at once

**Status**: accepted
**Date**: 2026-10-14

## Context

The Action Items card (ADR 0097) and the trip-bundle card (ADR 0233) let the
user send a suggestion to "Just me" or to ONE shared group. The owner wants to
send the same thing to several groups in one go: "share a trip with Alice
and Ben separately" — two two-person chats, each seeing it, neither seeing
the other's chat.

## Decision

**Several groups can be picked, and each picked group gets its own copy and
its own fan-out.** Confirming runs the suggestion once per group, exactly as a
single-group confirm would, inside the one transaction (all or nothing).

- **Wire**: `POST /proposals/:id/confirm` takes `targetGroupIds: string[]`
  (wins over `targetGroupId`; at most `MAX_CONFIRM_GROUPS` = 12). The client
  sends `targetGroupId` when one group is picked, so the one-group path is
  byte-for-byte the old request. Membership is checked for EVERY group before
  anything is written; one foreign group refuses the whole confirm.
- **Standalone suggestion** (to-do, list item, event, place): one execution per
  group. ADR 0150's learned-rule offer appears only when exactly one group was
  picked — a routing rule names one group, so several picks teach nothing.
- **Trip bundle**: the whole bundle (trip, legs, stays, reservations) runs once
  per group, so each group gets its OWN trip. A bundle that extends an existing
  trip, and a screenshot bundle, still ignore groups (ADR 0029/0233).
- **The confirmer is not duplicated on their own calendar.** A group event gives
  every member a copy, the confirmer included; the second group would give them
  a second one, pushed to Google. Every group after the first runs with
  `additionalGroupShare`, which makes `createEvent` skip the creator's copy
  (`omitCreatorCopy`) and skips the second event nudge. A flight leg's event is
  already folded per owner by ADR 0223.
- **Picking**: `GroupChips` (`mobile/src/group-chips.tsx`) — "Just me" clears
  everything; on a phone each tap toggles a group; on the web a plain click
  picks one group and Ctrl/⌘-click adds or removes one (the file-list
  convention), with a one-line hint. The rule is `nextGroupSelection` in
  kernel, tested.

## Consequences

- Copies are independent: a leg added later to one group's trip is not on the
  other's, and editing one to-do does not edit the other. The To Do's hub
  already shows same-named task/list copies as one row naming every group (ADR
  0094/0232), so the to-do case reads as one thing.
- The confirmer sees each trip once per group in the Trips tab (one trip per
  group is what was asked for).
- **No new chat tool.** This is a choice on a card, not a new capability: chat
  already sends to a named group per call (`withGroupName`, `share_trip`,
  `share_event`), and "share it with Alice and Ben" is two calls. Widening
  those tools to several groups is a separate change.

## Rejected

- **One trip visible in several groups** (a share table): every trip read is
  scoped by `trips.group_id` (~25 sites), and the owner asked for each group to
  get its own fan-out.
- **Requiring Ctrl on phones / long-press to multi-select**: phones have no
  modifier key, and a chip is already a toggle-shaped control.
- **Letting the confirmer get a copy per group**: two identical entries on their
  own Google calendar.
