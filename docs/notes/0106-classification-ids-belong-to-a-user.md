# 0106 — A classification id belongs to a user

**Status**: accepted
**Date**: 2026-08-25
**Relation**: fixes a latent flaw in [0066](./0066-in-repo-llm-email-classifier.md)'s
snapshot-replace ingest; the failure mode is
[0102](./0102-a-failed-tool-does-not-get-to-explain-itself.md)'s again — an
integrity fault logged at `warn` and mistaken for a flaky model for days.

## Context

Reported as a classification-quality question: *"why is this newsletter not
classified as newsletter?"* Checking prod turned up something else entirely.

`email_categories.id` is `text PRIMARY KEY` — **global**. But the id is derived
from the title path alone (`categoryIdForPath(['Newsletters']) → mk:newsletters`)
and `ingestClassification` deletes only the caller's rows. So every user
independently produces the *same* id, and:

- the first user to classify inserts `mk:newsletters` and owns it;
- every later user's ingest hits `duplicate key value violates unique constraint
  "email_categories_pkey"`;
- ingest is one transaction, so the whole snapshot rolls back — not one row;
- `afterSync` catches it at `warn`, so it reads as a flaky LLM call.

Nothing recovers, because the next sync attempts the identical insert. In prod
one account held all 48 category rows and worked perfectly, while **three other
mailboxes — 1,288 threads — had never been classified at all**, failing on every
sync since at least 22 Aug:

```
llm classifier failed: duplicate key value violates unique constraint
  "email_categories_pkey"
```

Classification was, structurally, a single-user feature. Nobody noticed because
the one user it worked for was the one looking.

## Decision

**Namespace the id where it is stored, not where it is minted.**
`storageCategoryId(userId, id) → `${userId}:${id}`` is applied at the three
write sites inside `ingestClassification`. Snapshot ids stay user-local
(`mk:newsletters`); only the stored id is scoped. Reads need no change — every
reader already selects the stored id, hands it to the client, and the client
echoes it back into `?category=`. Nothing parses it.

**Why the ingest boundary and not `categoryIdForPath`.** The obvious fix is to
thread `userId` through the tree builder, and it was written that way first. It
is wrong: `POST /me/email/classification` (ADR 0061 Mode B, service-token) takes
a snapshot from an **external** classifier that never touches
`classifier-tree.ts` and cannot know a Chord user id. That path would have
stayed exactly as wedged. Ingest is the one choke point every classifier
crosses.

It also keeps the id short. `CategoryNode.id` is capped at 128 in the kernel
contract, and validation runs on the snapshot before prefixing, so the namespace
costs nothing against a budget a depth-3 path of invented titles can already
strain.

**Migration 046** re-keys the existing rows. Extracted to
`db/email-category-ids.ts` as `scopeEmailCategoryIds` so it can be tested
against a real database, the way `mergeDuplicateLists` and
`hardenCalendarIdentity` already are. Two things it must do that are easy to get
wrong:

- **Drop both foreign keys for the rewrite.** They are immediate, so with them
  in place rewriting ids first strands the children and rewriting children first
  points them at rows that do not exist yet. No ordering of plain updates holds.
- **Open its own transaction.** `applyMigrations` runs each `up` bare — a
  half-rekeyed tree with its foreign keys dropped is not a state to leave
  behind.

Every statement is guarded on the prefix being absent, so a re-run is a no-op
rather than `u1:u1:mk:…`.

**And the log line moves to `error`.** A primary-key violation inside ingest is
a data-integrity fault that repeats forever; at `warn` it was indistinguishable
from the transient LLM failures either side of it.

## Consequences

- Existing rows keep their classification — this is a re-key, not a reclassify.
  The three wedged mailboxes drain on their own at `EMAIL_CLASSIFIER_BATCH_SIZE`
  (40) per sync tick, since `selectBatch` takes never-classified threads first.
- Tile ids visible to the client change shape once. They are opaque to it
  (hashed for colour, compared for identity), and the cached copy in
  AsyncStorage is overwritten on first fetch.
- A future writer that inserts a category directly, bypassing ingest, can still
  reintroduce the collision. The guard for that is a
  `CHECK (left(id, length(user_id) + 1) = user_id || ':')`, deliberately **not**
  added here: it trips four unrelated test fixtures that insert categories
  directly, and that churn does not belong in a fix this narrow. Worth adding.

## Alternatives rejected

**Composite primary key `(user_id, id)`.** The more correct-looking schema, and
the more dangerous one. Six join and update sites key on `id` alone today —
including a `gmail_label_id` update with no `user_id` predicate at all — so the
moment ids stop being globally unique each becomes a silent cross-user row
match. That trades a loud duplicate-key crash for a quiet tenancy bug.

**Opaque random ids with a unique `(user_id, path_key)`.** Because ingest is
delete-and-reinsert, keeping tile ids stable would mean reading the old ids back
by path key inside every transaction — all to store a path key that the
deterministic id already is.

**Deleting the tree and reclassifying.** Simplest migration, but it empties a
working user's email map and refills it 40 threads per sync tick.
