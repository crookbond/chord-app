# Postgres — one-time setup

Chord stores everything except uploaded files in Postgres (ADR 0038).
The default deploy runs the server and the database on the same VM
over `127.0.0.1:5432`. Connection config is a single `DATABASE_URL`
env var read by `server/src/config/env.ts`.

## Local dev (Windows / WSL2)

```bash
# WSL — apt path
sudo apt update && sudo apt install -y postgresql
sudo service postgresql start

# Create the chord role + databases. Peer-auth maps your unix user, so
# the libpq URL has no password.
sudo -u postgres createuser --superuser "$USER"
createdb chord
createdb chord_test       # for the test suite (commit 1b onward)
```

On native Windows the equivalent is the [Postgres installer](https://www.postgresql.org/download/windows/);
afterward, create the role and databases via `psql -U postgres`:

```sql
CREATE ROLE chord LOGIN PASSWORD 'chord-local';
CREATE DATABASE chord OWNER chord;
CREATE DATABASE chord_test OWNER chord;
```

…and set `DATABASE_URL=postgresql://chord:chord-local@127.0.0.1:5432/chord`
in `.env.local`.

## Production VM (Ubuntu / Debian)

```bash
sudo apt install -y postgresql
sudo systemctl enable --now postgresql

sudo -u postgres createuser chord
sudo -u postgres createdb -O chord chord

# pg_hba.conf — peer auth on the unix socket is fine when the Node
# process runs as the `chord` system user. Confirm with:
sudo -u chord psql chord -c '\conninfo'
```

`DATABASE_URL=postgresql://chord@127.0.0.1:5432/chord` (no password
because peer-auth maps the unix user).

> **⚠ TODO before/at first prod cutover:** if the prod VM ever needs a
> password (e.g. if Node runs as a different unix user than `chord`, or
> if we move to a managed Postgres), generate a strong random one — do
> NOT reuse the `chord-local` placeholder from `docs/ops/postgres.md`
> §"Local dev". Put the real password in the VM's `.env.local` only;
> never commit it. Rotate any credential that ever appeared in chat,
> a commit, or a screenshot.

## Backups

`pg_dump` cron, snapshotted to the same volume that holds `DATA_DIR/files`:

```cron
# /etc/cron.d/chord-pgdump  — daily at 03:15 UTC
15 3 * * *  chord  pg_dump --format=custom chord > /var/backups/chord/$(date -u +\%F).dump
```

Restore: `pg_restore -d chord_restored /var/backups/chord/2026-05-23.dump`.

When (if) we move to a managed service the provider takes this over;
see ADR 0038 §"Future: managed Postgres".

## First run

```bash
npm install
cp example.env .env
# create the chord database first (see above), then:
npm run migrate --workspace=server
npm run dev
```

`npm run migrate` is idempotent — every migration uses `CREATE … IF NOT
EXISTS`, and applied names live in the `_migrations` table.

## One-shot SQLite import (historical)

The `pg:import` npm script + `server/scripts/sqlite-to-pg.ts` were
removed once prod cut over (ADR 0038). They live in git history at
commit `0d2899b` if a similar import is ever needed again.

## Resetting local state

```bash
dropdb chord && createdb chord
rm -rf data/files logs        # uploaded files + logs anchor to DATA_DIR
npm run migrate --workspace=server
```

`data/` no longer contains the database — only the file uploads and
chunk indexer scratch. Don't reach for `rm -rf data` expecting it to
forget the DB.

## Troubleshooting

- **`password authentication failed for user "chord"`** — your
  `pg_hba.conf` is on `md5`/`scram` for `127.0.0.1`. Either set a
  password (`ALTER ROLE chord PASSWORD '...'` then put it in
  `DATABASE_URL`), or change the line to `trust` for local dev (never
  in production).
- **`role "chord" does not exist`** — re-run the `createuser` step
  under the postgres superuser.
- **`connection refused 127.0.0.1:5432`** — service isn't running.
  `sudo service postgresql start` (WSL) or `sudo systemctl start
  postgresql` (systemd).
