#!/usr/bin/env bash
# Deploy Chord to a single Google Cloud VM. Run from the repo root.
#
#   scripts/deploy/deploy.sh provision   # one-time: create VM, IP, firewall
#   scripts/deploy/deploy.sh dns         # print A record to set, then wait
#   scripts/deploy/deploy.sh bootstrap   # one-time: install node/nginx on VM
#   scripts/deploy/deploy.sh deploy      # push code, build, migrate, restart (repeat)
#   scripts/deploy/deploy.sh tls         # one-time: issue Let's Encrypt cert
#   scripts/deploy/deploy.sh nginx-site  # overwrite nginx template (then re-run tls)
#   scripts/deploy/deploy.sh migrate     # run db migrations on the VM (also auto-run in deploy)
#   scripts/deploy/deploy.sh sharp       # force-rebuild sharp's native binding + restart
#   scripts/deploy/deploy.sh pull-data   # copy VM data/ back to local (backup)
#   scripts/deploy/deploy.sh reset       # wipe /srv/chord + /var/lib/chord (keeps nginx + TLS)
#   scripts/deploy/deploy.sh logs        # tail server logs
#   scripts/deploy/deploy.sh ssh         # open a shell on the VM
#   scripts/deploy/deploy.sh status      # systemctl status + curl health
#   scripts/deploy/deploy.sh skill put f.json  # save a chat skill to prod (also list/show/disable/...)
#
# NOTE: There is intentionally no `push-data`. Production state is
# owned by the VM. The only ways it changes are: running migrations,
# `reset` (full wipe), and live traffic. Restoring a snapshot is a
# manual `ssh` + `scp` (or pg_dump / pg_restore) operation by design,
# so nobody clobbers prod with a dev DB by muscle-memory.

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
: "${DOMAIN:?}"
: "${CERTBOT_EMAIL:?}"
: "${SERVER_ENV_FILE:?}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-standard-2}"
DISK_SIZE="${DISK_SIZE:-30GB}"
DOMAIN_ALIASES="${DOMAIN_ALIASES:-}"
LOCAL_DATA_DIR="${LOCAL_DATA_DIR:-$REPO_ROOT/data}"
JOURNAL_MAX_USE="${JOURNAL_MAX_USE:-200M}"

# ADR 0211: '' = secrets travel in /srv/chord/.env as before; 'fetch' = the services also fetch them
# from Secret Manager at start (values still in .env, identical); 'only' = they are removed from the
# .env that reaches the VM. Set it in deploy.env. `fetch` first, `only` after it has run well.
SECRETS_MODE="${SECRETS_MODE:-}"
CRASH_REPORT_REPO="${CRASH_REPORT_REPO:-}"
CRASH_REPORT_TOKEN_SECRET="${CRASH_REPORT_TOKEN_SECRET:-CRASH_REPORT_GITHUB_TOKEN}"

APP_DIR=/srv/chord
DATA_DIR=/var/lib/chord/data
LOGS_DIR=/var/lib/chord/logs
REGION="${ZONE%-*}"

# ── helpers ──────────────────────────────────────────────────────────
gcloud_() { gcloud --project="$PROJECT_ID" "$@"; }

rsh() { gcloud_ compute ssh "$INSTANCE" --zone="$ZONE" --command="$1"; }

remote_user() { gcloud_ compute ssh "$INSTANCE" --zone="$ZONE" --command='echo $USER' | tr -d '\r\n'; }

instance_ip() {
  gcloud_ compute instances describe "$INSTANCE" --zone="$ZONE" \
    --format='value(networkInterfaces[0].accessConfigs[0].natIP)'
}

require_ssh_config() {
  # `gcloud compute config-ssh` writes ssh aliases like
  #   chord.us-central1-a.PROJECT
  # into ~/.ssh/config. Needed for plain rsync.
  gcloud_ compute config-ssh --quiet >/dev/null
}

ssh_host() { echo "$INSTANCE.$ZONE.$PROJECT_ID"; }

# ADR 0211 — secrets in Secret Manager. Names, one per line, from a keys file.
secret_names() { grep -v -E '^\s*(#|$)' "$1"; }

# Migrations need the app's full environment. With secrets in Secret Manager the VM's .env no longer
# has them, so chord-with-env (installed by secrets_prepare) supplies the same environment the services get.
run_migrate() {
  if [[ -n "$SECRETS_MODE" ]]; then
    rsh "cd $APP_DIR && chord-with-env env DATA_DIR=$DATA_DIR LOGS_DIR=$LOGS_DIR npm run migrate"
  else
    rsh "cd $APP_DIR && DATA_DIR=$DATA_DIR LOGS_DIR=$LOGS_DIR npm run migrate"
  fi
}

# ADR 0300 — `verify --fix` also saves a skill whose tool was only renamed.
run_skill_verify() {
  if [[ -n "$SECRETS_MODE" ]]; then
    rsh "cd $APP_DIR && chord-with-env env DATA_DIR=$DATA_DIR LOGS_DIR=$LOGS_DIR npm run --silent skill --workspace=server -- verify --fix"
  else
    rsh "cd $APP_DIR && DATA_DIR=$DATA_DIR LOGS_DIR=$LOGS_DIR npm run --silent skill --workspace=server -- verify --fix"
  fi
}

