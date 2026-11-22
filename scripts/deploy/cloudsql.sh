#!/usr/bin/env bash
# Move Chord's Postgres from the app VM to Cloud SQL (ADR 0202). Run from the
# repo root, in WSL (gcloud lives there). Shares scripts/deploy/deploy.env.
#
#   scripts/deploy/cloudsql.sh plan                  # what will be created, and what it costs roughly
#   scripts/deploy/cloudsql.sh provision [--yes]     # KMS key, instance (CMEK, PITR, pgaudit), database, user
#   scripts/deploy/cloudsql.sh preflight             # can the VM reach it? are the app's needs met?
#   scripts/deploy/cloudsql.sh rehearse [--yes]      # restore a live dump into a scratch DB, timed, then drop it (no downtime)
#   scripts/deploy/cloudsql.sh cutover [--yes]       # stop app, dump, restore, verify counts, print the .env line
#   scripts/deploy/cloudsql.sh verify                # row counts old vs new + sealed-content check on the new DB
#   scripts/deploy/cloudsql.sh drill [--yes]         # restore drill: point-in-time clone into a scratch instance, compare, delete
#   scripts/deploy/cloudsql.sh rollback [--yes]      # point the app back at the VM database
#   scripts/deploy/cloudsql.sh shrink-vm [--yes]     # resize the app VM once Postgres has left it
#   scripts/deploy/cloudsql.sh retire-old [--yes] [--snapshots] [--logs]
#                                                    # phase 6: report, then remove the old plaintext
#
# Every command accepts --dry-run: it prints each gcloud/ssh command instead of
# running it. `provision`, `cutover`, `rollback`, `shrink-vm` and `retire-old`
# also refuse to act without --yes, because they create billable resources,
# stop the app, or destroy data. `retire-old` without --yes only reports.
#
# What this script deliberately does NOT do:
#   - edit scripts/deploy/.env.prod. It prints the exact DATABASE_URL line and
#     you change the file yourself (a secrets file is not something to script).
#   - delete anything before `retire-old --yes`. The old VM database and its
#     dumps stay until then, after you have watched the new one for a while.
#   - generate or print a password. It asks Cloud SQL to create the user with a
#     password you supply via CLOUDSQL_APP_PASSWORD in your shell (never a file).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/deploy.env"

DRY_RUN=0
YES=0
SNAPSHOTS=0
LOGS=0
CMD="${1:-}"
[[ $# -gt 0 ]] && shift
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --yes) YES=1 ;;
    --snapshots) SNAPSHOTS=1 ;;
    --logs) LOGS=1 ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done
[[ -z "$CMD" || "$CMD" == "-h" || "$CMD" == "--help" ]] && { sed -n '2,28p' "$0"; exit 0; }

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE - copy deploy.env.example to deploy.env and fill it in." >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

: "${PROJECT_ID:?set in deploy.env}"
: "${ZONE:?}"
: "${INSTANCE:?}"

REGION="${CLOUDSQL_REGION:-${ZONE%-*}}"
SQL_INSTANCE="${CLOUDSQL_INSTANCE:-chord-db}"
SQL_TIER="${CLOUDSQL_TIER:-db-custom-1-3840}"
# The VM runs Postgres 15, so this matches it: moving and upgrading in one step
# would also break rollback (a dump from 16 cannot be restored into 15). Upgrade
# later as its own step, once the move has run well.
SQL_VERSION="${CLOUDSQL_VERSION:-POSTGRES_15}"
SQL_STORAGE_GB="${CLOUDSQL_STORAGE_GB:-20}"
SQL_DB="${CLOUDSQL_DB:-chord}"
# What goes in DATABASE_URL's ?sslmode=. NOT `require`: the app's node-postgres (8.21) treats
# require/prefer/verify-ca as verify-full, which checks the certificate chain against the system
# CAs and the host name. Cloud SQL's server certificate comes from a per-instance CA and is reached
# by IP, so every connection would fail. `no-verify` still encrypts; it just does not check who
# answered, which on a private-IP-only instance inside the project's VPC is the accepted trade.
# Stricter (verify the chain, not the name) needs the server CA on the VM plus
# `uselibpqcompat=true&sslmode=verify-ca&sslrootcert=...`, and breaks when Cloud SQL rotates that CA.
SSLMODE="${CLOUDSQL_SSLMODE:-no-verify}"
SQL_USER="${CLOUDSQL_USER:-chord}"
NETWORK="${CLOUDSQL_NETWORK:-default}"
KMS_KEYRING="${CLOUDSQL_KMS_KEYRING:-chord-keys}"
KMS_KEY="${CLOUDSQL_KMS_KEY:-chord-db}"
# The content key (ADR 0201) already exists and every stored data key is wrapped
# by it, so this script REUSES it and never creates one: a second key here would
# be a different key, and pointing the app at it would make sealed data unreadable.
CONTENT_KEY_PATH="${CLOUDSQL_CONTENT_KEY_PATH:-projects/$PROJECT_ID/locations/$REGION/keyRings/chord-content/cryptoKeys/content-kek}"
APP_DIR=/srv/chord

