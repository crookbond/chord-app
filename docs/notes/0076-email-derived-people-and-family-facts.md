# 0076 — Email-derived people + family facts as staged proposals

**Status**: accepted
**Date**: 2026-07-18

## Context

Chord mirrors the user's Gmail (ADR 0060) and extracts calendar/list magics
from it (ADR 0063), but learns nothing about *who matters*: the family graph
(ADR 0016 — `people` + `important_dates`) and persona memories (ADR 0019/0020
vocabulary: `spouse_name`, `kid_name`, …) fill only by hand or by chat
extraction. Email is the richest untapped source — senders, relationships,
birthdays, schools.

Owner decisions (2026-07-18): mine **all non-bulk mail** (not just the
Friends & family category), consent model is **propose → confirm**, with a
one-time **auto-write bootstrap** so a new user starts with critical mass
instead of an empty People screen.

## Decision

### Extraction pass

`email/person-extraction.ts`, modeled on the magics pass: runs from
`afterSync` behind `EMAIL_PERSONS_ENABLED` (default OFF), bounded (~15
threads/tick), once-ever `person_processed_at` marker (migration 029),
injectable `PersonExtractor` seam. Bulk-domain senders
(`deterministicPathFor`) and automation addresses (`no-reply|notifications@`)
are skipped without an LLM call. The prompt is grounded with the user's
name/email, the already-known people list, and sender/to — and returns
strict JSON persons with `relationship`, optional `email`, `confidence`,
dated facts, and free-form facts.

### Two sinks, both existing consent surfaces — no new UI

- **Structured entities** → staged proposals invoking the existing bot
  tools: `add_person` (gains an optional `email` arg → `createPerson`;
  confirming also backfills the email onto an already-known person) and
  `add_important_date` (recurring `0000-MM-DD` supported). Provenance
  `gmail:<threadId>`, so ADR 0073's trash-retraction and ADR 0070's Action
  Items surface apply unchanged. Confirm dispatches through
  `confirmProposal → applyToolCall`, writing `people`/`important_dates` via
  the normal consented path — birthday nudges (morning scan) and
  `people.tsx` light up with no promotion layer.
- **Soft prompt facts** (relationship keys mapped to the extraction.ts
  vocabulary — `spouse_name`, `kid_name`, `parent_name`, `sibling_name`,
  `friend_name` — plus explicit facts like `kid_school`) → memory proposals
  in the personal group, exactly like About-Me extraction; confirmed rows
  feed the bot prompt via `queryForTurn`.

### Sender anchor

`people.email` (migration 029, indexed on `(owner_user_id, LOWER(email))`)
+ `findPersonByEmail`: a repeated sender resolves to their person row, so
known people accrue only *new* dates/facts (deduped on kind + month/day)
instead of being re-proposed.

### Bootstrap — the deliberate D1/D8 deviation

On a user's **first pass** (zero `people` rows and no prior email-derived
person proposals), facts with `confidence ≥ 0.8` auto-write: direct
`createPerson`/`addImportantDate` plus memories at status `confirmed`,
capped at 12 people. Rationale (owner decision): the propose-only model has
a cold-start problem — dozens of taps before the assistant knows anyone.
The deviation is bounded (one pass, high-confidence, capped) and everything
remains visible and deletable in the People screen and Memory tab.
Below-threshold facts propose even during bootstrap; after the first pass,
steady state is proposals-only, per D1/D8.

## Rejected alternatives

- **Memory-only sink with confirm-time promotion** into `people` — needs
  fragile value parsing and a promotion hook; the tool-proposal route gets
  structured writes through an already-consented path.
- **Direct writes always** — violates D1/D8 beyond the bounded bootstrap.
- **ADR 0016's `contact_methods` table** — one nullable `email` column
  covers v1; the full table stays deferred.
- **Friends&family-category-only scope** — rejected by owner: too narrow
  (schools, coaches, doctors live outside it); bulk-domain + noreply
  filtering bounds cost instead.

## Consequences

- One email can yield both an `add_person` proposal and a `spouse_name`
  memory proposal (two taps) — accepted; they feed different systems and
  both dedupe idempotently.
- Misattribution from forwards/shared mailboxes is mitigated by the
  confidence threshold, the bootstrap cap, and deletability — not solved.
- Email bodies go to the LLM (same posture as classifier/magics); the
  per-user "lock what chat knows about me" toggle remains the follow-up.
- Expired proposals never retry (the marker is permanent — same trade as
  magics).

Tests: `person-extraction.test.ts` — parse narrowing, bootstrap auto-write
vs steady-state proposals, marker idempotence, bulk/noreply skip without an
LLM call, the confirm→people-row checkpoint (owner = confirming user), and
birthday surfacing in `listImportantDayOccurrences`.

## Addendum (2026-07-19): marks survive the mirror wipe

The once-ever markers originally lived on `email_threads`
(`magic_processed_at` / `person_processed_at`) — which `disconnectGmail`
and the ADR-0074-era provider-flip wipe delete, so a reconnect re-mined
every thread and re-staged proposals the user had already seen or
dismissed. Migration 030 moves both kinds into `email_extraction_marks`
(`user_id, gmail_thread_id, kind` — user-FK'd, thread-id-keyed), backfilled
from the legacy columns, which stop being written. Magics and person
extraction now anti-join this table (`extractionMarkQuery` /
`markThreadExtracted` in magics.service.ts), so "each email is read once,
ever" holds across disconnects, reconnects, and mock↔real flips. Account
deletion still clears the marks via the user FK cascade.
Test: `extraction-marks.integration.test.ts` (wipe + re-backfill → zero
re-reads, zero new proposals, for both kinds).
