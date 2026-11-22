# Cloud SQL — runbook

ADR [0202](../notes/0202-postgres-moves-off-the-app-vm.md). Everything below is driven by `scripts/deploy/cloudsql.sh`, run from the repo root **in WSL** (gcloud lives there). Every command takes `--dry-run`; anything that creates billable resources or stops the app also needs `--yes`.

**Not yet run against a real project.** The script was written and dry-run tested without credentials; the first real `provision` is also the first check of the `gcloud` flag spellings. Read the dry-run output first.

## Before you start

1. `scripts/deploy/deploy.env` has `PROJECT_ID`, `ZONE`, `INSTANCE`. Optional overrides: `CLOUDSQL_REGION`, `CLOUDSQL_INSTANCE`, `CLOUDSQL_TIER`, `CLOUDSQL_STORAGE_GB`, `CLOUDSQL_KMS_KEYRING`.
2. **Mail and attachments are sealed on the OLD database** ([content-encryption.md](./content-encryption.md), phases 2 and 3 through step 4). `npm run encrypt:backfill --workspace=server -- --step verify` must say nothing readable remains. This is what keeps plaintext off the managed instance.
3. You have a fresh backup of the VM database and a copy of `DATA_DIR/files`.
4. In your shell (not a file): `export CLOUDSQL_APP_PASSWORD='<a fresh random password>'`. Do not reuse `chord-local`. `provision`, `rehearse`, `cutover` and `verify` read it from that shell; it reaches the VM over ssh stdin into a mode-600 temp file that is removed afterwards, never on a command line. Commands that need it have to be run from the shell where you exported it.
5. **`DATABASE_URL` must end `?sslmode=no-verify`, not `require`.** The app's node-postgres (8.21) treats `require` as full verification, checks Cloud SQL's per-instance certificate against the system CAs, and fails ("self-signed certificate"), which `psql` would never show because libpq's `require` does not verify. `no-verify` still encrypts; it just does not check who answered, which on a private-IP-only instance in the project's VPC is the accepted trade. The password in the URL must be URL-safe (letters and digits, or percent-encoded). `rehearse` and `cutover` log in with the app's own client, in the mode the URL will use, before doing anything else, and print the instance's `max_connections`. Stricter verification (chain but not host name) needs the server CA on the VM and `uselibpqcompat=true&sslmode=verify-ca&sslrootcert=...`, and breaks when Cloud SQL rotates that CA; treat it as Phase 8 hardening.
6. **Postgres version.** The VM runs Postgres 15, so the instance defaults to `POSTGRES_15` (override with `CLOUDSQL_VERSION`). Moving and upgrading in one step would also break rollback, because a dump from 16 cannot be restored into 15. Upgrade later, as its own step.

## Steps

```bash
scripts/deploy/cloudsql.sh plan                       # what and roughly how much
scripts/deploy/cloudsql.sh provision --dry-run        # read the commands
scripts/deploy/cloudsql.sh provision --yes            # private-IP instance, database key, database, user
scripts/deploy/cloudsql.sh preflight                  # can the VM reach it; connection arithmetic
scripts/deploy/cloudsql.sh rehearse --yes             # restore a live dump into a scratch DB, timed, then drop it (no downtime)
scripts/deploy/cloudsql.sh cutover --dry-run
scripts/deploy/cloudsql.sh cutover --yes              # stops the app, dumps, restores, compares row counts
```

`rehearse` is the step that matters most for an unrun script: it shows, with the app still up, that the restore user can create tables, that the dump loads, and how long it takes. That time is the floor for the real cutover's downtime.

`cutover` checks the password, the connection and that the target database is empty **before** it stops anything. If anything fails after the app is stopped it restarts the app on the VM database (never modified) and tells you how to empty a half-restored target. On success it leaves the app **stopped** with the data on Cloud SQL and prints the `DATABASE_URL` line. You then edit `scripts/deploy/.env.prod` yourself, run `scripts/deploy/deploy.sh deploy`, and watch `scripts/deploy/logs.sh journal`. Expect the app to be down from the stop until the deploy finishes, several minutes, because the deploy rebuilds.

The content key (ADR 0201) is **reused, not created**. It already exists (`projects/chord-495323/locations/us-central1/keyRings/chord-content/cryptoKeys/content-kek`, made 2026-09-24), every stored data key is wrapped by it, and `.env.prod` already carries `CONTENT_KEY_PROVIDER=gcp-kms` and `GCP_KMS_KEY_NAME` pointing at it. `provision` only checks it is there (and stops if it is not) and never changes it, and Cloud SQL's disk key is a **separate** key, `chord-db`, so disabling or destroying one can never brick or erase the other. Do not change those two `.env.prod` lines when you switch `DATABASE_URL`. Turn on Data Access audit logs for Cloud KMS and Cloud SQL.

## Verify after