gcloud_() { gcloud --project="$PROJECT_ID" "$@"; }

# Run (or, under --dry-run, print) a command.
run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    if [[ "$1" == "gcloud_" ]]; then shift; set -- gcloud "--project=$PROJECT_ID" "$@"; fi
    printf '[dry-run]'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}
rsh() {
  if [[ $DRY_RUN -eq 1 ]]; then echo "[dry-run] ssh $INSTANCE: $1"; else gcloud_ compute ssh "$INSTANCE" --zone="$ZONE" --command="$1"; fi
}
# The database password reaches the VM without touching a file of yours or a
# command line: it goes over ssh stdin into a mode-600 temp file that is removed
# afterwards. (`PGPASSWORD="$CLOUDSQL_APP_PASSWORD"` inside an rsh command was
# expanded on the VM, where that variable does not exist, so the restore would
# have run with an empty password after the app had already been stopped.)
PW_FILE=/tmp/.chord-cloudsql-pw
push_password() {
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[dry-run] send CLOUDSQL_APP_PASSWORD to $PW_FILE on the VM over ssh stdin (mode 600), removed afterwards"
    return 0
  fi
  : "${CLOUDSQL_APP_PASSWORD:?export CLOUDSQL_APP_PASSWORD in your shell first (the one you gave the database user)}"
  printf '%s' "$CLOUDSQL_APP_PASSWORD" | gcloud_ compute ssh "$INSTANCE" --zone="$ZONE" --command="umask 077; cat > $PW_FILE"
}
drop_password() { rsh "rm -f $PW_FILE"; }
# Runs on the VM: psql/pg_restore against Cloud SQL with the password from PW_FILE.
PGREMOTE="PGPASSWORD=\"\$(cat $PW_FILE)\" PGSSLMODE=require"

# Log in the way the APP will: with node-postgres, through a DATABASE_URL built from $SSLMODE.
# psql has different SSL semantics (libpq's `require` does not verify), so a psql login proves
# nothing about whether the app can connect. Also prints max_connections. $1 = ip, $2 = database.
NODE_CHECK_JS='const {Pool}=require("pg");const u="postgresql://"+process.env.CU+":"+encodeURIComponent(process.env.PGPW)+"@"+process.env.CH+":5432/"+process.env.CD+"?sslmode="+process.env.CM;const p=new Pool({connectionString:u,max:1});p.query("select current_setting($1) as mc",["max_connections"]).then(r=>{console.log("app client can log in (sslmode="+process.env.CM+"), max_connections="+r.rows[0].mc);return p.end()}).catch(e=>{console.error("app client FAILED: "+e.message);process.exit(1)})'
node_client_check() {
  local b64
  b64="$(printf '%s' "$NODE_CHECK_JS" | base64 -w0)"
  rsh "cd $APP_DIR && CU=$SQL_USER CH=$1 CD=$2 CM=$SSLMODE PGPW=\"\$(cat $PW_FILE)\" node -e \"\$(echo $b64 | base64 -d)\""
}

need_yes() {
  if [[ $DRY_RUN -eq 0 && $YES -ne 1 ]]; then
    echo "Refusing to $1 without --yes (or use --dry-run to see the commands)." >&2
    exit 1
  fi
}

# ── plan ─────────────────────────────────────────────────────────────
cmd_plan() {
  cat <<EOF
Cloud SQL plan (nothing is created by this command)

  project        $PROJECT_ID
  region         $REGION
  instance       $SQL_INSTANCE  ($SQL_VERSION, $SQL_TIER, ${SQL_STORAGE_GB} GB SSD, single zone)
  network        private IP on "$NETWORK" (no public address)
  encryption     CMEK: key ring "$KMS_KEYRING", key "$KMS_KEY" (rotate yearly, never destroy)
  backups        daily 03:00 UTC, 14 kept, point-in-time recovery on (7 days of logs)
  auditing       pgaudit on (ddl, role), Cloud Audit Logs on
  connections    direct, SSL required; the app uses DATABASE_URL, no pooler
  human access   IAM database authentication enabled; no shared admin password

Content key (ADR 0201): already exists and is REUSED, not created here:
  $CONTENT_KEY_PATH
The database key above is separate on purpose: disabling or destroying one can never brick
or erase the other, and the Cloud SQL service agent gets nothing on the content key.

Rough monthly cost, from Google's published rates at the time of writing (verify in the
pricing calculator): instance about \$50 + storage/backups a few dollars; roughly double
the instance line if you later enable a high-availability standby.

