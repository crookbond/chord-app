# 0189 — A person is a node, not a string

**Status**: accepted
**Date**: 2026-09-18

## Context

Chord's memory system for people had three compounding problems. `people`
(private contacts), `personas` (per-group roster), and `memories` (facts)
were only unified by exact email/name string-matching at each write site —
never by a persistent edge. ADR 0016 originally planned a `relationships`
table and a `family_graph_2hop` view for exactly this; only `people` and
`important_dates` ever shipped.

Worse, `email/person-extraction.ts` had a real misattribution bug: every
fact extracted from an email — including arbitrary attributes about the
*named person* (`p.facts`, e.g. "loves sushi") — was written onto the
**asker's own** memory row (`subjectType:'user', subjectId:<asker>`), never
onto the person being talked about. There was no code path that could
attach a fact to a private `people` row at all (`memories.subject_type` was
only `'user'|'persona'|'household'`). Meanwhile `bot/extraction.ts` (the
chat-message background extractor) already resolved a fact's subject
correctly to a user or a managed persona — it just didn't know about
`people` either.

Separately: a background-mined fact writes `status:'proposed'`, and
`queryForTurn` only ever reads `status='confirmed'`. There is no TTL/sweep
on `memories` (unlike `proposals`' 72h `expireStale`), so a mined attribute
fact sat inert forever unless a human happened to open a confirm screen
with nothing pulling them there.

## Decision

**`people` becomes the canonical node; one new `person_relationships` edge
table completes ADR 0016.** Migration `082` widens `memories.subject_type`
to add `'person'` (pointing at `people.id`) and adds `person_relationships`
(`subject → relation → related`, each end a `user`/`persona`/`person`, no
supersede chain since two people can hold several relation kinds at once).
No FKs on the polymorphic id columns — mirrors `memories.subject_id`'s
existing pattern rather than introducing a new one.

**Both extraction sites now resolve to a real person, and write facts to
the right place.** `bot/extraction.ts`'s `resolveSubject` gained a third
fallback (after group member, after managed persona) against the sender's
own private `people` list; a `'person'`-subject write redirects to the
asker's **personal** group, never the shared group the chat happened in —
`family-profile.service.ts` already treats `people` as private-to-owner,
this just makes memory writes respect that. `email/person-extraction.ts`'s
bug is fixed the same way: once a person is resolved or created in a loop
iteration, `p.facts` targets that person's own `subjectType:'person'` row;
only the relationship-vocabulary fact (`spouse_name`, `kid_name`, …) keeps
targeting the asker (correctly — it describes the asker's relationship),
now **also** recorded as a `person_relationships` edge so the same
information is queryable from the person's own side.

**A brand-new, not-yet-confirmed person gets no attribute facts.**
Deliberate scope cut: attaching `p.facts`/a relationship edge needs a real
`people.id`, which doesn't exist until a pending `add_person` proposal is
confirmed. Rather than misattribute (the original bug) or build a
bundle-confirm mechanism for memory facts (out of scope here), those facts
are simply dropped for that one pass — honest incompleteness over a wrong
answer, in this codebase's usual style (ADR 0133's asymmetry: a missed
fact costs a search, a wrong one costs trust).

**Attachments feed the same extraction call, not a new one.** ADR 0071
already extracts `attachments.summary`/`extracted_text` once at index time
and links the row back to its source thread
(`origin_email_thread_id`). `person-extraction.ts` now joins that text into
the same per-thread prompt that already reads the body — no second LLM
call, no new extraction mark, reusing the existing `'person'`-kind mark.

**"Tell me about X" is one new read, not a bigger store.** New
`getPersonProfile` assembles three cheap queries (relationship edges,
confirmed person-scoped facts, and a bounded live pull from
`trips`/`tasks`/`events` via a linked persona) — the same
`Promise.all` + in-memory-composition shape `family-profile.service.ts`'s
`getGroupProfile` already uses. Recent activity is never stored as its own
fact; always queried live, so a cancelled trip is never stale. Exposed as
`get_person_profile`, gated `PERSONAL_ONLY_TOOL_NAMES` **and** an executor
`isPersonalTurn` check (ADR 0099's `send_briefing` precedent) — a private
person's profile must never render in a shared group turn even if the
prompt-time filter is bypassed.

**A lighter consent bar — attribute facts only, never identity or
relationship claims.** Creating a new `people` row, a new
`person_relationships` edge, and anything group-routing related stay fully
manual — these are identity/sharing claims, the same stakes ADR 0064/0065
and ADR 0097/0150 were careful about. An **attribute** fact
(`subject_type:'person'|'persona'`) about a subject that already exists as
a real row gets a lighter bar: at `confidence >= 0.8`, `upsertMemory` sets
`auto_confirm_at = now + 7 days` instead of leaving it `NULL`. A new
`decayMemories` sweep — structurally identical to `expireStale`, reusing
`confirmMemory` per row rather than re-implementing supersede — flips it to
`confirmed` once due, unless a human rejects it first. Swept lazily on
read (`memories.ts`'s and `family-profile.ts`'s GET routes), same
no-cron placement as `expireStale`.

## Alternatives considered

- **A JSON blob of facts per person** (`people.facts jsonb`) instead of
  per-fact `memories` rows — rejected. It would lose the per-fact
  provenance/confidence/proposed-confirm-supersede lifecycle ADR 0009
  depends on, and it's the exact schemaless-blob anti-pattern ADR 0188
  already rejected for a different entity ("breaks the closed-typed-
  vocabulary design every primitive's dedup/archive/search/briefing
  behavior depends on").
- **Storing recent trip/task/event activity as its own fact** on the
  person profile — rejected; it would drift the moment the underlying row
  changes (a cancelled trip, a completed task). Always queried live
  instead (ADR 0135/0138's render-don't-restate rule).
- **Auto-confirming new people or relationship edges** under the same
  lighter bar — rejected. Those are identity claims, not attributes; ADR
  0150's "no auto-routing, a recipe for security leaks" reasoning applies
  just as much to "no auto-relationship-assertion."
- **Bundling attribute facts into the pending `add_person` proposal** so a
  brand-new person's facts aren't dropped — deferred. Real gap, but needs
  a bundle-confirm mechanism for `memories` rows the way trips already have
  for `create_trip`/`add_travel_leg`; a separate, larger change.
- **A kernel-level relation-vocabulary normalizer** — deferred to when a
  second consumer needs it (mobile client rendering, say), per ADR 0158's
  precedent for `trip_classifier` helpers. There's exactly one write site
  today.

## Consequences

- A private contact's attribute facts now correctly attach to them, not
  the person who mentioned them — but a brand-new person's facts from the
  same turn are silently dropped until that person is confirmed and
  mentioned again. Worth revisiting if that proves common in practice.
- `person_relationships` has no UI yet beyond what `get_person_profile`
  surfaces to the bot; a pending relationship edge can only be confirmed
  via `confirmPersonRelationship`/`rejectPersonRelationship` (no route
  wired in this pass) — a People-screen affordance is a follow-up, not
  blocking this ADR.
- Fuzzy/nickname identity matching (`"Mani"` vs `"Alice"`) is unchanged
  — still exact-match, the same known limitation as `findPersonByName` and
  ADR 0094's list-name forking before its fix.
- `travel_legs.passenger_name` free-text strings are not retroactively
  reconciled into `person_id` links; `set_leg_passenger`/
  `set_trip_passengers` already support this manually.
