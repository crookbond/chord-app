# 0055 — Bot-only connector messages follow `mirror_inbound`

**Status**: accepted
**Date**: 2026-06-18
**Related**: [ADR 0010 — IM connectors](./0010-im-connectors.md),
[ADR 0022 — Quiet-mode bot replies](./0022-quiet-mode-bot-replies.md),
[ADR 0051 — Post-invocation follow-up window](./0051-post-invocation-followup-window.md)

## Context

The inbound pipeline (`connectors/inbound-pipeline.ts`) classified a connector
message that `@`-mentions **only the bot** — no other humans —
(`isBotOnly = mentionsBot && !mentionsOthers`) as a "private bot interaction"
and persisted it with `chord_visible=0` **in every shared group, regardless of
the group's `mirror_inbound` setting**. The bot still acted on it, but the
triggering message, the bot's reply, and the ADR-0022 receipt strip were all
hidden on the Chord surface (the list query filters `chord_visible=1`; the
receipt strip needs a *visible* trigger to anchor to). Only the side effect — a
created event/task — showed up, in Calendar/Resources.

A user reported this as lost messages: they instructed the bot on Telegram, the
bot did the thing on Telegram, and the Chord app showed **no record the
exchange ever happened**. Confirmed **not** a backfill/missing-data bug — the
rows are in the DB, deliberately hidden, and the reconnect re-pull goes through
the same visible-only `listMessages` path.

The "privacy" framing was the flaw. A bot-only message in a *shared* group was
still posted in the shared connector channel, so **every member there already
saw the exchange**. There was no privacy to preserve — hiding it only on the
Chord surface created a one-sided asymmetry. The real axis is **clutter**, and
the group already has a knob for that: `mirror_inbound`.

## Decision

Bot-only messages in a shared group follow the group's `mirror_inbound`
preference, exactly like every other message — instead of being a force-hidden
special case.

```ts
const chordVisible =
  group.kind === 'personal' || !isBotOnly || mirrorInbound ? 1 : 0;
```

- **Personal group** — unchanged, always `chord_visible=1` (one human, two
  surfaces on one conversation).
- **Shared, `mirror_inbound=1`** — bot-only messages now `chord_visible=1`: the
  trigger + bot reply + receipt strip surface in Chord, same as any other
  mirrored message. Fixes the "lost messages" confusion.
- **Shared, `mirror_inbound=0`** — bot-only messages stay `chord_visible=0`:
  clean-mirror groups still keep bot chatter off the Chord surface.

ADR 0022's `silent-bridge` reply mode keys off `trigger.chordVisible=0`, so it
still applies unchanged to clean-mirror groups; for mirroring groups the trigger
is now visible and the reply naturally surfaces via the normal receipt/visible
path.

## Alternatives considered

1. **Per-sender visibility** (the triggering user sees their own bot thread,
   others don't). Rejected: `chord_visible` is a global per-message boolean, so
   this needs per-viewer modeling (a `visible_to_user_id` column or a
   per-recipient filter). And it's unnecessary — the message already broadcast
   to the whole connector channel, so there's nothing to keep private from the
   rest of the group.
2. **Always mirror bot-only messages (ignore `mirror_inbound`).** Rejected:
   groups that deliberately opted into a clean mirror (`mirror_inbound=0`) would
   suddenly see bot Q&A chatter. Respecting the existing knob is the least
   surprising behavior.
3. **Receipt strip only** (keep the raw exchange hidden, surface a "handled on
   Telegram" marker). More work, and still drops the actual content; the
   `mirror_inbound`-respecting flip recovers the full thread for groups that
   want it with no schema change.
4. **Leave the policy, add an empty-state cue.** Doesn't recover the messages —
   only explains why they're missing.

## Consequences

- Mirroring shared groups now see bot-only exchanges in Chord (more content on
  that surface — but that is precisely what `mirror_inbound=1` opts into).
- Clean-mirror groups (`mirror_inbound=0`) are unchanged.
- One-line change in `inbound-pipeline.ts`; no schema, no migration.
- The `chord_visible` flag remains a global per-message boolean — no per-viewer
  visibility was introduced.
