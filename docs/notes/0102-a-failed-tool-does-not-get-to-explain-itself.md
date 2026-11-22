# 0102 — A failed tool does not get to explain itself

**Status**: accepted
**Date**: 2026-08-24
**Relation**: the failure-path counterpart to
[0100](./0100-a-past-event-is-a-typo-until-confirmed.md)'s refusal contract —
0100 covers the case where we *decide* not to write; this covers the case where
we *tried* and could not. Same posture as
[0050](./0050-online-calendar-import.md)'s honesty gating (never claim an
import that did not happen).

## Context

Prod, 2026-08-24, over WhatsApp:

> **John:** add meeting Sharon at 330p for Wednesday
> **ChordApp:** You already have a meeting with Sharon scheduled at 3:30 PM on
> Wednesday. Would you like to change the time or add a different event?

There was no such meeting. There was no meeting at all — the calendar was
empty, and after that turn it still was. The log:

```
20:44:34.644  POST /api/v1/webhooks/whatsapp
20:44:41.978  tool create_event failed
              23505  events_external_uid_per_group
              Key (group_id, external_uid)=(g_…, ) already exists.
```

Two independent defects compose into that reply.

### 1. An empty string is not a missing value

The model filled the optional `externalUid` with `""`. Empty string is falsy,
so the ADR 0013 dedup branch (`if (args.externalUid)`) treated it as absent and
skipped — but `""` is a perfectly real value to Postgres, and `createEvent`
wrote it with `input.externalUid ?? null`, where `??` passes `''` straight
through. The index is partial:

```sql
CREATE UNIQUE INDEX events_external_uid_per_group
  ON events (group_id, external_uid) WHERE external_uid IS NOT NULL
```

NULL is exempt from it. `''` is not. So the *first* such event in a group
inserts fine and the second one — any second one, whatever its title or date —
violates the constraint. One `''` row wedges the group.

The field was never meant to be reachable. Its own comment read *"Not
advertised to the bot; set programmatically by ingest pipelines"* — but
`buildToolDefs` runs `zodToJsonSchema` over the whole zod object, so every
declared field ships to the provider. The comment described an intent nothing
enforced, and the model saw an undocumented optional string named
`externalUid` and did what models do with those.

### 2. The driver's words reached the model

`executeAndBroadcast` caught the throw and returned `(err as Error).message`
verbatim, which the native loop serialized into the tool result:

```json
{"error":"duplicate key value violates unique constraint \"events_external_uid_per_group\""}
```

The model read "duplicate key" as "duplicate meeting" and reported it as a fact
about her calendar — inventing the confirming detail (3:30 PM, Wednesday) by
echoing the request back. To the reader that is indistinguishable from Chord
having looked. **An internal failure is not information about the user's data,
and anything the model can paraphrase, it will.**

This is worse than a bare error. A visible "something went wrong" costs a
retry; a confident false statement about what is on the calendar costs trust in
every true one.

## Decision

**Three rules.**

**Internal-only tool fields are stripped from the schema handed to providers.**
A new `INTERNAL_TOOL_FIELDS` map removes them in `buildToolDefs` — not from the
zod schema, because the `.ics` import, the Google pull and the email-invite
path all synthesize these calls and still need the field validated. Today the
map holds exactly `create_event.externalUid`.

**An empty string is normalized to "absent" at both ends.**
`emptyToUndefined` wraps the field in the zod schema, and the write uses
`|| null` rather than `?? null`. Belt and braces on purpose: the schema fix
covers the LLM, the write fix covers the ingest pipelines, which reach
`createEvent` directly and can produce `''` from an `.ics` with no `UID` line
with no model anywhere near it.

**A thrown tool speaks in our words, never the driver's.** `toolErrorForModel`
returns a fixed sentence — *"the tool failed inside the server and NOTHING was
written"* — for everything except `TRUST_DENIED`, which is genuinely about the
request rather than about us and is *restated* (its own message carries raw
user ids). The failure payload also carries an `instruction`, the same shape
ADR 0100 uses on its refusal:

> Tell the user plainly that this did not go through and they can try again. Do
> NOT say it worked, and do NOT explain the failure as if it were a fact about
> their calendar, tasks or lists.

The real error still reaches the log at `error` level, unchanged.

## Consequences

- Every group holding an `external_uid = ''` row stays wedged until the data is
  repaired; the code fix stops new ones, it does not clear old ones. The
  one-liner is `UPDATE events SET external_uid = NULL WHERE external_uid = ''`.
- The model loses the ability to relay a specific failure reason. That is the
  point — it was never reliably reading them, and one wrong reading did more
  damage than every correct one was worth. Diagnosis lives in the log, where a
  human reads it with the SQLSTATE attached.
- `INTERNAL_TOOL_FIELDS` is a list somebody has to remember to extend. It is
  the narrower version of the alternative below, and the test asserts the strip
  removes the field *and* keeps the real parameters.

## Alternatives rejected

**Validate `externalUid` with `.min(1)`.** Rejects the call instead of the
value — and a rejected call produces `{"error": …}`, which lands the model back
in exactly the confabulation this ADR is about. Dropping a meaningless value
silently is better than failing loudly over one nobody asked for.

**Delete `externalUid` from the zod schema entirely.** It is a real parameter
for four internal callers. Removing it would mean a second code path into
`applyToolCall` for the pipelines, which is a much bigger change than a
display-time strip.

**Make the index cover `''` too** (e.g. `WHERE external_uid <> ''`). Treats the
symptom, and leaves `''` in the column as a value that means "none" everywhere
else in the codebase — including `gcalLinkFromExternalUid`, which already
defends with `?? ''`.

**Pass DB errors through but tell the model in the prompt not to relay them.**
The 0100 precedent settles this: `create_event`'s description already carried a
STRICT timezone rule, and `normalizeDatetimes` exists as a server-side choke
point precisely because the instruction alone was not enough. A rule that only
lives in prose fails the same way.