```bash
scripts/deploy/cloudsql.sh verify        # row counts old vs new, and no readable mail content on the new database
```

Then: sign in, open the mail tab, search for something you know is there, ask the bot a question that needs a file, add a list item. Check `scripts/deploy/logs.sh errors`.

## Restore drill

```bash
scripts/deploy/cloudsql.sh drill --dry-run
scripts/deploy/cloudsql.sh drill --yes     # billable for about an hour; always deletes the scratch instance
```

Clones the live instance as of 15 minutes ago (point-in-time recovery) into `chord-db-drill`, compares every table's row count with production from the VM, checks that nothing readable came back (sealed values start `enc1.`), then deletes the clone. It needs no password from you: the comparison runs on the VM with the credential the app already uses, read from `/srv/chord/.env` inside one process, never printed or written out. Expect small differences (recent writes) in tables that change constantly; a missing table or a large gap is the failure.

Run it before phase 6, and again after any change to backup or key settings. **First drill, 2026-09-25: passed.** The instance was usable within minutes but its clone and follow-up backup operations kept running for at least 20 more (longer than `gcloud` will wait), 69 tables on both sides, differences of a few rows in the hot tables only, no readable mail content. Note that `gcloud` gave up waiting on the clone and the first version of the script then failed to clean up, because an instance with an operation in flight cannot be deleted; the script now starts the clone `--async`, polls until it is `RUNNABLE` with no pending operations, and retries the delete. A clone inherits the source's deletion protection, which the delete step turns off.

## Rolling back

`scripts/deploy/cloudsql.sh rollback --yes` explains it: the VM database was never modified, so set `DATABASE_URL` back to `postgresql://chord@127.0.0.1:5432/chord` and redeploy. Anything written to Cloud SQL after the cutover is not on the VM database; dump it first if it matters.

## After it has run well for a while

- `scripts/deploy/cloudsql.sh shrink-vm --yes` (default `e2-micro`; set `SHRINK_MACHINE_TYPE=e2-small` to be safer, and check memory under load first).
- **Phase 6, removing the old plaintext.** Until it is done, mail and file text as it was before the backfill still exists on the VM (the database, its write-ahead log, `/var/backups/chord`, disk snapshots).

  ```bash
  scripts/deploy/cloudsql.sh retire-old                 # report only: preconditions + inventory
  CONFIRM_RETIRE=chord-db scripts/deploy/cloudsql.sh retire-old --yes --snapshots --logs
  ```

  **Done in place on 2026-09-26** (the owner chose retiring over replacing the VM). It removed the nightly dump cron, the 15 daily dumps and the pre-encryption dump and files archive, the old Postgres (purged, with its data directory and write-ahead log), the pre-fix `prompts.log` (564 lines, 490 email-shaped strings, single lines over 100,000 characters), app logs older than a day, `~/.psql_history`, and the whole-disk snapshot from May 16. Afterwards: no Postgres server on the VM, the app connected only to Cloud SQL, the Sep 25 and Sep 26 automatic backups successful, and no disk snapshots left. `--logs` was added for this run because the first inventory missed the prompt log and older logs; the newer daily `prompts-YYYY-MM-DD.log` files carry only metadata (no email-shaped strings) and were kept.

  **Side effect:** the purge also removed `psql` and `pg_dump` from the VM. The restore drill (`drill`) installs the client on demand (`postgresql-client-15` only, not the server); `rehearse`, `cutover` and `verify` were for the move and are finished.

  **Still true after an in-place retire:** deleted files' blocks remain on the VM's disk (see the next paragraph), and copies on machines outside this project (`deploy.sh pull-data` copies, dumps taken to a laptop) are not touched. `C:\dev\chord-deps\data` and `logs` on the owner's laptop were flagged for a manual check.

  The report checks that the app's `DATABASE_URL` points off the VM, the instance is RUNNABLE, a successful Cloud SQL backup exists, and web + worker are running, then lists what it would remove. Deleting needs `--yes` **and** `CONFIRM_RETIRE=<instance name>`, and refuses if any check failed. It removes the daily-dump cron entry, the dumps, and the local Postgres (purged, data directory and WAL included); `--snapshots` also deletes the VM disk's snapshots. It does not touch copies on your own machines (`deploy.sh pull-data` copies the VM's `data/` down; any `pg_dump` you took to a laptop) or any bucket you copied a dump to: check those yourself.

  Deleting files does not overwrite their blocks. They stay on the VM's persistent disk (encrypted at rest by Google, erased when the disk is deleted). If "no readable copy anywhere" is the requirement, replace the VM instead: create a new one, `deploy.sh`, delete the old VM and its disk.

## What to check the first week

Sync throughput and search latency (the database is now a network hop away); connection counts against `max_connections`; that point-in-time recovery restores (do one restore drill into a scratch instance, do not trust the checkbox); Cloud Audit Logs show only expected principals reading KMS keys.
