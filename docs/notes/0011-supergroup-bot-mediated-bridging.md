# 0011 — Chord group as supergroup; bot-mediated information bridging

**Status**: accepted
**Date**: 2026-04-26
**Builds on**: [ADR 0010](./0010-im-connectors.md)

## Context

[ADR 0010](./0010-im-connectors.md) introduced IM connectors (Slack,
Telegram, Discord) and explicitly deferred the "Chord-native → external
channel" direction of mirroring. v1 only forwards bot replies outbound
and treats native + external as one bag of `messages` rows tagged with
`source`.

That ADR called bidirectional message bridging "v1.5 if real users want
it." The direction was left ambiguous: either we'd ship the bridge
later, or we'd commit to *not* shipping it. Without a stated direction,
the natural drift is toward bidirectional — every reasonable extension
("a Chord user wants to talk to Slack folks", "Telegram users want to
see what Slack users said") pushes us to mirror more.

This ADR commits to the other direction.

## Decision

**A Chord group is a supergroup.** It is a logical container that
federates one or more linked surfaces — native Chord chat, plus zero
or more bound external channels (a Slack channel, a Telegram chat, a
Discord channel). Bindings live in `group_external_channels`; the
schema already supports many channels per group_id, intentionally.

**Surfaces within a supergroup do not mirror messages between each
other.** A Slack message stays in Slack. A Telegram message stays in
Telegram. Native Chord users see external messages in the group view
(they're rows in `messages`), but external users do **not** see other
surfaces' traffic. The bot's reply is the only thing that crosses the
boundary, and only outbound.

**All surfaces feed the same `messages` table for the supergroup**,
distinguished by `messages.source` (`'chat' | 'import' | 'slack' |
'discord' | 'telegram'`). Memory, attachments, proposals, tasks, lists,
and every other resource in the group are shared across all surfaces.

**Information bridging is bot-mediated.** A question asked on Slack
can be answered using knowledge that arrived through Telegram or
native Chord, because the bot's context assembly
(`services/bot/context.ts`) reads the unified message stream regardless
of source. The bot is the only bridge between surfaces; it is a
deliberate, narrow channel.

## Alternatives considered

- **Full bidirectional message bridge** between every pair of linked
  surfaces. The natural extension once people see external users
  posting. Surface-area cost is large: identity attribution on
  outbound (post each native message as the bot prefixed with the
  user's name? as a webhook user?), edit/delete propagation either
  direction, formatting fidelity per platform (Slack mrkdwn vs
  Discord markdown vs Telegram MarkdownV2), bot-reply infinite-loop
  prevention, retroactive sync when a binding is added to a group
  with existing history. Rejected: every one of those problems is
  real, and none of them serves the actual product use ("Chord
  remembers things across the channels it's in").

- **One Chord group per external channel** (no supergroup concept).
  Cleanest mental model, but loses shared memory across channels.
  The travel team's Slack channel and the family's Telegram chat
  would each get their own Chord group with its own task list,
  trips, attachments — duplicated state, no cross-context recall.
  Rejected: kills the central reason to use Chord at all.

- **Mirror only specific message types** (bot replies + a manual
  `@chord broadcast …` verb). Possible compromise. Adds a verb
  surface, partial-mirror semantics, and the same "where do my
  Slack messages go?" surprise we get from the supergroup model.
  Rejected: the bot-as-bridge model already covers the use case
  ("@chord, did the family decide on a date?") with less
  machinery.

- **Mirror everything but the bot, with explicit per-binding
  toggle.** Advanced ops setting. We'd still pay all the
  bidirectional-bridge costs above, just hidden behind an "off by
  default" flag. Rejected: same surface area, more configuration
  cliff.

## Consequences

### What this unlocks

- **Cross-surface recall is automatic.** A Slack-user asking
  "@chord what was the decision about Friday?" pulls in Telegram and
  native Chord history without anything new in code; the bot's
  context window already does this.
- **Resources are unified.** Tasks, lists, events, trips, memories,
  attachments — all shared. The Costco list a Telegram user added an
  item to and the trip a native Chord user planned both live in the
  same supergroup.
- **Cross-surface proposals + commits work.** A Slack user proposes
  a trip via the bot; a Telegram user (in another binding of the
  same supergroup) confirms via `@chord confirm`. Proposals are
  keyed by group_id, not by channel, so this composes.
- **Hybrid native + external groups are first-class.** Native Chord
  users in a bridged supergroup see external messages in their
  group view as informational context. They simply can't reply
  *into* the external surface directly — that's a feature, not a
  bug.

### What we commit to NOT doing

- **No native → external message mirroring.** A Chord-native user's
  message is never forwarded to bound external channels. If they
  want to address Slack folks, they ask the bot ("@chord please
  let the Slack folks know …"). The work item once-listed in
  `docs/tasks/im-connectors.md` Phase 5 as "Chord-native → external
  mirroring" is now *rejected by design*, not deferred.
- **No external ↔ external mirroring.** Slack and Telegram bindings
  on the same supergroup do not cross-post.
- **Edit / delete propagation across surfaces.** Touching a Slack
  message doesn't update the Chord row; editing a Chord row
  doesn't reach Slack. `messages.external_message_id` exists but
  is for inbound dedup, not edit-sync.

### Things that follow from the decision

- **`tier: 'guest'` for shadow users** (set by the inbound pipeline)
  is the right default in this model. External users live in the
  supergroup but don't gain native-user privileges.
- **Personal groups can host bridges too.** Initially scoped out
  ("personal groups have nothing to configure"), but in practice a
  user often wants two-way reach into their private chat from
  Telegram on their phone. Pairing on a personal group is allowed;
  the no-mirror semantics above still hold (only bot replies cross),
  so the personal chat stays a 1:1 conversation between the user
  and Chord even when a Telegram bridge is bound. Amended 2026-04-30.
- **The "linked-identity claim" flow** (deferred to user settings,
  per ADR 0010) becomes meaningfully important: one human reaching
  the bot through Slack on Monday and Telegram on Tuesday is, by
  default, two `users` rows. Claiming unifies per-user memory;
  without claiming, the bot treats them as two people.
- **Member-list rendering**: shadow users will appear in the mobile
  member list of bridged supergroups. Whether to badge them
  (`📥 external`) or filter them is a UX call, not an architecture
  one.
- **Connector polish work** (per-platform formatting, threading,
  paging) is now genuinely optional polish — none of it is on a
  critical path to a working product because the bot's text reply
  is the only thing crossing the boundary.

### What we keep open

- Whether a supergroup *should* be bound to multiple channels of
  the same platform (e.g. two Slack channels sharing one
  supergroup). The schema allows it; not yet seen in practice.
  No reason to disallow.
- Whether to expose the supergroup framing in product copy
  ("Chord lives in your team's channel; everything Chord learns
  there stays available everywhere Chord is"). Pure marketing
  surface; can decide late.
