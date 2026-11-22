# SQLite → Postgres migration — done

> **Status:** complete. This file is preserved as a redirect so existing
> links don't break.

The migration shipped per [ADR 0038](./notes/0038-sqlite-to-postgres.md).
The commit-by-commit plan and operational runbook (local + prod) are in
[`tasks/postgres-migration.md`](./tasks/postgres-migration.md).

Quick links if you're here looking for setup:

- One-time Postgres install + role/db creation → [`ops/postgres.md`](./ops/postgres.md).
- Importing a legacy `chord.sqlite` into Postgres → same file, section
  "Importing an existing SQLite database".
- Why the cutover happened + type-mapping rules + pitfalls →
  [ADR 0038](./notes/0038-sqlite-to-postgres.md).
- Historical migration list (the 46 SQLite migrations squashed into
  `001_pg_init`) → [`notes/legacy-sqlite-migrations.ts.md`](./notes/legacy-sqlite-migrations.ts.md).
