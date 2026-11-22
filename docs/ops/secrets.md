# Secrets in Secret Manager — rollout runbook

ADR [0211](../notes/0211-secrets-are-fetched-when-the-app-starts.md). Run these from the repo root **in WSL, in your own shell**: `secrets.sh` reads `scripts/deploy/.env.prod` and never prints, logs or edits it. Every command takes `--dry-run`.

Stages are reversible until the last. Do them a day apart if you like; nothing forces the pace.

## 0. Look

```bash
scripts/deploy/secrets.sh list
```

Shows each name in `secret-keys.txt` (set/empty in `.env.prod`, present/current in Secret Manager) and flags secret-looking names in `.env.prod` that are on neither list. Add any real secret to `scripts/deploy/secret-keys.txt` before you continue. Empty values are skipped everywhere.

## 1. Store them (no runtime change)

```bash
scripts/deploy/secrets.sh push --dry-run
scripts/deploy/secrets.sh push --yes       # enables the API, creates/updates secrets, grants the VM's account read access
scripts/deploy/secrets.sh verify           # every secret in Secret Manager matches .env.prod
```

`push` grants the VM's account (`chord-vm`) `secretmanager.secretAccessor` **on each secret**, nothing broader. That is an IAM change; if the auto-mode classifier refuses it, run the command yourself. Turn on the audit trail once:

```bash
scripts/deploy/audit.sh data-access --yes  # adds Secret Manager to the Data Access logs
scripts/deploy/audit.sh alert --yes        # adds "a secret read by a non-app principal"
```

## 2. Fetch at start, values still in `.env` (`SECRETS_MODE=fetch`)

Add `SECRETS_MODE=fetch` to `scripts/deploy/deploy.env`, then `scripts/deploy/deploy.sh deploy`. The deploy refuses unless `verify` passes, installs the fetch scripts on the VM, and adds a start-up step to both services. `.env` still carries the same values, so nothing can behave differently; this proves the plumbing.

Check:

```bash
scripts/deploy/logs.sh journal
```

Both `chord` and `chord-worker` should log `fetch-secrets: wrote N secrets (NAMES...)`. No `Secret Manager answered 403/404`. The app works as before. The KMS-style audit shows the VM's account reading each secret at restart (Logs Explorer: `protoPayload.serviceName="secretmanager.googleapis.com"`).

## 3. Values leave the VM's `.env` (`SECRETS_MODE=only`)

Change `deploy.env` to `SECRETS_MODE=only` and deploy again. The `.env` that reaches the VM no longer has the secrets; the services get them only from Secret Manager. Verify:

```bash
scripts/deploy/deploy.sh ssh
grep -c -E '^(DATABASE_URL|STRIPE_SECRET_KEY|OPENAI_API_KEY)=' /srv/chord/.env   # expect 0
```

Then one real round trip of each integration you use: sign in, a mail sync, a bot turn, a Stripe webhook or checkout if billing is on, a WhatsApp message, and `scripts/deploy/logs.sh errors` clean.

## Changing a secret (the everyday case)

`scripts/deploy/.env.prod` on your machine stays the place you edit. Nothing on the VM is edited by hand.

1. Edit the value in `scripts/deploy/.env.prod`.
2. `scripts/deploy/secrets.sh push --yes` stores it as a new version in Secret Manager (unchanged ones are skipped).
3. Make the app pick it up. Either:
   - `scripts/deploy/deploy.sh deploy` (also restarts both services), or
   - just restart, without a deploy: `gcloud compute ssh chord --zone us-central1-a --command 'sudo systemctl restart chord chord-worker'`.

Editing `.env.prod` and skipping step 2 cannot silently do nothing: in `only` and `fetch` mode `deploy.sh` runs `secrets.sh verify` first and **refuses** with "Run: secrets.sh push --yes" if `.env.prod` and Secret Manager differ. A restart alone, though, re-reads what Secret Manager holds, so a `.env.prod` change you did not `push` is not live. When the new value is proven, disable the old version in Secret Manager.

Changing a **non-secret** setting (anything not in `secret-keys.txt`) is the old flow: edit `.env.prod`, deploy.

## Operating it

- **Run a one-off command with the app's environment:** `chord-with-env npm run migrate` (also `encrypt:backfill`, `wrap:master-key`). It fetches the secrets into that command's memory only, as you, not root. `deploy.sh` and `cloudsql.sh` already use it.
- **Rotate a secret:** the same steps as "Changing a secret" above, then disable the old version in Secret Manager once the new one is proven.
- **Add a secret:** add its name to `secret-keys.txt`, put the value in `.env.prod`, `push`, deploy.
- **A service will not start after a change:** `journalctl -u chord` shows `fetch-secrets: secret NAME: Secret Manager answered 404/403`. 404 = not pushed (`secrets.sh push`), 403 = the VM's account lost `secretAccessor` on it.

## Rolling back

Set `SECRETS_MODE=fetch` (values return to `.env`) or remove it (back to today), and deploy. Nothing in Secret Manager is deleted by a rollback.

## What is deliberately not in Secret Manager

`CONTACT_HASH_PEPPER` is not a secret: the server hands it to every signed-in app so contacts are hashed on the phone (ADR 0065), and prod runs the built-in default. It stays in `.env`. `secrets.sh list` knows not to flag it. `MAXMIND_LICENSE_KEY` is only needed on the deploying machine (`local-only-keys.txt`), so it is kept out of the VM's `.env` but not stored. `SLACK_SIGNING_SECRET` is set in `.env.prod` but nothing reads it any more (Slack left the server config in ADR 0154): delete the line when you next edit the file.

## Not covered

The values remain in `.env.prod` on your laptop; deploying needs them. Root on the VM can read the secrets. The VM's database credential is now also only in Secret Manager: keep it recoverable (the Cloud SQL user's password can be reset from the console).
