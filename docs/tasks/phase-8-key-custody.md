# Phase 8 - key and secret custody

**Status: planned, not started (written 2026-09-24).** Follows phases 1-7 of the content-encryption plan
(ADR [0201](../notes/0201-email-and-attachments-are-sealed-at-rest.md), ADR
[0202](../notes/0202-postgres-moves-off-the-app-vm.md), runbooks
[content-encryption.md](../ops/content-encryption.md) and [cloud-sql.md](../ops/cloud-sql.md)).

Phases 1-4 sealed the *content* (mail, files, derived text) and put its keys behind Cloud KMS. Phase 8 does the same
for everything else that lets someone act as a user or as the company: the token-sealing key, the third-party API
secrets, the database credential, and the infrastructure keys. Each workstream gets its own ADR (next free number)
when it is started; this document is the plan, not the decision record.

## Where things stand when this starts

- Content keys: `CONTENT_KEY_PROVIDER=gcp-kms`, key
  `projects/chord-495323/locations/us-central1/keyRings/chord-content/cryptoKeys/content-kek`, 90-day rotation,
  only `roles/cloudkms.cryptoKeyEncrypterDecrypter` on it, granted to the VM's service account.
- **Update 2026-09-25: the VM now runs as a dedicated account**, `chord-vm@chord-495323.iam.gserviceaccount.com`
  (switched 14:39 UTC), which holds only `roles/logging.logWriter`, `roles/monitoring.metricWriter` and
  `cryptoKeyEncrypterDecrypter` on the content key. The `cloud-platform` scope stays: it is only a ceiling and IAM is
  the real limit. That was the main 8d item. **Still open from 8d:** the old default compute account still holds
  `roles/editor` on the project and a decrypt grant on the content key, though nothing uses it now, and the project
  Owner can still decrypt. `scripts/deploy/custody.sh retire-default-sa` closed the first (run 2026-09-25: the old
  account now holds nothing, `chord-vm` is the only principal on the key, the app kept decrypting). **The second
  cannot be closed with a deny policy on this project:** `roles/iam.denyAdmin` cannot be granted on a project,
  `iam.denypolicies.*` cannot go in a custom role, and this project has no organization (owned by a personal
  account). What closes it is an **organization** (a free Cloud Identity on `chordapp.ai`, project moved in), after
  which `custody.sh deny-owner-decrypt` works unchanged. Until then the control is the human-decrypt alert plus the
  key-IAM-change alert, and not using Owner casually. The text below describes the plan as first written.
- (Original note) The VM ran as the **default compute service account** with the `cloud-platform` scope (widened on
  2026-09-24 so KMS calls work). That scope is only a ceiling; IAM is the real limit, and the default account
  normally carries a broad project role.
- Everything below is in `/srv/chord/.env` on the VM, pushed verbatim from `scripts/deploy/.env.prod` by every
  `deploy.sh deploy`.

## Threat model (unchanged)

Stolen or leaked disk, snapshot, backup, database dump, `.env` copy or log. **Not** an attacker with root on the app
VM: root can act as the VM's service account and so can read anything the app can read through KMS or Secret
Manager. Phase 7 (attested key release) is the answer to that, and stays optional.

## 8a - `MASTER_KEY` behind KMS  (highest value, smallest change)

**Status 2026-09-30: DONE and in production.** See ADR
[0210](../notes/0210-the-token-master-key-is-wrapped-not-stored.md) and the cutover runbook
[master-key.md](../ops/master-key.md). Cut over 2026-09-26: `MASTER_KEY_WRAPPED` deployed, verified (both services
unwrap from KMS at boot, refresh-token round trips checked), plain `MASTER_KEY` removed from `.env.prod` and from the
VM's environment, and the Secret Manager recovery copy of the plain key deleted once the owner confirmed a sealed
offline copy exists (where that copy lives is not recorded in this repo — that is the point of break-glass).
**Wraps under the shared content key, not a second key** — confirmed 2026-09-30 as the intended choice, not a
stale plan: `MASTER_KEY_KMS_KEY` is unset on the VM, so it defaults to the content key. The "open question" below
about which key to use is answered; the cost it accepted is the one stated where 8d's decisions are recorded.
Wrapped wins over a plain key and a set-but-not-unwrapped state throws. The plan below is the original.

