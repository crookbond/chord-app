#!/usr/bin/env bash
# Who is allowed to use the content key (Phase 8d). Run from the repo root, in WSL.
#
#   scripts/deploy/custody.sh status                    # who can do what, read-only
#   scripts/deploy/custody.sh retire-default-sa [--yes] # drop the old default compute account's Editor + key grant
#   scripts/deploy/custody.sh deny-owner-decrypt [--yes]# nobody but the app's account may decrypt with the content key
#   scripts/deploy/custody.sh undeny-owner-decrypt [--yes]  # remove that deny policy (break glass)
#   scripts/deploy/custody.sh test-decrypt              # try to decrypt as YOU; expect PERMISSION_DENIED after deny (fires the alert email)
#
# Every command accepts --dry-run. Changing commands need --yes.
#
# NOTE: deny-owner-decrypt needs a Google Cloud ORGANIZATION. On a project with no parent (as
# this one is today) it refuses with an explanation; see docs/tasks/phase-8-key-custody.md.
#
# Why a deny policy: the basic Owner role carries cloudkms.cryptoKeyVersions.useToDecrypt, and a
# basic role cannot be edited. An IAM deny policy is evaluated BEFORE allow policies, so it
# overrides Owner. It is scoped to the one key, and excepts the app's service account.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/deploy.env"
DRY_RUN=0; YES=0
CMD="${1:-}"; [[ $# -gt 0 ]] && shift
for a in "$@"; do case "$a" in --dry-run) DRY_RUN=1 ;; --yes) YES=1 ;; *) echo "Unknown arg: $a" >&2; exit 2 ;; esac; done
[[ -z "$CMD" || "$CMD" == "-h" || "$CMD" == "--help" ]] && { sed -n '2,15p' "$0"; exit 0; }
[[ -f "$ENV_FILE" ]] || { echo "Missing $ENV_FILE" >&2; exit 1; }
# shellcheck disable=SC1090
source "$ENV_FILE"
: "${PROJECT_ID:?}"; : "${ZONE:?}"; : "${INSTANCE:?}"

REGION="${ZONE%-*}"
KEYRING="${CONTENT_KEYRING:-chord-content}"
KEY="${CONTENT_KEY_NAME:-content-kek}"
DENY_NAME="${DENY_POLICY_NAME:-chord-content-key-app-only}"
gcloud_() { gcloud --project="$PROJECT_ID" "$@"; }
run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    if [[ "$1" == "gcloud_" ]]; then shift; set -- gcloud "--project=$PROJECT_ID" "$@"; fi
    printf '[dry-run]'; printf ' %q' "$@"; printf '\n'
  else "$@"; fi
}
need_yes() { if [[ $DRY_RUN -eq 0 && $YES -eq 0 ]]; then echo "Refusing: '$CMD' changes IAM. Use --dry-run to read it, --yes to do it." >&2; exit 2; fi; }

VM_SA="$(gcloud_ compute instances describe "$INSTANCE" --zone="$ZONE" --format='value(serviceAccounts[0].email)')"
PROJECT_NUMBER="$(gcloud_ projects describe "$PROJECT_ID" --format='value(projectNumber)')"
DEFAULT_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
KEY_PATH="projects/$PROJECT_ID/locations/$REGION/keyRings/$KEYRING/cryptoKeys/$KEY"

