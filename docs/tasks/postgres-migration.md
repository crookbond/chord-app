# SQLite → Postgres migration plan

Tracks the commit sequence for [ADR 0038](../notes/0038-sqlite-to-postgres.md).
Each commit lands behind the previous one with the test suite green —
no half-cut driver state on `main`.

## Commit 1 — Driver swap + squashed schema (no behavior change)

**Goal:** server boots against Postgres with the same schema as the
current end-state SQLite. No service-code changes yet.

- `server/package.json` — drop `better-sqlite3`, add `pg`. Add
  `@types/pg` to devDependencies.
- `server/src/config/env.ts` — replace `DB_FILE` with `DATABASE_URL`
  (default `postgresql://chord@127.0.0.1:5432/chord`). Keep `DATA_DIR`
  / `FILES_DIR` (still anchor uploaded files).
- `example.env` — same change, with a comment showing the libpq URL
  shape and a note that the on-VM role/db are created out-of-band.
- `server/src/db/index.ts` — `openDb()` returns
  `new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: env.DATABASE_URL, max: 10 }) }) })`.
  Drop the `journal_mode`/`foreign_keys` pragmas.
- `server/src/db/paths.ts` — drop the `DB_FILE` resolution; keep
  `FILES_DIR`/`LOGS_DIR`.
- `server/src/db/migrate.ts` — replace the 46-entry migration array
  with a single `001_pg_init` migration containing the end-state
  schema (every `CREATE TABLE`, `CREATE INDEX`, `CREATE UNIQUE INDEX`
  in Postgres SQL). FTS handling lands in commit 2 — `attachment_chunks`
  is created here as a plain table (id/text columns) without the
  `tsvector` column yet, matching the SQLite end-state.
- `server/src/db/schema.ts` — confirm every column type stays
  compatible with Postgres (TEXT → text, INTEGER → integer). No type
  renames; the Kysely TS types are unchanged.
- `docs/notes/legacy-sqlite-migrations.ts.md` — verbatim copy of the
  old SQLite migration array, fenced as TS, with a one-paragraph
  header explaining why it's frozen.
- `docs/ops/postgres.md` — one-time VM setup (`apt install
  postgresql-16`, `sudo -u postgres createuser`, `createdb`,
  pg_hba.conf for peer/scram). Cross-link from `docs/ops/dev.md`.
- `docs/ops/storage.md` — clarify that `DATA_DIR` no longer holds the
  DB file.

**Tests:** vitest runs against a freshly-migrated Postgres. The
existing in-memory SQLite path is gone; `openTestDb()` is updated in
this commit too (otherwise nothing runs). Test helper uses a
per-suite schema in `chord_test` provisioned by `globalSetup`.

**Risk:** highest of the five. Everything in subsequent commits
assumes this one is green.

> **Status update:** the FTS rewrite below was bundled into commit 1
> (`ce4fb45`) rather than landing as a separate commit. The data
> migration script described under "Commit 3" landed next as commit 2
> on the calling user's local. Sections kept verbatim for historical
> intent.

## Commit 2 (folded into 1) — FTS rewrite: `attachment_chunks` → tsvector

- New migration `002_attachment_chunks_tsv` — add
  `body_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, ''))) STORED`,
  create `GIN (body_tsv)`.
- `server/src/services/attachments.index.ts` — rewrite
  `searchAttachmentChunks`:
  - build a `to_tsquery` from the user query (`buildMatchQuery` →
    `buildTsQuery`); keep the prefix-OR shape (`foo:* | bar:*`).
  - `SELECT ts_rank_cd(body_tsv, query) AS rank,
    ts_headline('english', text, query, 'MaxFragments=1, MaxWords=32,
    MinWords=8, StartSel=«, StopSel=»') AS snippet`.
  - reorder by `-rank` so the JS-side filename boost still subtracts a
    constant from a "lower is better" score.
- Indexing path (`indexAttachmentChunks`) — no changes; the generated
  column derives `body_tsv` automatically on insert.

**Tests:** add a vitest case that indexes two synthetic chunks
("milk groceries" + "soccer practice tuesday") and asserts the
right one ranks first for "milk" and the right one for "practice".

## Commit 3 — Data migration script

`scripts/sqlite-to-pg.ts`:

- opens the production `data/chord.sqlite` read-only via
  `better-sqlite3` (the dep is still in the migration script's
  package.json only).
- opens the target Postgres via the same `openDb()`.
- runs `applyMigrations` first so the schema exists.
- for each table in topological order (users → groups → group_members
  → messages → attachments → ...), streams rows in batches of 500
  and bulk-inserts with `kysely.insertInto(...).values(batch).execute()`.
- after attachments + chunks are loaded, runs a SELECT that touches
  every row of `attachment_chunks` to force the `body_tsv` generated
  column to materialize (it's already STORED so this is just a
  consistency check).
- prints a per-table row-count diff at the end.

**Operational runbook in the commit message:**

```
ssh vm
sudo systemctl stop chord
sudo -u postgres createdb chord   # one-time
cd /opt/chord && npm run pg:import -- --sqlite=/opt/chord/data/chord.sqlite
sudo systemctl start chord
```

**Tests:** unit test on a tiny fixture sqlite (created in the test
itself) → migrate → assert row counts and FK integrity. Doesn't
need to cover every table; the smoke test guards against the
script crashing on empty tables / null columns.

## Commit 4 — Type cleanup (defer-or-do)

Only land this once commits 1–3 are stable. Migrates:

- `INTEGER 0/1` booleans → `boolean`. Sweep service code for
  `=== 1`/`=== 0` and replace with truthy checks; update
  `db/schema.ts` types.
- ISO 8601 `text` datetimes → `timestamptz`. Service code already
  passes ISO strings; Postgres parses them. Watch out for places
  that do `< new Date().toISOString()` string comparisons — those
  need to become Date comparisons.
- `text` JSON columns → `jsonb`, and rewrite the one `LIKE
  '%"scanDate":"..."%"' filter in `proactive.service.ts:1134` to a
  proper `payload->>'scanDate' = $1`.

Split across 2–3 commits, one column family per commit, each with a
real migration and a service-code sweep.

## Commit 5 — Ops + docs

- `docs/ops/postgres.md` filled in: backup (pg_dump cron), restore,
  vacuum / autovacuum tuning notes for a one-VM deploy.
- `README.md` — update the "first run" snippet to install Postgres
  and run `createdb` before `npm run migrate`.
- `CLAUDE.md` — add a one-liner noting the DB is now Postgres and
  point at ADR 0038. Update the "Dangers / pitfalls" section.

## Out of scope

- Connection-pool sizing for multi-node deploys.
- Replication / read replicas.
- The SSE hub adapter (ADR 0002 follow-up).
- Postgres-side row-level security for per-group scope.
