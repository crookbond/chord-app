# 0166 — A pending question needs a server-side referent

**Status**: accepted
**Date**: 2026-09-11
**Relation**: same insight as [0093](./0093-ordinal-references-to-enumerated-tasks.md)
("tool results do not survive a turn — `buildConvo` replays prose only"),
applied to [0157](./0157-inviting-someone-to-an-event.md)'s "I need this
person's email" question instead of a numbered task list.

## Context

Prod incident: "Add to calendar - Meet karl from 11-1p on Monday. Invite
Karl dale." The event was created; `Karl dale` had no email on file, so
[0157](./0157-inviting-someone-to-an-event.md) returned `unresolvedInvitees`
and a "pick from Contacts" card, and the bot's reply asked for the email. The
mobile card is wired correctly end-to-end (`presentContactPickerAsync` →
posts `"<name>'s email is <address>"` back into chat) — tapping it, or
manually typing the same fact, produced a plain declarative message with no
imperative verb. The bot did nothing with it. Only "update the invite to
include karl@media.example" — phrased as an explicit directive — finally
fired `update_event`.

Two things had to be true for that gap to open, and 0157 only had the
second:

1. Something has to tell the model **that this specific event is still
   waiting on an answer**, every turn, until it's resolved.
2. Something has to tell the model **that a bare statement of fact counts
   as answering it**.

0157 shipped (2) — a sentence buried inside `TOOL_DESCRIPTIONS.create_event`
("When they later give the email, call `update_event`...") — but not (1).
Per 0093, a `create_event` tool result's `unresolvedInvitees` field is gone
by the next turn; only the bot's own chat sentence survives, and the model
has no forced reason to notice, several turns later on an unrelated-looking
message, that its own long-past sentence is what that message answers. The
`NATIVE_TOOL_PROMPT`/`TEXT_FENCE_TOOL_PROMPT` "tool-firing is the default"
trigger list — imperative verbs, travel facts, RSVP language, relay
requests — had no category for "answering a question I asked."

## Decision

**Give the pending question a server-side referent, the same shape as
0093's `enumeration.ts`.** New `server/src/services/bot/pending-invites.ts`:
an in-memory, TTL-bounded `Map<groupId:userId, PendingInvite[]>` recording
`{ eventId, eventTitle, name }` whenever `create_event`/`update_event`
returns a non-empty `unresolvedInvitees`. `context.ts` gains
`pendingInviteesBlock`, read into the system prompt on **every** turn
(personal or group — an invite can originate from either) until the entry
is resolved or goes stale, explicitly naming the event id and instructing
the model to call `update_event` the moment a message supplies an email for
one of the listed names, in any form. `recordPendingInvitees` is called
with the *current* `unresolvedInvitees` on every invitee-bearing
create/update call — including a call that resolves everything, which is
how the reminder clears itself with no separate "mark resolved" path.

**TTL is a day, not 0093's 30 minutes.** An enumerated task list goes
stale the moment the underlying data could have changed; "text me their
email" is a real-world errand that can take hours.

**Reinforce (2) as well, since it was competing with a more salient list.**
Added a bullet to both tool-firing trigger lists: answering a pending
reminder or a prior "which one did you mean" disambiguation counts as a
trigger even with no imperative verb. Also gave `invitees` a `.describe()`
on both schemas — the block comment explaining it was stripped by
`zodToJsonSchema` before reaching the model at all, so the instruction
existed only in the free-text tool description, never in the field's own
JSON Schema.

**Fixed one latent gap found while reading the trigger lists**:
`TEXT_FENCE_TOOL_PROMPT`'s tool catalogue was missing `update_event`
entirely — `create_event` was listed, `update_event` never was. Not the
cause of this incident (prod runs a native-tool-calling provider), but any
text-fence provider (today: `mock`) could never resolve a pending invite,
or do any other edit, through that path.

## Audit: where else does this pattern recur?

Same question asked across every "the bot asks, a later turn must answer"
surface in the bot subsystem. Two structural backstops already exist and
served as the reference: 0093's `enumeration.ts` (ordinal→id), and proposal
bundles ([0009](./0009-consensus-before-commit.md)/[0158](./0158-email-body-through-the-trip-classifier.md))
which are DB-persisted state machines resolved by button tap or `@Chord
confirm` — never by the model re-parsing prose at all.

Everything else that returns `candidates`/asks a clarifying question is
prose-only. Risk splits into two bands:

- **Low** — "exact name or ask" group/list/calendar-rule resolvers
  ([0077](./0077-user-declared-email-routing.md) email routing,
  [0094](./0094-symmetric-list-name-resolution.md) list names,
  [0161](./0161-a-briefing-can-be-told-what-to-skip.md) briefing
  exclusions). The thing being resolved is a name the user retypes, not a
  hidden id — a late or garbled reply degrades to "ask again," never a
  silent wrong write. [0148](./0148-a-stale-weather-location-should-ask.md)
  (weather drift) already has its own backstop: an unanswered question is
  columns on `users`, not prose, and re-appears in the next day's briefing
  by construction.
- **Moderate–high** — anywhere a **candidate id** (not just a name) is
  handed to the model for the user to pick from, and that id lives only in
  the current turn's tool result: `delete_event`/`update_event` ambiguous
  title matches, `complete_task`/`update_task` ambiguous title matches
  (0093 knowingly left this class alone — "the enumeration store is
  generic enough to take a second caller"), and `set_leg_passenger`/
  `set_trip_passengers` ambiguous trip/leg matches. These are mechanically
  the *same* bug 0093 fixed for ordinals and this ADR fixes for invitees,
  just not yet reported as an incident. [0137](./0137-an-ambiguous-calendar-name-is-a-question.md)
  (calendar-name ambiguity) sits at the low end of this band — the ask
  itself is short-lived, but a wrong resolution is cached as the group's
  default calendar, which is why that ADR treats ambiguity as a hard stop
  rather than a guess.

**Not fixed here.** The moderate–high band is real and worth the same
treatment (most naturally: widen `enumeration.ts`'s existing map, or a
sibling module, into a general "candidates offered this turn" store keyed
by tool+entity rather than one-off per feature) — deferred as follow-up
work rather than folded into this incident's fix, since it touches four
different tools' candidate-matching paths and deserves its own scoping
pass rather than being rushed in alongside an unrelated bug.

## Rejected

- **A deterministic pre-LLM interceptor** — scan every inbound message for
  a bare email address and, if a pending invite exists for that user,
  resolve it without invoking the model at all (mirroring
  `confirm-verb.ts`'s regex fast-path for `@Chord confirm`). Rejected: an
  email can appear in a message for reasons that have nothing to do with a
  pending invite, and with more than one pending invite there's no way to
  disambiguate which name the address belongs to without the model reading
  the sentence around it. The context-block approach keeps that judgment
  with the model while still giving it the structural fact it was missing.
- **Fixing every moderate-risk surface found in the audit in this same
  change.** Real, but each is its own tool's candidate-matching code with
  its own shape; bundling four unrelated fixes into one incident response
  is how a focused fix turns into a sprawling one nobody reviews carefully.

## Consequences

- A pending invitee's email, however it's phrased and however many turns
  later it arrives, is visible to the model every turn until resolved —
  the mobile Contacts-card flow and a manually-typed email both go through
  the same reminder.
- `update_event` is now advertised to non-native (text-fence) providers,
  closing a latent gap unrelated to this incident but found while fixing
  it.
- `delete_event`/`update_event`/`complete_task`/`update_task`/
  `set_leg_passenger` ambiguous-match candidates remain prose-only and are
  the natural next target if a similar incident surfaces there.
