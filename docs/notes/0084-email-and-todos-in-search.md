# ADR 0084 — Email and pending to-dos join search, personal-scope only

**Status:** Accepted · 2026-08-13
**Extends:** [0062](./0062-global-search-fts.md) (user-facing global search),
[0059](./0059-unified-search-tool.md) (the bot's umbrella `search` tool)
**Constrained by:** [0032](./0032-strict-per-group-scope.md) (strict per-group scope)

## Context

Chord read, classified and acted on the user's mail, and none of it was
findable. Both search paths excluded email:

- the user-facing path (ADR 0062) indexed `message | file | task | list | save`;
- the bot's umbrella tool (ADR 0059) swept ten types, none of them mail.

So "find that email about the permission slip", asked in the 1:1 chat where the
search affordance lives, searched everything *except* the inbox. Pending
proposals — the Action Items the user is supposed to decide on — were equally
unfindable.

## Decision

Add two entity types on both paths: `email` / `emails`, and `todo` / `todos`.

### Email is searchable ONLY from the personal 1:1

This is the load-bearing decision. `email_threads` is keyed by `user_id` and
has no `group_id`: mail is personal data that never belonged to a group. The
existing scope model is group-based — cross-group from the personal chat, this
group only from a shared one — so email has to be placed deliberately rather
than falling out of the model.

It is searched **only when `crossGroup` is true**, which the callers guarantee
means the personal group. Returning a member's private mail inside a shared
group's search — or, worse, letting the bot answer a shared-group question with
it — is exactly the leak ADR 0032 exists to prevent. Hits are attributed to the
personal group with the display name `Email`.

### Email gets a real index; to-dos deliberately do not

Email uses a generated `search_tsv` + GIN (migration `038`) over subject,
snippet and sender, mirroring ADR 0062. Postgres maintains it on write, so
there is no sync code to drift. Threads only — message bodies are lazily
fetched and often absent locally, and subject/sender is what people search by.

Pending proposals get an **in-memory filter** instead. Their text lives inside
`args_json`, so a generated column would tokenise JSON keys (`title`,
`startsAt`) alongside the content and match on them. The set is also naturally
bounded, since proposals expire. `proposalLabel()` pulls the first human field
out of the args and falls back to the tool name, so an unrecognised proposal is
still findable rather than invisible.

### Email hits carry their action

Each hit includes the ADR 0086 `action`, so "which of these needs a reply" is
answerable from one call rather than a search followed by a second pass.

## Consequences

- **A shared-group search returns zero emails, silently.** The bot tool
  description says so explicitly, because the failure mode is the model
  inferring that the user has no matching mail rather than that it cannot see
  mail from here.
- **Archived mail is excluded**, matching every other email surface (ADR 0073).
- **To-dos stay group-scoped** and therefore obey the existing membership
  pre-filter unchanged; a to-do hit carries a group NAME, never a raw id, so
  ADR 0032's scrubber does not drop it on the bot path.
- **`SEARCH_ENTITY_TYPES` grew**, which is a breaking-ish change for any
  exhaustive `Record<SearchEntityType, …>`. The mobile search modal's icon and
  label maps were exactly that, and the compiler caught both.
- To-do hits share the rank-ordered score band used for files rather than a
  `ts_rank_cd` score; normalising the two scoring schemes remains the
  documented follow-up from ADR 0062.

## Alternatives considered

- **Index email message bodies too.** Better recall, but bodies are fetched
  lazily on thread open, so the index would be sparse and inconsistent in a way
  users would read as broken search.
- **Give email a synthetic group so it flows through the group model
  unchanged.** Less special-casing, at the cost of inventing a group that
  exists only to satisfy a filter — and one bad membership query away from
  making private mail group-visible.
- **A tsvector on `proposals.args_json`.** Consistent with the other types, but
  it indexes JSON keys as content and buys nothing on a set that is small by
  construction.
