#!/usr/bin/env bash
# Inspect, sync, and tune logging on the deployed Chord VM. Run from the repo
# root. Shares scripts/deploy/deploy.env with deploy.sh (same GCP target).
#
#   scripts/deploy/logs.sh level [LEVEL]    # show / set runtime LOG_LEVEL (restarts chord + chord-worker)
#   scripts/deploy/logs.sh tail [WHICH]     # tail -f a winston log file (combined|error|prompts)
#   scripts/deploy/logs.sh journal          # tail -f the systemd journal for chord + chord-worker (ADR 0172)
#   scripts/deploy/logs.sh errors [N]       # last N lines of the newest error log (default 200)
#   scripts/deploy/logs.sh grep <pat> [WHICH]  # search a remote log file (default combined)
#   scripts/deploy/logs.sh ls               # list remote log files with sizes + mtimes
#   scripts/deploy/logs.sh pull             # rsync the VM's logs dir back to ./logs/from-vm-<ts>
#
# WHICH is one of: combined (default), error, prompts.
#
# "Enabling logging" on a deployed box means turning the level up: the winston
# file transports are always on (see server/src/config/logging.ts), but the
# combined-*.log only captures down to LOG_LEVEL. `level debug` makes it
# verbose; `level info` quiets it back down. The change edits /srv/chord/.env
# and restarts the service — it is EPHEMERAL: the next `deploy.sh deploy`
# overwrites /srv/chord/.env from your local prod env file. To persist, set
# LOG_LEVEL in that file too (the path is SERVER_ENV_FILE in deploy.env).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ENV_FILE="$SCRIPT_DIR/deploy.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE — copy deploy.env.example to deploy.env and fill it in." >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

: "${PROJECT_ID:?set in deploy.env}"
: "${ZONE:?}"
: "${INSTANCE:?}"
SERVER_ENV_FILE="${SERVER_ENV_FILE:-}"

APP_DIR=/srv/chord
LOGS_DIR=/var/lib/chord/logs
REMOTE_ENV="$APP_DIR/.env"

# ── helpers ──────────────────────────────────────────────────────────
gcloud_() { gcloud --project="$PROJECT_ID" "$@"; }

rsh() { gcloud_ compute ssh "$INSTANCE" --zone="$ZONE" --command="$1"; }

require_ssh_config() { gcloud_ compute config-ssh --quiet >/dev/null; }

ssh_host() { echo "$INSTANCE.$ZONE.$PROJECT_ID"; }

# Map a WHICH keyword to a shell expression that resolves to the live file on
# the VM. combined/error are date-rotated, so pick the newest by mtime;
# prompts-* is date-rotated too (metadata only in production; PROMPT_LOG=full
# is refused there).
remote_file_expr() {
  case "${1:-combined}" in
    combined) echo "\$(ls -1t $LOGS_DIR/combined-*.log 2>/dev/null | head -1)" ;;
    error)    echo "\$(ls -1t $LOGS_DIR/error-*.log 2>/dev/null | head -1)" ;;
    prompts)  echo "\$(ls -1t $LOGS_DIR/prompts-*.log 2>/dev/null | head -1)" ;;
    *) echo "unknown log '$1' — use combined | error | prompts" >&2; exit 1 ;;
  esac
}

# ── subcommands ──────────────────────────────────────────────────────

cmd_level() {
  local new="${1:-}"
  if [[ -z "$new" ]]; then
    echo "→ current LOG_LEVEL on $INSTANCE:"
    rsh "grep -E '^LOG_LEVEL=' $REMOTE_ENV || echo 'LOG_LEVEL= (unset → server default: debug)'"
    echo
    echo "Set with: scripts/deploy/logs.sh level <error|warn|info|http|verbose|debug|silly>"
    return
  fi
  case "$new" in
    error|warn|info|http|verbose|debug|silly) ;;
    *) echo "✗ invalid level '$new' — use error|warn|info|http|verbose|debug|silly" >&2; exit 1 ;;
  esac

  echo "→ setting LOG_LEVEL=$new in $REMOTE_ENV and restarting chord + chord-worker"
  # Replace the line in place if present, otherwise append it. sed -i edits the
  # remote file; the fallback append handles a first-time set.
  rsh "
