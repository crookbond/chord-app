# Audit logging — runbook

ADR [0207](../notes/0207-who-touched-the-keys-and-the-vm-is-recorded-off-the-box.md). Everything is driven by `scripts/deploy/audit.sh`, run from the repo root **in WSL**. `status` is read-only; every other command takes `--dry-run` and needs `--yes`.

```bash
scripts/deploy/audit.sh status
scripts/deploy/audit.sh data-access --yes   # KMS + Cloud SQL Data Access logs
scripts/deploy/audit.sh sink --yes          # chord-audit bucket (365 days, not locked) + sink
scripts/deploy/audit.sh alert --yes         # email alerts (ALERT_EMAIL, default CERTBOT_EMAIL)
scripts/deploy/audit.sh ops-agent --yes     # ships auth.log + audit.log off the VM
scripts/deploy/audit.sh auditd --yes        # who opened .env / the files dir / psql
scripts/deploy/audit.sh oslogin --yes       # LAST: stops the app, see below
```

## Asking "who read it"

| Question | Where |
|---|---|
| Who decrypted with the content key | Logs Explorer: `LOG_ID("cloudaudit.googleapis.com/data_access") AND protoPayload.serviceName="cloudkms.googleapis.com" AND protoPayload.resourceName:"content-kek"`. Expected: only the VM service account. Cloud SQL's own agent appears on the `chord-db` key. |
| Who logged in / ran sudo on the VM | `LOG_ID("auth")`, and with OS Login also the admin activity log |
| Who opened `.env` or the files directory | `LOG_ID("audit")`, keys `chord_env`, `chord_files`; on the VM `sudo ausearch --input-logs -k chord_env -i` |
| Who ran psql / pg_dump | key `chord_db_tools` |
| Was a key disabled or destroyed | Admin Activity log (kept 400 days, cannot be turned off), and the alert |

**Always `ausearch --input-logs`.** Without it, `ausearch` reads standard input when it is a pipe and reports "no matches" over ssh while the events are there.

## What each alert means

- **human decrypt of the content key**: someone other than the app's service account decrypted. Today the project **Owner** account can (Owner carries KMS decrypt), so a test or a genuine break-glass shows up here. Read the log entry for the principal and method. If it is not you, disable the key version at once.
- **a secret read by a non-app principal** (added with ADR 0211, once secrets are in Secret Manager): someone other than the VM's service account read a secret's value. `secrets.sh push` and `verify` do not trigger it (they write, or compare fingerprints, and never read values back). If it was not you, rotate that secret and check who holds `secretAccessor`.
- **key disabled, destroyed or IAM changed**: a change to the content or database key. Disabling the content key makes every sealed mail and file unreadable until it is re-enabled; destruction has a scheduled window. Restore first, investigate second.

## OS Login

`deploy.sh` runs the services as the SSH user, and OS Login gives a different Unix user (for example `ownertest_gmail_com`). `audit.sh oslogin --yes` enables it, **stops chord and chord-worker**, chowns `/srv/chord` and `/var/lib/chord` to the new user, and leaves the app stopped. Run `scripts/deploy/deploy.sh deploy` immediately: it re-renders both units with `User=<new user>` and starts them. Expect several minutes of downtime, the same as any deploy.

Roll back: `gcloud compute instances remove-metadata chord --zone us-central1-a --keys enable-oslogin`, then over ssh as the old user `sudo chown -R john:john /srv/chord /var/lib/chord`, then `deploy.sh deploy`. The old metadata SSH key keeps working once OS Login is off.

## Not done, on purpose

- **Locking the bucket**: `gcloud logging buckets update chord-audit --location=global --locked` is irreversible (retention can never be shortened, the bucket never deleted early). Do it once the filter is settled.
- **A sink to a separate project**, so nobody with rights in this project can remove the trail.
- **Query-level auditing beyond what is on.** `pgaudit` is already enabled on the instance (`pgaudit.log = ddl,role`, set when it was provisioned), so schema changes and role/grant changes are recorded in Cloud Logging. Reads and writes are not, deliberately: on a database the app queries constantly that would bury the one statement that matters. Widen `pgaudit.log` only for a specific investigation.
- **A deny policy** so the project Owner cannot decrypt with the content key. Not possible today: deny policies need a Google Cloud organization, and this project has none (`iam.denyAdmin` cannot be granted on a project). `scripts/deploy/custody.sh deny-owner-decrypt` is ready and will work once the project is moved into an organization (a free Cloud Identity on the company domain). Even then it is a guard, not a wall: whoever can administer deny policies can remove it, and that change is what the key-IAM alert reports.
- Root on the VM can stop `auditd` or the agent; the attempt is logged up to that moment. Attested key release (ADR 0203) is the answer.