Next: scripts/deploy/cloudsql.sh provision --dry-run
EOF
}

# ── provision ────────────────────────────────────────────────────────
cmd_provision() {
  need_yes "provision Cloud SQL"
  echo "== APIs"
  run gcloud_ services enable sqladmin.googleapis.com cloudkms.googleapis.com servicenetworking.googleapis.com compute.googleapis.com

  echo "== Private services access (VPC peering for Cloud SQL private IP)"
  run gcloud_ compute addresses create google-managed-services-"$NETWORK" \
    --global --purpose=VPC_PEERING --prefix-length=16 --network="$NETWORK" || true
  run gcloud_ services vpc-peerings connect --service=servicenetworking.googleapis.com \
    --ranges=google-managed-services-"$NETWORK" --network="$NETWORK" || true

  echo "== Content key (ADR 0201): must already exist; reused, never created here"
  if ! run gcloud_ kms keys describe "$CONTENT_KEY_PATH" --format='value(name,purpose,primary.state)'; then
    echo "The content key was not found at $CONTENT_KEY_PATH." >&2
    echo "Refusing to continue: every sealed data key is wrapped by it. Set CLOUDSQL_CONTENT_KEY_PATH to the key the app uses (GCP_KMS_KEY_NAME in .env.prod)." >&2
    exit 1
  fi

  echo "== KMS: key ring and database key (the content key is not touched)"
  run gcloud_ kms keyrings create "$KMS_KEYRING" --location="$REGION" || true
  run gcloud_ kms keys create "$KMS_KEY" --keyring="$KMS_KEYRING" --location="$REGION" \
    --purpose=encryption --rotation-period=365d --next-rotation-time="$(date -u -d '+365 days' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo 2027-09-23T00:00:00Z)" || true

  echo "== CMEK: let Cloud SQL's service agent use the database key"
  run gcloud_ beta services identity create --service=sqladmin.googleapis.com
  local project_number
  if [[ $DRY_RUN -eq 1 ]]; then project_number='<project-number>'; else project_number="$(gcloud_ projects describe "$PROJECT_ID" --format='value(projectNumber)')"; fi
  run gcloud_ kms keys add-iam-policy-binding "$KMS_KEY" --keyring="$KMS_KEYRING" --location="$REGION" \
    --member="serviceAccount:service-${project_number}@gcp-sa-cloud-sql.iam.gserviceaccount.com" \
    --role=roles/cloudkms.cryptoKeyEncrypterDecrypter

  echo "== The instance"
  run gcloud_ beta sql instances create "$SQL_INSTANCE" \
    --database-version="$SQL_VERSION" --edition=ENTERPRISE --tier="$SQL_TIER" --region="$REGION" \
    --storage-type=SSD --storage-size="${SQL_STORAGE_GB}GB" --storage-auto-increase \
    --network="projects/$PROJECT_ID/global/networks/$NETWORK" --no-assign-ip \
    --ssl-mode=ENCRYPTED_ONLY \
    --disk-encryption-key="projects/$PROJECT_ID/locations/$REGION/keyRings/$KMS_KEYRING/cryptoKeys/$KMS_KEY" \
    --backup-start-time=03:00 --enable-point-in-time-recovery --retained-backups-count=14 --retained-transaction-log-days=7 \
    --maintenance-window-day=SUN --maintenance-window-hour=8 \
    '--database-flags=^:^cloudsql.enable_pgaudit=on:pgaudit.log=ddl,role:cloudsql.iam_authentication=on' \
    --deletion-protection

  echo "== Database and application user"
  run gcloud_ sql databases create "$SQL_DB" --instance="$SQL_INSTANCE"
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[dry-run] gcloud sql users create $SQL_USER --instance=$SQL_INSTANCE --password=\$CLOUDSQL_APP_PASSWORD"
  else
    : "${CLOUDSQL_APP_PASSWORD:?export CLOUDSQL_APP_PASSWORD in your shell first (a fresh random one; do not reuse chord-local)}"
    gcloud_ sql users create "$SQL_USER" --instance="$SQL_INSTANCE" --password="$CLOUDSQL_APP_PASSWORD"
  fi

  echo "== Content key: nothing to do here"
  cat <<EOF
The content key is already in use and is left exactly as it is:
  $CONTENT_KEY_PATH
The VM's service account already has encrypt/decrypt on it, and .env.prod already carries
CONTENT_KEY_PROVIDER=gcp-kms and GCP_KMS_KEY_NAME=<that path>. Do NOT change either when you
point DATABASE_URL at Cloud SQL. The Cloud SQL service agent was granted the DATABASE key only.
Also turn on Data Access audit logs for Cloud KMS and Cloud SQL (IAM -> Audit Logs).
EOF
  echo "Done. Next: scripts/deploy/cloudsql.sh preflight"
}

