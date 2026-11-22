# 0191 — A new person is provisional until you tap

**Status**: accepted
**Date**: 2026-09-19

## Context

ADR 0189 made mined facts attach to the person they describe, but only once a
`people.id` exists. For a person the user has not confirmed, `person-extraction`
staged an `add_person` card carrying `{displayName, notes, email}` and **dropped
everything else**. Prod dry-runs (ownertest) showed what that costs:

- Robert Wells (teacher): the card kept name, email and "teacher"; the
  `subject=Middle School Science` and `role=Science Olympiad Head Coach` facts
  were lost.
- Kate Stone: `dietary_preference=vegan meal requested on flights` lost.
- Julia Sutton: `phone=860-555-0135` lost.

The loss is permanent, because the thread is stamped mined (ADR 0076/0110) and
never re-read. A second thread mentioning a person who already had a pending card
was skipped outright, so its facts were lost too. And on confirm, `add_person`
wrote only name, notes and email.

The obvious fix, "generate a person and attach to it", has a trap. `people` is
read at 18 sites in 8 files, and several have real-world effects: the bulk gate
(ADR 0127) exempts any sender in `people.email` from newsletter suppression,
compose autocomplete (ADR 0114) ranks it, event invites (ADR 0157) resolve names
against it and send real Google invites, and the People screen and briefing read
it. A mis-extracted contact (Julia arrived at 0.60, relationship "other") would
leak into all of them.

## Decision

**A new person gets a provisional row in its own table.** Migration `083` adds
`provisional_people` (`id`, `owner_user_id`, `display_name`, `email`, `notes`,
`proposal_id`). No existing reader touches it, so it is invisible by
construction (fail-closed) instead of by 18 filters someone must remember.

- **Extraction:** for an unknown, non-bootstrap person, find or create the
  provisional row, stage the `add_person` card with `provisionalPersonId` in its
  args, and link the row to the proposal. The existing fact and relationship-edge
  writes then run for new people too, attached to the provisional id. A second
  thread finds the row and adds to it; there is no proposal merging.
- **Provisional facts never auto-confirm.** ADR 0189's lighter bar assumes the
  subject already exists; a provisional one does not. `upsertMemory` gained
  `autoConfirm: false`, and provisional facts are not broadcast into the live
  Memory tab. They confirm only through the card.
- **Confirm promotes the row under the same id** (`createPerson({ id })`), so
  attached facts and the edge need no re-point. Facts are confirmed and the edge
  becomes `confirmed`: the user tapped a card that listed both. If a real person
  exists by then (a race or a duplicate), the facts and edge move onto that
  person instead of being dropped.
- **The card shows what it confirms**: `listPendingPersonSuggestions` appends the
  attached facts to `detail`.
- **Cleanup is one sweep, not three hooks.** A pending `add_person` ends by
  reject, expiry or source-email deletion, and all three flip `proposals.status`.
  `sweepOrphanProvisionalPeople` deletes rows whose proposal is no longer pending
  (plus their proposed facts and edges), and runs where each of those paths flips
  status and at the start of every extraction pass. A row that was never linked is
  only swept after a 10-minute grace, so a sweeper on another process cannot take
  a row mid-creation.
- **Facts are bounded** (`sanitizeFacts`): they come from untrusted email text and
  land in memory, so keys must be snake_case (else dropped, not repaired), values
  are clipped to 200 chars, repeats are dropped, and a person keeps at most 8.
- **`provisionalPersonId` is an internal field** (`INTERNAL_TOOL_FIELDS`, ADR
  0102): the model never sees or supplies it.
- The extraction prompt asks for an `organization` fact only when the email
  states one in a signature or letterhead, never guessed from the domain.
- Account fold reattributes `provisional_people.owner_user_id`.

## Alternatives considered

- **A real `people` row, no pending state** — rejected: leaks into the bulk gate,
  autocomplete, invite resolution and the People screen.
- **A `people.status` column** — rejected: 18 readers would each need the filter,
  and a forgotten one leaks quietly. The separate table gets the same result with
  no reader changes.
- **Embed the facts in the `add_person` args** — workable and needs no schema, but
  a second thread's facts must be merged into a pending proposal's `args_json`,
  and the card and the facts have to be kept in step by hand. Attaching to a real
  id reuses the known-person path unchanged.
- **Separate `add_person_fact` proposals bundled with the person** — rejected:
  one card per fact, and the bundle machinery (ADR 0029) exists to stamp a created
  id into children, which promoting under the same id makes unnecessary.

## Consequences

- Nothing mined about a new person is lost any more, provided the card is
  eventually tapped. If it expires, everything attached to it goes with it, which
  is the intended meaning of "never confirmed".
- Facts lost **before** this shipped (Julia's phone, Robert Wells's role) are not
  recovered: those threads stay marked mined. Clearing `person` marks per thread is
  a separate one-off, prod-data operation and is deliberately not part of this.
- A pending `add_person` staged before this shipped has no `provisionalPersonId`;
  a later thread about that person does not attach facts to it, as before, until
  the card is decided or expires (72h).
- The two Simon itinerary threads still return nobody; the attachment-text
  theory from ADR 0189 remains unproven for them.
