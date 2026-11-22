# 0209 — The app VM runs as its own least-privilege account

**Status**: accepted; tooling built and dry-run against the real project (2026-09-25); `create` / `switch` / `revoke-old` are run by the owner
**Date**: 2026-09-25

Phase 8d of the key-custody plan ([docs/tasks/phase-8-key-custody.md](../tasks/phase-8-key-custody.md)). Extends [ADR 0201](./0201-email-and-attachments-are-sealed-at-rest.md) and [ADR 0207](./0207-who-touched-the-keys-and-the-vm-is-recorded-off-the-box.md).

## Context

The app VM ran as the project's **default compute service account**, which holds **`roles/editor` on the whole project**, with the `cloud-platform` scope. Anything that becomes that account (root on the VM, or code running there) can edit or delete almost everything in the project, including the Cloud SQL instance and its backups, and could grant itself more. The plan names this the item "that makes the rest mean something": least privilege on each key is undone by a broad account next to it.

What the app actually needs from its Google identity, checked in the code (2026-09-25): **decrypt on the content key** (per-owner data keys are unwrapped through Cloud KMS, ADR 0201), and, for the Ops Agent (ADR 0207), **writing logs and metrics**. Gmail, Calendar and Search go through each user's OAuth token or an API key; Cloud SQL is a password over a private IP. None of those involve the VM's IAM.

## Decision

A dedicated account, **`chord-vm@<project>.iam.gserviceaccount.com`**, with exactly:

- `roles/cloudkms.cryptoKeyEncrypterDecrypter` **on the content key only** (key-level, not project-level);
- `roles/logging.logWriter` and `roles/monitoring.metricWriter` on the project (Ops Agent).

Phase 8a (the token-sealing key) and 8b (named secrets) add their grants to this account, not to a project role.

The scope stays `cloud-platform`: it is only a ceiling, and Google's guidance is to leave it broad and limit with IAM. Narrowing the scope as well would add a second list to keep in step with the grants for no extra protection.

`scripts/deploy/vm-identity.sh` does it in guarded steps (every command takes `--dry-run`; changes need `--yes`):

1. **`create`** — the account and its grants. No downtime; nothing uses it yet.
2. **`switch`** — stop the VM, `set-service-account`, start, wait for `/api/v1/health`, then **re-point ADR 0207's human-decrypt alert** at the new account. That alert's filter names the VM account; left alone, every decrypt the app makes as `chord-vm` would page as a human decrypt. A service account can only be changed on a stopped instance, so this is ~2 minutes down; the static IP (`chord-ip`) and the services' boot-time start make it safe.
3. **`verify`** — reads the Data Access log for a content-key decrypt **by `chord-vm`** since the switch. That, not health, proves the app can open sealed mail.
4. **`revoke-old`** — only after verify and some run time: remove the default account's key grant and its project **Editor** role. Refuses while any VM still runs as the default account.
5. **`rollback`** — re-grants the default account, moves the VM back, re-points the alert. `chord-vm` is left in place, unused.

## Consequences

- Root on the VM can still use whatever `chord-vm` holds — decrypt with the content key, write logs. That is the threat phase 7 (attested key release) exists for; this change shrinks what that attacker gets from "edit the project" to "what the app itself can do".
- The key-IAM-changed alert (ADR 0207) fires once on `create` and once on `revoke-old`; both are expected.
- New VMs in the project would still default to the default compute account, which after `revoke-old` has no roles. That is the intended failure mode (a new VM can do nothing until given an account on purpose).

## Rejected

- **Keep the default account and remove Editor from it.** Same end state for this VM, but the default account is what every new VM and several Google services reach for by default; a named account makes "who is this" obvious in every audit log line.
- **Narrow the scopes instead of IAM.** Scopes are coarse and legacy; they cannot say "this one key".
- **Grant KMS at the project level.** Would let the app decrypt with any key in the project, including the database key and 8a's future token key.
- **Switch without re-pointing the alert.** The first mail sync would page as a human decrypt, and an alert that fires on normal operation gets muted.
