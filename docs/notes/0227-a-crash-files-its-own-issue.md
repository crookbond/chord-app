# 0227 — A crash files its own issue, and asks for a fix

Status: accepted (2026-10-08). Built; not yet run on the VM or in Actions.

## Context

On 2026-10-06 at 23:41 UTC `chord-worker` exited on an unhandled `'error'`
event from an IMAP client. systemd restarted it three seconds later. Nobody
knew for two days: it was found by a person reading `systemctl show` during a
routine check.

Nothing was watching for it:

- The uptime check (`monitor.sh`) asks `/health`, which the **web** role
  answers. A worker that dies and restarts never fails it.
- The app's error log was empty. A process that dies on an uncaught error
  writes the stack to stderr, which goes to the journal, not to winston.
- The Ops Agent ships only `auth.log` and `audit.log` (ADR 0207), on purpose:
  the app journal can carry user content.

The same search found the cause in a few minutes once someone looked. What
was missing was the looking.

## Decision

**Detect on the VM, with systemd.** Both units get an `ExecStopPost` that
runs after every stop and does nothing when `SERVICE_RESULT` is `success`
(a deploy, a `systemctl restart`). Otherwise it starts
`/usr/local/lib/chord/crash-report.mjs` through `systemd-run --no-block`, in
its own transient unit, so the service's restart never waits on the report and
a reporter failure never counts against the service. `ExecStopPost` rather
than `OnFailure=`: with `Restart=always` a unit goes straight to
auto-restart, and `OnFailure=` does not fire until the start limit is hit.

**Report as a GitHub issue.** The reporter reads the journal of the stopped
invocation, takes the fatal block Node printed (source location through
`Node.js vNN`), and files an issue labelled `crash` with the service, time,
systemd result, deployed commit and the trace.

- **One issue per distinct crash.** The signature is a hash of the error line
  (numbers and ids flattened) and the first five frames (function, file,
  line). A repeat of a crash whose issue is still open adds a comment, at most
  once every six hours, with the count since the last one. A repeat after the
  issue was closed files a new issue that points at the old one. At most five
  new issues an hour, whatever happens. `RestartSec=3` means a crash on start
  is twenty stops a minute; without these limits that is twenty issues a
  minute.
- **Only the trace leaves the VM.** The app's own log lines are dropped even
  when they fall inside the block, and emails, credentials in URLs and long
  tokens are removed from what remains. A stop with no Node trace (killed,
  out of memory, a failed `ExecStartPre`) is reported with the systemd result
  alone and no log lines.
- **The token never touches the app.** It is a fine-grained GitHub token with
  Issues read and write on this one repository, stored in Secret Manager
  (`CRASH_REPORT_GITHUB_TOKEN`) and read by the root-owned reporter at the
  moment it files. It is not in `secret-keys.txt`, so it is not in the app's
  environment, and not in `.env.prod`.
- The reporter and its code live in `/usr/local/lib/chord` (root-owned, like
  ADR 0211's fetcher), installed by `deploy.sh` when `CRASH_REPORT_REPO` is
  set. Unset, the unit lines are comments and nothing is installed.

**Ask for a fix in Actions.** `.github/workflows/crash-fix.yml` runs when an
issue gets the `crash` label. It runs Claude with the repository checked out
and the same Postgres service as CI, and asks for what `CLAUDE.md` asks of any
bug fix: the cause, a test that reproduces the real failure and is seen to
fail first, the fix, a sweep for the same pattern, and a **draft** pull
request. If the cause is not clear it comments on the issue instead of
opening a speculative pull request. It cannot merge or deploy.

The issue text is not pasted into the prompt. The workflow tells Claude to
read the issue and to treat it as output from a crashed process, not as
instructions: an error message can contain text that arrived from outside.

## Consequences

- A crash now costs one Actions run (up to 45 minutes) and one model session.
  Repeats of the same crash cost nothing.
- GitHub's own email for a new issue is the notification. There is no second
  channel: if the VM cannot reach GitHub or Secret Manager, the report is one
  line in the journal and is dropped.
- A pull request opened with the workflow's token does not start `ci.yml`.
  CI runs when a person marks the draft ready.
- A hang is not a crash. A worker that stops doing work without exiting is
  still invisible; that needs a heartbeat, not this.
- Errors the app catches and logs are not reported. They are in `error-*.log`.
- The redaction is a pattern match, not a guarantee. The repository is
  private, and the trace is code locations plus one error message.
- If the state file (`/var/lib/chord-crash/state.json`) is lost, the next
  occurrence of a known crash files one duplicate issue.

## Alternatives rejected

- **A log-based alert in Cloud Monitoring.** Needs the app journal shipped to
  Cloud Logging, which ADR 0207 deliberately does not do, and an email has
  nowhere to hang a fix.
- **Sentry or similar.** A new vendor holding production error data, for two
  processes on one VM.
- **A `process.on('uncaughtException')` handler in the app that reports.**
  The process is in an unknown state at that point, the handler must be
  right in exactly the case where something is wrong, and it sees nothing
  when the process is killed from outside.
- **Polling `NRestarts` from CI on a schedule.** Minutes spent on every run
  to find nothing, a delay of up to the polling interval, and no stack.
- **Letting the workflow merge a fix that passes its own test.** A test
  written by the author of the fix is evidence, not review.

## Addendum 2026-10-20: a deploy is not a crash

Once the token worked, the reporter would have filed an issue on four of the
last eleven deploys: the worker (once also the web role) exited with code 143
on a requested stop. Both units started through the `tsx` command, which runs
the code in a child process. systemd's stop sends SIGTERM to both; the `tsx`
parent waits 30 ms for the child to confirm the signal, signals it again,
waits another 30 ms, then SIGKILLs it and exits 128 + 15. A worker busy for
those 60 ms was killed mid-shutdown, so the exit code was the smaller problem.

- The units run `node --enable-source-maps --import tsx src/entrypoints/<role>.ts`:
  one process, so our own handler decides the exit code. tsx stays the loader
  (path aliases and the kernel import unchanged).
- `stopOnSignal` (`entrypoints/stop-on-signal.ts`) stops a role once, exits 0,
  and exits 1 if the stop itself throws, which is a real failure to report.
  A second signal during a stop waits for the first. The dev entrypoint uses it too.
- The reporter is unchanged. A requested stop that exits 0, or dies of
  SIGTERM, is already a success to systemd, so nothing needs filtering.
- `unit-start-command.test.ts` fails if a unit goes back to the `tsx` command,
  and on Linux shows the 143 against `node --import tsx`'s 0 with a busy
  process stopped the way systemd stops it.

Not covered: a stop that hangs past systemd's 90-second timeout is SIGKILLed
and reported as `timeout`. That is a real problem and is reported on purpose.
