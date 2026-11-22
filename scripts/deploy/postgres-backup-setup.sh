#!/usr/bin/env bash
# One-time setup of daily pg_dump backups on the production VM.
#
#   scripts/deploy/postgres-backup-setup.sh           # install + take a smoke-test dump
#   scripts/deploy/postgres-backup-setup.sh --dry-run # print what would happen
#
# Idempotent: re-running overwrites the cron file with the latest
# template and re-asserts /var/backups/chord ownership. The smoke
# dump always runs so you see the backup land before walking away.
#
# What it sets up on the VM:
#   1. /var/backups/chord/                  — backup directory, owned by postgres
#   2. /etc/cron.d/chord-pgdump             — daily 03:15 UTC dump + 14-day retention
#   3. one immediate manual dump            — verifies the cron command works
#
# Restore example:
#   pg_restore -d chord_restored /var/backups/chord/2026-05-24.dump
#
# The cron runs as the `postgres` unix user → uses peer auth on the
# unix socket → no password needed in the cron command. Independent
# of the application's chord:password TCP connection.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/deploy.env"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE." >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

: "${PROJECT_ID:?}"
: "${ZONE:?}"
: "${INSTANCE:?}"

PG_DB=chord
BACKUP_DIR=/var/backups/chord
RETENTION_DAYS=14
CRON_FILE=/etc/cron.d/chord-pgdump
CRON_TIME='15 3 * * *'   # daily at 03:15 UTC

gcloud_() { gcloud --project="$PROJECT_ID" "$@"; }
rsh()     { gcloud_ compute ssh "$INSTANCE" --zone="$ZONE" --command="$1"; }

run_remote() {
  local label="$1" cmd="$2"
  echo
  echo "▶ $label"
  echo "    \$ $cmd"
  [[ $DRY_RUN -eq 1 ]] && return 0
  rsh "$cmd"
}

echo "================================================================"
echo "Postgres backup setup for $INSTANCE ($ZONE)"
echo "  database      : $PG_DB"
echo "  backup dir    : $BACKUP_DIR"
echo "  cron schedule : $CRON_TIME UTC"
echo "  retention     : $RETENTION_DAYS days"
[[ $DRY_RUN -eq 1 ]] && echo "  mode          : DRY RUN"
echo "================================================================"

# ── 1. backup dir owned by postgres ──────────────────────────────────
run_remote "create $BACKUP_DIR owned by postgres" "\
  sudo install -d -o postgres -g postgres -m 0750 '$BACKUP_DIR' && \
  ls -ld '$BACKUP_DIR'"

# ── 2. install the cron file ─────────────────────────────────────────
# Heredoc must be quoted so the local shell doesn't expand $(date),
# which has to expand on the VM at cron-run time. We also re-quote
# the find command's curly braces.
CRON_BODY="$(cat <<EOF
# Daily pg_dump of the chord database. Installed by
# scripts/deploy/postgres-backup-setup.sh; re-run that to update.
# Runs as postgres → peer auth on the unix socket → no password.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
$CRON_TIME postgres pg_dump --format=custom $PG_DB > $BACKUP_DIR/\$(date -u +\\%F).dump && find $BACKUP_DIR -name '*.dump' -type f -mtime +$RETENTION_DAYS -delete
EOF
)"

# Push the cron file via stdin so we don't have to deal with quoting
# the literal % characters inside ssh -c.
echo
echo "▶ install $CRON_FILE (daily $CRON_TIME UTC, $RETENTION_DAYS-day retention)"
echo "    (cron body below)"
echo "$CRON_BODY" | sed 's/^/      /'
if [[ $DRY_RUN -eq 0 ]]; then
  echo "$CRON_BODY" | gcloud_ compute ssh "$INSTANCE" --zone="$ZONE" \
    --command="sudo tee '$CRON_FILE' >/dev/null && sudo chmod 644 '$CRON_FILE' && sudo chown root:root '$CRON_FILE' && echo 'cron installed'"
fi

# ── 3. smoke-test by running the dump immediately ────────────────────
run_remote "smoke-test: take one dump now" "\
  sudo -u postgres pg_dump --format=custom '$PG_DB' > /tmp/chord-smoke.dump && \
  sudo install -o postgres -g postgres -m 0640 /tmp/chord-smoke.dump '$BACKUP_DIR/smoke-test.dump' && \
  rm /tmp/chord-smoke.dump && \
  sudo ls -lh '$BACKUP_DIR/smoke-test.dump'"

# ── 4. verify cron will fire (next run line) ─────────────────────────
run_remote "show next scheduled cron run for chord-pgdump" "\
  sudo systemctl status cron --no-pager | head -5 && \
  echo '---' && \
  sudo cat '$CRON_FILE'"

echo
echo "================================================================"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "DRY RUN complete."
else
  echo "Backups configured."
  echo "  - Smoke dump at: $BACKUP_DIR/smoke-test.dump (delete when satisfied)"
  echo "  - Daily dumps at: $BACKUP_DIR/YYYY-MM-DD.dump"
  echo "  - Restore: pg_restore -d <target> $BACKUP_DIR/<date>.dump"
  echo "  - Off-host copies (snapshot the dump dir to GCS / another VM) are"
  echo "    NOT set up here — same-VM dumps don't survive disk loss."
fi
echo "================================================================"
