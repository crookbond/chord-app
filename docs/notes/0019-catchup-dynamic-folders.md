# 0019 — Catchup dynamic folders

**Status**: accepted — server wired 2026-05-05 (PR-C, regex classifier only). LLM classifier and 14-day demotion worker still pending.
**Date**: 2026-05-05

## Context

The Catchup tab today shows fixed sub-tabs: Tasks, Lists, Saves,
Trips. The product wants this to feel less like a database and more
like a personal Notion — folders that *appear* when there's enough
content to justify them, with names the AI picks.

Concrete examples the user has given:

- "Shopping" — when several lists exist that look like grocery /
  Costco / Target runs.
- "Tasks" — open todos.
- "Trips" — itineraries with date ranges.
- "Recipes" — emerges if you save five recipe links.
- "School" — emerges if there's a cluster of saves and lists tagged
  to the school year.
- "Other" — bucket for the unclassified.

The AI decides folder membership at write time. Folders are not a
new entity type — they are a *view* over existing entities.

## Decision

### Folders are virtual, classification is materialized

A folder is a row in a new `catchup_folders` table:

```sql
CREATE TABLE catchup_folders (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,            -- one word, lower-case, e.g. "shopping"
  display     TEXT NOT NULL,            -- "Shopping"
  kind        TEXT NOT NULL,            -- 'seed' | 'derived'
  created_at  INTEGER NOT NULL
);

CREATE TABLE catchup_assignments (
  user_id     TEXT NOT NULL REFERENCES users(id),
  entity_type TEXT NOT NULL,            -- 'task' | 'list' | 'save' | 'trip'
  entity_id   TEXT NOT NULL,
  folder_id   TEXT NOT NULL REFERENCES catchup_folders(id),
  source      TEXT NOT NULL,            -- 'classifier' | 'manual'
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, entity_type, entity_id)
);
```

Folders are **per-user**, not per-group, matching ADR 0004's
position that views are user-scoped even though entities are
group-scoped.

### Seed folders

Every user starts with four seeds: `tasks`, `lists`, `trips`, `other`.
These are inserted on first login and cannot be renamed or deleted.
`other` is the catch-all — any entity the classifier can't place
goes there.

### Derived folders — promotion threshold

The classifier runs on every entity create and on every entity
update that changes its name or content. It returns a single
suggested folder name (one word, lowercase, e.g. `shopping`,
`recipes`, `school`).

- If the suggested name matches an existing folder for this user,
  assign there.
- Otherwise the entity is assigned to `other` *and* the suggested
  name is recorded in a `pending_folder_name` column on the
  assignment.
- When N items in `other` share the same `pending_folder_name`, a
  promotion job fires:
  1. Create a new `catchup_folders` row with `kind = 'derived'`.
  2. Reassign all matching entities from `other` to the new folder.
  3. Broadcast `SSE.catchupFolderCreated` so the mobile client
     animates the folder in.

`N = 4` to start. Tunable in `env.CATCHUP_PROMOTION_THRESHOLD`.

### Demotion

If a derived folder ends up with fewer than `N - 1` entities for
14 consecutive days (e.g., the user deletes everything school-
related after the year ends), it is auto-collapsed back into
`other`. Folder row stays but gets `kind = 'archived'` so the same
suggestion later can re-promote it. No data loss.

### Manual override

The user can:
- Drag an entity between folders. Sets `source = 'manual'`. The
  classifier is not allowed to overwrite manual assignments.
- Rename a derived folder. Updates `display`, `name` is locked once
  set so SQL paths stay stable.
- Pin a derived folder. Pinned folders are exempt from demotion.

### Classifier

A small LLM call: given an entity (name + a few items / first lines)
and the user's current folder list, output one of:
- `<existing folder name>` to assign there
- `<new one-word name>` to suggest a new folder
- `other` to give up

Prompt is one paragraph, temperature 0.2, runs in the same provider
as the bot. A regex fallback (Costco/Target/grocery → shopping;
recipe.com / allrecipes → recipes; etc.) handles obvious cases
without hitting the LLM, and the mock provider uses regex only.

## Alternatives considered

- **Tags, not folders.** More flexible (one entity, many tags) but
  loses the "stuff just appeared in a new folder" feel the user is
  after. Save for a future iteration.
- **AI-named folders without a threshold.** Folders churn — every
  new entity might create a folder. The threshold ensures folders
  feel earned.
- **Server-side classification on a cron, not at write time.** Adds
  latency to the user's "I added a list, where did it land?"
  question. Doing it inline is cheap (a single small LLM call).
- **Vector-clustering instead of LLM.** Overkill for the cardinality
  here (low hundreds of entities per user). The LLM call is small
  and the prompt is bounded by current folder list.

## Consequences

- Two new tables, one new SSE event, one new env var.
- New service `services/catchup/classifier.service.ts`. Hooks into
  every entity create path (`tasks.service`, `lists.service`,
  `saves.service`, `trips.service`).
- Mock LLM provider gets a regex-driven classifier so demos work
  without a key (consistent with ADR 0003's existing mock surface).
- Mobile renders folders dynamically from `/me/catchup/folders`.
  Empty derived folders never appear — only seeds always show.
- Promotion / demotion windows make folder count stable enough for
  UI animation without flicker.
- Out of scope: cross-user folder sharing, classifier learning from
  manual overrides (could be a future "we noticed you keep moving
  these — should this be its own folder?" prompt).