# ── preflight ────────────────────────────────────────────────────────
cmd_preflight() {
  echo "== Instance"
  run gcloud_ sql instances describe "$SQL_INSTANCE" --format='value(state,ipAddresses[0].ipAddress,settings.tier,settings.backupConfiguration.pointInTimeRecoveryEnabled)'
  local ip
  if [[ $DRY_RUN -eq 1 ]]; then ip='<private-ip>'; else ip="$(gcloud_ sql instances describe "$SQL_INSTANCE" --format='value(ipAddresses[0].ipAddress)')"; fi
  echo "== The VM can reach it on 5432"
  rsh "timeout 5 bash -c '</dev/tcp/$ip/5432' && echo reachable || (echo NOT reachable; exit 1)"
  echo "== Connections the app will open (per process: DB_POOL_MAX + CONTENT_KEY_POOL_MAX)"
  run gcloud_ sql instances describe "$SQL_INSTANCE" --format='value(settings.databaseFlags)'
  cat <<EOF
Check by hand: two processes (web, worker) x (DB_POOL_MAX + CONTENT_KEY_POOL_MAX, default 12) = 24 connections,
against Cloud SQL's max_connections for the tier (about 50 at 3.75 GB). Keep DB_POOL_MAX modest.
Direct connections only: the migration lock and the proactive drain lock are session advisory locks and
break under transaction-mode pooling (ADR 0038, 0174).
No Postgres extensions are used by the migrations, so nothing needs enabling.
EOF
}

# ── cutover ──────────────────────────────────────────────────────────
cmd_cutover() {
  need_yes "cut over (stops the app)"
  local ip
  if [[ $DRY_RUN -eq 1 ]]; then ip='<private-ip>'; else ip="$(gcloud_ sql instances describe "$SQL_INSTANCE" --format='value(ipAddresses[0].ipAddress)')"; fi
  cat <<EOF
Before running this for real:
  1. Mail and attachments must already be sealed on the OLD database (docs/ops/content-encryption.md),
     so this moves ciphertext and no plaintext ever lands on the managed instance.
       npm run encrypt:backfill --workspace=server -- --step verify        (must say none remain)
  2. You have a recent backup and know how to repoint DATABASE_URL back (rollback subcommand).
  3. CLOUDSQL_APP_PASSWORD is exported in this shell.
EOF
  echo "== Check the password, the connection and that the target is EMPTY, BEFORE stopping anything"
  push_password
  # If anything fails once the app is stopped, put it back on the VM database (which this
  # command never modifies) instead of leaving the site down.
  APP_STOPPED=0
  cutover_cleanup() {
    local rc=$?
    drop_password || true
    if [[ $APP_STOPPED -eq 1 ]]; then
      echo "Cutover FAILED after the app was stopped: restarting it on the VM database, which is untouched." >&2
      echo "If Cloud SQL was partly restored, empty it before trying again:" >&2
      echo "  gcloud sql databases delete $SQL_DB --instance=$SQL_INSTANCE && gcloud sql databases create $SQL_DB --instance=$SQL_INSTANCE" >&2
      rsh "sudo systemctl start chord chord-worker" || true
    fi
    return $rc
  }
  trap cutover_cleanup EXIT
  rsh "$PGREMOTE psql -h $ip -U $SQL_USER -d $SQL_DB -Atc 'select 1' >/dev/null && echo 'Cloud SQL login works'"
  node_client_check "$ip" "$SQL_DB"
  rsh "n=\$($PGREMOTE psql -h $ip -U $SQL_USER -d $SQL_DB -Atc \"select count(*) from information_schema.tables where table_schema='public'\"); [ \"\$n\" = 0 ] && echo 'target database is empty' || (echo \"target database already has \$n tables: empty it first (see the recovery note in this script)\"; exit 1)"
  echo "== Stop the app (web and worker)"
  rsh "sudo systemctl stop chord chord-worker"
  APP_STOPPED=1
  echo "== Final dump from the VM database (mode 600, owned by the ssh user)"
  rsh "umask 077; sudo -u postgres pg_dump --format=custom --no-owner --no-privileges chord > /tmp/chord-cutover.dump && ls -l /tmp/chord-cutover.dump"
  echo "== Restore into Cloud SQL"
  rsh "$PGREMOTE pg_restore --no-owner --no-privileges --exit-on-error -h $ip -U $SQL_USER -d $SQL_DB /tmp/chord-cutover.dump"
  echo "== Verify row counts, old vs new"
  cmd_verify_inner "$ip"
  # Counts matched: from here the app is meant to stay stopped until DATABASE_URL is switched.
  APP_STOPPED=0
  echo "== Remove the temporary dump, count files and password file from the VM"
  rsh "rm -f /tmp/chord-cutover.dump /tmp/counts.old /tmp/counts.new $PW_FILE"
  trap - EXIT
  cat <<EOF

The data is on Cloud SQL and the app is STOPPED. Now, by hand:
  1. Edit scripts/deploy/.env.prod and set
       DATABASE_URL=postgresql://$SQL_USER:<the password>@$ip:5432/$SQL_DB?sslmode=$SSLMODE
     (NOT sslmode=require: the app's client would try to verify Cloud SQL's certificate and fail.
      The password must be URL-safe: letters and digits, or percent-encoded. Keep DB_POOL_MAX modest; see preflight.)
  2. scripts/deploy/deploy.sh deploy        # pushes .env.prod and restarts web + worker
  3. Watch: scripts/deploy/logs.sh journal, and open the app.
  4. If anything is wrong: scripts/deploy/cloudsql.sh rollback --yes   (the VM database is untouched)
The old VM database and its dumps are NOT removed. Phase 6 is a separate, later, manual step.
EOF
}

