# 0088 — Email magics see calendar / tasks / trips before extracting

**Status**: accepted
**Date**: 2026-08-17

## Context

The email-magics extractor staged T2 proposals from subject/body/attachments
plus the user's timezone. The model did not know what was already on the
calendar, so a newsletter about a race the user had registered for produced
a twin event, and a date the calendar could have resolved was left unparsed.

[`chord_email.md`](../tasks/chord_email.md) §14.3 wants an index lookup
**before** the model — cheapest large win in Stage 3. Conflict-on-the-card
(§14.5) is the next slice; this ADR is the prompt-side half.

## Decision

1. **One bounded snapshot per `runEmailMagics` pass**, injected into every
   thread's extractor input as `worldContext`. Events: the owner's copies
   (`owner_user_id`) in a −12h / +60d window. Open/active tasks and
   not-yet-ended trips the user can see via membership. Caps 12 / 8 / 6.
2. **Names and dates only.** No group ids, no bodies, no other members
   (ADR 0032). Shared-group tasks may appear by title — that is the user's
   own to-do list, not a leak of the group identifier.
3. **Prompt rule.** If the email is clearly about an item already listed,
   emit `none` (never a twin). The list may still resolve a *new* obligation
   the email introduces (RSVP deadline, something to bring).
4. **Lookup is not a write.** Staging, conflict-on-card, and empty-delta
   drops stay in later Stage 3 PRs. Invite ICS skip-LLM is unchanged.
5. **Windowed by instant, not by string.** `starts_at` / `due_at` carry mixed
   offsets, so a SQL `BETWEEN` + `ORDER BY … LIMIT` would drop a real event
   today and let the lexical order pick which ones survive the cap. The SQL
   bounds are padded and the true window / order / cap are applied in JS —
   the same technique `conflicts.service` pads for. Trip dates are date-only,
   where lexical *is* the real order.
6. **Loaded only when a thread will use it.** The pass runs after every sync
   and usually finds nothing new; the snapshot is skipped in that case.
7. **Bounded in bytes, not just rows.** The row caps don't bound the prompt on
   their own — titles arrive from ICS / Google, which never see the 200-char
   tool schema. Names clip at 80 chars and the whole block ceilings at 2000,
   shedding its tail rather than growing. Events go first because they carry
   the twin-suppression weight.

## Alternatives considered

- **Per-thread keyword search against events** — more precise, more
  round-trips, and the model still needs the nearby schedule to resolve
  relative dates. Rejected.
- **Wait for conflict-at-propose and skip the prompt** — a twin that never
  stages is better than a twin that is proposed, but the model still cannot
  *use* the October date sitting on the calendar. Both slices are needed;
  this one is cheaper and first.
- **Gate the lookup to threads that look date-bearing** — raised on review as
  cost discipline. Rejected. §4's rule governs whether a *model runs*, and this
  block rides on a call already decided by the `magic` mark: one per new
  classified thread, once ever. A subject-regex gate would also miss the case
  this ADR exists for — the half marathon's date is on the **calendar**, not in
  the mail, which is why per-thread keyword search was rejected above.
  The honest per-pass lever is the yield / dead-letter exit (§14.2), and that is
  Stage 4. A sender-domain gate is specifically wrong for magics: the
  deterministic bulk list (`deterministicPathFor`) is Evite / Paperless Post /
  Punchbowl / Eventbrite / Meetup — the invitation and ticket senders whose
  obligations this extractor exists to catch. Person extraction can skip them
  because people facts don't live in bulk mail; obligations do.

## Consequences

- A quiet calendar keeps the prompt unchanged (`worldContext` omitted).
- **Cost.** A full ordinary world is ~1.4k chars (~350 tokens) beside the
  prompt's own 2k-char body slice and 8k of attachment text; the ceiling caps a
  pathological one near 2k chars. The adder for a pass is `ctxChars` ×
  `processed`, both on the per-pass log line, so the next version of this
  question gets a number instead of an argument.
- Stage 3b (conflict on the card / skip empty deltas) still has to run —
  the model can ignore the block.
- Yield / Never (Stage 4) do not belong in this snapshot.