set -e
if grep -qE '^LOG_LEVEL=' $REMOTE_ENV; then
  sudo sed -i -E 's|^LOG_LEVEL=.*|LOG_LEVEL=$new|' $REMOTE_ENV
else
  echo 'LOG_LEVEL=$new' | sudo tee -a $REMOTE_ENV >/dev/null
fi
sudo systemctl restart chord chord-worker
"
  echo "✓ LOG_LEVEL=$new active."
  echo "  NOTE: ephemeral — next \`deploy.sh deploy\` reverts /srv/chord/.env."
  if [[ -n "$SERVER_ENV_FILE" ]]; then
    echo "  To persist, set LOG_LEVEL=$new in $SERVER_ENV_FILE too."
  fi
}

cmd_tail() {
  local which="${1:-combined}"
  local f; f="$(remote_file_expr "$which")"
  echo "→ tail -f $which log on $INSTANCE (Ctrl-C to stop)"
  rsh "f=$f; [ -n \"\$f\" ] && [ -f \"\$f\" ] || { echo 'no $which log yet at $LOGS_DIR'; exit 0; }; echo \"== \$f ==\"; tail -n 50 -f \"\$f\""
}

cmd_journal() {
  rsh 'sudo journalctl -u chord -u chord-worker -f --no-pager'
}

cmd_errors() {
  local n="${1:-200}"
  local f; f="$(remote_file_expr error)"
  rsh "f=$f; [ -n \"\$f\" ] && [ -f \"\$f\" ] || { echo 'no error log — nothing has hit error level'; exit 0; }; echo \"== \$f (last $n) ==\"; tail -n $n \"\$f\""
}

cmd_grep() {
  local pat="${1:?usage: logs.sh grep <pattern> [combined|error|prompts]}"
  local which="${2:-combined}"
  local f; f="$(remote_file_expr "$which")"
  # Escape single quotes in the pattern so it survives the remote single-quoted arg.
  local safe="${pat//\'/\'\\\'\'}"
  rsh "f=$f; [ -n \"\$f\" ] && [ -f \"\$f\" ] || { echo 'no $which log yet'; exit 0; }; echo \"== grep in \$f ==\"; grep -n -- '$safe' \"\$f\" || echo '(no matches)'"
}

cmd_ls() {
  rsh "ls -lh --time-style=long-iso $LOGS_DIR 2>/dev/null || echo 'no logs dir at $LOGS_DIR'"
}

cmd_pull() {
  require_ssh_config
  local host; host=$(ssh_host)
  local dest="$REPO_ROOT/logs/from-vm-$(date +%Y%m%d-%H%M%S)"

  echo "→ rsync $host:$LOGS_DIR/ → $dest/"
  mkdir -p "$dest"
  # The chord service runs as the remote user (User= in chord.service) and
  # writes the log files itself, so they're user-readable — no sudo staging
  # needed (unlike deploy.sh pull-data, where uploaded files can be root-owned).
  rsync -az "$host:$LOGS_DIR/" "$dest/"
  echo "✓ pulled to $dest"
}

cmd_help() {
  sed -n '2,28p' "$0"
}

# ── dispatch ─────────────────────────────────────────────────────────
cmd="${1:-help}"; shift || true
case "$cmd" in
  level)   cmd_level "$@" ;;
  tail)    cmd_tail "$@" ;;
  journal) cmd_journal "$@" ;;
  errors)  cmd_errors "$@" ;;
  grep)    cmd_grep "$@" ;;
  ls)      cmd_ls "$@" ;;
  pull)    cmd_pull "$@" ;;
  help|-h|--help) cmd_help ;;
  *) echo "unknown command: $cmd"; cmd_help; exit 1 ;;
esac
