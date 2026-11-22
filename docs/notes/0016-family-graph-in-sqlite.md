# 0016 — Family graph in SQLite

**Status**: accepted — storage now Postgres, see [0038](./0038-sqlite-to-postgres.md) — UPDATED 2026-06-01
**Date**: 2026-05-03

## Update — 2026-06-01

The relationship / important-dates graph model below is unchanged and still in
use. Only the store changed: it lives in Postgres now, not SQLite, per
[0038](./0038-sqlite-to-postgres.md). The "SQLite" in the title is kept as
history. Read the SQLite-specific phrasing below as "the relational store".

## Context

Chord needs to know about the people around the user — parents,
children, siblings, in-laws, close friends — so it can:

- Nudge about birthdays / anniversaries / death anniversaries.
- Suggest cards / gifts / calls in time for them.
- Resolve "Mom" in a chat message to a specific person, with their
  address when needed.
- Filter to "people within 2 hops with a relevant date in the next N
  days" for the daily nudge prompt (see Phase 5E).

Two questions: what data shape, and what storage.

The product also asked for **per-user JSON profile** with the user's
own contact info + addresses. That is a separate surface — the user's
*own* preferences and account-shaped data. The two need a clean
boundary so they don't both end up holding "John's address" with
divergent values.

## Decision

### Storage: SQLite, relational

Use the existing SQLite database with a small set of normalised
tables. No graph DB (Neo4j, etc.). Graph queries — "people within 2
hops of the user" — use SQLite recursive CTEs.

```sql
CREATE TABLE people (
  id            TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  display_name  TEXT NOT NULL,
  notes         TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE relationships (
  from_person_id TEXT NOT NULL REFERENCES people(id),
  to_person_id   TEXT NOT NULL REFERENCES people(id),
  kind           TEXT NOT NULL,  -- parent | child | spouse | sibling | grandparent | in_law | friend | other
  PRIMARY KEY (from_person_id, to_person_id, kind)
);

CREATE TABLE important_dates (
  id         TEXT PRIMARY KEY,
  person_id  TEXT NOT NULL REFERENCES people(id),
  kind       TEXT NOT NULL,  -- birthday | anniversary | death | other
  date       TEXT NOT NULL,  -- ISO yyyy-mm-dd; year may be 0000 for unknown
  recurs     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE addresses (
  id         TEXT PRIMARY KEY,
  person_id  TEXT NOT NULL REFERENCES people(id),
  label      TEXT,            -- "home" | "work" | etc.
  address    TEXT NOT NULL
);

CREATE TABLE contact_methods (
  id         TEXT PRIMARY KEY,
  person_id  TEXT NOT NULL REFERENCES people(id),
  kind       TEXT NOT NULL,   -- email | phone | other
  value      TEXT NOT NULL,
  label      TEXT
);
```

`relationships` is directional and asymmetric on purpose — `parent`
from A → B does not auto-imply `child` from B → A. Bot tools that
write a parent relationship insert the inverse explicitly. This is
verbose but keeps the read path obvious.

### Source-of-truth boundary

- **Family graph** is canonical for any person *other than the user*.
- **Profile JSON** (per-user) is canonical for the user's *own*
  preferences, settings, and account-shaped data — including the
  user's own address and birthday.

The user does not get a `people` row for themselves. `owner_user_id`
on `people` ties the graph to the user; queries that walk the graph
start from `users.profile_json` and then traverse `people`.

Concrete consequence: if the bot is asked "what's Mom's address?", it
queries `people` + `addresses`. If asked "what's *my* address?", it
reads `profile_json`.

## Alternatives considered

- **Neo4j (or any graph DB).** Right model, wrong scale. A family
  graph has ~10–100 nodes and ~10–500 edges. SQLite recursive CTEs
  finish in microseconds at that size. Adding a second datastore
  doubles operational surface for zero query-perf benefit.
- **One JSON blob per user holding everything (people, edges,
  dates).** Tempting — matches the "easy to read whole" instinct
  behind the profile JSON. Rejected: as soon as a bot tool wants to
  "find people with a birthday in the next 14 days", we either build
  an index over the JSON (badly reinventing a relational schema) or
  scan every user's blob (slow once we have more than one user).
  Relational here is cheaper.
- **Put people + relationships in the existing `contacts` table.**
  `contacts` is already used for ad-hoc "save this person's phone
  number" entries from the bot's `save_contact` tool — flat, no
  edges, no important dates. Rejected: bolting relationships onto
  `contacts` blurs the distinction between "people I might want to
  text" and "members of my family graph the bot should reason
  about". Keep them separate; bot tools can promote a `contacts` row
  into a `people` row when the user confirms.
- **Store everything (including the user's own data) in the graph and
  drop profile JSON.** Rejected: profile JSON is the right shape for
  preferences ("I prefer evening reminders"), settings, and the
  user's connected-account state — none of which is graph-shaped.

## Consequences

### What this commits us to

- **Migrations**: a new migration adds `people`, `relationships`,
  `important_dates`, `addresses`, `contact_methods`. All scoped by
  `owner_user_id` (directly or transitively through `person_id`).
  No cross-user visibility.
- **Bot tools** (Phase 5D): `add_person`, `link_people`,
  `add_important_date`, `set_address`, `set_contact_method`, plus
  read-side `find_people` (by name / by relationship-from-user / by
  upcoming date). Native function-calling friendly.
- **Two-hop CTE is the canonical query for nudges.** A SQL view
  `family_graph_2hop(user_id, person_id, distance)` materialises it;
  the daily-nudge `family-context.md` partial is a thin SELECT on
  that view + `important_dates` filtered by date window.
- **Year-zero birthdays**. We accept `0000-mm-dd` for unknown years.
  Date math has to handle this — birthdays are recurring on
  `mm-dd`, not on the literal stored date.
- **Owner-scoped, not group-scoped.** Unlike most existing tables,
  the family graph is `owner_user_id`-keyed. ADR 0004's "agent is
  group-scoped" doesn't apply here: family-graph reads happen in the
  user's *personal* group only. Nudges land in personal chat (ADR
  0012); shared groups never see another user's family-graph data.

### What we explicitly do NOT do

- **No automatic inference of relationship inverses.** The bot
  writes both directions explicitly when it adds a relationship.
- **No graph-DB layer.** Stay in SQLite until we have a query that
  doesn't fit (we won't).
- **No shared family graphs** across two users in the same family.
  Each user has their own. Q4 in `phase-5-plan.md` captures the
  follow-up.
- **No PII export endpoint yet.** GDPR-style "give me my graph as
  JSON" is a future ask; capture when we have a real user.
