# 0155 — A past date in a file is history, not a question

**Status**: accepted
**Date**: 2026-09-10
**Relation**: narrows [0100](./0100-a-past-event-is-a-typo-until-confirmed.md) for
one source; the bot-turn sibling of [0137](./0137-a-proactive-message-is-not-always-the-briefing.md)'s
`retractPastEventProposals` (email stopped proposing a date already lived
through). Same "refuse and hand back" shape as
[0093](./0093-ordinal-references-to-enumerated-tasks.md) / [0094](./0094-symmetric-list-name-resolution.md).

## Context

ADR 0100 refuses a `create_event` / `update_event` whose start has already
passed and tells the model to **read the date back and ask** — a user who
really meant it re-confirms with `confirmPast: true`. That is the right move
when a person *typed* the date: "add dinner Friday" on a Saturday is a slip,
and the friendly thing is to catch it.

It is the wrong move when the date came out of an **uploaded file**. A
school-year calendar, a sports schedule, a term planner — these routinely
list dozens of dates already gone by alongside the handful still ahead. When
the bot works through such a file, ADR 0100 makes it stop on every past row
and ask "did you mean this?", and the answer is always the same: no, that is
just the part of the schedule that already happened.

A file is also not a typo channel. Reading from an attachment, a past date is
not a misremembered weekday — it is a fact the document states about
something that is over. Nothing in the product needs the family calendar to
hold last term.

## Decision

**When the triggering message carried an uploaded file, a past
`create_event` / `update_event` still writes nothing — but the result tells
the model it is historical context from a file: do NOT create it and do NOT
ask about it. Only the rows still in the future become events.**

The file stays fully indexed — indexing happens at upload and is untouched —
so the past dates remain searchable and answerable. They are simply not
calendar entries.

Carried on `ApplyToolCallInput.triggerFromAttachment`, set by the bot turn
from the same signal that already gates the trip/content auto-filers
(`triggerHasAttachment`). A turn with no attachment is byte-for-byte on ADR
0100 — it still asks.

`confirmPast: true` still overrides: a user who says "yes, add the whole past
schedule too" gets it. ADR 0100's exemptions are unchanged — a call with no
`turnId` (ingest, ICS import, proposal confirm) or any `externalUid`-stamped
call still files history.

Prompt plus choke point, ADR 0100's own precedent: `tools.ts` tells the
model not to call `create_event` for a past date in a file, `context.ts`'s
attachment note repeats it, and the executor is the backstop for when it
does anyway.

## Rejected

**Suppress `create_event` entirely for document uploads** (as it already is
for images). A schedule PDF's *future* rows — parent-teacher night, the
season opener — are exactly what the user wants on the calendar, and unlike
travel they have no other auto-filer to land in.

**Ask once for the whole batch** ("this schedule has 14 past dates — add
them?"). Still a prompt on every schedule upload, and the answer is reliably
no.

**Silently roll each past date forward to its next occurrence.** ADR 0100
already rejected this for typed dates; it is worse from a file, where a past
row has no intended future date at all — a term calendar's gone-by dates are
just over.

**A per-file `allowPastFromFile` the user toggles.** A setting for a case
that wants one behaviour.

## Consequences

- A document whose events are all in the past produces no calendar writes and
  no questions — the bot answers about the file from the index and moves on.
- `ApplyToolCallInput` gains `triggerFromAttachment`; `executeAndBroadcast`
  threads it from the turn context. Every non-attachment path is unchanged.
