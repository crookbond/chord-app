# Master key behind KMS — cutover runbook

ADR [0210](../notes/0210-the-token-master-key-is-wrapped-not-stored.md). Two deploys. The plain `MASTER_KEY` stays in `.env.prod` until the wrapped one has been used in production, so every step is reversible until step 5.

You edit `scripts/deploy/.env.prod` yourself; nothing here does.

## Before you start

- The VM's service account (`chord-vm`) can already use the content key, which is the default wrapping key. Nothing to grant.
- Keep an offline copy of the plain `MASTER_KEY` somewhere sealed (password manager, printed and stored). If the KMS key is ever destroyed the wrapped value is unrecoverable; without an offline copy every user would have to reconnect Google, Microsoft and mail accounts.

## Steps

1. **Deploy the code.** `scripts/deploy/deploy.sh deploy`. No environment change yet; the app behaves exactly as before.

2. **Wrap the key, on the VM.** It reads `MASTER_KEY` inside one process and prints only ciphertext, after proving it unwraps to the same bytes:

   ```bash
   scripts/deploy/deploy.sh ssh
   cd /srv/chord && set -a && . ./.env && set +a && NODE_ENV=production npm run wrap:master-key --workspace=server
   # once secrets are in Secret Manager (docs/ops/secrets.md), MASTER_KEY is not in .env; use instead:
   cd /srv/chord && chord-with-env npm run wrap:master-key --workspace=server
   ```

   It prints `MASTER_KEY_WRAPPED=...`. That line is safe to store: it is useless without the KMS key.

3. **Add the line to `.env.prod`** (keep `MASTER_KEY` too), and set `MASTER_KEY_KMS_KEY` only if you are not wrapping under the content key. Deploy.

4. **Verify** (wrapped wins, so this run uses only the KMS copy):
   - The **app's own log file**, not the journal (the services write to `/var/lib/chord/logs`), shows `token master key unwrapped from Cloud KMS` twice after the restart (once for `chord`, once for `chord-worker`), and no `could not unwrap MASTER_KEY_WRAPPED`: `scripts/deploy/deploy.sh ssh`, then `sudo grep -h "unwrapped from Cloud KMS" /var/lib/chord/logs/combined-$(date -u +%F).log`. A failed unwrap stops the service at start, so `systemctl is-active chord chord-worker` also proves it.
   - Sign in, and open an email thread on a Google account and on an Outlook or IMAP account (these open sealed refresh tokens and app passwords).
   - Ask the bot something on a BYOK account if you have one.
   - The KMS Data Access log shows a decrypt by `chord-vm` at each restart.

5. **Remove the plain key.** Delete `MASTER_KEY` from `.env.prod` and deploy. Then confirm the VM has none: `grep -c '^MASTER_KEY=' /srv/chord/.env` should print `0` (and `MASTER_KEY_WRAPPED=` should be there). Two things to expect: the deploy appends an empty `MASTER_KEY=` line back to `.env.prod` (it copies keys missing from `example.env`; harmless, since an empty value is skipped everywhere), and once the secrets are in Secret Manager the plain key is also fetched from there until it is out of `.env.prod` (the deploy's list of fetched secrets only names secrets that have a value in `.env.prod`). The `MASTER_KEY` secret in Secret Manager is left as a recovery copy until you confirm an offline copy exists; delete it then with `gcloud secrets delete MASTER_KEY`.

## Rolling back

- Before step 5: remove `MASTER_KEY_WRAPPED` from `.env.prod` and redeploy (the plain key is still there). **Remove the wrapped line too**, not just the plain one: while it is set the app insists on unwrapping it.
- After step 5: put the plain `MASTER_KEY` back from your offline copy, remove `MASTER_KEY_WRAPPED`, redeploy.

## If the app will not start

The error names the cause: `could not unwrap MASTER_KEY_WRAPPED (…)`. Usual reasons: `MASTER_KEY_KMS_KEY` differs from the key that wrapped it (it is bound in, and must never change), the VM's service account lost access to the key, or the value was copied with a stray character.

## After

Phase 8b (third-party secrets into Secret Manager) is next; see [phase-8-key-custody.md](../tasks/phase-8-key-custody.md).
