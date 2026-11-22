# Disaster recovery plan

Written 2026-10-23. Owner: John Doe (`hello@chordapp.ai`). Review once a year, and after
any change to hosting, backups or keys. Related: [cloud-sql.md](./cloud-sql.md),
[data-protection-architecture.md](./data-protection-architecture.md),
[master-key.md](./master-key.md), [secrets.md](./secrets.md).

## What is running, and where

| Piece | Where | How it comes back |
|---|---|---|
| Database (all users, mail mirror, calendar, chats) | Cloud SQL, Postgres 15, us-central1, private IP | Restore from a Cloud SQL backup or point-in-time clone (below) |
| Application (web + worker) | One Compute Engine VM `chord`, **e2-standard-2** (2 vCPU, 8 GB, since 2026-10-23; was e2-medium), Debian 12, Node 22, us-central1-a | Rebuilt from the git repository with `scripts/deploy/deploy.sh` (set `MACHINE_TYPE=e2-standard-2` in `deploy.env` before `provision`) |
| Uploaded and imported files (`DATA_DIR/files`) | The VM's disk, sealed per user | **See "Gap" below** |
| Encryption keys | Cloud KMS (`chord-content/content-kek`, `chord-db`) | Managed by Google; never exported |
| Token master key | Cloud KMS-wrapped copy in Secret Manager, plus a sealed offline copy held by the owner | Unwrapped at start-up |
| Secrets (API keys, OAuth secrets, database password) | Google Secret Manager | Fetched at service start |
| Source code | GitHub (`crookbond/chord`) and local clones | Clone |
| DNS and TLS | Cloudflare (DNS, edge certificate); Let's Encrypt on the VM | Cloudflare dashboard; certbot on a new VM |

## Backups

- **Database:** automatic daily backups at 03:00 UTC, the last **14** kept, plus
  point-in-time recovery from a **7-day** write-ahead log. Encrypted with the
  customer-managed `chord-db` key. Backups and the clone are off the VM.
- **Restore tested:** a point-in-time restore drill passed on **2026-09-25**
  (`scripts/deploy/cloudsql.sh drill --yes`): clone usable within minutes, row counts matched
  production, no readable mail content. Repeat the drill every 6 months and after any change
  to backup or key settings.
- **Code:** GitHub plus every developer clone.
- **Secrets and keys:** held by Google (Secret Manager, KMS). The plain token master key has
  a sealed offline copy with the owner, in case the KMS key were ever lost.

- **Uploaded and imported files (the VM disk):** snapshot schedule `chord-daily-disk`
  (us-central1) on disk `chord`, daily at 08:00 UTC, each kept **7 days**, stored in the `us`
  multi-region, kept even if the disk is deleted. Added 2026-10-23. The files are sealed, so a
  snapshot holds ciphertext. A snapshot of a running disk is crash-consistent, which is enough
  here: the database is not on the VM.
- **Why snapshotting this disk is safe now:** the 2026-09-26 clean-up deleted old plaintext
  (the old Postgres, dumps, the prompt log), and deleting files does not overwrite blocks. The
  weekly `fstrim` has since discarded the freed space four times (8.9 GiB on the first run), and
  a manual trim ran just before the schedule was attached, so those freed blocks are released
  to the disk and are not copied into snapshots.
- **Restore not yet tested.** Planned for Sunday 2026-10-25: create a disk from the latest
  snapshot, attach it to a throwaway VM (or mount it read-only on a spare), and check that
  `srv/chord/data/files` is there and that a file opens through the app's key. Then delete the
  test disk and VM.

## Targets

- **Recovery time objective:** service back within **4 hours** of the decision to recover.
- **Recovery point objective:** at most **15 minutes** of database writes lost (point-in-time
  recovery); files: at most **24 hours** (daily snapshot).

## Scenarios

### 1. Bad data (a wrong migration, a bug that deletes or corrupts rows)
1. Stop the worker so nothing writes further damage: `sudo systemctl stop chord-worker`.
2. Clone the instance to a moment before the damage:
   `gcloud sql instances clone <instance> chord-db-recover --point-in-time=<UTC time>`.
3. Either copy the affected rows back from the clone, or point `DATABASE_URL` at the clone
   (edit `scripts/deploy/.env.prod`, run `deploy.sh deploy`).
4. Delete the clone when done.

### 2. The application VM is lost or unusable
1. Create a new VM (`deploy.sh` creates one from the Debian 12 image if none exists) running
   as the `chord-vm` service account.
2. `scripts/deploy/deploy.sh bootstrap`, then `deploy` from a clean `main`: installs Node, the
   app, nginx, certbot, the systemd units and ClamAV with its nightly scan; secrets come from
   Secret Manager. Then `scripts/deploy/audit.sh ops-agent --yes` and `auditd --yes`, so the
   security logs and the malware alert work again.
3. Point Cloudflare's DNS A record at the new VM's address, if it changed.
4. Check `https://chordapp.ai/api/v1/health` and `scripts/deploy/logs.sh journal`.
5. Restore uploaded files from the latest snapshot or `pull-data` copy, if any.

### 3. The Cloud SQL instance is lost
1. Restore the latest backup into a new instance (Cloud SQL → Backups → Restore to new
   instance), or a point-in-time clone if the instance still exists.
2. Point `DATABASE_URL` at it and redeploy.

### 4. A secret or key is leaked
1. Rotate it at the provider (Google, Microsoft, Stripe, Meta, OpenRouter …).
2. Add the new value as a new version in Secret Manager and restart both services.
3. If the leak is a user's data key or the content key itself, follow
   [content-encryption.md](./content-encryption.md); destroying a key version makes
   anything sealed only under it unreadable.

### 5. Google Cloud region outage
Wait for Google, or restore the latest backup into a new instance in another region and run
scenario 2 there. Backups are kept in multi-region storage by Cloud SQL by default (**CHECK**
in the console: Cloud SQL → Backups → location).

## Who does what

The owner runs every recovery step. Users are told through the in-app message and email if
data was lost or the outage lasted more than an hour.