cmd_verify_inner() {
  local ip="$1"
  local q="select table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I', table_name), false, true, '')))[1]::text as n from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1"
  rsh "sudo -u postgres psql -At -F' ' chord -c \"$q\" > /tmp/counts.old && $PGREMOTE psql -At -F' ' -h $ip -U $SQL_USER $SQL_DB -c \"$q\" > /tmp/counts.new && diff /tmp/counts.old /tmp/counts.new && echo 'row counts identical' || (echo 'ROW COUNTS DIFFER'; exit 1)"
}

# Compare the two databases. Only meaningful BEFORE the app writes to Cloud SQL
# (cutover runs it for you); afterwards the counts differ by whatever it wrote.
cmd_verify() {
  local ip
  if [[ $DRY_RUN -eq 1 ]]; then ip='<private-ip>'; else ip="$(gcloud_ sql instances describe "$SQL_INSTANCE" --format='value(ipAddresses[0].ipAddress)')"; fi
  push_password
  trap 'drop_password || true' EXIT
  cmd_verify_inner "$ip"
  drop_password
  trap - EXIT
  echo "== No readable content on the database the app is using"
  # The app's own user owns /srv/chord (there is no 'chord' login on the VM), and its env comes from .env.
  # chord-with-env (ADR 0211) supplies settings + Secret Manager secrets once secrets have left .env; before that it
  # does not exist and .env has everything.
  rsh "cd $APP_DIR && if command -v chord-with-env >/dev/null; then chord-with-env npm run encrypt:backfill --workspace=server -- --step verify; else set -a && . ./.env && set +a && NODE_ENV=production DATA_DIR=/var/lib/chord/data LOGS_DIR=/var/lib/chord/logs npm run encrypt:backfill --workspace=server -- --step verify; fi"
}

# Rehearse the move without stopping anything: restore a live dump into a
# scratch database on the instance, time it, then drop it. It proves what a real
# cutover would only reveal after the app was already stopped: that the restore
# user can create and own tables, that a 15 dump loads, and how long it takes.
cmd_rehearse() {
  need_yes "rehearse the restore (creates and drops a scratch database on the instance)"
  local ip scratch="${SQL_DB}_rehearsal"
  if [[ $DRY_RUN -eq 1 ]]; then ip='<private-ip>'; else ip="$(gcloud_ sql instances describe "$SQL_INSTANCE" --format='value(ipAddresses[0].ipAddress)')"; fi
  push_password
  trap 'drop_password || true' EXIT
  echo "== Login check"
  rsh "$PGREMOTE psql -h $ip -U $SQL_USER -d $SQL_DB -Atc 'select version()'"
  echo "== Login the way the app will (node-postgres, sslmode=$SSLMODE)"
  node_client_check "$ip" "$SQL_DB"
  echo "== Scratch database"
  run gcloud_ sql databases create "$scratch" --instance="$SQL_INSTANCE"
  echo "== Dump the live database (the app keeps running; pg_dump reads a consistent snapshot and takes no lock)"
  rsh "umask 077; sudo -u postgres pg_dump --format=custom --no-owner --no-privileges chord > /tmp/chord-rehearsal.dump && ls -l /tmp/chord-rehearsal.dump"
  echo "== Restore into the scratch database (timed)"
  rsh "time $PGREMOTE pg_restore --no-owner --no-privileges --exit-on-error -h $ip -U $SQL_USER -d $scratch /tmp/chord-rehearsal.dump"
  echo "== Table counts, live vs scratch"
  local q="select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'"
  rsh "echo live:    \$(sudo -u postgres psql -Atc \"$q\" chord); echo scratch: \$($PGREMOTE psql -h $ip -U $SQL_USER -d $scratch -Atc \"$q\")"
  echo "== Drop the scratch database and the temporary files"
  run gcloud_ sql databases delete "$scratch" --instance="$SQL_INSTANCE" --quiet
  rsh "rm -f /tmp/chord-rehearsal.dump $PW_FILE"
  trap - EXIT
  echo "Rehearsal done. The restore time above is your downtime floor for the real cutover."
}

