# Storage

## Where everything lives

```
chord-demo/
├── data/
│   └── files/
│       ├── group/{groupId}/{attachmentId}/{filename}
│       └── user/{userId}/{attachmentId}/{filename}
└── logs/
    ├── combined.log          # all Winston output
    └── error.log             # errors only
```

The **database** itself lives in Postgres now — see
[`postgres.md`](./postgres.md) and [ADR 0038](../notes/0038-sqlite-to-postgres.md).
`data/` only anchors uploaded files (and the extraction scratch dir).
`logs/` is unchanged.

Both `data/` and `logs/` are anchored to the **repo root**, not the
current working directory. The resolution happens in
`server/src/config/env.ts` via `fileURLToPath(import.meta.url)` going
up three dirs from `server/src/config/`. So you can launch the server
from anywhere and paths stay stable.

Both dirs are gitignored.

### Pointing storage elsewhere

If you want uploaded files and Winston logs outside the repo (a shared
volume, a Windows drive, anywhere stable across `git clean`), set
`DATA_DIR` and `LOGS_DIR` in `.env.local`:

```bash
DATA_DIR=/mnt/c/dev/chord-deps/data
LOGS_DIR=/mnt/c/dev/chord-deps/logs
```

These have been supported since `phase 0`. Use them instead of
committing symlinks at `data` / `logs` — a tracked symlink to a
developer-specific path breaks every other clone, and pulling the
commit can also wipe an existing local `./data/` directory in the
forced-checkout case.

### Recommended for personal dev: preserve data across `git clean`

The repo-root default keeps a demo self-contained, which is what you
want for clean demos and CI. For ongoing personal dev where losing
your uploaded files would be expensive, point `DATA_DIR` somewhere
git can't touch:

```bash
# .env.local (already gitignored, won't affect anyone else)
DATA_DIR=$HOME/chord-data
LOGS_DIR=$HOME/chord-logs
```

Database state lives in Postgres independently — see `postgres.md`
for the backup story there (`pg_dump` cron).

## Postgres

- Same-VM Postgres in the default deploy; `DATABASE_URL` configurable.
- Driver: `pg` (node-postgres), pooled.
- Kysely's `PostgresDialect` against a `pg.Pool` of `max: 10`.
- The DB shape is declared in `server/src/db/schema.ts` and the
  migration runner lives in `server/src/db/migrate.ts`. Per ADR 0038
  the schema is currently captured in one squashed `001_pg_init`
  migration; new migrations resume sequential numbering from there.

Migrations are idempotent — `CREATE TABLE IF NOT EXISTS` + an
`_migrations` ledger. Re-running `npm run migrate` is safe and a
no-op after the first time.

### Migration conventions (multi-developer)

- **Forward-only.** Never edit a migration that has shipped, even on
  your local DB. Add a new migration that fixes/extends the prior one.
  Once a migration name is in `_migrations`, the runner skips it; an
  edited body silently desyncs every other developer's DB.
- **Numbering.** `NNN_short_name` where `NNN` is the next free 3-digit
  number in the `migrations` array. Numbers are advisory ordering,
  not unique keys — the DB tracks by `name`, so two devs adding
  `005_*` on parallel branches don't break the runner. On merge,
  renumber whichever lands second so the file list stays in
  execution order.
- **One concern per migration.** A column add and a backfill belong
  in the same migration; an unrelated table belongs in another.
- **Backfills go in the same migration, not a one-off script.** A
  migration must leave the DB in a state the next migration assumes.
- **No destructive drops without an ADR.** Postgres makes
  `ALTER TABLE ... DROP COLUMN` cheap, but the contract still binds
  service code; rename/copy/swap if there's any possibility of
  in-flight writers.

To reset local DB state:

```bash
dropdb chord && createdb chord && npm run migrate --workspace=server
```

## Files on disk

- Scope-keyed paths so privacy is obvious at a glance:
  - `data/files/group/<gid>/<attId>/<filename>` — visible to group members.
  - `data/files/user/<uid>/<attId>/<filename>` — private to that user.
- The **filename on disk is sanitised** (`[^a-zA-Z0-9._-]` → `_`, truncated to 128 chars) but the original filename is kept in the `attachments.filename` column for display and `Content-Disposition`.
- Access is always mediated via `GET /attachments/:id` — the files dir is **not** served statically. Authorization runs on every request (membership for group scope, owner check for user scope).

## Size limits

- `multer` cap: 20 MB per file.
- `extractedText` truncated at 40 000 characters before storage.
- Attachment summaries ≤ 220 tokens.

## What would change for production-at-scale

- Move `data/files/` → S3 / R2 / GCS, with the `path` column storing a key instead of a local relative path.
- Pull Postgres off the same VM — managed service, see ADR 0038 §"Future".
- Add a sweep on boot for `attachments` rows with `indexed_at IS NULL` so interrupted extractions eventually complete.
