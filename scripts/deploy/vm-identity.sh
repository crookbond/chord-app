#!/usr/bin/env bash
# The app VM's Google identity: a dedicated, least-privilege service account
# instead of the default compute account (phase 8d, ADR 0209).
# Run from the repo root, in WSL (gcloud lives there). Shares scripts/deploy/deploy.env.
#
#   scripts/deploy/vm-identity.sh status              # who the VM runs as, and what that can do (read-only)
#   scripts/deploy/vm-identity.sh create [--yes]      # the chord-vm account and its grants (no downtime)
#   scripts/deploy/vm-identity.sh switch [--yes]      # stop the VM, move it to chord-vm, start, re-point the alert (~2 min down)
#   scripts/deploy/vm-identity.sh verify              # the app decrypted as chord-vm since the switch (read-only)
#   scripts/deploy/vm-identity.sh revoke-old [--yes]  # drop the default account's key grant and its project Editor role
#   scripts/deploy/vm-identity.sh rollback [--yes]    # back to the default account (re-grants what revoke-old removed)
#
# Every command accepts --dry-run (print, do not change). Anything that changes
# the project or the VM also needs --yes. Order: create, switch, verify, and
# revoke-old only after verify has passed and the app has run for a while.
#
# What the app needs from its Google identity is small: decrypt on the content
# key (the app unwraps per-owner data keys through Cloud KMS, ADR 0201) and, for
# the Ops Agent, writing logs and metrics (ADR 0207). Gmail/Calendar/Search go
# through each user's OAuth token or an API key, and Cloud SQL is a password
# over a private IP, so none of those need IAM. Phase 8a/8b add their own
# grants (the token key, named secrets) to this account as they land.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${DEPLOY_ENV_FILE:-$SCRIPT_DIR/deploy.env}"

DRY_RUN=0
YES=0
CMD="${1:-}"
[[ $# -gt 0 ]] && shift
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes) YES=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done
[[ -z "$CMD" || "$CMD" == "-h" || "$CMD" == "--help" ]] && { sed -n '2,22p' "$0"; exit 0; }

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE - copy deploy.env.example to deploy.env and fill it in." >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"
: "${PROJECT_ID:?set in deploy.env}"
: "${ZONE:?}"
: "${INSTANCE:?}"
: "${DOMAIN:?}"

REGION="${ZONE%-*}"
CONTENT_KEY="${CONTENT_KEY_NAME:-content-kek}"
CONTENT_KEYRING="${CONTENT_KEYRING:-chord-content}"
VM_SA_NAME="${VM_SA_NAME:-chord-vm}"
NEW_SA="$VM_SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
PROJECT_ROLES=(roles/logging.logWriter roles/monitoring.metricWriter)
ALERT_NAME="chord-audit: human decrypt of the content key"

gcloud_() { gcloud --project="$PROJECT_ID" "$@"; }

need_yes() {
  if [[ $DRY_RUN -eq 0 && $YES -eq 0 ]]; then
    echo "Refusing: '$CMD' changes the project or the VM. Re-run with --dry-run to read it, or --yes to do it." >&2
    exit 2
  fi
}
run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    if [[ "$1" == "gcloud_" ]]; then shift; set -- gcloud "--project=$PROJECT_ID" "$@"; fi
    printf '[dry-run]'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}
api() { # api METHOD URL [JSON-body-file]
  local method="$1" url="$2" body="${3:-}" tok
  tok="$(gcloud auth print-access-token)"
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" -H "Authorization: Bearer $tok" -H "Content-Type: application/json" -H "x-goog-user-project: $PROJECT_ID" --data @"$body" "$url"
  else
    curl -sS -X "$method" -H "Authorization: Bearer $tok" -H "x-goog-user-project: $PROJECT_ID" "$url"
  fi
}

vm_sa() { gcloud_ compute instances describe "$INSTANCE" --zone="$ZONE" --format='value(serviceAccounts[0].email)'; }
default_sa() {
  local num
  num="$(gcloud_ projects describe "$PROJECT_ID" --format='value(projectNumber)')"
  echo "$num-compute@developer.gserviceaccount.com"
}
key_members() {
  gcloud_ kms keys get-iam-policy "$CONTENT_KEY" --keyring="$CONTENT_KEYRING" --location="$REGION" \
    --flatten='bindings[].members' --filter='bindings.role:roles/cloudkms.cryptoKeyEncrypterDecrypter' \
    --format='value(bindings.members)'
}
sa_exists() { gcloud_ iam service-accounts describe "$NEW_SA" --format='value(email)' >/dev/null 2>&1; }

# Point the alert at the account the app now runs as, so the app's own
# decrypts are not reported as a human's. The filter and its text both name it.
repoint_alert() {
  local sa="$1" tmp base name
  base="https://monitoring.googleapis.com/v3/projects/$PROJECT_ID"
  tmp="$(mktemp -d)"
  api GET "$base/alertPolicies" > "$tmp/all.json"
  # The program comes in on stdin (the heredoc), so the JSON is passed by path.
  name="$(python3 - "$ALERT_NAME" "$tmp/all.json" <<'PY'
import json,sys
for p in json.load(open(sys.argv[2])).get("alertPolicies",[]):
    if p["displayName"]==sys.argv[1]: print(p["name"]); break
PY
)"
  if [[ -z "$name" ]]; then
    echo "  alert '$ALERT_NAME' not found - nothing to re-point (create it with audit.sh alert)"
    rm -rf "$tmp"; return 0
  fi
  python3 - "$ALERT_NAME" "$sa" "$tmp/all.json" > "$tmp/patch.json" <<'PY'