# ── drill ────────────────────────────────────────────────────────────
# Restore drill: a point-in-time CLONE of the live instance into a scratch instance, compared
# with production, then deleted. A backup nobody has restored is a hope, not a backup. It needs
# no password from you: the comparison runs on the VM with the credential the app already uses
# (read from /srv/chord/.env there, never printed or copied), and the clone carries the same users.
cmd_drill() {
  need_yes "run the restore drill (creates a billable scratch instance from a point-in-time clone, then deletes it)"
  # drill and created are globals on purpose: the EXIT trap runs after this function has returned.
  drill="${CLOUDSQL_DRILL_INSTANCE:-$SQL_INSTANCE-drill}"; created=0
  local age=15 ts b64 ip
  [[ "$drill" != "$SQL_INSTANCE" ]] || { echo "Refusing: the drill instance must not be the live one." >&2; exit 1; }
  if [[ $DRY_RUN -eq 0 ]] && gcloud_ sql instances describe "$drill" >/dev/null 2>&1; then
    echo "Refusing: $drill already exists (left over from an earlier drill?). Check it, delete it, then re-run." >&2; exit 1
  fi
  # The comparison runs psql on the VM. Phase 6 purged the old Postgres, and its client tools with it, so
  # install just the client if it is missing. Done before the clone so a failure costs nothing.
  rsh "command -v psql >/dev/null || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-client-15 >/dev/null 2>&1; command -v psql"
  ts="$(date -u -d "$age minutes ago" +%Y-%m-%dT%H:%M:%S.000Z)"
  # A clone (and its follow-up backup) can outlast gcloud's own wait limit, and an instance with an
  # operation in flight cannot be deleted, so both waiting and deleting poll instead of trusting one call.
  pending_ops() { gcloud_ sql operations list --instance="$drill" --filter='status!=DONE' --format='value(name)' 2>/dev/null | wc -l; }
  cleanup() {
    [[ $created -eq 1 ]] || return 0
    gcloud_ sql instances describe "$drill" >/dev/null 2>&1 || return 0   # the clone never got created
    echo "== Delete the scratch instance $drill"
    local i
    for i in $(seq 1 45); do
      gcloud_ sql instances patch "$drill" --no-deletion-protection --quiet >/dev/null 2>&1 || true
      gcloud_ sql instances delete "$drill" --quiet >/dev/null 2>&1 || true
      gcloud_ sql instances describe "$drill" >/dev/null 2>&1 || { echo "deleted"; return 0; }
      sleep 60
    done
    echo "!! could not delete $drill: delete it by hand, it is billed by the hour" >&2
  }
  trap cleanup EXIT
  echo "== Clone $SQL_INSTANCE as of $ts into $drill (this is the restore, timed)"
  if [[ $DRY_RUN -eq 1 ]]; then run gcloud_ sql instances clone "$SQL_INSTANCE" "$drill" --point-in-time="$ts"; else
    created=1
    local t0=$SECONDS state
    gcloud_ sql instances clone "$SQL_INSTANCE" "$drill" --point-in-time="$ts" --async
    while :; do
      state="$(gcloud_ sql instances describe "$drill" --format='value(state)' 2>/dev/null || true)"
      [[ "$state" == RUNNABLE && "$(pending_ops)" -eq 0 ]] && break
      [[ $((SECONDS - t0)) -lt 5400 ]] || { echo "clone still not finished after 90 minutes" >&2; exit 1; }
      sleep 30
    done
    echo "clone finished in $((SECONDS - t0)) s"
  fi
  if [[ $DRY_RUN -eq 1 ]]; then ip='<clone-private-ip>'; else
    ip="$(gcloud_ sql instances describe "$drill" --format='value(ipAddresses[0].ipAddress)')"
    gcloud_ sql instances describe "$drill" --format='value(state,settings.backupConfiguration.pointInTimeRecoveryEnabled,diskEncryptionConfiguration.kmsKeyName.basename())' | sed 's/^/clone state, PITR, disk key: /'
  fi
  b64="$(base64 -w0 "$SCRIPT_DIR/templates/drill-compare.sh")"
  echo "== Compare with production (from the VM)"
  rsh "if command -v chord-with-env >/dev/null; then echo $b64 | base64 -d | chord-with-env env DRILL_IP=$ip DRILL_AGE=$age bash; else echo $b64 | base64 -d | DRILL_IP=$ip DRILL_AGE=$age bash; fi"
}

