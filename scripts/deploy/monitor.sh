#!/usr/bin/env bash
# Tell someone when the service is down, or about to be.
# Run from the repo root, in WSL (gcloud lives there). Shares scripts/deploy/deploy.env.
#
#   scripts/deploy/monitor.sh status          # what exists, and how the check is doing (read-only)
#   scripts/deploy/monitor.sh setup [--yes]   # uptime check + the two alerts + the email channel
#   scripts/deploy/monitor.sh remove [--yes]  # delete all of the above
#
# Every command accepts --dry-run (print, do not change); setup and remove also need --yes.
#
# What it sets up, in Google Cloud Monitoring:
#   - an uptime check: GET https://$DOMAIN/api/v1/health every minute from several
#     regions; passes on a 2xx whose body contains "ok":true
#   - "chord-ops: service is down": the check failing from more than one region for
#     two minutes. A second email is sent when it recovers.
#   - "chord-ops: disk is filling up": the VM's root disk above DISK_ALERT_PERCENT
#     (default 80) for five minutes. The 2026-10-03 outage was a full disk.
#   - one email channel, "chord-ops email", to ALERT_EMAIL (falls back to CERTBOT_EMAIL).
#
# The check is made from outside, through Cloudflare, exactly as a phone reaches
# the service, so it also catches nginx, TLS and DNS failures. It does not know
# about a fault that leaves /health answering (a stuck worker, a dead queue).

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
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done
[[ -z "$CMD" || "$CMD" == "-h" || "$CMD" == "--help" ]] && { sed -n '2,22p' "$0"; exit 0; }

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE - copy deploy.env.example to deploy.env and fill it in." >&2
  exit 1
fi
# An ALERT_EMAIL given on the command line wins over the one in deploy.env.
ALERT_EMAIL_ARG="${ALERT_EMAIL:-}"
# shellcheck disable=SC1090
source "$ENV_FILE"
: "${PROJECT_ID:?set in deploy.env}"
: "${DOMAIN:?}"
: "${INSTANCE:?}"

ALERT_EMAIL="${ALERT_EMAIL_ARG:-${ALERT_EMAIL:-${CERTBOT_EMAIL:-}}}"
DISK_ALERT_PERCENT="${DISK_ALERT_PERCENT:-80}"
BASE="https://monitoring.googleapis.com/v3/projects/$PROJECT_ID"

CHECK_NAME="chord-ops: health"
CHANNEL_NAME="chord-ops email"
DOWN_POLICY="chord-ops: service is down"
DISK_POLICY="chord-ops: disk is filling up"

