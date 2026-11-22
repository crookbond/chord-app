# Vulnerability and patch policy

Written 2026-10-23. Owner: John Doe (`hello@chordapp.ai`). Review once a year.
Related: [dependency-exploitability.md](./dependency-exploitability.md),
[disaster-recovery.md](../ops/disaster-recovery.md).

## Finding vulnerabilities

- **Every month:** `npm audit` on the repository.
- **Every quarter:** a full scan of the app and its infrastructure:
  - OWASP Dependency-Check on `main` (the report goes in `docs/security/`);
  - `npm audit`;
  - pending operating-system updates on the VM (`apt list --upgradable`);
  - Google Cloud's security recommendations for the project (Security Command Center or
    Recommender).
- **As they arrive:** GitHub security alerts, vendor advisories for Node.js, Debian, Postgres
  (Cloud SQL), Expo and React Native, and anything a user or researcher reports to
  `hello@chordapp.ai`.

## Ranking

Each finding is rated by its published severity (CVSS), then adjusted for whether Chord can
actually be attacked through it: is the vulnerable code shipped to users or run on the server,
or only used at build time? The reasoning is written down in
[dependency-exploitability.md](./dependency-exploitability.md).

## How fast fixes go out

| Severity, after ranking | Patch deployed within |
|---|---|
| Critical, or being exploited | 7 days (as soon as possible when exploited) |
| High | 30 days |
| Medium | 90 days |
| Low | Next routine update |

If no fix exists, the finding is recorded with the reason and a workaround or other
protection, and re-checked every quarter.

## Operating system and runtime

- The VM's operating system installs Debian security updates automatically every day
  (`unattended-upgrades`, enabled and running; checked 2026-10-23). A kernel update only takes
  effect after a reboot: `/var/run/reboot-required` on the VM says when one is waiting, and the
  reboot is done within the same deadline as the update's severity (a few minutes of downtime,
  done at a quiet hour).
- Anti-malware: ClamAV on the VM (installed by `deploy.sh`). Signatures update through
  `clamav-freshclam`; `chord-clamscan.timer` scans the app folder, home and temp folders,
  `/etc`, `/usr/local` and `/opt` every night at low priority (sealed uploads are skipped,
  since they are ciphertext). A detection emails the owner (`audit.sh alert`, policy
  "malware found on the VM") and is kept in the audit log bucket.
- Node.js, the Debian release, Postgres and Expo SDK versions are kept on releases their
  maintainers still support. Node moved from 20 (end of life) to 22 on 2026-10-23. A move to a new major version is planned before the old one
  reaches end of life.
- Cloud SQL's minor-version patches are applied by Google in the instance's maintenance
  window.

## Record

Each quarterly scan is recorded by date in [dependency-exploitability.md](./dependency-exploitability.md),
with what was found and what was done.