# ── rollback ─────────────────────────────────────────────────────────
cmd_rollback() {
  need_yes "roll back to the VM database"
  cat <<EOF
Rollback is a configuration change, because the VM database was never touched:
  1. Set DATABASE_URL in scripts/deploy/.env.prod back to postgresql://chord@127.0.0.1:5432/chord
  2. scripts/deploy/deploy.sh deploy
Anything written to Cloud SQL after cutover is NOT on the VM database. If the app took writes on
Cloud SQL, dump them first:  pg_dump ... | psql chord  (data since cutover only; decide case by case).
EOF
  rsh "sudo systemctl status chord chord-worker --no-pager | head -20"
}

# ── shrink the VM ────────────────────────────────────────────────────
cmd_shrink_vm() {
  need_yes "resize the app VM (it will be stopped briefly)"
  local target="${SHRINK_MACHINE_TYPE:-e2-micro}"
  cat <<EOF
Only after Postgres has left this VM and you have watched the new database for a while. e2-micro has
1 GB of memory: check the app's memory under load (the LLM/PDF work is the heavy part) before choosing it.
Set SHRINK_MACHINE_TYPE=e2-small to be safer. A disk cannot be shrunk in place; leave it, or snapshot
and recreate later.
EOF
  run gcloud_ compute instances stop "$INSTANCE" --zone="$ZONE"
  run gcloud_ compute instances set-machine-type "$INSTANCE" --zone="$ZONE" --machine-type="$target"
  run gcloud_ compute instances start "$INSTANCE" --zone="$ZONE"
}

