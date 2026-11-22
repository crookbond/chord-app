#!/usr/bin/env bash
# Who touched what: audit trail for the keys, the database and the app VM (ADR 0207).
# Run from the repo root, in WSL (gcloud lives there). Shares scripts/deploy/deploy.env.
#
#   scripts/deploy/audit.sh status              # what is on and what is not (read-only)
#   scripts/deploy/audit.sh data-access [--yes] # Data Access audit logs for Cloud KMS + Cloud SQL
#   scripts/deploy/audit.sh sink [--yes]        # copy audit + VM security logs to a bucket kept 1 year
#   scripts/deploy/audit.sh alert [--yes]       # email on a human decrypt / a key being disabled or destroyed
#   scripts/deploy/audit.sh ops-agent [--yes]   # ship the VM's auth log and audit log off the box
#   scripts/deploy/audit.sh auditd [--yes]      # record who opens .env / the files dir / psql on the VM
#   scripts/deploy/audit.sh oslogin [--yes]     # SSH tied to a Google identity (changes the app's Unix user!)
#
# Every command accepts --dry-run (print, do not change). Everything except
# `status` also needs --yes. Order that works: data-access, sink, alert,
# ops-agent, auditd, then oslogin last, because oslogin briefly stops the app.
#
# What this does NOT do: lock the log bucket (irreversible: retention can then
# never be shortened and the bucket never deleted before it expires), or stop
# root on the VM from stopping auditd. Off-box shipping means that attempt is
# itself logged, not that it is prevented.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/deploy.env"

