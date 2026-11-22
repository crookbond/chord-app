# 0038 — SQLite → Postgres on the same VM

**Status**: accepted
**Date**: 2026-05-23
**Related**: [ADR 0002 — SSE over WebSockets](./0002-sse-over-websockets.md) (notes the SSE hub will need an adapter once we're multi-node; that's out of scope here),
[ADR 0021 — FTS5 attachment index](./0021-fts5-attachment-index.md) (the FTS contract this migration replaces)

## Context

Chord has been on SQLite (better-sqlite3 + Kysely `SqliteDialect`) since
Phase 0. That worked for a single-node demo but is now blocking us:

- The native iOS rollout and per-user write traffic will exceed
  single-writer WAL throughput.
- Strict per-group scope (ADR 0032) and the always-on group design will
  add a lot of per-message bookkeeping (proposals, signup-intents,
  proactive scans), all hitting the same writer.
- Postgres unlocks proper transactional isolation, connection pooling,
  partial indexes, jsonb, and `tsvector` for FTS — useful soon.
- The existing FTS5 attachment index already feels stretched: bm25
  re-ranking lives in JS (`attachments.index.ts`) because FTS5's tuning
  knobs are limited.

We are not moving to a managed service. The Postgres instance runs on
the same VM as the Node server, reachable on `127.0.0.1:5432` over a
unix-domain-or-TCP libpq connection. Operationally this is one extra
systemd unit, not a deployment topology change.

## Decision

Migrate the server from SQLite to Postgres, in five sequential pieces:

1. **Driver swap.** Replace `better-sqlite3` + `SqliteDialect` with `pg`
   + Kysely `PostgresDialect`. Connection config moves to a single
   `DATABASE_URL` libpq env var (`postgresql://chord@127.0.0.1:5432/chord`).
   Pool sized small (10) for one-VM-one-node.
2. **Schema squash.** The 46 historical migrations in
   `server/src/db/migrate.ts` are collapsed into one Postgres init
   migration (`001_pg_init`) that materializes the current end-state
   schema. The legacy SQLite migration list moves to
   `docs/notes/legacy-sqlite-migrations.ts.md` as a historical artifact
   — preserved for context but no longer executable. New migrations
   resume sequential numbering (`002_*`, `003_*`) from there.
3. **FTS5 → `tsvector`.** Attachment chunk search switches from a
   VIRTUAL TABLE + bm25/snippet to a generated `tsvector` column on
   `attachment_chunks` with a GIN index, queried via `to_tsquery` +
   `ts_rank_cd` + `ts_headline`. Porter English config. The
   filename-boost rerank stays in JS but operates on `ts_rank_cd`.
4. **Data migration.** A one-shot script (`scripts/sqlite-to-pg.ts`)
   streams every table out of the production `chord.sqlite` into the
   new Postgres database, preserving IDs and timestamps. It runs on the
   VM, against the local sqlite file, while the server is stopped. The
   attachment_chunks FTS index is rebuilt from the chunk text after the
   load.
5. **Test infra.** `openTestDb()` switches to a per-test ephemeral
   Postgres schema (`CREATE SCHEMA test_<id>` inside a shared test
   database) instead of in-memory SQLite. The test runner expects a
   local Postgres on `127.0.0.1:5432` named `chord_test`. Vitest
   `globalSetup` provisions it; `globalTeardown` drops it. We do not
   adopt `pglite` (embedded Postgres) — vendoring 50MB of WASM into
   `node_modules` to dodge a docker-compose entry isn't worth it.

### Type-mapping rules

- **Booleans stored as `INT 0/1`** → kept as `integer NOT NULL` columns.
  Service code reads them as numbers in many places; converting to
  `boolean` is a separate refactor we don't need to bundle with the
  driver swap. Postgres handles `0`/`1` integer values fine; the Kysely
  type definitions in `db/schema.ts` stay numeric.
- **ISO 8601 `TEXT` datetimes** → kept as `text`. Same reasoning:
  service code passes ISO strings everywhere and compares them
  lexicographically, which is correct for ISO 8601. Converting to
  `timestamptz` is a follow-up, not part of the move. See
  *"When to convert datetimes"* below for the triggers.