# `sed` expression that switches on the marker lines in the systemd unit templates.
secrets_unit_sed() {
  if [[ -n "$SECRETS_MODE" ]]; then echo 's|^#SECRETS#||'; else echo 's|^#SECRETS#.*$||'; fi
}

# In fetch/only mode: refuse to deploy unless Secret Manager holds what .env.prod holds (a missing or
# stale DATABASE_URL would otherwise stop the app, or worse), then install the root-owned fetch scripts
# and the list of secrets that actually exist (a name that is empty in .env.prod is not in it).
secrets_prepare() {
  local host="$1"
  case "$SECRETS_MODE" in
    "") return 0 ;;
    fetch|only) ;;
    *) echo "SECRETS_MODE must be empty, 'fetch' or 'only'; got '$SECRETS_MODE'" >&2; exit 1 ;;
  esac
  echo "→ SECRETS_MODE=$SECRETS_MODE: checking Secret Manager holds every secret in $SERVER_ENV_FILE"
  "$SCRIPT_DIR/secrets.sh" verify || { echo "Run: scripts/deploy/secrets.sh push --yes   (then deploy again)" >&2; exit 1; }
  local stage; stage=$(mktemp -d)
  cp "$SCRIPT_DIR"/vm/*.mjs "$SCRIPT_DIR/vm/chord-with-env" "$stage/"
  local n
  while read -r n; do
    [[ -n "$(grep -m1 "^$n=" "$SERVER_ENV_FILE" | cut -d= -f2- | tr -d '\r')" ]] && echo "$n"
  done < <(secret_names "$SCRIPT_DIR/secret-keys.txt") > "$stage/secret-keys.txt"
  echo "→ installing secret fetch scripts on the VM ($(wc -l < "$stage/secret-keys.txt") secrets)"
  rsync -az "$stage/" "$host:/tmp/chord-vm/"
  rsh '
set -e
sudo install -d -m 755 -o root -g root /usr/local/lib/chord
sudo install -m 644 -o root -g root /tmp/chord-vm/secrets-lib.mjs /tmp/chord-vm/fetch-secrets.mjs /tmp/chord-vm/with-env.mjs /tmp/chord-vm/secret-keys.txt /usr/local/lib/chord/
sudo install -m 755 -o root -g root /tmp/chord-vm/chord-with-env /usr/local/bin/chord-with-env
rm -rf /tmp/chord-vm
'
  rm -rf "$stage"
}

# ADR 0227 — crash reports. `sed` expression that switches on the #CRASH# lines in the unit templates.
crash_unit_sed() {
  if [[ -n "$CRASH_REPORT_REPO" ]]; then echo 's|^#CRASH#||'; else echo 's|^#CRASH#.*$||'; fi
}

# Install the root-owned crash reporter and tell it which repository to file in and which commit is
# running. The GitHub token is NOT sent from here: the reporter reads it from Secret Manager itself.
crash_report_prepare() {
  local host="$1"
  [[ -n "$CRASH_REPORT_REPO" ]] || return 0
  [[ "$CRASH_REPORT_REPO" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "CRASH_REPORT_REPO must be owner/name; got '$CRASH_REPORT_REPO'" >&2; exit 1; }
  local stage commit
  stage=$(mktemp -d)
  commit=$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true)
  cp "$SCRIPT_DIR/vm/secrets-lib.mjs" "$SCRIPT_DIR/vm/crash-report-lib.mjs" "$SCRIPT_DIR/vm/crash-report.mjs" "$stage/"
  printf '{"repo":"%s","tokenSecret":"%s","commit":"%s"}\n' "$CRASH_REPORT_REPO" "$CRASH_REPORT_TOKEN_SECRET" "$commit" > "$stage/crash-report.json"
  echo "→ installing the crash reporter on the VM (issues go to $CRASH_REPORT_REPO)"
  rsync -az "$stage/" "$host:/tmp/chord-crash/"
  rsh '
set -e
sudo install -d -m 755 -o root -g root /usr/local/lib/chord
sudo install -m 644 -o root -g root /tmp/chord-crash/secrets-lib.mjs /tmp/chord-crash/crash-report-lib.mjs /tmp/chord-crash/crash-report.mjs /tmp/chord-crash/crash-report.json /usr/local/lib/chord/
sudo install -d -m 700 -o root -g root /var/lib/chord-crash
rm -rf /tmp/chord-crash
'
  rm -rf "$stage"
}

# ADR 0091 — GeoLite2-City, for the briefing's weather location. Downloaded
# here and rsync'd up rather than fetched on the VM, so a MaxMind outage or a
# missing key never blocks a deploy: the server treats an absent database as
# "IP location off" and falls back to the timezone.
#
# Refreshed when the local copy is older than a week (MaxMind publishes
# weekly). Set MAXMIND_LICENSE_KEY in deploy.env to enable; without it this
# is a no-op and weather still works off the timezone tier.
GEOIP_LOCAL="${GEOIP_LOCAL:-$SCRIPT_DIR/.geolite2-city.mmdb}"

geoip_sync() {
  local host="$1"
  if [[ -z "${MAXMIND_LICENSE_KEY:-}" ]]; then
    echo "→ GeoLite2: MAXMIND_LICENSE_KEY unset, skipping (weather falls back to timezone)"
    return 0
  fi
  # `-mtime -7` is false for a missing file too, so this covers both cases.
  if [[ ! -f "$GEOIP_LOCAL" ]] || [[ -z "$(find "$GEOIP_LOCAL" -mtime -7 2>/dev/null)" ]]; then
    echo "→ GeoLite2: downloading fresh database"
    local tmp; tmp=$(mktemp -d)
    if curl -fsSL -o "$tmp/db.tar.gz"         "https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-City&license_key=${MAXMIND_LICENSE_KEY}&suffix=tar.gz"; then
      tar -xzf "$tmp/db.tar.gz" -C "$tmp"
      # The tarball nests the .mmdb under a dated directory.
      local found; found=$(find "$tmp" -name '*.mmdb' | head -1)
      if [[ -n "$found" ]]; then
        mv "$found" "$GEOIP_LOCAL"
      else
        echo "  ! no .mmdb in the archive — keeping any existing copy"
      fi
    else
      echo "  ! download failed — keeping any existing copy"
    fi
    rm -rf "$tmp"
  else
    echo "→ GeoLite2: local copy is fresh"
  fi
  if [[ -f "$GEOIP_LOCAL" ]]; then
    echo "→ GeoLite2: uploading to $host:$APP_DIR/data/geolite2-city.mmdb"
    rsh "mkdir -p $APP_DIR/data"
    rsync -az "$GEOIP_LOCAL" "$host:$APP_DIR/data/geolite2-city.mmdb"
  fi
}

# ── subcommands ──────────────────────────────────────────────────────────────

cmd_provision() {
  echo "→ creating static IP chord-ip in $REGION (if missing)"
  gcloud_ compute addresses describe chord-ip --region="$REGION" >/dev/null 2>&1 \
    || gcloud_ compute addresses create chord-ip --region="$REGION"
  local ip
  ip=$(gcloud_ compute addresses describe chord-ip --region="$REGION" --format='value(address)')

  echo "→ creating VM $INSTANCE in $ZONE (if missing)"
  if ! gcloud_ compute instances describe "$INSTANCE" --zone="$ZONE" >/dev/null 2>&1; then
    gcloud_ compute instances create "$INSTANCE" \
      --zone="$ZONE" \
      --machine-type="$MACHINE_TYPE" \
      --image-family=debian-12 --image-project=debian-cloud \
      --boot-disk-size="$DISK_SIZE" --boot-disk-type=pd-balanced \
      --tags=http-server,https-server \
      --address="$ip"
  else
    echo "  VM already exists, leaving as-is"
  fi

  echo "→ ensuring firewall rules"
  gcloud_ compute firewall-rules describe allow-http >/dev/null 2>&1 \
    || gcloud_ compute firewall-rules create allow-http  --allow=tcp:80  --target-tags=http-server
  gcloud_ compute firewall-rules describe allow-https >/dev/null 2>&1 \
    || gcloud_ compute firewall-rules create allow-https --allow=tcp:443 --target-tags=https-server

  echo
  echo "✓ provisioned. Static IP: $ip"
  echo "  Next: scripts/deploy/deploy.sh dns"
}

cmd_dns() {
  local ip; ip=$(instance_ip)
  cat <<EOF
Set these DNS records at your registrar for $DOMAIN, then wait for propagation:

  Type  Name              Value
  A     @                 $ip
EOF
  for alias in $DOMAIN_ALIASES; do
    local sub="${alias%.$DOMAIN}"
    echo "  A     $sub               $ip"
  done
  echo
  echo "Check propagation: dig +short $DOMAIN"
}

cmd_bootstrap() {
  # The Node major version comes from .nvmrc, the same file CI reads.
  local node_major; node_major=$(tr -dc '0-9' < "$REPO_ROOT/.nvmrc")
  [[ -n "$node_major" ]] || { echo "Could not read a Node major version from .nvmrc" >&2; exit 1; }
  echo "→ installing node $node_major, nginx, certbot on $INSTANCE"
  rsh '
set -e
sudo apt-get update -qq
sudo apt-get install -y -qq nginx certbot python3-certbot-nginx build-essential git rsync python3 ca-certificates curl gnupg
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1)" != "v'"$node_major"'" ]; then
  curl -fsSL https://deb.nodesource.com/setup_'"$node_major"'.x | sudo bash -
  sudo apt-get install -y -qq nodejs
fi
sudo mkdir -p '"$APP_DIR"' '"$DATA_DIR"' '"$LOGS_DIR"'
sudo chown -R "$USER":"$USER" '"$APP_DIR"' /var/lib/chord
'
  echo "✓ bootstrap complete"
}

cmd_deploy() {
  if [[ ! -f "$SERVER_ENV_FILE" ]]; then
    echo "Missing $SERVER_ENV_FILE — create it from example.env (see deploy.env.example)." >&2
    exit 1
  fi

  # Refuse to ship a prod .env that sets DATA_DIR / LOGS_DIR — the systemd
  # units (chord.service, chord-worker.service — ADR 0172) are the single
  # source of truth for those paths (both set them to /var/lib/chord/data
  # and /var/lib/chord/logs, rendered from these same deploy.sh variables,
  # so the two can't drift from each other). When the .env also defines
  # them, EnvironmentFile= wins and the Node process ends up writing
  # uploaded files to a different data dir than the one anyone reads from.
  # Lost an evening to this; never again.
  if grep -qE '^(DATA_DIR|LOGS_DIR)=' "$SERVER_ENV_FILE"; then
    echo "✗ $SERVER_ENV_FILE sets DATA_DIR / LOGS_DIR." >&2
    grep -nE '^(DATA_DIR|LOGS_DIR)=' "$SERVER_ENV_FILE" >&2
    echo "  Remove those lines — the systemd units set the canonical paths" >&2
    echo "  (DATA_DIR=/var/lib/chord/data, LOGS_DIR=/var/lib/chord/logs)." >&2
    echo "  Setting them in .env causes the Node process to write uploaded" >&2
    echo "  files under /srv/chord/data/ that drift from the real data dir." >&2
    exit 1
  fi

  # Auto-merge any new keys from example.env into the prod env file. When
  # a feature adds a new env var, you set it in example.env and ship —
  # the deploy then appends the same line (with whatever default
  # example.env carries) to the prod env file so the prod boot doesn't
  # crash on a missing var. Existing keys are left untouched: prod
  # secrets and overrides win. Skips DATA_DIR / LOGS_DIR (banned above).
  local example_env="$REPO_ROOT/example.env"
  if [[ -f "$example_env" ]]; then
    # Lines that look like KEY=... (not comments, not blank).
    local example_keys prod_keys missing
    example_keys=$(grep -E '^[A-Z_][A-Z0-9_]*=' "$example_env" | cut -d= -f1 | sort -u)
    prod_keys=$(grep -E '^[A-Z_][A-Z0-9_]*=' "$SERVER_ENV_FILE" | cut -d= -f1 | sort -u)
    missing=$(comm -23 <(echo "$example_keys") <(echo "$prod_keys") \
              | grep -vE '^(DATA_DIR|LOGS_DIR)$' || true)
    if [[ -n "$missing" ]]; then
      echo "→ adding new env keys from example.env to $SERVER_ENV_FILE:"
      # Append a separator + each missing key's example.env line. The
      # line carries the default value, so the server boots even when
      # the new var is optional. Secrets you actually need still have to
      # be filled in by hand — we just stop the prod boot from crashing
      # on a hard ENV_VAR_REQUIRED.
      printf '\n# ── added by deploy on %s ──\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$SERVER_ENV_FILE"
      while IFS= read -r key; do
        [[ -z "$key" ]] && continue
        local line
        # example.env can have Windows line endings; the carriage return must not ride into the prod file.
        line=$(grep -E "^${key}=" "$example_env" | head -1 | tr -d '\r')
        echo "$line" >> "$SERVER_ENV_FILE"
        echo "  + $line"
      done <<< "$missing"
      echo "  ($SERVER_ENV_FILE has been edited locally — review and commit if it's tracked.)"
    fi
  fi

  require_ssh_config
  local host; host=$(ssh_host)
  local ruser; ruser=$(remote_user)

  secrets_prepare "$host"
  crash_report_prepare "$host"
  geoip_sync "$host"

  echo "→ rsync source to $host:$APP_DIR"
  # .claude holds local Claude Code state, including git worktrees - full
  # checkouts of other in-progress branches - which must never reach the VM.
  # rsync copies the working folder, not the git tree, so .gitignore does not
  # apply here: videos are excluded by name (the same set .gitignore lists),
  # or a deploy copies ~1 GB of marketing video onto a 30 GB disk. The
  # website's own demo video is let back in, as .gitignore does (rsync takes
  # the first rule that matches, so the include sits above the excludes).
  rsync -az --delete \
    --exclude=node_modules \
    --exclude=.git \
    --exclude=.claude \
    --exclude=data \
    --exclude=logs \
    --exclude='mobile/.expo' \
    --exclude='mobile/web-build' \
    --exclude='server/dist' \
    --exclude='client/dist' \
    --exclude='*.log' \
    --exclude='/marketing-video' \
    --exclude='/marketing-videos' \
    --include='/mobile/public/site/video/*.mp4' \
    --exclude='*.[mM][pP]4' \
    --exclude='*.[mM][oO][vV]' \
    --exclude='*.[mM]4[vV]' \
    --exclude='*.[wW][eE][bB][mM]' \
    --exclude='*.[mM][kK][vV]' \
    --exclude='*.[aA][vV][iI]' \
    --exclude='*.[wW][mM][vV]' \
    --exclude='.env' \
    --exclude='.env.*' \
    --exclude='scripts/deploy/.env.prod' \
    --exclude='scripts/deploy/deploy.env' \
    "$REPO_ROOT/" "$host:$APP_DIR/"

  local env_to_push="$SERVER_ENV_FILE" env_tmp=""
  if [[ "$SECRETS_MODE" == "only" ]]; then
    env_tmp=$(umask 077; mktemp)
    local strip
    strip=$(cat <(secret_names "$SCRIPT_DIR/secret-keys.txt") <(secret_names "$SCRIPT_DIR/local-only-keys.txt") | paste -sd'|')
    grep -v -E "^(${strip})=" "$SERVER_ENV_FILE" > "$env_tmp" || true
    env_to_push="$env_tmp"
    echo "→ SECRETS_MODE=only: $(( $(wc -l < "$SERVER_ENV_FILE") - $(wc -l < "$env_tmp") )) secret lines kept out of the .env that reaches the VM"
  fi
  echo "→ pushing .env to server AND mobile (Expo build reads EXPO_PUBLIC_* from mobile/.env at bundle time)"
  rsync -az --chmod=F600 "$env_to_push" "$host:$APP_DIR/.env"
  rsync -az --chmod=F600 "$env_to_push" "$host:$APP_DIR/mobile/.env"
  [[ -z "$env_tmp" ]] || rm -f "$env_tmp"

  echo "→ rendering systemd units (chord = web role, chord-worker = worker role, ADR 0172)"
  sed -e "s|__APP_DIR__|$APP_DIR|g" \
      -e "s|__DATA_DIR__|$DATA_DIR|g" \
      -e "s|__LOGS_DIR__|$LOGS_DIR|g" \
      -e "s|__REMOTE_USER__|$ruser|g" \
      -e "$(secrets_unit_sed)" \
      -e "$(crash_unit_sed)" \
      "$SCRIPT_DIR/templates/chord.service" \
    | gcloud_ compute ssh "$INSTANCE" --zone="$ZONE" --command='sudo tee /etc/systemd/system/chord.service >/dev/null'
  sed -e "s|__APP_DIR__|$APP_DIR|g" \
      -e "s|__DATA_DIR__|$DATA_DIR|g" \
      -e "s|__LOGS_DIR__|$LOGS_DIR|g" \
      -e "s|__REMOTE_USER__|$ruser|g" \
      -e "$(secrets_unit_sed)" \
      -e "$(crash_unit_sed)" \
      "$SCRIPT_DIR/templates/chord-worker.service" \
    | gcloud_ compute ssh "$INSTANCE" --zone="$ZONE" --command='sudo tee /etc/systemd/system/chord-worker.service >/dev/null'

  # Nginx site is installed only when missing — certbot edits this file in
  # place to add the TLS server block, so re-writing the template every
  # deploy would wipe out HTTPS. Use `nginx-site` subcommand to force.
  local domains="$DOMAIN $DOMAIN_ALIASES"
  if rsh 'test ! -f /etc/nginx/sites-available/chord' 2>/dev/null; then
    echo "→ installing nginx site (first time)"
    sed -e "s|__APP_DIR__|$APP_DIR|g" \
        -e "s|__DOMAINS__|$domains|g" \
        "$SCRIPT_DIR/templates/nginx-chord" \
      | gcloud_ compute ssh "$INSTANCE" --zone="$ZONE" --command='sudo tee /etc/nginx/sites-available/chord >/dev/null'
  else
    echo "→ nginx site already present, skipping (run \`nginx-site\` to overwrite, then re-run \`tls\`)"
  fi
  install_nginx_security

  # Extract EXPO_PUBLIC_* vars from the prod env and pass them inline to
  # `expo export` so we don't depend on Expo's flaky .env discovery.
  local expo_env_args=""
  while IFS= read -r line; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    expo_env_args+=" $line"
  done < <(grep -E '^EXPO_PUBLIC_[A-Z0-9_]+=' "$SERVER_ENV_FILE" || true)

  echo "→ build server + web on VM (with $(echo "$expo_env_args" | wc -w) EXPO_PUBLIC_* vars)"
  rsh '
set -e
cd '"$APP_DIR"'
npm ci --no-audit --no-fund
# Sharp ships per-arch native binaries. npm ci picks them up most of the
# time, but a cached node_modules layer (older Node version, stale
# optional-deps state, or a partial install from a previous deploy) can
# leave the wrong libvips loaded — the process then crashes the moment
# any image route is hit. Force a rebuild against the VM''s current
# Node + libc so the binary we end up with is the one this host can run.
npm rebuild --workspace=server sharp --no-audit --no-fund
# server runs from TypeScript via tsx (see chord.service); no tsc build step.
# Force-clean previous web build + caches so a stale bundle never sneaks
# through. Metro keeps a cache under /tmp that survives reboots and can
# pin EXPO_PUBLIC_* values from earlier builds — nuke it every time.
rm -rf mobile/web-build mobile/.expo mobile/node_modules/.cache
rm -rf /tmp/metro-* /tmp/haste-map-* ~/.expo
( cd mobile && env'"$expo_env_args"' npx expo export --platform web --output-dir web-build )
'

  echo "→ run db migrations (idempotent — already-applied are skipped)"
  run_migrate

  # ADR 0300 — the new code must still be able to run every stored skill.
  # Runs before the restart, so a failure leaves the old services running.
  if [[ -n "${SKIP_SKILL_VERIFY:-}" ]]; then
    echo "⚠ SKIP_SKILL_VERIFY set: not checking stored skills"
  else
    echo "→ check stored chat skills against the new code"
    run_skill_verify || {
      echo "✗ a stored skill names a tool or check this code no longer has (listed above)." >&2
      echo "  Fix: edit + 'npm run skill -- put' the skill, or 'npm run skill -- disable <id>', then deploy again." >&2
      echo "  The running services were NOT restarted. SKIP_SKILL_VERIFY=1 deploys anyway (the skill is then skipped)." >&2
      exit 1
    }
  fi

  echo "→ enable nginx site + reload"
  rsh '
set -e
sudo ln -sf /etc/nginx/sites-available/chord /etc/nginx/sites-enabled/chord
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
'

  # ADR 0226: the system journal is capped too. Left at its default it may
  # take 10% of the disk, and it carries a copy of every service crash.
  echo "→ cap the system journal at $JOURNAL_MAX_USE"
  rsh "
set -e
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=$JOURNAL_MAX_USE\n' | sudo tee /etc/systemd/journald.conf.d/chord.conf >/dev/null
sudo systemctl restart systemd-journald
sudo journalctl --vacuum-size=$JOURNAL_MAX_USE >/dev/null 2>&1 || true
"

  install_clamav

  echo "→ restart chord + chord-worker services"
  rsh '
set -e
sudo systemctl daemon-reload
sudo systemctl enable --now chord chord-worker
sudo systemctl restart chord chord-worker
'

  echo "✓ deployed. Try: scripts/deploy/deploy.sh status"
}

# Anti-malware: ClamAV's scanner and signature updater (not the clamd daemon) and
# a nightly scan. Installed only when missing, so a deploy never upgrades it as a
# side effect; unattended-upgrades keeps it patched. The alert on a detection is
# set up by `audit.sh ops-agent` + `audit.sh alert`.
install_clamav() {
  echo "→ ClamAV: scanner, signature updates, nightly scan"
  rsh 'dpkg -s clamav clamav-freshclam >/dev/null 2>&1 || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends clamav clamav-freshclam'
  # A Windows checkout gives these files CRLF; a \r after ExecStart's continuation
  # backslashes would break the unit, so they are stripped on the way up.
  local f
  for f in chord-clamscan.service chord-clamscan.timer; do
    tr -d '\r' < "$SCRIPT_DIR/templates/$f" \
      | gcloud_ compute ssh "$INSTANCE" --zone="$ZONE" --command="sudo tee /etc/systemd/system/$f >/dev/null"
  done
  tr -d '\r' < "$SCRIPT_DIR/templates/chord-clamscan.logrotate" \
    | gcloud_ compute ssh "$INSTANCE" --zone="$ZONE" --command='sudo tee /etc/logrotate.d/chord-clamscan >/dev/null'
  rsh '
set -e
sudo systemctl daemon-reload
sudo systemctl enable --now clamav-freshclam chord-clamscan.timer
'
}

# ADR 0269 — HSTS and an access log without query strings. Both files are ours
# and rewritten every deploy; the site file is certbot's once TLS is issued, so
# it only gains an include after each `server_name` (the 80 block, and the 443
# block certbot added) and only when the include is not there yet. The reload
# step runs `nginx -t` first, so a bad edit fails the deploy instead of nginx.
install_nginx_security() {
  echo "→ nginx: HSTS + query-free access log + one canonical host"
  nginx_canonical_conf | gcloud_ compute ssh "$INSTANCE" --zone="$ZONE" \
    --command='sudo tee /etc/nginx/conf.d/chord-canonical.conf >/dev/null'
  gcloud_ compute ssh "$INSTANCE" --zone="$ZONE" \
    --command='sudo mkdir -p /etc/nginx/snippets && sudo tee /etc/nginx/snippets/chord-security.conf >/dev/null' \
    < "$SCRIPT_DIR/templates/nginx-chord-security.conf"
  gcloud_ compute ssh "$INSTANCE" --zone="$ZONE" \
    --command='sudo tee /etc/nginx/conf.d/chord-logformat.conf >/dev/null' \
    < "$SCRIPT_DIR/templates/nginx-chord-logformat.conf"
  # The visitor's address behind Cloudflare (rate limits, IP weather lookup).
  # The repo copy is the starting list; install_cloudflare_ips keeps it current.
  gcloud_ compute ssh "$INSTANCE" --zone="$ZONE" \
    --command='sudo tee /etc/nginx/conf.d/chord-realip.conf >/dev/null' \
    < "$SCRIPT_DIR/templates/nginx-chord-realip.conf"
  rsh "sudo grep -q 'snippets/chord-security.conf' /etc/nginx/sites-available/chord || sudo sed -i '/^[[:space:]]*server_name /a\\    include snippets/chord-security.conf;' /etc/nginx/sites-available/chord"
  # ADR 0335 - OAuth discovery for the MCP connector, same include pattern.
  gcloud_ compute ssh "$INSTANCE" --zone="$ZONE" \
    --command='sudo tee /etc/nginx/snippets/chord-mcp.conf >/dev/null' \
    < "$SCRIPT_DIR/templates/nginx-chord-mcp.conf"
  rsh "sudo grep -q 'snippets/chord-mcp.conf' /etc/nginx/sites-available/chord || sudo sed -i '/^[[:space:]]*server_name /a\\    include snippets/chord-mcp.conf;' /etc/nginx/sites-available/chord"
  install_nginx_website
  install_cloudflare_ips
}

# Cloudflare's address ranges, refreshed daily from cloudflare.com so a range
# Cloudflare adds is picked up without a deploy. Runs once now too. A failed
# refresh leaves the list as it was (the repo copy just written), so it warns
# and the deploy goes on.
install_cloudflare_ips() {
  echo "→ nginx: Cloudflare address ranges (refreshed daily)"
  tr -d '\r' < "$SCRIPT_DIR/vm/refresh-cloudflare-ips.sh" \
    | gcloud_ compute ssh "$INSTANCE" --zone="$ZONE" \
      --command='sudo install -d -m 755 -o root -g root /usr/local/lib/chord && sudo tee /usr/local/lib/chord/refresh-cloudflare-ips.sh >/dev/null && sudo chmod 755 /usr/local/lib/chord/refresh-cloudflare-ips.sh'
  local f
  for f in chord-cloudflare-ips.service chord-cloudflare-ips.timer; do
    tr -d '\r' < "$SCRIPT_DIR/templates/$f" \
      | gcloud_ compute ssh "$INSTANCE" --zone="$ZONE" --command="sudo tee /etc/systemd/system/$f >/dev/null"
  done
  rsh '
sudo systemctl daemon-reload
sudo systemctl enable --now chord-cloudflare-ips.timer
sudo systemctl start chord-cloudflare-ips.service \
  || echo "⚠ Cloudflare range refresh failed; keeping the list from the repo (journalctl -u chord-cloudflare-ips)"
sudo journalctl -u chord-cloudflare-ips -n 1 --no-pager -o cat
'
}

# The public website (docs/ops/website.md): static pages nginx serves ahead of
# the app. Same shape as the security snippet - our files, rewritten every
# deploy - but the include goes after the `root` line, which only the block
# that serves the web build has (certbot's port-80 redirect block has none).
install_nginx_website() {
  echo "→ nginx: public website routes"
  gcloud_ compute ssh "$INSTANCE" --zone="$ZONE" \
    --command='sudo tee /etc/nginx/conf.d/chord-website-map.conf >/dev/null' \
    < "$SCRIPT_DIR/templates/nginx-chord-website-map.conf"
  gcloud_ compute ssh "$INSTANCE" --zone="$ZONE" \
    --command='sudo mkdir -p /etc/nginx/snippets && sudo tee /etc/nginx/snippets/chord-website.conf >/dev/null' \
    < "$SCRIPT_DIR/templates/nginx-chord-website.conf"
  rsh "sudo grep -q 'snippets/chord-website.conf' /etc/nginx/sites-available/chord || sudo sed -i '/^[[:space:]]*root .*web-build;/a\\    include snippets/chord-website.conf;' /etc/nginx/sites-available/chord"
}

# The http-context half of the canonical-host redirect in chord-security.conf:
# which hosts are aliases (redirected) and where they go. Only listed aliases
# move - a request by IP or any other Host is left as it is.
nginx_canonical_conf() {
  printf '# Generated by deploy.sh from DOMAIN / DOMAIN_ALIASES. Rewritten every deploy.\n'
  printf 'map $host $chord_alias_host {\n    default 0;\n'
  local a
  for a in $DOMAIN_ALIASES; do printf '    %s 1;\n' "$a"; done
  printf '}\n'
  printf 'map $host $chord_canonical_host {\n    default %s;\n}\n' "$DOMAIN"
}

cmd_nginx_site() {
  local ruser; ruser=$(remote_user)
  local domains="$DOMAIN $DOMAIN_ALIASES"
  echo "⚠ Overwriting /etc/nginx/sites-available/chord — TLS block from certbot will be lost."
  read -r -p "  Continue? [y/N] " ans
  [[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "aborted"; exit 1; }
  sed -e "s|__APP_DIR__|$APP_DIR|g" \
      -e "s|__DOMAINS__|$domains|g" \
      "$SCRIPT_DIR/templates/nginx-chord" \
    | gcloud_ compute ssh "$INSTANCE" --zone="$ZONE" --command='sudo tee /etc/nginx/sites-available/chord >/dev/null'
  install_nginx_security
  rsh 'sudo nginx -t && sudo systemctl reload nginx'
  echo "→ now run: scripts/deploy/deploy.sh tls    # re-adds the TLS server block"
}

cmd_tls() {
  echo "→ requesting Let's Encrypt cert for $DOMAIN $DOMAIN_ALIASES"
  local args="-d $DOMAIN"
  for a in $DOMAIN_ALIASES; do args="$args -d $a"; done
  rsh "sudo certbot --nginx --non-interactive --agree-tos -m '$CERTBOT_EMAIL' --redirect $args"
  echo "✓ TLS issued. Auto-renew is handled by the certbot systemd timer."
}

cmd_pull_data() {
  require_ssh_config
  local host; host=$(ssh_host)
  local dest
  dest="$(dirname "$LOCAL_DATA_DIR")/data.from-vm-$(date +%Y%m%d-%H%M%S)"

  echo "→ rsync $host:$DATA_DIR/ → $dest/"
  mkdir -p "$dest"
  # Stage on remote into a user-readable tmp, then pull. Avoids sudo over rsync.
  rsh "sudo cp -a $DATA_DIR /tmp/chord-data-pull && sudo chown -R \$USER:\$USER /tmp/chord-data-pull"
  rsync -az --delete "$host:/tmp/chord-data-pull/" "$dest/"
  rsh "rm -rf /tmp/chord-data-pull"
  echo "✓ pulled to $dest"
}

cmd_migrate() {
  run_migrate
}

# Force-rebuild sharp's native binding on the VM. Use when libvips or Node
# moved (e.g. you bumped Node on the box, or sharp crashes at boot with
# "Could not load the sharp module"). The `deploy` command already does
# this on every push; this subcommand is for the case where you don't want
# to redeploy code just to refresh the native binary.
cmd_sharp() {
  echo "→ rebuilding sharp on VM"
  rsh "cd $APP_DIR && npm rebuild --workspace=server sharp --no-audit --no-fund"
  echo "→ restart chord + chord-worker services to pick up the new binary"
  rsh 'sudo systemctl restart chord chord-worker'
  echo "✓ sharp rebuilt"
}

cmd_reset() {
  echo "⚠ Will WIPE /srv/chord (app) and /var/lib/chord (data + logs) on $INSTANCE."
  echo "  Nginx site + Let's Encrypt certs are preserved."
  read -r -p "  Continue? [y/N] " ans
  [[ "$ans" == "y" || "$ans" == "Y" ]] || { echo "aborted"; exit 1; }
  local ruser; ruser=$(remote_user)
  rsh '
set -e
sudo systemctl stop chord chord-worker || true
sudo rm -rf '"$APP_DIR"' /var/lib/chord
sudo mkdir -p '"$APP_DIR"' '"$DATA_DIR"' '"$LOGS_DIR"'
sudo chown -R "'"$ruser"'":"'"$ruser"'" '"$APP_DIR"' /var/lib/chord
'
  echo "✓ wiped. Next: deploy → migrate"
  echo "    scripts/deploy/deploy.sh deploy"
  echo "    scripts/deploy/deploy.sh migrate"
}

cmd_logs() {
  rsh 'sudo journalctl -u chord -u chord-worker -f --no-pager'
}

cmd_ssh() {
  gcloud_ compute ssh "$INSTANCE" --zone="$ZONE"
}

cmd_status() {
  rsh 'sudo systemctl status chord --no-pager || true'
  echo
  rsh 'sudo systemctl status chord-worker --no-pager || true'
  echo
  echo "→ curl https://$DOMAIN/api/v1/health"
  curl -fsS "https://$DOMAIN/api/v1/health" || echo "(health check failed — that route may not exist; try the root)"
}

# ADR 0300 — manage the chat skills stored in production, from here.
# `put` copies the definition file to the VM first; every other subcommand
# (list, show, disable, enable, rollback, tools, checks, verify) runs as is.
cmd_skill() {
  local sub="${1:-}"; shift || true
  local env_prefix="env DATA_DIR=$DATA_DIR LOGS_DIR=$LOGS_DIR"
  [[ -n "$SECRETS_MODE" ]] && env_prefix="chord-with-env $env_prefix"
  case "$sub" in
    put)
      local file="${1:-}"; shift || true
      [[ -f "$file" ]] || { echo "✗ give the skill's JSON file: deploy.sh skill put my-skill.json" >&2; exit 1; }
      local remote; remote="/tmp/chord-skill-$(date +%s)-$RANDOM.json"
      gcloud_ compute scp "$file" "$INSTANCE:$remote" --zone="$ZONE"
      rsh "cd $APP_DIR && $env_prefix npm run --silent skill --workspace=server -- put $remote$(printf ' %q' "$@"); rc=\$?; rm -f $remote; exit \$rc"
      ;;
    check)
      echo "✗ check runs on your machine: npm run skill --workspace=server -- check <file>" >&2
      exit 1
      ;;
    list|show|disable|enable|rollback|tools|checks|verify)
      rsh "cd $APP_DIR && $env_prefix npm run --silent skill --workspace=server -- $sub$(printf ' %q' "$@")"
      ;;
    *)
      echo "usage: deploy.sh skill put <file.json> [--by <name>] | list | show <id> | disable <id> | enable <id> | rollback <id> <version> | tools | checks | verify" >&2
      exit 1
      ;;
  esac
}

cmd_help() {
  sed -n '2,23p' "$0"
}

# ── dispatch ─────────────────────────────────────────────────────────
cmd="${1:-help}"; shift || true
case "$cmd" in
  provision) cmd_provision "$@" ;;
  dns)       cmd_dns "$@" ;;
  bootstrap) cmd_bootstrap "$@" ;;
  deploy)    cmd_deploy "$@" ;;
  tls)       cmd_tls "$@" ;;
  nginx-site) cmd_nginx_site "$@" ;;
  migrate)   cmd_migrate "$@" ;;
  sharp)     cmd_sharp "$@" ;;
  pull-data) cmd_pull_data "$@" ;;
  push-data)
    echo "✗ push-data was removed. Production data is owned by the VM." >&2
    echo "  If you really need to restore a snapshot, ssh in and do it by hand:" >&2
    echo "    scripts/deploy/deploy.sh ssh" >&2
    exit 2
    ;;
  reset)     cmd_reset "$@" ;;
  logs)      cmd_logs "$@" ;;
  ssh)       cmd_ssh "$@" ;;
  status)    cmd_status "$@" ;;
  skill)     cmd_skill "$@" ;;
  help|-h|--help) cmd_help ;;
  *) echo "unknown command: $cmd"; cmd_help; exit 1 ;;
esac
