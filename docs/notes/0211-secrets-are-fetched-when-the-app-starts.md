# 0211 — Secrets are fetched when the app starts, not stored on the VM

**Status**: accepted and **in production since 2026-09-26** (`SECRETS_MODE=only`). 12 secrets stored; stage 2 (`fetch`) and stage 3 (`only`) each deployed and verified the same day (runbook: [secrets.md](../ops/secrets.md)).

**What the real run showed.** Both services fetch all 12 at every start with 0 restarts; the file is `root:root` 600 in a 700 directory on tmpfs; the VM's `.env` holds none of the 12 secret names (23 secret lines kept out, including the 11 empty ones) and is mode 600 (it had been 777); Secret Manager's Data Access log shows only `chord-vm` reading, 48 reads in the first half hour, the same entries reaching the year-long bucket, and the human-read alert quiet. One bug surfaced in operation, not testing: `secrets.sh list` looked hung because gcloud asked "enable the API? (y/N)" on a terminal while the script hid stderr; the reads now run with `--quiet` and a closed stdin. The `Failed with result 'exit-code'` line at each restart is the OLD process's SIGTERM exit (143), not a failed start.
**Date**: 2026-09-26

Phase 8b of [the key custody plan](../tasks/phase-8-key-custody.md). [ADR 0210](./0210-the-token-master-key-is-wrapped-not-stored.md) took the token key out of `.env`; this does the rest of what sits there: the database password, the LLM keys, Stripe, Twilio/Meta, Telegram, Google/Microsoft client secrets, Apple's signing key.

## Context

`scripts/deploy/deploy.sh` pushed `.env.prod` verbatim to `/srv/chord/.env` on every deploy. So every third-party secret was in one file, on the persistent disk, in every snapshot, readable by whoever had a shell, and in `.env.prod` on the deploying laptop. Wrapping these under KMS (as for the master key) would gain nothing: they have to be plaintext in memory to call the vendor. What can be improved is **where they rest and who can read them**: IAM-gated reads, an audit trail per read, versioned rotation, and not on disk.

## Decision

**Secret Manager holds them; a root-owned step fetches them into tmpfs each time a service starts.**

- `ExecStartPre=+` runs `fetch-secrets.mjs` as root, which reads the VM service account's token from the metadata server, reads each named secret, and writes `/run/chord-secrets/secrets.env` (`/run` is memory-backed, mode 600). A second `EnvironmentFile` after `.env` wins over it. **No application code changes**: `config/env.ts` still reads `process.env`. The alternative, an in-process loader, would have to run before `env.ts` is imported and be remembered by every entrypoint and script.
- **The scripts are root-owned in `/usr/local/lib/chord`, not run from `/srv/chord`.** They execute as root; code in a directory the app's own user can write would let a compromise of the app become root at the next restart.
- **Fail closed.** A missing (404) or refused (403) secret stops the service instead of being skipped: skipping `DATABASE_URL` would start the app on its default, the local Postgres, against stale data. Transient errors (network, 429, 5xx) are retried with backoff. One run reports every problem, not the first.
- **One resilience exception.** If Secret Manager is briefly unreachable at a *restart*, the previous file from this boot is reused (up to 30 days) with a loud warning. `/run` is cleared on reboot, so a cold boot can never run on stale secrets.
- **Values are byte-identical to today.** They are stored and written exactly as the `.env` line was (the file has no quoting and no multi-line values), so systemd parses them as it always did. A value with a newline or NUL is refused rather than escaped, because it would inject another assignment.
- **Two modes, so it is reversible.** `SECRETS_MODE=fetch` adds the fetch while `.env` still carries the same values (nothing can differ, so it proves the plumbing); `SECRETS_MODE=only` also removes them from the `.env` that reaches the VM. Unset returns to today. `deploy.sh` refuses to deploy in either mode unless Secret Manager holds what `.env.prod` holds (`secrets.sh verify`).
- **Operator commands still work.** Migrations, `encrypt:backfill` and `wrap:master-key` used to source `.env`, which no longer has the secrets. `chord-with-env <cmd>` (sudo, then drops back to you) gives the command the same environment the services get, in the child's memory only.
- **Which names are secrets is a checked-in list** (`secret-keys.txt`, names only); `secrets.sh list` also flags secret-looking names in `.env.prod` that are on neither list. `MAXMIND_LICENSE_KEY` is local-only: the VM never uses it, so it is removed from the VM `.env` and not stored.
- **Reads are audited.** Secret Manager Data Access logs are on, and an alert fires when anything other than the VM's account reads a secret's value. Pushing a secret is a *write*, and `secrets.sh` never reads values back: it compares a truncated SHA-256 it stores as an annotation, so `push`/`verify` do not trip the alert.

## What this does not do

Root on the running VM can read the secrets (it can ask Secret Manager as the VM's account, or read `/proc/<pid>/environ`); ADR 0203 is the answer to that. The values still exist in `.env.prod` on the deploying laptop until you decide otherwise (deploying needs them to push them). A rotated secret takes effect on a **restart** of both services (no live reload). The fingerprint check proves what `secrets.sh` pushed, not what someone later added by hand as a new version.

## What was checked and left out

`CONTACT_HASH_PEPPER` was on the first list and is **not** moved (checked 2026-09-26, before any secret was pushed). ADR 0065 has the server return it to every signed-in app so contacts are hashed on the phone, so it is public to any user by design; Secret Manager would protect nothing. Prod runs the built-in default, and changing it would invalidate every stored `phone_hash` and `contact_links` row. The weakness it leaves (a database dump alone could be rainbow-attacked against phone numbers) is the one ADR 0065 accepted for the family cohort; the fix is a per-deployment pepper plus a one-off re-hash, before public launch. The rule that came out of it: a value belongs in Secret Manager only if disclosure of it would hurt, so the list is names of things that must stay private, not names that merely look secret.

## Rejected

Wrapping vendor secrets under KMS (no gain: plaintext in memory regardless); an in-process loader (must precede `env.ts` and be remembered by every script); running the fetch from `/srv/chord` (root executing app-writable code); skipping missing secrets (silent fallback to defaults, catastrophically for the database URL); escaping newlines into values (a different representation than `.env` has today, so the app could see different bytes); storing the secrets' plain hashes as full SHA-256 (a truncated fingerprint is enough to detect change); pushing secrets from the VM (the values live on the laptop, so the laptop pushes them).