`MASTER_KEY` (`utils/crypto-tokens.ts`) seals Google and Microsoft refresh tokens, IMAP app passwords, the Apple
refresh token, connector credentials (`services/connectors/secrets.ts`) and, through derivation, the image-proxy
tokens (`services/email/image-token.ts`). A stolen refresh token is a stolen mailbox, and today the key that seals
them sits in `.env` next to the database.

Plan:
- Wrap the current `MASTER_KEY` value once with the content KMS key (the choice made, see the status line above)
  and store only the ciphertext as `MASTER_KEY_WRAPPED`. The app unwraps it once at boot, before anything seals or
  opens a blob. Existing sealed blobs stay valid because the key *value* does not change.
- `crypto-tokens.ts` resolves its key synchronously today and is cached; the unwrap makes startup async. There is
  already a boot-time assertion hook ("call from server startup so a misconfigured prod env fails fast"); it becomes
  the place the unwrap happens.
- Migration is two deploys: accept either `MASTER_KEY` or `MASTER_KEY_WRAPPED` (wrapped wins), deploy, verify a
  refresh-token round trip and an IMAP sync, then remove plain `MASTER_KEY` from `.env.prod` and deploy again.
- Bind the key name as additional authenticated data, as `GcpKmsKeyProvider` already does.
- Test: wrapped key opens blobs sealed under the plain key; a wrong/missing key fails loudly at boot with the
  `AccountAuthError` path from ADR 0080 still intact.

Stretch (separate ADR, not required for 8a): move the blobs from one global key to **per-owner data keys**, the way
content is sealed. That gives per-user erasure and real rotation of the token-sealing key, at the price of a
re-seal backfill.

## 8b - third-party secrets in Secret Manager, not KMS

