# ADR 0093 — "Mark 3-4-5-6 done" resolves server-side

- **Status:** Accepted
- **Date:** 2026-08-22
- **Amends:** ADR 0005 (iterative tool use), ADR 0092 (closing out stale to-dos)

## Context

A user asked for their to-do list, got six numbered items back, and replied:

> mark 3-4-5-6 done. keep others as is

All six were marked done. The production log is unambiguous — one turn, six
writes, no read:

```
13:39:58  bot tool exec: list_tasks: 6 task(s) (status=open)     ← previous turn
13:40:38  bot tool exec: complete_task: t_g5v4S23g_dR4 → done    ← this turn
13:40:38  bot tool exec: complete_task: t_YegcP9nynZmc → done
13:40:38  bot tool exec: complete_task: t_G9Hy_cFrBZVp → done
13:40:38  bot tool exec: complete_task: t_sXarpYRD71QR → done
13:40:38  bot tool exec: complete_task: t_a9P0wFW2KKLU → done
13:40:38  bot tool exec: complete_task: t_gm5fHAlK-7NW → done
```

The model's own prose was right — *"tasks 3, 4, 5, and 6 are marked completed.
The others remain open"* — and the six receipt cards underneath it told the
truth. The user noticed within eight minutes.

**"3" had no referent.** `buildConvo` (`bot/context.ts`) replays history as
prose only: a bot turn becomes `{ role: 'assistant', content: m.body }`. Tool
calls and tool results do not survive the turn that produced them. So when the
next turn began, the model held its own numbered sentences and nothing else —
no ids, no ordering, no list. Asked to act on positions 3 through 6 of a list
it could no longer see, it re-derived the set from titles it remembered, and
with nothing anchoring the numbering it swept the whole list.

This is not a prompt-tuning miss. `complete_task`'s description already says
*"fire ONLY when the human explicitly asks"* and *"Never infer completion from
indirect chatter."* The model was not inferring — it was resolving a reference,
and the information needed to resolve it correctly was not in the system.

## Decision

**The server owns the numbering. The model never maps a number to a task.**

### 1. `list_tasks` records the list it showed

Each row comes back with an explicit `n`, and the ordered ids are stored under
`(groupId, actorUserId)` in `bot/enumeration.ts` — in-memory, TTL-bounded,
capped, exactly the shape ADR 0051 uses for the follow-up window.

Storing it server-side rather than injecting the last tool result back into
context is the whole point: injected ids would still be *the model's* mapping to
get wrong, and would grow the prompt on every turn. A lookup cannot be
misremembered.

### 2. `complete_task` gains `ordinals: number[]`

`ordinals: [3, 4, 5, 6]` resolves against that record. The tool description
states the rule directly — when the user refers to items by position, use
`ordinals`; never re-derive by title — and tool descriptions are in context on
every turn, which is precisely what the enumeration is not.

### 3. Plurality is structural, not advisory

`taskId` and `titleContains` stay strictly single-item. **Acting on a set is
only expressible through `ordinals`**, and `ordinals` only resolves against a
real enumeration. A model that wants to close four things cannot spell that as
four independent guesses inside one call.

To close the remaining hole — six *separate* calls, which is what actually
happened — at most one `complete_task` per turn may resolve by `taskId` or
`titleContains`. A second such call in the same turn is refused with
`reason: 'batch_requires_ordinals'`, telling the model to call `list_tasks` and
use `ordinals`. Turn identity is `botMsgId`, already threaded through
`executeAndBroadcast`, so this is an exact per-turn count and not a time window
that a user typing two quick messages would trip.

The refusal is not a dead end inside a turn: `list_tasks` records an enumeration
the moment it runs, so the iterative loop (ADR 0005) can read, then act on
`ordinals`, without the user seeing anything. Ordinal-resolved calls are
uncapped — they are explicit and server-verified.

### 4. Ordinal resolution is all-or-nothing

If any ordinal in the set fails to resolve — no enumeration on record (a
restart, an expiry), or a number past the end of the list — **the whole call is
refused** and nothing is written. A partially-applied selection is the failure
mode this ADR exists to prevent; there is no reading of "3-4-5-6" under which
writing three of them is correct.

Losing the map therefore costs a re-list, never a wrong write.

## Consequences

**A restart forgets what number 3 was.** The next ordinal call refuses and the
model re-lists. Persisting the mapping to Postgres would remove even that, but
it would add a table and a write on every read to buy a slightly quieter failure
in an already-safe direction.

**The cap can refuse a legitimate two-title request.** "Mark the dentist task
and the vet task done" now needs a `list_tasks` first. That costs one extra tool
call inside the same turn and is invisible to the user — and it is the trade
this ADR is buying, since two title-resolved writes in one turn is
indistinguishable from the incident above.

**`ordinals` is only as good as the numbering the model prints.** The tool
returns `n` and the description says to number the reply exactly as `n` came
back. If the model renumbers anyway, the mapping is wrong again — this narrows
the failure from "no referent at all" to "an explicit referent that must be
copied faithfully", which is far more reliable, but it is not a proof.

**Other enumerate-then-act tools still guess.** `check_list_item` resolves list
items by text and has the same shape of exposure. Left alone deliberately:
checking off the wrong grocery item is cheap and visible, and one worked example
of the enumeration seam is worth more than a speculative sweep. The store is
generic enough to take a second caller.

## Alternatives considered

**Carry tool results into the next turn's context.** The direct read of the root
cause — the model lost the ids, so give them back. Rejected: it grows the prompt
on every turn with data that is stale the moment anything else writes, and it
leaves the number→task mapping with the model, which is the step that failed.
Server-owned resolution is strictly stronger for less context.

**Number the tasks in the persisted bot message so history replays them.**
Cheap, no new state. Rejected: it makes the *display* the source of truth, so
any later re-render, translation, clip (WhatsApp's 1600-char cap) or edit
silently changes what "3" means.

**Confirm every multi-task write with a proposal card.** The proposals machinery
already exists and would have caught this exactly. Rejected as the default: it
taxes the common, correct case — "mark 3-4-5-6 done" is a clear instruction, and
answering a clear instruction with a confirmation prompt is how users learn to
tap through confirmations without reading them.

**Cap a turn at N task writes regardless of how they resolve.** Simpler than
threading turn identity through resolution paths. Rejected: four writes were
correct here. A cap that permits four permits the incident; a cap that forbids
six forbids a real request, and neither addresses the reference that was
actually broken.

**Just harden the tool description.** Free. Rejected: the description was
already explicit about not firing on anything but an explicit ask, and the model
*was* answering an explicit ask. No wording supplies an id the turn does not
have.