need_yes() {
  if [[ $DRY_RUN -eq 0 && $YES -eq 0 ]]; then
    echo "Refusing: '$CMD' changes the project. Re-run with --dry-run to read it, or --yes to do it." >&2
    exit 2
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
# find KIND-PATH LIST-KEY DISPLAY-NAME -> the resource name, or nothing
find_by_name() {
  api GET "$BASE/$1?pageSize=200" | python3 -c '
import json,sys
key,name=sys.argv[1:3]
d=json.load(sys.stdin)
if "error" in d: sys.exit("API error: "+d["error"].get("message",""))
for x in d.get(key,[]):
    if x.get("displayName")==name: print(x["name"]); break' "$2" "$3"
}
created() { python3 -c 'import json,sys
d=json.load(sys.stdin)
if "error" in d: sys.exit("API error: "+d["error"].get("message",""))
print(d["name"])'; }

cmd_status() {
  local check chan
  check="$(find_by_name uptimeCheckConfigs uptimeCheckConfigs "$CHECK_NAME")"
  chan="$(find_by_name notificationChannels notificationChannels "$CHANNEL_NAME")"
  echo "uptime check : ${check:-none}"
  echo "email channel: ${chan:-none}"
  if [[ -n "$chan" ]]; then
    api GET "https://monitoring.googleapis.com/v3/$chan" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print("  sends to   :", d.get("labels",{}).get("email_address"), "| enabled:", d.get("enabled",True))'
  fi
  for p in "$DOWN_POLICY" "$DISK_POLICY"; do
    echo "alert        : $p -> $( [[ -n "$(find_by_name alertPolicies alertPolicies "$p")" ]] && echo present || echo none )"
  done
  if [[ -n "$check" ]]; then
    local id="${check##*/}" now start
    now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; start="$(date -u -d '-10 minutes' +%Y-%m-%dT%H:%M:%SZ)"
    echo "last 10 minutes, by checker region (True = passed):"
    curl -sS -G -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "x-goog-user-project: $PROJECT_ID" \
      --data-urlencode "filter=metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id=\"$id\"" \
      --data-urlencode "interval.startTime=$start" --data-urlencode "interval.endTime=$now" \
      "$BASE/timeSeries" | python3 -c '
import json,sys
d=json.load(sys.stdin)
ts=d.get("timeSeries",[])
if not ts: print("  no results yet (a new check takes a few minutes to report)")
for s in ts:
    pts=[p["value"].get("boolValue") for p in s.get("points",[])]
    print("  %-22s passed %d of %d" % (s["metric"]["labels"].get("checker_location","?"), sum(1 for v in pts if v), len(pts)))'
  fi
}

cmd_setup() {
  need_yes
  : "${ALERT_EMAIL:?set ALERT_EMAIL (or CERTBOT_EMAIL in deploy.env)}"
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[dry-run] email channel '$CHANNEL_NAME' -> $ALERT_EMAIL"
    echo "[dry-run] uptime check '$CHECK_NAME': GET https://$DOMAIN/api/v1/health every 60s, body must contain \"ok\":true"
    echo "[dry-run] alert '$DOWN_POLICY': check failing from more than one region for 2 minutes"
    echo "[dry-run] alert '$DISK_POLICY': root disk of $INSTANCE above ${DISK_ALERT_PERCENT}% for 5 minutes"
    return 0
  fi
  local tmp; tmp="$(mktemp -d)"

  local chan; chan="$(find_by_name notificationChannels notificationChannels "$CHANNEL_NAME")"
  if [[ -z "$chan" ]]; then
    python3 -c 'import json,sys; print(json.dumps({"type":"email","displayName":sys.argv[1],"labels":{"email_address":sys.argv[2]}}))' \
      "$CHANNEL_NAME" "$ALERT_EMAIL" > "$tmp/chan.json"
    chan="$(api POST "$BASE/notificationChannels" "$tmp/chan.json" | created)"
    echo "created email channel -> $ALERT_EMAIL"
  else
    echo "email channel exists"
  fi

  local check; check="$(find_by_name uptimeCheckConfigs uptimeCheckConfigs "$CHECK_NAME")"
  if [[ -z "$check" ]]; then
    python3 - "$CHECK_NAME" "$PROJECT_ID" "$DOMAIN" > "$tmp/check.json" <<'PY'
import json,sys
name,project,domain=sys.argv[1:4]
print(json.dumps({
 "displayName":name,
 "monitoredResource":{"type":"uptime_url","labels":{"project_id":project,"host":domain}},
 "httpCheck":{"path":"/api/v1/health","port":443,"useSsl":True,"validateSsl":True,
   "acceptedResponseStatusCodes":[{"statusClass":"STATUS_CLASS_2XX"}]},
 "contentMatchers":[{"content":'"ok":true',"matcher":"CONTAINS_STRING"}],
 "period":"60s","timeout":"10s"}))
PY
    check="$(api POST "$BASE/uptimeCheckConfigs" "$tmp/check.json" | created)"
    echo "created uptime check"
  else
    echo "uptime check exists"
  fi
  local check_id="${check##*/}"

  policy() { # policy NAME JSON-FILE
    if [[ -n "$(find_by_name alertPolicies alertPolicies "$1")" ]]; then echo "alert exists: $1"; return 0; fi
    api POST "$BASE/alertPolicies" "$2" | created >/dev/null
    echo "created alert: $1"
  }

  python3 - "$DOWN_POLICY" "$check_id" "$chan" "$DOMAIN" > "$tmp/down.json" <<'PY'
import json,sys
name,check_id,chan,domain=sys.argv[1:5]
print(json.dumps({
 "displayName":name,"combiner":"OR","enabled":True,
 "conditions":[{"displayName":"health check failing from more than one region",
   "conditionThreshold":{
     "filter":'metric.type="monitoring.googleapis.com/uptime_check/check_passed" AND metric.label.check_id="%s" AND resource.type="uptime_url"' % check_id,
     "aggregations":[{"alignmentPeriod":"1200s","perSeriesAligner":"ALIGN_NEXT_OLDER",
       "crossSeriesReducer":"REDUCE_COUNT_FALSE","groupByFields":["resource.label.*"]}],
     "comparison":"COMPARISON_GT","thresholdValue":1,"duration":"120s",
     "trigger":{"count":1}}}],
 "notificationChannels":[chan],
 "documentation":{"mimeType":"text/markdown","content":
   "https://%s/api/v1/health is not answering from more than one region.\n\n"
   "From the repo root, in WSL:\n\n"
   "    scripts/deploy/deploy.sh status   # are chord and chord-worker running; does health answer on the VM\n"
   "    scripts/deploy/deploy.sh logs     # what the service last said\n\n"
   "Check the disk first (`df -h /` on the VM): a full disk stops both services starting." % domain}}))
PY
  policy "$DOWN_POLICY" "$tmp/down.json"

  python3 - "$DISK_POLICY" "$chan" "$DISK_ALERT_PERCENT" "$INSTANCE" > "$tmp/disk.json" <<'PY'
import json,sys
name,chan,pct,instance=sys.argv[1:5]
print(json.dumps({
 "displayName":name,"combiner":"OR","enabled":True,
 "conditions":[{"displayName":"root disk above %s%%" % pct,
   "conditionThreshold":{
     "filter":'metric.type="agent.googleapis.com/disk/percent_used" AND resource.type="gce_instance" AND metric.label.state="used" AND metric.label.device!=monitoring.regex.full_match("(loop|tmpfs|udev|devtmpfs).*")',
     "aggregations":[{"alignmentPeriod":"300s","perSeriesAligner":"ALIGN_MEAN"}],
     "comparison":"COMPARISON_GT","thresholdValue":float(pct),"duration":"300s",
     "trigger":{"count":1}}}],
 "notificationChannels":[chan],
 "documentation":{"mimeType":"text/markdown","content":
   "A disk on `%s` is more than %s%% full. A full disk stops both services starting and stops Redis saving.\n\n"
   "On the VM: `sudo du -xsh /var/lib/chord/* /var/log/* | sort -h | tail`. "
   "App logs are capped at 150 MB and the journal at 200 MB (ADR 0226), so look for what else grew." % (instance, pct)}}))
PY
  policy "$DISK_POLICY" "$tmp/disk.json"

  rm -rf "$tmp"
  echo "Done. Google sends no confirmation email for a channel; the first email you get is a real alert."
  echo "A new check takes a few minutes to report: scripts/deploy/monitor.sh status"
}

cmd_remove() {
  need_yes
  local name kind
  for kind in alertPolicies:"$DOWN_POLICY" alertPolicies:"$DISK_POLICY" uptimeCheckConfigs:"$CHECK_NAME" notificationChannels:"$CHANNEL_NAME"; do
    name="$(find_by_name "${kind%%:*}" "${kind%%:*}" "${kind#*:}")"
    [[ -z "$name" ]] && continue
    if [[ $DRY_RUN -eq 1 ]]; then echo "[dry-run] delete $name"; else api DELETE "https://monitoring.googleapis.com/v3/$name" >/dev/null; echo "deleted ${kind#*:}"; fi
  done
}

case "$CMD" in
  status) cmd_status ;;
  setup) cmd_setup ;;
  remove) cmd_remove ;;
  *) echo "Unknown command: $CMD" >&2; sed -n '2,22p' "$0"; exit 2 ;;
esac