import json,re,sys
name,sa,path=sys.argv[1],sys.argv[2],sys.argv[3]
p=next(p for p in json.load(open(path))["alertPolicies"] if p["displayName"]==name)
pat=re.compile(r'principalEmail="[^"]*"')
for c in p["conditions"]:
    c["conditionMatchedLog"]["filter"]=pat.sub(f'principalEmail="{sa}"',c["conditionMatchedLog"]["filter"])
doc=p.get("documentation",{})
if "content" in doc:
    doc["content"]=re.sub(r"`[^`]+@[^`]+`",f"`{sa}`",doc["content"],count=1)
print(json.dumps({"conditions":p["conditions"],"documentation":doc}))
PY
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[dry-run] PATCH $name (updateMask=conditions,documentation):"; sed 's/^/    /' "$tmp/patch.json"
  else
    api PATCH "https://monitoring.googleapis.com/v3/$name?updateMask=conditions,documentation" "$tmp/patch.json" \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); print("  alert re-pointed:", d["conditions"][0]["conditionMatchedLog"]["filter"].split("principalEmail=")[-1])'
  fi
  rm -rf "$tmp"
}

wait_healthy() {
  local url="https://$DOMAIN/api/v1/health" code i
  for i in $(seq 1 60); do
    code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$url" || true)"
    if [[ "$code" == "200" ]]; then echo "  healthy after ~$((i * 5))s"; return 0; fi
    sleep 5
  done
  echo "  NOT healthy after 5 minutes ($url -> $code). Check: scripts/deploy/logs.sh journal" >&2
  return 1
}

move_vm_to() {
  local sa="$1"
  echo "→ stopping $INSTANCE (the app is down from here until it restarts)"
  run gcloud_ compute instances stop "$INSTANCE" --zone="$ZONE"
  echo "→ running $INSTANCE as $sa"
  # cloud-platform is only a ceiling; IAM on the account is the real limit.
  run gcloud_ compute instances set-service-account "$INSTANCE" --zone="$ZONE" \
    --service-account="$sa" --scopes=cloud-platform
  echo "→ starting $INSTANCE"
  run gcloud_ compute instances start "$INSTANCE" --zone="$ZONE"
  if [[ $DRY_RUN -eq 0 ]]; then wait_healthy; fi
}

# ── status ────────────────────────────────────────────────────────────
cmd_status() {
  local cur def
  cur="$(vm_sa)"; def="$(default_sa)"
  echo "== VM runs as: $cur$([[ "$cur" == "$def" ]] && echo '  (the DEFAULT compute account)')"
  gcloud_ compute instances describe "$INSTANCE" --zone="$ZONE" --format='value(serviceAccounts[0].scopes)' | sed 's/^/   scopes: /'
  echo "== project roles of $cur"
  gcloud_ projects get-iam-policy "$PROJECT_ID" --flatten='bindings[].members' \
    --filter="bindings.members:serviceAccount:$cur" --format='value(bindings.role)' | sed 's/^/   /'
  if [[ "$cur" != "$def" ]]; then
    echo "== project roles of the default account ($def)"
    gcloud_ projects get-iam-policy "$PROJECT_ID" --flatten='bindings[].members' \
      --filter="bindings.members:serviceAccount:$def" --format='value(bindings.role)' | sed 's/^/   /' || true
  fi
  echo "== may decrypt with $CONTENT_KEY"
  key_members | sed 's/^/   /'
  echo "== $NEW_SA: $(sa_exists && echo exists || echo 'not created')"
}

# ── create ────────────────────────────────────────────────────────────
cmd_create() {
  need_yes
  if sa_exists; then
    echo "→ $NEW_SA exists"
  else
    echo "→ creating $NEW_SA"
    run gcloud_ iam service-accounts create "$VM_SA_NAME" --display-name="Chord app VM" \
      --description="Runs the chord VM. Decrypt on the content key; log and metric writer. ADR 0209."
  fi
  echo "→ decrypt on the content key only (key-level, not project-level)"
  run gcloud_ kms keys add-iam-policy-binding "$CONTENT_KEY" --keyring="$CONTENT_KEYRING" --location="$REGION" \
    --member="serviceAccount:$NEW_SA" --role=roles/cloudkms.cryptoKeyEncrypterDecrypter --format=none
  for role in "${PROJECT_ROLES[@]}"; do
    echo "→ $role (Ops Agent)"
    # A just-created account can take a while to be visible to the project
    # policy ("service account ... does not exist"), so retry before failing.
    local attempt
    for attempt in 1 2 3 4 5 6; do
      if run gcloud_ projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:$NEW_SA" --role="$role" --condition=None --format=none; then
        break
      fi
      [[ $attempt -lt 6 ]] || { echo "  giving up on $role - re-run create in a minute" >&2; exit 1; }
      echo "  not visible yet, retrying in $((attempt * 10))s"
      sleep $((attempt * 10))
    done
  done
  echo "✓ created. Nothing uses it yet. Next: scripts/deploy/vm-identity.sh switch --dry-run"
}