# ── phase 6: remove the old plaintext ────────────────────────────────
# Everything before this ran without deleting anything. This is the only
# command that does, and only with --yes AND CONFIRM_RETIRE=<the Cloud SQL
# instance name> in the environment, so a stray --yes cannot wipe the fallback.
cmd_retire_old() {
  local ok=1
  echo "== Preconditions: is the new database really the one in use?"
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "[dry-run] would check: .env DATABASE_URL is not loopback; $SQL_INSTANCE RUNNABLE; a SUCCESSFUL backup exists; chord + chord-worker active"
  else
    local chk out
    chk="$(base64 -w0 "$SCRIPT_DIR/templates/retire-check.sh")"
    if out="$(rsh "echo $chk | base64 -d | bash" 2>&1)"; then
      echo "  ok   $out"
    else
      echo "  FAIL $out; finish the cutover first"; ok=0
    fi
    if [[ "$(gcloud_ sql instances describe "$SQL_INSTANCE" --format='value(state)')" == "RUNNABLE" ]]; then
      echo "  ok   $SQL_INSTANCE is RUNNABLE"
    else
      echo "  FAIL $SQL_INSTANCE is not RUNNABLE"; ok=0
    fi
    if [[ -n "$(gcloud_ sql backups list --instance="$SQL_INSTANCE" --filter='status=SUCCESSFUL' --limit=1 --format='value(id)')" ]]; then
      echo "  ok   a successful Cloud SQL backup exists"
    else
      echo "  FAIL no successful Cloud SQL backup yet; take one before deleting the only other copy"; ok=0
    fi
    if rsh "systemctl is-active --quiet chord && systemctl is-active --quiet chord-worker"; then
      echo "  ok   web and worker are running"
    else
      echo "  FAIL web or worker is not running"; ok=0
    fi
  fi

  echo
  echo "== Inventory: what still holds mail or file text as it was BEFORE sealing"
  rsh "echo 'daily dumps and smoke dump:'; sudo ls -l /var/backups/chord 2>/dev/null || echo '  (none)'; echo 'cron:'; ls -l /etc/cron.d/chord-pgdump 2>/dev/null || echo '  (none)'; echo 'leftover dumps in /tmp:'; ls -l /tmp/*.dump 2>/dev/null || echo '  (none)'; echo 'Postgres data (includes WAL):'; sudo du -sh /var/lib/postgresql 2>/dev/null || echo '  (none)'"
  echo "-- app logs (the pre-fix prompt log and older logs can hold email and file text) and shell history:"
  rsh "sudo ls -l /var/lib/chord/logs 2>/dev/null | grep -E 'prompts' || echo '  no prompts.log'; printf '  other logs older than a day: %s files, %s\n' \"\$(sudo find /var/lib/chord/logs -type f -name '*.log*' -mtime +0 ! -name 'prompts.log*' | wc -l)\" \"\$(sudo find /var/lib/chord/logs -type f -name '*.log*' -mtime +0 ! -name 'prompts.log*' -printf '%s\\n' | awk '{s+=\$1} END{printf \"%.0f MB\", s/1048576}')\"; ls -l \$HOME/.psql_history 2>/dev/null || echo '  no ~/.psql_history'"
  echo "-- disk snapshots of $INSTANCE:"
  run gcloud_ compute snapshots list --filter="sourceDisk~$INSTANCE" --format='table(name,creationTimestamp,storageBytes)'
  echo "-- machine images:"
  run gcloud_ compute machine-images list --format='table(name,creationTimestamp)'
  cat <<EOF

Outside this script's reach, and worth doing by hand:
  - copies on your own machines: 'deploy.sh pull-data' copies the VM's data/ down, and any
    pg_dump you took to a laptop or a drive. Files sealed since phase 2 are ciphertext; older copies are not.
  - any Cloud Storage bucket or other host you copied a dump to.
EOF

  if [[ $DRY_RUN -eq 0 && $YES -ne 1 ]]; then
    cat <<EOF

Report only. To remove the old database, its dumps and its cron entry:
  CONFIRM_RETIRE=$SQL_INSTANCE scripts/deploy/cloudsql.sh retire-old --yes
add --snapshots to also delete the disk snapshots listed above, and --logs to also delete the
prompt log, app logs older than a day and ~/.psql_history.
EOF
    return 0
  fi
  if [[ $DRY_RUN -eq 0 ]]; then
    if [[ $ok -ne 1 ]]; then echo "Refusing: a precondition failed (see above)." >&2; exit 1; fi
    if [[ "${CONFIRM_RETIRE:-}" != "$SQL_INSTANCE" ]]; then
      echo "Refusing: set CONFIRM_RETIRE=$SQL_INSTANCE to confirm you mean to delete the VM's database and dumps." >&2
      exit 1
    fi
  fi

  echo
  echo "== Removing"
  rsh "sudo rm -f /etc/cron.d/chord-pgdump"
  rsh "sudo find /var/backups/chord -type f -delete 2>/dev/null; sudo rm -f /tmp/chord-*.dump /tmp/counts.old /tmp/counts.new"
  rsh "sudo systemctl disable --now postgresql"
  rsh "sudo apt-get purge -y 'postgresql*' && sudo rm -rf /var/lib/postgresql /etc/postgresql /var/backups/chord"
  if [[ $LOGS -eq 1 ]]; then
    echo "== App logs and shell history"
    # prompts.log is the pre-fix full-prompt log; dated logs older than a day predate the leak fixes and can carry
    # raw model replies. Today's and yesterday's are kept for operations. -mtime +0 = modified more than 24h ago.
    rsh "sudo find /var/lib/chord/logs -type f \\( -name 'prompts.log*' -o \\( -name '*.log*' -mtime +0 \\) \\) -delete; rm -f \$HOME/.psql_history; echo removed"
  fi
  if [[ $SNAPSHOTS -eq 1 ]]; then
    echo "== Snapshots"
    if [[ $DRY_RUN -eq 1 ]]; then
      echo "[dry-run] gcloud compute snapshots delete <each snapshot listed above> --quiet"
    else
      local names
      names="$(gcloud_ compute snapshots list --filter="sourceDisk~$INSTANCE" --format='value(name)')"
      if [[ -n "$names" ]]; then
        # shellcheck disable=SC2086
        gcloud_ compute snapshots delete $names --quiet
      else
        echo "  none"
      fi
    fi
  fi
  [[ $DRY_RUN -eq 1 ]] && echo && echo "(dry run: nothing above was executed)"
  cat <<EOF

What removing achieves, and what it does not:
  - the database, its write-ahead log, the dumps and the cron entry are gone from the filesystem.
  - deleting a file does not overwrite its blocks. They sit on this VM's persistent disk, which
    Google encrypts at rest and cryptographically erases when the DISK is deleted. If "no readable
    copy of the old plaintext anywhere" matters more than convenience, replace the VM: create a new
    one, run deploy.sh, then delete the old VM and its disk.
  - Cloud SQL's backups and point-in-time logs hold ciphertext only, because the data was sealed
    before it moved.
EOF
}

case "$CMD" in
  plan) cmd_plan ;;
  provision) cmd_provision ;;
  preflight) cmd_preflight ;;
  rehearse) cmd_rehearse ;;
  drill) cmd_drill ;;
  cutover) cmd_cutover ;;
  verify) cmd_verify ;;
  rollback) cmd_rollback ;;
  shrink-vm) cmd_shrink_vm ;;
  retire-old) cmd_retire_old ;;
  *) echo "Unknown command: $CMD" >&2; sed -n '2,28p' "$0"; exit 2 ;;
esac
