# Dogfooding people/family extraction (ADR 0076)

`EMAIL_PERSONS_ENABLED` is default-on, and the F&F plan flags that it has
**never been verified against a real mailbox**. `runPersonExtraction` has good
unit coverage (`person-extraction.test.ts`), but nobody has read what it
actually produces from real senders and real model output.

`npm run dogfood:persons` is the safe way to look. It runs the **real** pass
over whatever is already in a user's `email_threads` mirror, prints per thread
what the model returned and what would be staged, and **rolls the whole thing
back** unless you pass `--commit`.

## Runbook

```bash
# 1. Connect a real Gmail in a dev build (GMAIL_PROVIDER=real) and let it sync,
#    or point at a user who already has a synced mailbox.
# 2. Set a real LLM key — the pass uses the system provider (getLlm()).
#    With LLM_PROVIDER=mock the wiring runs but the model returns no people.

# 3. Dry run — nothing is written:
npm run dogfood:persons --workspace=server -- --user you@example.com --limit 50

# 4. Read the report (below). If it looks right on your mailbox:
npm run dogfood:persons --workspace=server -- --user you@example.com --limit 50 --commit

# --json for the structured form; --user also accepts a raw userId.
```

`--commit` persists the `add_person` / `add_important_date` proposals, any
bootstrap auto-written people, the memory proposals, **and** the once-ever
`person_processed_at` marks. After that, the normal `afterSync` pass handles new
mail.

## What the report shows

- **Candidates in scope** — threads matching the same selection the real pass
  uses (unmarked, not archived, past the ADR 0127 bulk gate), newest first, up
  to `--limit`.
- **reached the model / skipped pre-model** — how many candidates were sent to
  the LLM vs. dropped for free as a bulk sender (`deterministicPathFor`) or
  automation (`no-reply@…`), with examples.
- **Per thread** — sender, subject, and the parsed `ExtractedPerson[]`: name,
  relationship, confidence, any dates/facts.
- **Would stage** — bootstrap auto-writes (people created with no confirm),
  `add_person` proposals, `add_important_date` proposals, memory
  proposals/writes — the actual row contents, not just counts.
- **Totals** — the `PersonExtractionResult`.

## Findings from a code read — what to watch in a real report

1. **Bootstrap auto-writes are the risk moment.** A user's *first* pass (no
   `people` rows, no prior email-derived person proposals) auto-creates up to
   `BOOTSTRAP_PERSON_CAP` (12) people at confidence ≥ `BOOTSTRAP_CONFIDENCE`
   (0.8) with **no proposal and no confirm** (`person-extraction.ts` §
   `autoWrite`). On a mailbox with years of history this fires on the oldest 12
   high-confidence hits. Read that list first: a colleague who wrote "my wife
   booked it", a landlord, a one-off contractor's "regards, and say hi to the
   kids" are all plausible 0.8s. If it looks wrong, the levers are
   `BOOTSTRAP_CONFIDENCE` / `BOOTSTRAP_PERSON_CAP`, or making bootstrap
   propose-only.

2. **Yield is gated hard before the model.** `minablePredicate` (ADR 0127) +
   `deterministicPathFor` + `NOREPLY_RE` remove most mail. On a personal Gmail,
   *reached the model* will be a small fraction of the inbox. If real family
   mail is being skipped, check whether that sender is being scored as bulk.

3. **System-key billing.** `llmPersonExtractor` calls `getLlm()` (the system
   provider), not `getLlmForUser()`. A BYOK user's person-extraction spend
   lands on the **system** key. This matches `magics.service.ts`; the
   classifier (`llm-classifier.ts`) uses `getLlmForUser`. Decide whether the
   two per-thread passes should follow the classifier.

4. **`knownPeople` starts empty.** The prompt lists already-known people so the
   model reports only *new* facts about them. Early in a mailbox that list is
   empty, so people you added via About-Me / contacts get re-proposed;
   `findPersonByName` dedups exact names, nickname/spelling variants slip
   through as proposals.

5. **Relationship enum vs. free text.** `RELATION_MEMORY_KEY` maps only
   spouse/partner/kid/parent/sibling/friend (+ synonyms) to a `*_name` memory
   key. "grandmother", "nanny", "in-law" → a person proposal but no memory
   fact.

6. **Body text.** Since ADR 0110's addendum the passes get `body_text` (capped
   at 2000 chars). On an older mailbox some rows still have null bodies —
   confirm the per-thread output shows the model had more than a subject line.

7. **Once-ever mark.** A thread mined once (`person_processed_at`) is never
   revisited, even if extraction later improves. A dry run does not set it
   (rolled back); `--commit` does.

## Related

- `server/src/services/email/person-extraction.ts` — the pass.
- `server/src/services/email/__tests__/person-extraction.test.ts` — logic
  coverage (bootstrap, steady-state, gates, caps, dedup, sweep).
- ADR 0076 (people + family facts), ADR 0127 (bulk gate), ADR 0149 (this is
  sanctioned-lane item 1: verify against a real mailbox).
