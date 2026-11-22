# Crash monitor

When `chord` or `chord-worker` stops abnormally on the VM, a GitHub issue
labelled `crash` is filed with the stack trace, and a workflow asks Claude for
a draft pull request. Design and limits: [ADR 0227](../notes/0227-a-crash-files-its-own-issue.md).

Off until the four steps below are done. Run the `gcloud` and deploy commands
in WSL.

## Turn it on

1. **Create the token.** GitHub > Settings > Developer settings > Fine-grained
   tokens. Repository access: only this repository. Permissions: **Issues:
   Read and write**, nothing else. Create the label once:

   ```bash
   gh label create crash --color B60205 --description "Filed by the production VM (ADR 0227)"
   ```

2. **Store it where only the VM can read it.** Paste the token when `read`
   waits, so it is never in shell history:

   ```bash
   read -rs T && printf '%s' "$T" | gcloud secrets create CRASH_REPORT_GITHUB_TOKEN --replication-policy=automatic --labels=app=chord --data-file=- ; unset T
   ```

   ```bash
   gcloud secrets add-iam-policy-binding CRASH_REPORT_GITHUB_TOKEN --member="serviceAccount:$(gcloud compute instances describe chord --zone=us-central1-a --format='value(serviceAccounts[0].email)')" --role=roles/secretmanager.secretAccessor --condition=None
   ```

3. **Let Actions ask for fixes.** Add the repository secret
   `ANTHROPIC_API_KEY` (Settings > Secrets and variables > Actions), and tick
   Settings > Actions > General > "Allow GitHub Actions to create and approve
   pull requests".

4. **Deploy.** In `scripts/deploy/deploy.env` set `CRASH_REPORT_REPO=owner/name`,
   then run `scripts/deploy/deploy.sh deploy`. This installs the reporter and
   adds the `ExecStopPost` line to both units.

## Check it works

Kill the worker the way a crash would. systemd restarts it in three seconds:

```bash
sudo systemctl kill -s SIGKILL chord-worker
```

```bash
sudo journalctl --since "2 minutes ago" | grep crash-report
```

You should see `crash-report: filed #N for chord-worker.service (...)`, an
issue titled "Crash in chord-worker: stopped (signal, KILL)", and a
`crash-fix` run in Actions. Close the issue afterwards; the run will comment
that there is nothing to fix.

## Reading a report

- **Signature**: the same crash always gets the same one. Repeats comment on
  the open issue, at most once every six hours.
- **Deployed commit**: the commit `deploy.sh` was run from.
- **No stack trace**: the process was killed or never started. Read
  `scripts/deploy/logs.sh journal`.

## Turn it off

Remove `CRASH_REPORT_REPO` from `deploy.env` and deploy. To stop only the fix
requests, disable the `crash-fix` workflow in the Actions tab; issues are
still filed.

## What it does not catch

A process that hangs without exiting, and errors the app catches and logs
(`error-*.log`). Reports are dropped, with one journal line, if the VM cannot
reach GitHub or Secret Manager.
