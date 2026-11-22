# 0202 — Postgres moves off the app VM

**Status**: accepted and **complete** (2026-09-26). Production runs on Cloud SQL since 2026-09-25 (cutover rehearsed, downtime about 6 minutes, row counts identical); the restore drill from a point-in-time clone passed; phase 6 removed the old database, dumps, pre-fix logs and disk snapshot in place on 2026-09-26. Not done: replacing the VM disk, so deleted plaintext blocks still exist on it (an owner decision; see [cloud-sql.md](../ops/cloud-sql.md)).
**Date**: 2026-09-23

Supersedes the "we are not moving to a managed service" decision in [ADR 0038](./0038-sqlite-to-postgres.md), which was made for a single cheap demo VM. Companion to [ADR 0201](./0201-email-and-attachments-are-sealed-at-rest.md).

## Context

ADR 0201 encrypts mail and attachments in the database, but three things it cannot do from application code remained true while Postgres ran on the app VM: the nightly `pg_dump` sat in plaintext on the same disk as `.env`; anyone with a shell on the VM could `psql` the database as `postgres` with no record of it; and the database disk had no key of its own. A managed database closes the second and third by construction (no shell on the database host, IAM-audited admin access, a disk key you control and can revoke) and replaces the first with encrypted, off-host, point-in-time-recoverable backups. It also retires patching, failover and restore drills the team was doing by hand.

What it does not do is stop a SQL login from reading a column. At-rest and CMEK encryption protect the disk and the backups, not the rows a database user can `SELECT`. That is what ADR 0201's column encryption is for, and why the order is encrypt first, migrate second.

## Decision

**Cloud SQL for PostgreSQL 16, Enterprise edition, private IP only, CMEK, single zone to start** (`db-custom-1-3840`, about $50/month plus storage and backups; a high-availability standby roughly doubles the instance line and is deferred). Automated daily backups, 14 kept, **point-in-time recovery on**. `pgaudit` on for DDL and role changes, Cloud Audit Logs on, IAM database authentication enabled so people reach the database as themselves rather than through a shared password. SSL required. Deletion protection on.

**The migration runs after the content is sealed.** `pg_dump` from the VM then carries ciphertext, so no plaintext mail ever lands on the managed instance or in its backups. This is the reason phases 3 and 4 came first, and the script prints the precondition (`encrypt:backfill --step verify`) before it will act.

**Direct connections, no pooler.** The migration lock and the proactive drain lock are session-scoped advisory locks and break under transaction-mode pooling (ADR 0038, 0174). Consequence: total connections are `processes x (DB_POOL_MAX + CONTENT_KEY_POOL_MAX)`, two processes and 12 each by default, against a `max_connections` of about 50 at this tier. The script's `preflight` prints the arithmetic; keep `DB_POOL_MAX` modest.

**No extensions needed.** Checked: the migrations `CREATE EXTENSION` nothing, so there is nothing to enable or to be unsupported.

**The tooling is a script an operator runs, not code that acts on its own** (`scripts/deploy/cloudsql.sh`): `plan`, `provision`, `preflight`, `cutover`, `verify`, `rollback`, `shrink-vm`, `retire-old`. Everything accepts `--dry-run`; anything that creates billable resources, stops the app or destroys data refuses without `--yes`. It never edits `.env.prod` (it prints the exact `DATABASE_URL` line and the owner changes the file), never generates or prints a password (it takes `CLOUDSQL_APP_PASSWORD` from the shell), and never deletes the old database or its dumps except through `retire-old`.

**Rollback is a configuration change.** The VM database is never touched by the cutover, so going back is setting `DATABASE_URL` back and redeploying. What is lost is anything written to Cloud SQL after the cutover, which the runbook says to dump first.

**The VM can then shrink.** With Postgres gone the VM runs only Node (web and worker), and `shrink-vm` resizes it. A disk cannot be shrunk in place; it is left alone.

## What was and was not verified

Built and exercised: the script's syntax, every subcommand's `--dry-run` output, the refusal without `--yes`, and the precondition text. **Not verified**: any `gcloud` call against a real project. No credentials, no project and no billing approval exist in the environment this was written in, so the flag spellings (notably `--ssl-mode`, `--disk-encryption-key`, the `^:^` delimiter for `--database-flags`, and the private-services-access peering) are from documentation and must be confirmed by the first real `provision` run, which is why that step is a dry-run away from being read and needs `--yes` to act.

**Retiring the old copy is its own command, and the only one that deletes** (`retire-old`, phase 6). It reports first (preconditions plus an inventory of dumps, the cron entry, the Postgres data directory and disk snapshots) and destroys only with `--yes` plus `CONFIRM_RETIRE=<instance name>`, both, so a habitual `--yes` cannot remove the fallback. It refuses unless the app is demonstrably using Cloud SQL and a successful managed backup exists, because the VM database is the only other copy until then. It is honest about the limit: removing files does not overwrite blocks, so a guarantee of "no readable copy anywhere" means deleting the disk, which is a VM replacement, not a script step.

## Consequences

- Backups stop being the owner's job. The old `postgres-backup-setup.sh` and its cron entry are retired after the cutover has been watched (phase 6), not before.
- An older plaintext dump on the VM survives the cutover until phase 6 deletes it; "sealed at rest" is true of the live database, and of the managed instance and its backups, but not of a dump taken before the backfill.
- Application-to-database latency rises from loopback (about 0.1 ms) to a private-network hop (about 1 to 2 ms). Chatty paths (the mail sync's per-thread recompute, the sweeps) pay it per query. The mail recompute now skips work when nothing changed (ADR 0201), which helps, and the first thing to measure after cutover is sync throughput.
- Human database access moves to IAM (a person, logged) instead of a shared `postgres` shell.

## Rejected alternatives

- **Stay self-hosted and harden it** (CMEK on the disk, encrypted off-host dumps): cheaper, and it gets most of the protection, but keeps patching, failover and restore testing as manual work and leaves a root shell as the way in.
- **Migrate first, encrypt after**: puts plaintext on the managed instance and in its backups for a while, which is the exposure this whole effort exists to remove.
- **A connection pooler in front**: incompatible with session advisory locks.
- **Public IP with an authorized network or the Auth Proxy**: workable, but private IP has no address to attack and no proxy process to keep alive.
- **Database Migration Service**: continuous replication for near-zero downtime. Overkill for a database this size and a few minutes of downtime; a dump and restore is simpler to reason about and to roll back.
