# 0066 — In-repo LLM email classifier

**Status**: accepted
**Date**: 2026-07-14

## Context

ADR 0061 (as described in `docs/tasks/email-reader-plan.md`) owns the
classification *contract* and ingest path; the original plan left the clustering
engine to another team. We still need a real classifier for demos and for users
before an external worker exists. Options were: fork an OSS labeller, buy
enterprise search, or own a small LLM classifier inside Chord.

## Decision

Ship a **Chord-owned in-repo LLM classifier** under
`server/src/services/email/llm-classifier.ts`, gated by `EMAIL_CLASSIFIER=llm`.

- Emits the existing `EmailClassificationSnapshot` and calls
  `ingestClassification` (same path as the mock fixture).
- Batches new/changed threads (`EMAIL_CLASSIFIER_BATCH_SIZE`), merges results
  into the previous tree, and fail-closes on LLM/parse errors (never wipe tiles).
- Uses `getLlmForUser` (BYOK-aware). `EMAIL_CLASSIFIER=mock` remains for
  zero-LLM demos/tests.
- `POST /api/v1/me/email/classification` accepts either a user session **or**
  `x-chord-classifier-token: <EMAIL_CLASSIFIER_SERVICE_TOKEN>` with
  `snapshot.userId`, so a future external worker can use Mode B without a new
  ingest surface.

## Alternatives considered

- **Fork email-labeller / emailibrium** — heavy dependency surface; contract
  mismatch with our snapshot shape; not worth owning their stack.
- **Glean / enterprise search** — paid, poor fit for a personal inbox tile tree.
- **External-only classifier from day one** — blocks AI tiles in production
  until another team ships; mock alone is not enough for real mail.
- **Embeddings / vector DB** — overkill for v1 path assignment; revisit if
  taxonomy quality stalls.

## Consequences

- Production stays off until `EMAIL_CLASSIFIER=llm` is set plus a working LLM
  key (`LLM_PROVIDER` / BYOK).
- Snapshot-replace + batch merge means untouched threads keep their prior path;
  a failed LLM call leaves the previous classification intact.
- Service token is optional; empty `EMAIL_CLASSIFIER_SERVICE_TOKEN` keeps
  session-only ingest (current behavior).
- Mock and LLM share `classifier-tree.ts` slug/path helpers so tile ids stay
  stable across both gates.

## Addendum (2026-07-15) — social/events taxonomy, deterministic senders, Gmail category hint

Real inboxes surfaced two gaps: LinkedIn/social mail had no home (the LLM
improvised inconsistent tiles batch to batch) and event invites only fit the
family-flavored "Playdates & invites". Three changes:

- **Taxonomy**: the prompt's illustrative tiles gain
  `Social & professional → LinkedIn | Job alerts | Social updates` and
  `Events & invites → Invitations | Tickets`, plus an explicit rule that
  platform notifications are NOT "Newsletters" (that tile is for editorial
  digests).
- **Deterministic sender routing** (`deterministicPathFor`): unmistakable bulk
  senders (linkedin.com, facebookmail.com, evite.com, eventbrite.com, … —
  domain-suffix match so subdomains route) skip the LLM entirely and land on a
  fixed path with confidence 1. Cheaper, and immune to batch-to-batch naming
  drift. Fail-closed nuance: when the LLM call fails, the deterministic share
  still ingests; only the LLM's share keeps its previous classification.
- **Gmail category hint** (`gmailCategoryOf`): each LLM-batch thread now
  carries Gmail's own tab (`CATEGORY_SOCIAL` → `"social"`, promotions,
  updates, forums; `CATEGORY_PERSONAL` is dropped as noise) from the already-
  synced `gmail_label_ids` — a free signal the prompt tells the model to
  treat as strong but overridable.
- **Newsletters get topic leaves** (2026-07-16): a newsletter is never bare
  `["Newsletters"]` — the prompt requires a topic leaf (Finance | Sports |
  Tech | Recipes & food | Local | Junk, or an invented short topic), with
  `["Newsletters","Junk"]` as the sink for low-value promotional blasts.
