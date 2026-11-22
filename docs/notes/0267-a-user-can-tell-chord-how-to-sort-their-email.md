# 0267 — A user can tell Chord how to sort their email

**Status:** Accepted, 2026-10-18

## Context

The email sorter (the LLM classifier, ADR 0066/0086/0109) files each thread
under a category path from a fixed illustrative vocabulary. Nothing the user
said could change it: "never put the PTA newsletter in Newsletters", "Chase
emails go in Finance", "make a category for Kids' sports" had nowhere to go.
The only per-user email rules (ADR 0077) route mail to GROUPS and only read
the category.

## Decision

Two per-user lists in `users.defaults` (ADR 0255 key store, so no migration),
set in the 1:1 chat:

- **Sorting rules** (`email_sort_rules`): `{ from?, subject?, category, rule:
  always | never }`. `from` is an address or a domain (a domain covers its
  subdomains); `subject` is words that must appear (case ignored); at least
  one is required. Saying the same sender/subject/category again replaces
  the old rule.
- **The user's own categories** (`email_user_categories`): `{ title, about }`,
  where `about` says what belongs there in the user's words.

The sorter uses them on every pass, three ways:

1. The system prompt lists the user's categories (with `about`) and rules.
2. After the model answers, the rules are applied to every thread in the
   batch (`applySortRules`): an `always` rule sets the path (the newest
   matching one wins; a title already in the tree resolves to its full path,
   a new one is top-level), then each `never` rule cuts its category and
   everything below it off the path. A thread a rule leaves with no category
   is dropped from the carried-forward baseline too, so the old path cannot
   come back. Step 2 is why the rules hold even when the model ignores step 1.
3. Adding or removing a rule re-queues the mail it covers
   (`classifier_version = 0`), so existing threads are re-sorted, not only
   new ones. A new category re-queues the last 30 days, since only the model
   can tell what fits it.

A `never` rule needs a category that exists (else nothing is saved and close
names are offered); an `always` rule naming a new category creates it.

Chat tools, all personal-only (their contents are the user's own mail
setup): `add_email_sort_rule`, `create_email_category`,
`list_email_sort_rules`, `remove_email_sort_rule` (removes every rule matching
the fields given; a category name alone also deletes a category the user
created). No Settings screen yet; chat is the place to say these, the same
call ADR 0161 made for briefing exclusions.

ADR 0149 gate: these decide what the AI view and its decisions are grouped
under, which the user asked to control; no mail-client polish is added.

## Consequences

- Rules apply only when `EMAIL_CLASSIFIER=llm`; the mock classifier ignores
  them.
- Re-sorting is not instant: re-queued mail goes through the normal batches,
  newest first.
- A new category appears only once some mail is filed in it.
- Rules are matched against sender and subject only, never the body.

## Rejected

- Prompt-only rules (the model can and does ignore instructions; ADR 0100's
  precedent).
- Re-sorting the whole mailbox on every rule change (a model call per thread
  for mail the rule cannot touch).
- Storing rules against category ids (the ids are rebuilt from titles on
  every pass, ADR 0106; a title is also what the user says).