**Status 2026-09-26: DONE and in production (`SECRETS_MODE=only`); the vendor secrets are no longer on the VM's
disk.** The unused `SLACK_SIGNING_SECRET` line is gone from `.env.prod` and its Secret Manager copy deleted
(2026-09-26, after a deploy confirmed the VM no longer fetched it). The values still exist in
`.env.prod` on the deploying laptop (deploying needs them). ADR
[0211](../notes/0211-secrets-are-fetched-when-the-app-starts.md), runbook [secrets.md](../ops/secrets.md). Built as
the "preferred" option below (an `ExecStartPre` writing a tmpfs `EnvironmentFile`), fail-closed, in two reversible
modes (`SECRETS_MODE=fetch`, then `only`); the database URL is included (its password is a secret) and
`CONTACT_HASH_PEPPER` is deliberately **not** moved (it is not a secret, see the note under "Also in this
workstream"). The plan below is the original.

These have to be plaintext in memory to call the vendor, so wrapping them under KMS only moves the problem. Secret
Manager gives IAM-gated reads, audit logs and versioned rotation, and keeps them out of `.env`, `deploy.sh` and
every copy of the disk.

In scope: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OSS_API_KEY`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `TWILIO_AUTH_TOKEN`, `META_WHATSAPP_TOKEN`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`,
`TELEGRAM_BOT_TOKEN`, `GOOGLE_CLIENT_SECRET`, `MS_CLIENT_SECRET`, `APPLE_PRIVATE_KEY`, `EXPO_ACCESS_TOKEN`,
`GOOGLE_SEARCH_API_KEY`, `EMAIL_CLASSIFIER_SERVICE_TOKEN`, `MAIL_PUSH_GMAIL_TOKEN`. (`CONTACT_HASH_PEPPER` was on the original list and was removed: not a secret.)
Priority within it: Stripe, the LLM keys, Meta.

Design constraint: `config/env.ts` reads `process.env` at import, so secrets must exist before the app starts.
Two ways to do that:
- **Preferred: a systemd `ExecStartPre`** on `chord` and `chord-worker` that fetches the secrets through the
  metadata-server token and writes `/run/chord/secrets.env` (tmpfs, mode 600), added as a second `EnvironmentFile`.
  No application code changes and the values never touch the persistent disk.
- Alternative: an in-process loader that fills `process.env` before `env.ts` is imported. More code, and every
  entrypoint and script (`npm run migrate`, the backfills) has to remember to call it.

Also in this workstream:
- `deploy.sh` stops pushing secret values; `.env.prod` keeps only non-secret settings and the secret *names*.
- A small helper to create or rotate a secret from a local file, so rotation is one command plus a restart.
- Scripts and the backfills run on the VM as the same service account, so they keep working through the same
  fetch.
- `CONTACT_HASH_PEPPER` is **not a secret and stays out of Secret Manager** (checked 2026-09-26: prod runs the
  built-in default `chord-dev-contact-pepper`). ADR 0065 has the server hand it to every signed-in app so contacts are
  hashed on the phone, so a Secret Manager copy would protect nothing, and changing it would invalidate every stored
  `phone_hash` and `contact_links` row (a re-hash job). The residual weakness is real but accepted for the family
  cohort: with the default pepper a database dump alone could be rainbow-attacked against phone numbers. Revisit
  before public launch (a per-deployment pepper plus a one-off re-hash from the stored E.164 numbers).
- Local dev and CI are unchanged: with no secrets provider configured, `.env` still works.

## 8c - infrastructure keys

- **Cloud SQL** (already in ADR 0202): customer-managed encryption key on the instance. The database password moves
  into Secret Manager (8b). IAM database login instead of a password is worth evaluating, but the token is
  short-lived and the pool has to refresh it, so it is an open question rather than the default.
- **VM boot disk and snapshots:** customer-managed key. A disk cannot be re-keyed in place, so this rides on a
  "replace the VM" cleanup rather than being its own outage. **Phase 6 was done in place (2026-09-26), not by
  replacing the VM**, so this item, and removing the deleted-file blocks from the current disk, are still open and
  would be done together if the VM is ever replaced.
- **Backups:** after the move to Cloud SQL the nightly `pg_dump` cron and `/var/backups/chord` go away. Anything
  exported to a bucket afterwards is written under a customer-managed key with a retention rule, and restore is
  drilled once (do not trust the checkbox).

## 8d - harden the custody itself

**Dedicated VM account: built** — [ADR 0209](../notes/0209-the-app-vm-runs-as-its-own-least-privilege-account.md),
`scripts/deploy/vm-identity.sh` (`create` → `switch` → `verify` → `revoke-old`). **Correction 2026-09-30:** an
earlier version of this line said 8a would wrap `MASTER_KEY` under a second, separate KMS key. That was never the
plan that shipped — 8a wraps under the shared content key (confirmed as the intended choice, not an oversight; see
8a's status). The Cloud SQL password went into Secret Manager, as decided (not IAM database login). Break-glass no
longer blocks 8a: the owner confirmed a sealed offline copy of the plain `MASTER_KEY` exists before its Secret
Manager copy was deleted.

- **Dedicated service account for the VM** instead of the default compute account, with only what it needs:
  encrypt/decrypt on the content key, `secretmanager.secretAccessor` on named secrets, Cloud SQL client, log and
  metric writers. Then drop `cloud-platform` for a scope list that matches. This is the item that makes the rest
  mean something: a broad default account undoes least-privilege on every key above.
- **Audit logs:** Data Access logs on for Cloud KMS and Secret Manager; alert on any decrypt or secret read by a
  human principal and on any read outside the VM account.
- **Humans:** the project **Owner** basic role DOES carry `cloudkms.cryptoKeyVersions.useToDecrypt` (verified
  2026-09-25: a decrypt by the owner account was authorized, `granted = True` in the Data Access log; an earlier line
  here said otherwise and was wrong). Editor does not, and the VM's default account is Editor, so it can read the key
  only through its explicit grant. Close the Owner gap with an IAM **deny policy** on
  `cloudkms.googleapis.com/cryptoKeyVersions.useToDecrypt` for the content key, excepting the VM service account,
  or by working day to day under a role that is not Owner. Until then the `chord-audit: human decrypt` alert
  ([audit-logging.md](../ops/audit-logging.md)) is the control. Secret Manager access needs the same check.
- **Rotation:** keep the 90-day automatic rotation on the content key; decrypt picks the right version by itself.
  Add a documented rotation for each Secret Manager secret and a calendar reminder for the ones with vendor-side
  expiry.
- **Break-glass:** `MASTER_KEY`'s offline copy is done — the owner confirmed one exists before the Secret Manager
  recovery copy was deleted (2026-09-30). Still open: the equivalent for the third-party secrets in 8b (their
  values exist today only in `.env.prod` on the deploying laptop and in Secret Manager; no separate sealed copy).

## Order and dependencies

1. 8d's dedicated service account first, or alongside 8a: it changes who can read everything else.
2. 8a (`MASTER_KEY`), then 8b (Secret Manager), in that order; both are independent of the database move.
3. 8c waits for phase 5 (Cloud SQL) and rides phase 6 (VM replacement). Do not schedule it before those.
4. Rest of 8d (alerts, audit logs) can land any time and should not wait for the code work.

Rough size: 8a a day including the two-step deploy and tests; 8b two to three days (the boot-time fetch is the only
tricky part); 8d a day of console and IAM work; 8c is mostly folded into phases 5 and 6.

## Verification

- 8a: refresh tokens for a Google, an Outlook and an IMAP account still work after each of the two deploys; `.env`
  on the VM has no plain `MASTER_KEY`; boot fails clearly with a bad wrapped value.
- 8b: `grep` of `/srv/chord/.env` and of a fresh disk snapshot finds none of the listed secrets; each integration
  (LLM, Stripe webhook, WhatsApp, Telegram, Apple sign-in) does one real round trip; rotating one secret takes
  effect after a restart and the old version can be disabled.
- 8d: a test principal without the role is refused; a human decrypt triggers the alert.

## Rollback

Each step is reversible until its plain-text source is removed. 8a: put `MASTER_KEY` back in `.env.prod` and
redeploy. 8b: put the values back in `.env.prod` and drop the second `EnvironmentFile`. Do not remove a plain source
until the wrapped or stored copy has been used successfully in production for a while. Never destroy a KMS key
version or a secret version that something still depends on.

## Not doing

- Wrapping third-party API secrets under KMS (no gain; see 8b).
- HSM-protected keys or attested key release. That is phase 7 and only matters if root on the VM enters the threat
  model.
- Encrypting the sender and recipient addresses, labels and dates, or confirmed family content. Those stay readable
  by design (ADR 0201).

## Open questions

- ~~Wrap `MASTER_KEY` under the content key or a second, separately permissioned key?~~ Answered 2026-09-30: the
  content key. Accepted cost: disabling or destroying the content key now also makes stored refresh tokens
  unreadable (users would reconnect); a second key would have kept that failure isolated, at the price of one more
  key and grant to manage.
- ~~IAM database login or a password in Secret Manager for Cloud SQL?~~ Answered: a password in Secret Manager (8b).
- Do we want per-owner token-sealing keys (the 8a stretch) now, or is one wrapped global key enough for the
  current user base?
- ~~Who holds the break-glass copy, and where?~~ `MASTER_KEY`'s copy exists (owner-confirmed); the 8b secrets'
  equivalent is still open.