DRY_RUN=0
YES=0
CMD="${1:-}"
[[ $# -gt 0 ]] && shift
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes) YES=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done
[[ -z "$CMD" || "$CMD" == "-h" || "$CMD" == "--help" ]] && { sed -n '2,20p' "$0"; exit 0; }

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE - copy deploy.env.example to deploy.env and fill it in." >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"
: "${PROJECT_ID:?set in deploy.env}"
: "${ZONE:?}"
: "${INSTANCE:?}"

AUDIT_BUCKET="${AUDIT_BUCKET:-chord-audit}"
AUDIT_RETENTION_DAYS="${AUDIT_RETENTION_DAYS:-365}"
ALERT_EMAIL="${ALERT_EMAIL:-${CERTBOT_EMAIL:-}}"
REGION="${ZONE%-*}"
CONTENT_KEY="${CONTENT_KEY_NAME:-content-kek}"
DB_KEY="${CLOUDSQL_KMS_KEY:-chord-db}"

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
rsh() {
  if [[ $DRY_RUN -eq 1 ]]; then echo "[dry-run] ssh $INSTANCE:"; printf '%s\n' "$1" | sed 's/^/    /'; else gcloud_ compute ssh "$INSTANCE" --zone="$ZONE" --command="$1"; fi
}
# Send a script to the VM over stdin and run it as root, so nothing depends on quoting.
rsh_script() {
  if [[ $DRY_RUN -eq 1 ]]; then echo "[dry-run] ssh $INSTANCE (as root):"; sed 's/^/    /'; else gcloud_ compute ssh "$INSTANCE" --zone="$ZONE" --command='sudo bash -s'; fi
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

# ── status ────────────────────────────────────────────────────────────
cmd_status() {
  echo "== Data Access audit config (project IAM)"
  gcloud_ projects get-iam-policy "$PROJECT_ID" --format=json | python3 -c '
import json,sys
d=json.load(sys.stdin)
cfg=d.get("auditConfigs")
if not cfg: print("  NONE - KMS decrypts and Cloud SQL data reads are not logged")
for c in cfg or []:
    print("  ", c["service"], [x["logType"] for x in c["auditLogConfigs"]])'
  echo "== audit bucket + sink"
  gcloud_ logging buckets describe "$AUDIT_BUCKET" --location=global --format='value(name,retentionDays,locked)' 2>&1 | head -2 || true
  gcloud_ logging sinks list --format='value(name,destination)' 2>&1 | grep -E "$AUDIT_BUCKET" || echo "  no $AUDIT_BUCKET sink"
  echo "== alert policies"
  api GET "https://monitoring.googleapis.com/v3/projects/$PROJECT_ID/alertPolicies" | python3 -c '
import json,sys
d=json.load(sys.stdin)
ps=[p["displayName"]+(" (enabled)" if p.get("enabled",True) else " (disabled)") for p in d.get("alertPolicies",[]) if p["displayName"].startswith("chord-audit:")]
print("  "+"\n  ".join(ps) if ps else "  none")'
  echo "== OS Login (instance metadata)"
  gcloud_ compute instances describe "$INSTANCE" --zone="$ZONE" --format=json | python3 -c '
import json,sys
d=json.load(sys.stdin)
m={i["key"]:i["value"] for i in d.get("metadata",{}).get("items",[])}
print("  enable-oslogin =", m.get("enable-oslogin","(unset)"))'
  echo "== on the VM"
  rsh 'for u in google-cloud-ops-agent-fluent-bit auditd; do printf "  %s: " $u; systemctl is-active $u; done; echo "  ssh user: $USER"; sudo auditctl -l 2>&1 | sed "s/^/  rule: /" | head -12'
}

# ── 1. Data Access audit logs ─────────────────────────────────────────
cmd_data_access() {
  need_yes
  local tmp; tmp="$(mktemp)"
  gcloud_ projects get-iam-policy "$PROJECT_ID" --format=json > "$tmp"
  python3 - "$tmp" <<'PY'
import json,sys
p=sys.argv[1]
d=json.load(open(p))
want={"cloudkms.googleapis.com","cloudsql.googleapis.com","secretmanager.googleapis.com"}
types=["ADMIN_READ","DATA_READ","DATA_WRITE"]
cfgs=d.setdefault("auditConfigs",[])
have={c["service"]:c for c in cfgs}
for s in sorted(want):
    c=have.get(s)
    if c is None:
        c={"service":s,"auditLogConfigs":[]}; cfgs.append(c)
    present={x["logType"] for x in c["auditLogConfigs"]}
    for t in types:
        if t not in present: c["auditLogConfigs"].append({"logType":t})
json.dump(d,open(p,"w"),indent=1)
print("merged auditConfigs:", [(c["service"],[x["logType"] for x in c["auditLogConfigs"]]) for c in cfgs])
PY
  run gcloud_ projects set-iam-policy "$PROJECT_ID" "$tmp" --format='value(etag)'
  rm -f "$tmp"
  echo "Data Access logs on for Cloud KMS and Cloud SQL. They land in the _Default bucket (30 days) until 'sink' copies them somewhere longer."
}

# ── 2. Sink to a bucket kept for a year ───────────────────────────────
cmd_sink() {
  need_yes
  if gcloud_ logging buckets describe "$AUDIT_BUCKET" --location=global >/dev/null 2>&1; then
    echo "bucket $AUDIT_BUCKET exists"
  else
    run gcloud_ logging buckets create "$AUDIT_BUCKET" --location=global --retention-days="$AUDIT_RETENTION_DAYS" \
      --description="Chord audit trail: KMS/Cloud SQL data access + VM auth/audit logs (not locked)"
  fi
  local filter='LOG_ID("cloudaudit.googleapis.com/data_access") OR LOG_ID("auth") OR LOG_ID("audit") OR LOG_ID("clamav")'
  if gcloud_ logging sinks describe "$AUDIT_BUCKET" >/dev/null 2>&1; then
    run gcloud_ logging sinks update "$AUDIT_BUCKET" "logging.googleapis.com/projects/$PROJECT_ID/locations/global/buckets/$AUDIT_BUCKET" --log-filter="$filter"
  else
    run gcloud_ logging sinks create "$AUDIT_BUCKET" "logging.googleapis.com/projects/$PROJECT_ID/locations/global/buckets/$AUDIT_BUCKET" --log-filter="$filter"
  fi
  echo "Bucket is NOT locked. Lock it once you are happy: gcloud logging buckets update $AUDIT_BUCKET --location=global --locked (irreversible)."
}

# ── 3. Alerts ─────────────────────────────────────────────────────────
cmd_alert() {
  need_yes
  : "${ALERT_EMAIL:?set ALERT_EMAIL (or CERTBOT_EMAIL in deploy.env)}"
  local sa; sa="$(vm_sa)"
  local base="https://monitoring.googleapis.com/v3/projects/$PROJECT_ID"
  local tmp; tmp="$(mktemp -d)"
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[dry-run] create email notification channel for $ALERT_EMAIL (if none), then policies:"
    echo "  chord-audit: human decrypt of the content key  (decrypt on $CONTENT_KEY by anyone but $sa)"
    echo "  chord-audit: key disabled, destroyed or IAM changed  (content + $DB_KEY keys)"
    echo "  chord-audit: a secret read by anyone but $sa  (Secret Manager, ADR 0211)"
    echo "  chord-audit: malware found on the VM  (a FOUND line in the nightly ClamAV scan log)"
    return 0
  fi
  local chan
  chan="$(api GET "$base/notificationChannels" | python3 -c '
import json,sys
for c in json.load(sys.stdin).get("notificationChannels",[]):
    if c["displayName"]=="chord-audit email": print(c["name"]); break')"
  if [[ -z "$chan" ]]; then
    printf '{"type":"email","displayName":"chord-audit email","labels":{"email_address":"%s"}}' "$ALERT_EMAIL" > "$tmp/chan.json"
    chan="$(api POST "$base/notificationChannels" "$tmp/chan.json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')"
  fi
  echo "notification channel: $chan"
  policy() { # policy NAME FILTER DOC
    local name="$1" filter="$2" doc="$3"
    api GET "$base/alertPolicies" | python3 -c '
import json,sys
n=sys.argv[1]
for p in json.load(sys.stdin).get("alertPolicies",[]):
    if p["displayName"]==n: print(p["name"]); break' "$name" > "$tmp/existing"
    if [[ -s "$tmp/existing" ]]; then echo "policy exists: $name"; return 0; fi
    python3 - "$name" "$filter" "$doc" "$chan" > "$tmp/policy.json" <<'PY'
import json,sys
name,filt,doc,chan=sys.argv[1:5]
print(json.dumps({
 "displayName":name,"combiner":"OR","enabled":True,
 "conditions":[{"displayName":name,"conditionMatchedLog":{"filter":filt,
   "labelExtractors":{"principal":"EXTRACT(protoPayload.authenticationInfo.principalEmail)","method":"EXTRACT(protoPayload.methodName)"}}}],
 "alertStrategy":{"notificationRateLimit":{"period":"300s"}},
 "notificationChannels":[chan],
 "documentation":{"content":doc,"mimeType":"text/markdown"}}))
PY
    api POST "$base/alertPolicies" "$tmp/policy.json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print("created:", d.get("displayName") or d)'
  }
  policy "chord-audit: human decrypt of the content key" \
    "protoPayload.serviceName=\"cloudkms.googleapis.com\" AND protoPayload.resourceName:\"cryptoKeys/$CONTENT_KEY\" AND protoPayload.methodName:\"Decrypt\" AND NOT protoPayload.authenticationInfo.principalEmail=\"$sa\"" \
    "Someone other than the app's VM service account (\`$sa\`) decrypted with the content key. Only the app should. Find the principal in the log entry (logs: cloudaudit data_access), and decide whether to disable the key version."
  policy "chord-audit: key disabled, destroyed or IAM changed" \
    "logName:\"cloudaudit.googleapis.com%2Factivity\" AND protoPayload.serviceName=\"cloudkms.googleapis.com\" AND (protoPayload.resourceName:\"cryptoKeys/$CONTENT_KEY\" OR protoPayload.resourceName:\"cryptoKeys/$DB_KEY\") AND protoPayload.methodName=~\"DestroyCryptoKeyVersion|UpdateCryptoKeyVersion|SetIamPolicy\"" \
    "A Chord KMS key version was disabled or scheduled for destruction, or its access list changed. Disabling or destroying the content key makes every sealed mail and file unreadable. If unexpected, restore the key version immediately (destroy has a scheduled-destruction window)."
  policy "chord-audit: a secret read by a non-app principal" \
    "protoPayload.serviceName=\"secretmanager.googleapis.com\" AND protoPayload.methodName:\"AccessSecretVersion\" AND NOT protoPayload.authenticationInfo.principalEmail=\"$sa\"" \
    "Someone other than the app's VM service account (\`$sa\`) read a secret's value from Secret Manager. Only the app (and the VM's operator helper, which runs as the same account) should. If it was not you, rotate that secret and check who has secretAccessor."
  policy "chord-audit: malware found on the VM" \
    "logName=\"projects/$PROJECT_ID/logs/clamav\" AND textPayload:\"FOUND\"" \
    "The nightly ClamAV scan (\`chord-clamscan.service\`) reported an infected file; the log line names it and the signature. Check the file on the VM (\`sudo tail /var/log/clamav/scan.log\`), find how it got there, and follow docs/security/patch-policy.md for the fix deadline."
  rm -rf "$tmp"
}

# ── 4. Ops Agent ──────────────────────────────────────────────────────
cmd_ops_agent() {
  need_yes
  rsh_script <<'REMOTE'
set -e
if ! systemctl list-unit-files | grep -q google-cloud-ops-agent; then
  cd /tmp
  curl -sSO https://dl.google.com/cloudagents/add-google-cloud-ops-agent-repo.sh
  bash add-google-cloud-ops-agent-repo.sh --also-install
  rm -f add-google-cloud-ops-agent-repo.sh
fi
# Ships ONLY the login/sudo log, the audit log and the ClamAV scan log, on top of the
# default syslog receiver. The chord services log to the journal, which is deliberately
# not shipped: app logs should not leave the box as a side effect of turning on
# security logging. The scan log holds a summary and, with --infected, only the names
# of infected files; the "clamav" receiver id is the log name the malware alert matches.
cat > /etc/google-cloud-ops-agent/config.yaml <<'YAML'
logging:
  receivers:
    auth:
      type: files
      include_paths: [/var/log/auth.log]
    audit:
      type: files
      include_paths: [/var/log/audit/audit.log]
    clamav:
      type: files
      include_paths: [/var/log/clamav/scan.log]
  service:
    pipelines:
      security:
        receivers: [auth, audit, clamav]
YAML
systemctl restart google-cloud-ops-agent
sleep 3
systemctl is-active google-cloud-ops-agent-fluent-bit google-cloud-ops-agent-opentelemetry-collector
REMOTE
}

# ── 5. auditd ─────────────────────────────────────────────────────────
cmd_auditd() {
  need_yes
  rsh_script <<'REMOTE'
set -e
DEBIAN_FRONTEND=noninteractive apt-get install -y auditd >/dev/null
# auid is the login user's id and survives sudo; services started by systemd have none
# (4294967295), so the app's own reads of these paths are not logged - only a person's.
cat > /etc/audit/rules.d/chord.rules <<'RULES'
-a always,exit -F arch=b64 -S open,openat -F path=/srv/chord/.env -F auid>=1000 -F auid!=4294967295 -k chord_env
-a always,exit -F arch=b64 -S open,openat -F dir=/var/lib/chord/data -F auid>=1000 -F auid!=4294967295 -k chord_files
-w /usr/bin/psql -p x -k chord_db_tools
-w /usr/bin/pg_dump -p x -k chord_db_tools
-w /usr/bin/pg_restore -p x -k chord_db_tools
RULES
augenrules --load >/dev/null
systemctl enable --now auditd >/dev/null 2>&1 || true
systemctl is-active auditd
auditctl -l
REMOTE
}

# ── 6. OS Login ───────────────────────────────────────────────────────
# The app's services run as the SSH user (deploy.sh renders User= from $USER). OS Login
# gives you a different Unix user (e.g. ownertest_gmail_com), so the app's user has to move
# with it, in one step, or the services cannot write their own data directory.
cmd_oslogin() {
  need_yes
  echo "This enables OS Login on $INSTANCE, stops the app, hands /srv/chord and /var/lib/chord to the new SSH user,"
  echo "and leaves the app STOPPED. Run scripts/deploy/deploy.sh deploy straight after: it re-renders the services"
  echo "under the new user and starts them."
  run gcloud_ compute instances add-metadata "$INSTANCE" --zone="$ZONE" --metadata=enable-oslogin=TRUE
  if [[ $DRY_RUN -eq 0 ]]; then sleep 15; fi
  rsh 'echo "ssh user is now: $USER"; [ "$USER" != "john" ] || { echo "still the old user - OS Login not in effect yet, stopping"; exit 1; }
sudo systemctl stop chord chord-worker
sudo chown -R "$USER:$USER" /srv/chord /var/lib/chord
sudo chmod 600 /srv/chord/.env /srv/chord/mobile/.env 2>/dev/null || true
echo "chowned. App is stopped: run deploy.sh deploy now."'
  echo "Rollback: gcloud compute instances remove-metadata $INSTANCE --zone=$ZONE --keys=enable-oslogin ; sudo chown -R john:john /srv/chord /var/lib/chord ; deploy.sh deploy"
}

case "$CMD" in
  status)      cmd_status ;;
  data-access) cmd_data_access ;;
  sink)        cmd_sink ;;
  alert)       cmd_alert ;;
  ops-agent)   cmd_ops_agent ;;
  auditd)      cmd_auditd ;;
  oslogin)     cmd_oslogin ;;
  *) echo "Unknown command: $CMD" >&2; sed -n '2,20p' "$0"; exit 2 ;;
esac
