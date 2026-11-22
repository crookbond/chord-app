# 0207 — Who touched the keys and the VM is recorded off the box

**Status**: accepted; data-access logs, the audit bucket, alerts, Ops Agent and auditd are running (2026-09-25); OS Login is scripted and waiting on an owner go-ahead because it changes the app's Unix user
**Date**: 2026-09-25

Extends [ADR 0201](./0201-email-and-attachments-are-sealed-at-rest.md) and [ADR 0202](./0202-postgres-moves-off-the-app-vm.md). Those made stolen copies useless; this answers the other half of the reviewer's question, *would we know if someone read it*.

## Context

After the move to sealed content and Cloud SQL, an audit found nothing that recorded access: the project had no Data Access audit config (so KMS decrypts and Cloud SQL data reads were not logged at all), the Ops Agent was not installed (so the VM's logs existed only on the VM, where root can edit them), `auditd` was absent (a person reading `/srv/chord/.env` or the files directory left no trace), and SSH used metadata keys rather than a Google identity.

## Decision

**Record, ship off the box, keep a year, alert on the two events that matter.** `scripts/deploy/audit.sh` is idempotent and every command takes `--dry-run`; anything that changes state needs `--yes`.

1. **Data Access logs on for Cloud KMS and Cloud SQL** (all three log types), merged into the project's IAM audit config without touching other services.
2. **A dedicated log bucket, `chord-audit`, 365 days, deliberately not locked**, plus a sink copying Data Access, and the VM's `auth` and `audit` logs, into it. The default bucket keeps 30 days and is deletable by anyone with logging admin; a locked bucket can be neither shortened nor deleted early. Locking is irreversible, so it is a separate, explicit step.
3. **Two alert policies, email**: any Decrypt of the **content key** by a principal other than the VM's service account; and any disable/destroy/IAM change on the content or database key. Scoped to the content key resource on purpose: Cloud SQL's own service agent calls Decrypt on the `chord-db` key constantly and legitimately, so an unscoped filter would alert forever and be muted within a week.
4. **Ops Agent** on the VM, configured to ship only `/var/log/auth.log` and `/var/log/audit/audit.log` (plus the default syslog receiver; checked that syslog carries no app output). The chord services log to the journal, which is deliberately not shipped: turning on security logging must not be how application logs leave the box.
5. **`auditd`** with rules on `.env`, the data directory and `psql`/`pg_dump`/`pg_restore`, **filtered to logged-in people** (`auid >= 1000`, not unset). systemd services carry no login uid, so the app's own constant reads do not appear and the log stays readable. `sudo` keeps the uid, so a person acting as root is still attributed to them.
6. **OS Login** ties SSH to a Google identity in Cloud Audit Logs (off the box). Because `deploy.sh` runs the services *as the SSH user*, OS Login changes the Unix user, so the script stops the app, hands `/srv/chord` and `/var/lib/chord` to the new user and leaves the app stopped for an immediate `deploy.sh deploy`, which re-renders the units. Rollback is one metadata key plus a chown.
7. **`.env` is written mode 600** by the deploy (`--chmod=F600`); it had been 777, inherited from the file's mode on the deploying machine.

## What testing found

- A decrypt by the project owner was **authorized** (`useToDecrypt granted = True`): the basic **Owner** role carries KMS decrypt. Earlier docs said humans could not decrypt; that was wrong for the owner. The alert fired on the test, so the control works; **preventing** it needs an IAM deny policy on the key, which this project cannot have because it has no organization (checked 2026-09-25: `denyAdmin` is not grantable on a project, `iam.denypolicies.*` is not allowed in custom roles; `custody.sh deny-owner-decrypt` is written and waits for an organization). The policy would except the VM service account. Until there is an organization the controls are the alert, the key-IAM-change alert, and not using Owner casually.
- `ausearch` reads standard input when it is a pipe, so run over ssh from a tool it silently reads nothing and reports "no matches" while the log holds the events. Always `ausearch --input-logs`. The first verification here was wrong for exactly this reason.
- The Ops Agent adds about 530 MB on disk and a few hundred MB of memory. Relevant to `shrink-vm`: do not size the VM down to a micro instance without measuring with the agent running.

## What this does not do

Root on the VM can stop `auditd` or the agent. Shipping off the box means the attempt is recorded up to the moment it stops, not that it is prevented. Attested key release ([ADR 0203](./0203-attested-key-release-for-root-on-the-app-vm.md)) is the answer to that. `pgaudit` was already enabled when the instance was provisioned but only for `ddl,role` (schema and grant changes); reads and writes are not logged, and the Data Access logs cover Cloud SQL's admin API, not queries. (This ADR first said `pgaudit` was not enabled; that was an unchecked assumption, corrected 2026-09-25.)

## Rejected

Locking the bucket now (irreversible, and the filter may still need adjusting); shipping the app journal (leaks application logs as a side effect); auditing the app's own file reads (thousands of events that bury the one a person made); alerting on every KMS decrypt (the app decrypts constantly); a sink to a second project (better, and a fair next step, but needs a project to exist); revoking Owner's KMS permissions by editing the role (primitive roles cannot be edited).
