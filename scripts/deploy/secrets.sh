#!/usr/bin/env bash
# Move the app's secrets into Secret Manager (ADR 0211, Phase 8b). Run from the repo root, in WSL,
# in YOUR shell: it reads scripts/deploy/.env.prod, and nobody else needs to see the values.
#
#   scripts/deploy/secrets.sh list                # per secret: set in .env.prod? in Secret Manager? current?
#   scripts/deploy/secrets.sh push [--yes]        # create/update secrets, grant the VM's account access
#   scripts/deploy/secrets.sh verify              # is what Secret Manager holds what .env.prod holds? (exit 1 if not)
#
# Every command accepts --dry-run. `push` needs --yes. Values are never printed, logged, or put on a
# command line: they travel through stdin to gcloud. It never edits .env.prod.
#
# Which names are secrets: scripts/deploy/secret-keys.txt. A name that is empty or missing in
# .env.prod is skipped. Rotating a secret = change it in .env.prod, `push`, restart the services.

set -euo pipefail
set +x
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/deploy.env"
DRY_RUN=0; YES=0
CMD="${1:-}"; [[ $# -gt 0 ]] && shift
for a in "$@"; do case "$a" in --dry-run) DRY_RUN=1 ;; --yes) YES=1 ;; *) echo "Unknown arg: $a" >&2; exit 2 ;; esac; done
[[ -z "$CMD" || "$CMD" == "-h" || "$CMD" == "--help" ]] && { sed -n '2,15p' "$0"; exit 0; }
[[ -f "$ENV_FILE" ]] || { echo "Missing $ENV_FILE" >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"
: "${PROJECT_ID:?}"; : "${ZONE:?}"; : "${INSTANCE:?}"; : "${SERVER_ENV_FILE:?}"
SERVER_ENV_FILE="${SECRETS_ENV_FILE:-$SERVER_ENV_FILE}"   # override for a dry run against a scratch file
[[ "$SERVER_ENV_FILE" = /* ]] || SERVER_ENV_FILE="$(cd "$SCRIPT_DIR/../.." && pwd)/${SERVER_ENV_FILE#./}"
[[ -f "$SERVER_ENV_FILE" ]] || { echo "Missing $SERVER_ENV_FILE" >&2; exit 1; }

gcloud_() { gcloud --project="$PROJECT_ID" "$@"; }
names() { grep -v -E '^\s*(#|$)' "$1"; }
# The raw value after the first '=' of the first matching line, exactly as the app's env file has it.
# A trailing carriage return is line-ending noise, not part of the value: an "empty" assignment in a file
# with Windows line endings (or copied from one, as deploy.sh does from example.env) would otherwise count as
# a one-character secret. The tr is on the value only, so a real value is untouched.
value_of() { grep -m1 "^$1=" "$SERVER_ENV_FILE" | cut -d= -f2- | tr -d '\r' || true; }
hash16() { printf '%s' "$1" | sha256sum | cut -c1-16; }
SECRET_NAMES="$(names "$SCRIPT_DIR/secret-keys.txt")"

need_yes() { if [[ $DRY_RUN -eq 0 && $YES -eq 0 ]]; then echo "Refusing: '$CMD' changes Secret Manager and IAM. Use --dry-run to read it, --yes to do it." >&2; exit 2; fi; }
say() { if [[ $DRY_RUN -eq 1 ]]; then echo "[dry-run] $*"; fi; }

# These reads must never wait for a keypress. With the API disabled, gcloud asks "enable it? (y/N)"; with
# stderr hidden that looked like a hang. --quiet and a closed stdin make it fail fast instead.
existing() { gcloud_ secrets list --quiet --format='value(name.basename())' </dev/null 2>/dev/null || true; }
annotation() { gcloud_ secrets describe "$1" --quiet --format='value(annotations.chord-sha256)' </dev/null 2>/dev/null || true; }
api_enabled() { [[ -n "$(gcloud_ services list --enabled --quiet --filter='config.name=secretmanager.googleapis.com' --format='value(config.name)' </dev/null 2>/dev/null)" ]]; }

cmd_list() {
  if api_enabled; then :; else echo "Secret Manager API: not enabled on $PROJECT_ID yet (fine: 'push --yes' enables it). Nothing can be stored until then."; echo; fi
  local have; have="$(existing)"
  printf '%-32s %-12s %-16s\n' NAME ".env.prod" "Secret Manager"
  local n v sm
  while read -r n; do
    v="$(value_of "$n")"
    if [[ -z "$v" ]]; then local st="empty/absent"; else st="set"; fi
    if grep -qx "$n" <<<"$have"; then
      if [[ -n "$v" && "$(annotation "$n")" == "$(hash16 "$v")" ]]; then sm="current"; else sm="exists"; fi
    else sm="-"; fi
    printf '%-32s %-12s %-16s\n' "$n" "$st" "$sm"
  done <<<"$SECRET_NAMES"
  echo
  echo "Secret-looking names in .env.prod that are in NEITHER list (check each; add to secret-keys.txt if it is a secret):"
  local listed; listed="$(cat <(echo "$SECRET_NAMES") <(names "$SCRIPT_DIR/local-only-keys.txt"))"
  local k found=0
  while read -r k; do
    grep -qx "$k" <<<"$listed" && continue
    [[ "$k" == EXPO_PUBLIC_* || "$k" == *_PUBLIC_URL || "$k" == "MASTER_KEY_WRAPPED" || "$k" == "GOOGLE_SEARCH_CX" || "$k" == "CONTACT_HASH_PEPPER" ]] && continue
    [[ -n "$(value_of "$k")" ]] || continue
    echo "  $k"; found=1
  done < <(grep -o -E '^[A-Z][A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PRIVATE|PEPPER|_URL)[A-Z0-9_]*=' "$SERVER_ENV_FILE" | tr -d '=')
  [[ $found -eq 1 ]] || echo "  none"
}

cmd_push() {
  need_yes
  local sa; sa="$(gcloud_ compute instances describe "$INSTANCE" --zone="$ZONE" --format='value(serviceAccounts[0].email)')"
  echo "VM service account: $sa"
  if [[ $DRY_RUN -eq 1 ]]; then say "gcloud services enable secretmanager.googleapis.com"; else gcloud_ services enable secretmanager.googleapis.com --quiet </dev/null; fi
  local have; have="$(existing)"
  local n v h cur pushed=0 skipped=0
  while read -r n; do
    v="$(value_of "$n")"
    if [[ -z "$v" ]]; then skipped=$((skipped+1)); continue; fi
    if [[ "$v" == *$'\r'* ]]; then echo "!! $n has a carriage return; fix the line ending in .env.prod (skipped)" >&2; continue; fi
    h="$(hash16 "$v")"
    if ! grep -qx "$n" <<<"$have"; then
      say "gcloud secrets create $n --replication-policy=automatic --labels=app=chord"
      [[ $DRY_RUN -eq 1 ]] || gcloud_ secrets create "$n" --replication-policy=automatic --labels=app=chord >/dev/null
      cur=""
    else cur="$(annotation "$n")"; fi
    if [[ "$cur" != "$h" ]]; then
      say "add a new version of $n (value from .env.prod via stdin) and record its fingerprint"
      if [[ $DRY_RUN -eq 0 ]]; then
        printf '%s' "$v" | gcloud_ secrets versions add "$n" --data-file=- >/dev/null
        gcloud_ secrets update "$n" --update-annotations="chord-sha256=$h" >/dev/null
      fi
      pushed=$((pushed+1))
      echo "  $n: stored"
    else
      echo "  $n: already current"
    fi
    say "gcloud secrets add-iam-policy-binding $n --member=serviceAccount:$sa --role=roles/secretmanager.secretAccessor"
    [[ $DRY_RUN -eq 1 ]] || gcloud_ secrets add-iam-policy-binding "$n" --member="serviceAccount:$sa" --role=roles/secretmanager.secretAccessor --condition=None >/dev/null
  done <<<"$SECRET_NAMES"
  echo "Done: $pushed stored/updated, $skipped empty or absent in .env.prod (skipped)."
  echo "Next: scripts/deploy/secrets.sh verify, then set SECRETS_MODE=fetch in deploy.env and deploy (docs/ops/secrets.md)."
}

cmd_verify() {
  local have bad=0 n v st; have="$(existing)"
  while read -r n; do
    v="$(value_of "$n")"
    [[ -n "$v" ]] || continue
    if ! grep -qx "$n" <<<"$have"; then st="MISSING in Secret Manager"; bad=1
    elif [[ "$(annotation "$n")" == "$(hash16 "$v")" ]]; then st="ok"
    else st="DIFFERS from .env.prod (push again)"; bad=1; fi
    printf '  %-32s %s\n' "$n" "$st"
  done <<<"$SECRET_NAMES"
  [[ $bad -eq 0 ]] && echo "All secrets in Secret Manager match .env.prod." || { echo "Not all secrets match." >&2; exit 1; }
}

case "$CMD" in
  list) cmd_list ;;
  push) cmd_push ;;
  verify) cmd_verify ;;
  *) echo "Unknown command: $CMD" >&2; exit 2 ;;
esac