# ── switch ────────────────────────────────────────────────────────────
cmd_switch() {
  need_yes
  if [[ $DRY_RUN -eq 0 ]]; then
    sa_exists || { echo "Refusing: $NEW_SA does not exist. Run create first." >&2; exit 2; }
    key_members | grep -qx "serviceAccount:$NEW_SA" \
      || { echo "Refusing: $NEW_SA cannot decrypt with $CONTENT_KEY - the app could not open sealed mail. Run create." >&2; exit 2; }
    if [[ "$(vm_sa)" == "$NEW_SA" ]]; then echo "→ $INSTANCE already runs as $NEW_SA"; repoint_alert "$NEW_SA"; return 0; fi
  fi
  move_vm_to "$NEW_SA"
  echo "→ re-pointing the human-decrypt alert at $NEW_SA"
  repoint_alert "$NEW_SA"
  echo "✓ switched. Next: scripts/deploy/vm-identity.sh verify (after the app has had a few minutes to decrypt something)"
}

# ── verify ────────────────────────────────────────────────────────────
cmd_verify() {
  local cur n
  cur="$(vm_sa)"
  echo "== VM runs as: $cur"
  [[ "$cur" == "$NEW_SA" ]] || { echo "  not switched yet"; exit 1; }
  n="$(gcloud_ logging read \
    "protoPayload.serviceName=\"cloudkms.googleapis.com\" AND protoPayload.methodName:\"Decrypt\" AND protoPayload.resourceName:\"cryptoKeys/$CONTENT_KEY\" AND protoPayload.authenticationInfo.principalEmail=\"$NEW_SA\"" \
    --freshness=2h --limit=5 --format='value(timestamp)' | wc -l)"
  echo "== content-key decrypts by $NEW_SA in the last 2h: $n"
  if [[ "$n" -eq 0 ]]; then
    echo "  none yet - the app decrypts on first read of sealed content (mail sweep every few minutes). Open a mail thread and re-run." >&2
    exit 1
  fi
  echo "== health: $(curl -s -m 10 -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/v1/health")"
  echo "✓ the app is decrypting as $NEW_SA. revoke-old can follow once it has run for a while."
}

# ── revoke-old ────────────────────────────────────────────────────────
cmd_revoke_old() {
  need_yes
  local def
  def="$(default_sa)"
  if [[ $DRY_RUN -eq 0 && "$(vm_sa)" != "$NEW_SA" ]]; then
    echo "Refusing: $INSTANCE does not run as $NEW_SA yet - revoking now would stop the app decrypting." >&2
    exit 2
  fi
  if [[ $DRY_RUN -eq 0 ]]; then
    local others
    others="$(gcloud_ compute instances list --format='value(name,serviceAccounts[0].email)' | awk -v sa="$def" '$2==sa {print $1}')"
    [[ -z "$others" ]] || { echo "Refusing: these VMs still run as $def: $others" >&2; exit 2; }
  fi
  echo "→ removing $def from $CONTENT_KEY"
  run gcloud_ kms keys remove-iam-policy-binding "$CONTENT_KEY" --keyring="$CONTENT_KEYRING" --location="$REGION" \
    --member="serviceAccount:$def" --role=roles/cloudkms.cryptoKeyEncrypterDecrypter --format=none
  echo "→ removing roles/editor from $def (nothing runs as it any more)"
  run gcloud_ projects remove-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$def" --role=roles/editor --condition=None --format=none
  echo "✓ the default account can no longer decrypt or edit the project."
}

# ── rollback ──────────────────────────────────────────────────────────
cmd_rollback() {
  need_yes
  local def
  def="$(default_sa)"
  echo "→ re-granting $def (in case revoke-old ran)"
  run gcloud_ projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$def" --role=roles/editor --condition=None --format=none
  run gcloud_ kms keys add-iam-policy-binding "$CONTENT_KEY" --keyring="$CONTENT_KEYRING" --location="$REGION" \
    --member="serviceAccount:$def" --role=roles/cloudkms.cryptoKeyEncrypterDecrypter --format=none
  if [[ $DRY_RUN -eq 1 || "$(vm_sa)" != "$def" ]]; then move_vm_to "$def"; fi
  repoint_alert "$def"
  echo "✓ back on $def. $NEW_SA and its grants are left in place (harmless unused)."
}

case "$CMD" in
  status) cmd_status ;;
  create) cmd_create ;;
  switch) cmd_switch ;;
  verify) cmd_verify ;;
  revoke-old) cmd_revoke_old ;;
  rollback) cmd_rollback ;;
  *) echo "Unknown command: $CMD" >&2; sed -n '2,22p' "$0"; exit 2 ;;
esac