- **`json` stored as `TEXT`** → kept as `text` for now. One place uses
  `LIKE '%"scanDate":"..."%'` to filter; switching to `jsonb` would
  change that into a proper `->>` index lookup, which we should do, but
  not in the same commit as the driver swap.
- **`AUTOINCREMENT`** (only used for `_migrations._pk` and one log
  table) → `GENERATED ALWAYS AS IDENTITY`.
- **`CHECK (col IN (...))`** → kept verbatim (Postgres syntax-compatible).
- **`COALESCE`, `LOWER`, `INSTR`/`SUBSTR`** → already replaced in
  service code with Kysely's portable `fn.lower(...)`; the one
  `INSTR/SUBSTR` usage lives inside a SQLite-only migration we're
  dropping in the squash.

### When to convert datetimes

Do this when one of these triggers fires — not on a schedule.

1. **Postgres-side TZ math becomes non-trivial.** Today the only TZ
   logic lives in JS (`Intl.DateTimeFormat`, the nudge-schedule code).
   The moment we want a query like `date_trunc('week', col AT TIME
   ZONE u.tz)` — likely first from the always-on-group / proactive
   scan path — we need real `timestamptz`.
2. **A range index starts mattering.** ISO text + B-tree handles
   `created_at > $x` fine. It breaks down when we want `tstzrange`
   overlap queries (calendar conflict / busy-block intersection
   across many events) or BRIN on append-only tables. Messages is
   ~10K rows today; we'll feel it around 1M.
3. **We touch the `LIKE '%"scanDate":"..."%"` hack** in
   `proactive.service.ts:1134`. That's the canary — when we go fix
   that to `jsonb`, the same commit should fix the datetime columns
   it joins against. Mixing typed JSON timestamps with text columns
   is worse than doing both.
4. **A string-vs-Date comparison bug surfaces.** `< new
   Date().toISOString()` works today by accident of ISO 8601 sort
   order. The first time someone writes `< new Date()` and the
   lexicographic compare silently does the wrong thing, we convert.

**Shape of the conversion when we do it.** One migration *per table*,
not all 30-odd datetime columns at once. Each migration: add a new
`timestamptz` column, backfill with `old_col::timestamptz`, swap
reads, drop old. Whether `db/schema.ts` flips from `string` to `Date`
depends on whether we keep a Kysely plugin that serializes at the
boundary — keeping it minimizes service-code churn. Expect ~30–50
service-code edits per table touched (`new Date().toISOString()` →
`new Date()`), plus a fixture sweep. It's a several-hundred-line PR
on its own; don't bundle it.

### Search behavior delta

FTS5 with porter english and SQLite's `bm25()` is replaced by Postgres
`to_tsvector('english', ...)` + `ts_rank_cd`. Both stem English on
write; ranking math differs. The user-visible delta should be small
because we already over-fetch (40 hits, JS-side rerank with a
filename-match bias of -10), and the deterministic order across
runs of the same query is preserved.

Snippet rendering changes from FTS5's `snippet(table, col, ...)` to
`ts_headline('english', body, query, 'MaxFragments=1, MaxWords=32,
MinWords=8, StartSel=«, StopSel=»')`. The delimiters stay the same so
clients don't need to change.

## Alternatives considered

- **Postgres on Neon / managed service.** Cleanest, but the demo runs
  on one cheap VM and we want to keep the deploy story simple
  (`systemctl restart chord`). Adoptable later — Postgres is Postgres.
- **Stay on SQLite + LiteFS.** Buys distributed writes via fencing,
  but writes still serialize through one node and FTS5 + bm25 stays as
  the search ceiling. Doesn't address the underlying typing/jsonb gaps.
- **Port each of the 46 migrations 1:1.** Preserves change history but
  expands the diff ~50×, with several migrations using the SQLite
  table-rebuild pattern (`ALTER TABLE RENAME TO`, `CREATE TABLE new`,
  `INSERT...SELECT`, `DROP old`) that need substantial rewriting under
  Postgres. We capture the historical reasoning in the squashed
  migration's comments and in `docs/notes/` (one ADR per nontrivial
  schema decision already exists for most of them).
