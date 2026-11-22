# 0100 — A past calendar event is a typo until the user says otherwise

**Status**: accepted
**Date**: 2026-08-23
**Relation**: same shape as [0093](./0093-ordinal-references-to-enumerated-tasks.md)'s
`turnId` carve-out and [0094](./0094-symmetric-list-name-resolution.md)'s
"return candidates and ask"; the calendar sibling of
[0095](./0095-tasks-fold-instead-of-multiplying.md)'s "the LLM is not looking at
the list, the person is".

## Context

A calendar entry is a thing the family still has to show up for. Nothing in the
product needs the bot to file history — history is what the mail, the chat and
the completed-task trail are for.

So a `create_event` whose `startsAt` has already gone by is, more often than
not, a mistake:

- a **stale year** carried out of the model's training data or out of an old
  message quoted in context;
- a **weekday that already passed** — "add dinner Friday" said on a Saturday
  means *next* Friday, and a model anchoring on the nearest matching weekday
  picks the one six days behind;
- a date read off a document that describes something already over.

The old behaviour was to write it. The event lands silently on a Google
calendar nobody scrolls back to, the bot reports success, and the user finds
out weeks later — or never. The failure is quiet in both directions: the thing
they wanted scheduled isn't scheduled, and something they didn't want is.

Prompting alone does not hold. `create_event`'s description already carried a
STRICT timezone rule and the model still emits bare-`Z` timestamps often enough
that `normalizeDatetimes` exists as a server-side choke point. A date rule
enforced only in prose fails the same way.

## Decision

**`create_event` and `update_event` refuse a start that has already passed and
hand the question back, rather than writing.** The result is `created: false` /
`updated: false` with `reason: 'past'` and a summary that says nothing was
written. The tool descriptions tell the model to read the date back in words
and ask; a user who really does mean it re-confirms and the bot calls again
with `confirmPast: true`.

A reschedule is the same typo, not a milder one: "move it to Friday" said on a
Saturday means *next* Friday, and a model anchoring on the nearest matching
weekday sends the event backwards exactly as it would on a create.

This is the shape ADR 0094 uses for an ambiguous list name and ADR 0093 for an
unresolvable ordinal: the server refuses, returns *why*, and the bot asks. It
beats a silent correction, because guessing which way the typo went is guessing
— "Friday" could be next Friday or a date the user genuinely wants recorded,
and shifting it forward on the user's behalf produces a wrong event that reads
as a right one.

### The boundary is the start of the user's local day, not `now`

`isPastEventStart` compares calendar *dates* in the user's zone, not instants.
Two cases force this:

- **All-day events arrive as floating midnight** (ADR 0040). A strict
  `startsAt < now` test would reject every all-day event created after 00:00
  local — i.e. all of them.
- **"Lunch at noon" typed at 2pm** is someone recording a live day, not making
  a mistake. Same-day-earlier is genuinely ambiguous, and the friction of
  asking is not worth it.

Only a date that has actually turned over is treated as suspect. That is also
the boundary the typo modes above all cross, so the guard catches what it is
for while staying quiet on the ambiguous cases.

### On `update_event`, only a supplied `startsAt` can trip it

The guard is about the date being moved **to**, never about where the event
currently sits. Renaming or relocating an event that already happened moves
nothing, so it stays silent — the common case of tidying up a past entry does
not get interrogated. Correcting the *time* of something already past does ask,
which is the one piece of friction accepted here: a single rule ("a start that
has passed needs a yes") is easier to reason about than one that also depends
on the event's current position, and the user's confirmation costs one turn.

The zone comes from the turn's `tzOffset`, the same value
[0074](./0074-timezone-anchoring-and-invite-reconciliation.md) established as
the anchor for every bare datetime. An unparseable `startsAt` passes through
untouched — zod is the guard for shape, and having two things reject the same
input in different words helps nobody.

### Only conversational turns are guarded

The gate is `input.turnId`, which ADR 0093 already established as "this call
came from a bot turn". Ingest, ICS import and proposal confirm carry none, and
all three legitimately file history: importing a school calendar means
importing the term that already happened, and confirming an emailed invite for
last Tuesday is the user's own explicit yes. Anything stamped with an
`externalUid` (ADR 0013) is exempt for the same reason — that field is set by
pipelines, not advertised to the model.

This is why the guard is in the executor and not in `createEvent`: the service
is shared by paths that must keep writing the past, and the distinction being
drawn is about *who is asking*, not about the data.

## Consequences

- The mock provider's potluck fixture and every hardcoded event date in the
  test suite had to become relative. That is not incidental — a fixed literal
  in a fixture rots into a *silently non-writing* test the day it passes, which
  is precisely the failure this ADR is about, one layer down.
- A person creating an event through the app is unaffected — they are looking
  at a date they picked, which is ADR 0095's reasoning for leaving the REST
  route's dedup to the bot. The guard is about a model's date arithmetic, not
  about the calendar.
- A user who genuinely wants to record something that already happened pays one
  extra round-trip. Worth it: they know what they meant, and can say so.

## Rejected

**Silently correcting to the next matching date.** Turns a visible refusal into
an invisible wrong answer. If the model meant a stale year, rolling forward may
land the right date; if the user really did mean last Tuesday, it fabricates
one — and neither case is distinguishable to the reader afterwards.

**A `< now` boundary.** Rejects every all-day event for today, and nags on
same-day back-fill that is usually legitimate.

**Prompt-only.** The timezone rule is the precedent: a STRICT instruction in
the tool description, plus a server-side normalizer that exists because the
instruction alone was not enough.

**Guarding `createEvent` in the service.** Would have had to grow an
`allowPast` flag threaded through ICS import, the Google pull, invite staging
and proposal confirm — every caller opting out, one caller opting in.

## Addendum 2026-11-09 — `message_user`'s invite is a `create_event`

`message_user` can carry an `event` ("text Adrian coffee Friday at 11"). That
path called `createEvent` itself, so it had none of this ADR's refusal, none of
ADR 0244/0245's clock fixes (the nested `event` was not in `NEW_TIME_FIELDS`)
and no ADR 0182 calendar sentence: a stale-year coffee was filed with no
question. The event now runs as a `create_event` in the pair group (the
executor calls itself, the way ADR 0232's named-group create did), BEFORE the message is posted:
a refusal sends nothing, not even the message, and the yes (`event.confirmPast`)
sends both once. `anchorModelTimes` treats `message_user.event` as a
`create_event`. Rule for later paths: an event written for the bot goes through
`create_event`, never straight to `createEvent`.
