# 0162 — An event remembers what made it

**Status**: accepted
**Date**: 2026-09-11
**Relation**: generalizes
[0158](./0158-email-body-through-the-trip-classifier.md)'s addendum
(`buildLegEventDescription`/`emailThreadLinkFromProvenance`, travel legs
only) to every event Chord creates. Follows
[0102](./0102-a-failed-tool-does-not-get-to-explain-itself.md)'s posture:
the model must never write what it cannot know, so the excerpt is always
server-composed from stored data, never model-authored.

## Context

A calendar entry said only "X is on your calendar" — no trace of what led
to it. The plumbing for an event `description` already existed end to end
(`events.service.ts`'s `createEvent`, the DB column, the Google push/pull
in `two-way-sync.ts`) but had exactly **one** writer: `syncFlightLegEvent`
for travel legs. Worse, `rowToEvent` — the DB-row → API `GroupEvent`
serializer — never included it, so even a travel leg's carefully composed
description (passenger, confirmation, source-email link) was stored,
pushed to Google, and never returned to any Chord client. The bot's
`create_event`/`update_event` tool schemas had no description field at
all, and the live chat path carried **no provenance whatsoever** —
`bot.service.ts`'s `executeAndBroadcast` hardcoded `provenance: null` for
every tool call, so there was no raw source text to excerpt from for a
chat-triggered event even in principle. Email-triggered events (magics
extraction, proposal confirm) *did* already carry
`source_raw_context = 'gmail:<threadId>'` through to `createEvent` — the
gap there was purely that nothing turned the pointer into a description.

## Decision

**Expose `description` on `GroupEvent`** (kernel type) and in `rowToEvent`
— a plumbing fix, not a new concept; the column and the Google round-trip
already worked, they just stopped one hop short of the client.

**Generalize the excerpt builder.** New
`server/src/services/events/context-excerpt.ts`,
`buildEventContextExcerpt(db, userId, sourceRawContext)`:
`gmail:<threadId>` → the thread's own `subject` + `snippet` (already
fetched at sync, no extra call) plus a one-tap link back to it, reusing
[0158](./0158-email-body-through-the-trip-classifier.md)'s
`emailThreadLinkFromProvenance` verbatim (already provider-agnostic).
`chat:<messageId>` (new — see below) → the triggering message's own text,
truncated, plus its sender. Anything else, or the flag off, → `null`.

**One touch point, not one per caller.** Called inside `createEvent`
itself, **only when the caller left `description` unspecified** (`undefined`,
not an explicit `null` — a travel leg's `buildLegEventDescription` can
legitimately decide there's nothing to say and passes `null` on purpose,
which must not be second-guessed). Every caller of `createEvent` — the
chat tool-calling loop, proposal confirm, event-convergence — gets the
behavior automatically, rather than each needing its own excerpt call.

**Chat now carries real provenance.** `bot.service.ts`'s
`executeAndBroadcast` changes its hardcoded `provenance: null` to
`opts.triggeringMessageId ? \`chat:${triggeringMessageId}\` : null` —
`triggeringMessageId` was already on the opts, so this is a one-line
change. Verified this is safe more broadly than just `create_event`: the
same `provenance` value flows into every write tool's `sourceRawContext`
column (tasks, saves, etc.), and every existing reader of that column
matches by **prefix** (`gmail:%`, `LIKE`, `IN (specific gmail keys)`) —
[0143](./0143-a-to-do-dies-with-the-email-it-came-from.md)'s
`retireTasksByProvenance`,
[0106](./0106-classification-ids-belong-to-a-user.md)-era convergence
lookups — never by null-equality, so a `chat:` value where `null` used to
be changes nothing for them and only adds new information for `create_event`.

**Guardrail**: `description` is **not** exposed as a `create_event`/
`update_event` tool parameter in this change. The model never authors it —
it's always composed from a stored email snippet or a stored chat message
body, never a paraphrase the model invents. This is the same discipline
[0102](./0102-a-failed-tool-does-not-get-to-explain-itself.md) established
after the model once invented a fake calendar conflict by echoing a raw DB
error back as fact.

**Feature flag**: `EVENT_CONTEXT_EXCERPT_ENABLED` (default on) — this
changes the Google-pushed description of every future Chord-created event
system-wide, visible to co-invitees on a shared event, so it gets a quick
kill-switch like `EMAIL_TRIPS_ENABLED`.

## Rejected

- **Letting the model write a free-text description.** Confabulation
  risk — [0102](./0102-a-failed-tool-does-not-get-to-explain-itself.md)'s
  exact failure mode, an invented specificity that reads as fact.
- **Re-deriving the excerpt on every `update_event`.** Scoped to
  creation only — "what led to its setup" is a moment-of-creation fact,
  and re-deriving on every edit risks clobbering a description the user
  or an organizer has since edited.
- **Restricting the new provenance value to `create_event` only** (leaving
  every other tool call at hardcoded `null`). Checked instead of assumed:
  every existing reader of `source_raw_context` matches by prefix, so
  broadening it is safe and is itself useful plumbing (the same "which
  message led to this" question applies to a task or a save, not only an
  event) rather than one more special case to remember.

## Consequences

- A chat-triggered event's `description` now carries a short excerpt of
  the message that created it; an email-triggered one carries the source
  thread's subject/snippet and a link back to it — both visible in the
  mobile event detail view and on the pushed Google Calendar entry.
- A travel leg's own richer description (passenger, confirmation,
  itinerary number, source link) is completely unaffected — it's supplied
  explicitly, so the generalized excerpt never runs for it.
- Every write tool's `sourceRawContext` now carries `chat:<messageId>`
  instead of `null` when triggered live from chat — inert everywhere
  except the one new consumer, banked for future features that want to
  trace an entity back to its triggering message.

## Addendum 2026-10-29: an edit adds its own line

The excerpt was written once, at creation, so an event moved from chat
kept saying how it began ("From chat: lunch at 12 pm") on an event now at
2 pm. `update_event` now appends a line built the same way
(`buildEventEditNote`: `Changed from chat: "<message>" - <sender>`, or
`Changed by email: <subject>` when an email change card is confirmed)
whenever it changes a field, for a single event and for a whole series.
The line is added once per message. Edits made in the app, or with no
message behind them, leave the description alone.