- **pg_trgm trigram search instead of `tsvector`.** Better for
  typo-tolerant short-token search, but attachment chunks are
  paragraph-length OCR / summaries / keyfacts — full-text ranking on
  stemmed tokens beats trigrams for that shape.
- **`pglite` (embedded WASM Postgres) for tests.** Removes the
  external service dependency for `npm test`, but adds ~50MB to
  `node_modules` and historically lags Postgres feature support
  (extension availability is the recurring issue). A docker-compose
  Postgres + `globalSetup` in vitest is the boring, reliable choice.
- **Dual-driver bridge period** (both SQLite and Postgres writable
  from the server). Halves the migration risk on paper, doubles the
  service-code complexity for the duration of the bridge. Not worth
  it for a one-VM demo we can take down for ~5 minutes during cutover.

## Consequences

- `DATA_DIR` no longer contains the database file. It still anchors
  uploaded files (`FILES_DIR`) and any other on-disk state. The
  comment in `example.env` is updated and `docs/ops/storage.md`
  documents the new split.
- The VM needs `postgresql-server` installed and a `chord` role + db.
  `docs/ops/dev.md` and a new `docs/ops/postgres.md` document the
  one-time setup (apt install, `createuser`, `createdb`, peer-auth or
  scram via libpq URL).
- `npm run migrate` still works the same way (single homegrown
  runner), but it now connects to Postgres. The `_migrations` table
  carries over so post-init migrations apply in order.
- Tests now require a local Postgres. CI gains a `services: postgres`
  block.
- The SSE hub remains in-process — ADR 0002's note about adopting an
  adapter when we go multi-node still stands; this migration does not
  change that.

## Recovering the cutover tooling (one-shot)

The data-importer and cutover orchestrator were removed once prod was
on Postgres (commits `0a85a06`, `9c4eba2`). They're still available in
git history — restore them locally when a remaining SQLite environment
needs to come across.

```bash
# 1. Restore the importer + give it a home in package.json.
git show 0a85a06^:server/scripts/sqlite-to-pg.ts > server/scripts/sqlite-to-pg.ts
# Re-add the npm script (one entry in server/package.json):
#   "pg:import": "tsx scripts/sqlite-to-pg.ts",

# 2. Re-add the devDeps the importer needs:
npm install -D --workspace=server better-sqlite3 @types/better-sqlite3

# 3. (Optional, VM-style cutover only) Restore the orchestrator:
git show 9c4eba2^:scripts/deploy/postgres-cutover.sh \
  > scripts/deploy/postgres-cutover.sh
chmod +x scripts/deploy/postgres-cutover.sh

# 4. Apply the PG schema, then import.
DATABASE_URL=postgresql://chord@127.0.0.1:5432/chord npm run migrate
DATABASE_URL=postgresql://chord@127.0.0.1:5432/chord \
  npm run pg:import --workspace=server -- --sqlite=path/to/chord.sqlite
```

The importer is idempotent at the row level (skips on PK conflict) so
a partial run can be re-attempted. None of the restored files should
be committed to `main` — they live only on the migrating environment.
Delete them again once the cutover lands.

## Pitfalls for future readers

- **Don't reintroduce `INSERT OR IGNORE` / `INSERT OR REPLACE`.** Use
  Kysely's `onConflict().doNothing()` or `.doUpdateSet()` — already the
  pattern in service code, but trivial to slip back to SQLite-isms in
  ad-hoc SQL.
- **Don't compare boolean columns with `IS TRUE`/`IS FALSE`** — we
  kept them as `integer 0/1` deliberately so service code can stay
  numeric. Use `= 1`.
- **`LIKE` is case-sensitive in Postgres.** Service code already
  lower-cases both sides (`fn.lower(col)` + `needle.toLowerCase()`)
  before the comparison. New comparisons must do the same, or use
  `ILIKE`.
- **`text` ISO 8601 still works for ordering.** ISO 8601 sorts
  correctly as a string. Don't switch a single column to `timestamptz`
  in isolation — either do the whole sweep or none, otherwise mixed
  joins/orderings get confusing.
