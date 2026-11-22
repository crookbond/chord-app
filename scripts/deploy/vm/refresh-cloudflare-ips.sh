#!/bin/sh
# Keeps nginx's list of Cloudflare addresses current (installed by deploy.sh,
# run daily by chord-cloudflare-ips.timer and once on every deploy).
#
# nginx believes CF-Connecting-IP only from these ranges; a range missing from
# the file makes visitors arriving through it count as the Cloudflare edge
# (rate limits, IP weather lookup). The file in the repo is the starting copy.
#
# Never makes things worse: a download that fails, is empty, or holds anything
# but CIDR ranges leaves the current file alone, and a file nginx rejects is
# put back. Writes and reloads only when the list changed.
#
# Overridable for tests: CHORD_REALIP_CONF, CF_IPS_V4_URL, CF_IPS_V6_URL,
# NGINX (the nginx binary), NGINX_RELOAD (command that reloads nginx).
set -u

CONF="${CHORD_REALIP_CONF:-/etc/nginx/conf.d/chord-realip.conf}"
V4_URL="${CF_IPS_V4_URL:-https://www.cloudflare.com/ips-v4}"
V6_URL="${CF_IPS_V6_URL:-https://www.cloudflare.com/ips-v6}"
NGINX="${NGINX:-nginx}"
NGINX_RELOAD="${NGINX_RELOAD:-systemctl reload nginx}"
# Cloudflare has published 15 IPv4 and 7 IPv6 ranges for years; far fewer
# means a truncated or wrong answer, not a real change.
MIN_V4=5
MIN_V6=2

log() { echo "refresh-cloudflare-ips: $*"; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch() {
  curl -fsS --max-time 30 --retry 2 "$1" -o "$2" || { log "download failed: $1"; exit 1; }
  # Lines, trimmed, CR dropped, blanks dropped.
  tr -d '\r' < "$2" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -v '^$' > "$2.clean" || true
}

# Prints the number of lines when every line matches $2 and there are at least
# $3 of them; otherwise explains and exits.
check() {
  file="$1"; pattern="$2"; min="$3"; name="$4"
  bad="$(grep -Ev "$pattern" "$file" | head -n 1)"
  if [ -n "$bad" ]; then log "$name list has a line that is not a range: '$bad'"; exit 1; fi
  n="$(wc -l < "$file" | tr -d ' ')"
  if [ "$n" -lt "$min" ]; then log "$name list has only $n ranges (expected at least $min)"; exit 1; fi
}

fetch "$V4_URL" "$tmp/v4"
fetch "$V6_URL" "$tmp/v6"
check "$tmp/v4.clean" '^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$' "$MIN_V4" IPv4
check "$tmp/v6.clean" '^[0-9a-fA-F:]+/([0-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$' "$MIN_V6" IPv6

{
  echo "# The visitor's address behind Cloudflare. Written by"
  echo "# /usr/local/lib/chord/refresh-cloudflare-ips.sh from $V4_URL"
  echo "# and $V6_URL; do not edit here (scripts/deploy/vm/refresh-cloudflare-ips.sh)."
  echo
  while IFS= read -r r; do echo "set_real_ip_from $r;"; done < "$tmp/v4.clean"
  echo
  while IFS= read -r r; do echo "set_real_ip_from $r;"; done < "$tmp/v6.clean"
  echo
  echo "real_ip_header CF-Connecting-IP;"
} > "$tmp/new.conf"

# Compare the ranges, not the comments, so the starting copy from the repo is
# not rewritten just for its header.
ranges() { grep -E '^(set_real_ip_from|real_ip_header)' "$1" 2>/dev/null | sort; }
if [ -f "$CONF" ] && [ "$(ranges "$CONF")" = "$(ranges "$tmp/new.conf")" ]; then
  log "unchanged ($(grep -c '^set_real_ip_from' "$tmp/new.conf") ranges)"
  exit 0
fi

had_old=no
if [ -f "$CONF" ]; then cp -p "$CONF" "$tmp/old.conf"; had_old=yes; fi
cp "$tmp/new.conf" "$CONF"
chmod 644 "$CONF"

if ! "$NGINX" -t >"$tmp/nginx-t.log" 2>&1; then
  log "nginx rejected the new list; putting the old one back"
  cat "$tmp/nginx-t.log"
  if [ "$had_old" = yes ]; then cp -p "$tmp/old.conf" "$CONF"; else rm -f "$CONF"; fi
  exit 1
fi

$NGINX_RELOAD || { log "nginx reload failed"; exit 1; }
log "updated to $(grep -c '^set_real_ip_from' "$CONF") ranges and reloaded nginx"