roles_of() { gcloud_ projects get-iam-policy "$PROJECT_ID" --flatten=bindings --filter="bindings.members:$1" --format='value(bindings.role)'; }
key_members() { gcloud_ kms keys get-iam-policy "$KEY" --keyring="$KEYRING" --location="$REGION" --format=json | python3 -c '
import json,sys
d=json.load(sys.stdin)
for b in d.get("bindings",[]): print("  ", b["role"], "->", ", ".join(b["members"]))'; }

cmd_status() {
  echo "VM runs as:          $VM_SA"
  echo "  project roles:     $(roles_of "serviceAccount:$VM_SA" | tr '\n' ' ')"
  echo "Default compute SA:  $DEFAULT_SA"
  echo "  project roles:     $(roles_of "serviceAccount:$DEFAULT_SA" | tr '\n' ' ')"
  echo "Grants on the content key ($KEY):"; key_members
  echo "Deny policies on the project:"
  gcloud_ iam policies list --kind=denypolicies --attachment-point="cloudresourcemanager.googleapis.com/projects/$PROJECT_ID" --format='table(name.basename(),displayName)' 2>&1 | head -6
}

cmd_retire_default_sa() {
  need_yes
  [[ "$VM_SA" != "$DEFAULT_SA" ]] || { echo "Refusing: the VM still runs as the default account; switch it first." >&2; exit 1; }
  echo "$VM_SA" | grep -q . || { echo "Cannot read the VM's service account." >&2; exit 1; }
  echo "Guard: the VM's own account must hold the key grant before the old one loses it."
  key_members | grep -q "$VM_SA" || { echo "Refusing: $VM_SA has no grant on the content key." >&2; exit 1; }
  local other; other="$(gcloud_ compute instances list --format='value(name,serviceAccounts[0].email)' | grep "$DEFAULT_SA" || true)"
  [[ -z "$other" ]] || { echo "Refusing: these instances still run as the default account: $other" >&2; exit 1; }
  run gcloud_ kms keys remove-iam-policy-binding "$KEY" --keyring="$KEYRING" --location="$REGION" \
    --member="serviceAccount:$DEFAULT_SA" --role=roles/cloudkms.cryptoKeyEncrypterDecrypter
  run gcloud_ projects remove-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:$DEFAULT_SA" --role=roles/editor
  echo "Done. The default account still exists (it can be re-granted); it now holds nothing. Check the app: scripts/deploy/logs.sh errors"
}

deny_json() {
  cat <<EOF
{
  "displayName": "Only the app's service account may decrypt with the Chord content key",
  "rules": [{
    "denyRule": {
      "deniedPrincipals": ["principalSet://goog/public:all"],
      "exceptionPrincipals": ["principal://iam.googleapis.com/projects/-/serviceAccounts/$VM_SA"],
      "deniedPermissions": ["cloudkms.googleapis.com/cryptoKeyVersions.useToDecrypt"],
      "denialCondition": {
        "title": "content key only",
        "expression": "resource.name.startsWith('$KEY_PATH/')"
      }
    }
  }]
}
EOF
}

cmd_deny() {
  need_yes
  # Deny policies are administered with roles/iam.denyAdmin, which cannot be granted on a project,
  # and iam.denypolicies.* cannot go in a custom role: it takes an organization. A project owned by
  # a personal account has none, so say so instead of failing with a permissions error.
  if [[ -z "$(gcloud_ projects describe "$PROJECT_ID" --format='value(parent.id)')" ]]; then
    echo "Cannot: $PROJECT_ID has no organization, and IAM deny policies need one (nobody can be granted" >&2
    echo "the permission to create them on a bare project). Options: create a Cloud Identity organization" >&2
    echo "on your domain and move the project into it, or rely on the human-decrypt alert (audit.sh alert)." >&2
    exit 1
  fi
  local f; f="$(mktemp --suffix=.json)"
  deny_json > "$f"
  if [[ $DRY_RUN -eq 1 ]]; then echo "[dry-run] policy file:"; cat "$f"; fi
  if gcloud_ iam policies describe "$DENY_NAME" --kind=denypolicies --attachment-point="cloudresourcemanager.googleapis.com/projects/$PROJECT_ID" >/dev/null 2>&1; then
    echo "deny policy $DENY_NAME already exists; leaving it"
  else
    run gcloud_ iam policies create "$DENY_NAME" --kind=denypolicies \
      --attachment-point="cloudresourcemanager.googleapis.com/projects/$PROJECT_ID" --policy-file="$f"
  fi
  rm -f "$f"
  echo "Now run: scripts/deploy/custody.sh test-decrypt   (expects PERMISSION_DENIED), then confirm the app still decrypts."
}

cmd_undeny() {
  need_yes
  run gcloud_ iam policies delete "$DENY_NAME" --kind=denypolicies \
    --attachment-point="cloudresourcemanager.googleapis.com/projects/$PROJECT_ID" --quiet
}

cmd_test() {
  local ct out; ct="$(mktemp)"; head -c 32 /dev/urandom > "$ct"
  echo "Trying to decrypt with the content key as $(gcloud config get-value account 2>/dev/null) (this fires the human-decrypt alert email):"
  out="$(gcloud_ kms decrypt --location="$REGION" --keyring="$KEYRING" --key="$KEY" --ciphertext-file="$ct" --plaintext-file=/dev/null 2>&1 || true)"
  rm -f "$ct"
  echo "$out" | tail -2 | cut -c1-220
  if echo "$out" | grep -q -i "PERMISSION_DENIED"; then echo "RESULT: denied (good)"; elif echo "$out" | grep -q -i "ciphertext is invalid"; then echo "RESULT: ALLOWED to attempt decrypt (the permission check passed; only the junk ciphertext failed)"; else echo "RESULT: unclear, read the message above"; fi
}

case "$CMD" in
  status) cmd_status ;;
  retire-default-sa) cmd_retire_default_sa ;;
  deny-owner-decrypt) cmd_deny ;;
  undeny-owner-decrypt) cmd_undeny ;;
  test-decrypt) cmd_test ;;
  *) echo "Unknown command: $CMD" >&2; exit 2 ;;
esac
