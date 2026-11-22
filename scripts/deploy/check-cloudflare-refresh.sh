#!/bin/sh
# Checks vm/refresh-cloudflare-ips.sh inside the nginx image (Docker), with a
# real `nginx -t`. Each case states what the conf.d file must end up as.
# On Git Bash run with MSYS_NO_PATHCONV=1. Exits non-zero on any failure.
set -u
if [ "${1:-}" != inside ]; then
  DIR="$(cd "$(dirname "$0")" && pwd)"
  WD="$(cygpath -w "$DIR" 2>/dev/null || echo "$DIR")"
  exec docker run --rm -v "$WD:/t:ro" nginx:1.27-alpine sh /t/check-cloudflare-refresh.sh inside
fi

S=/t/vm/refresh-cloudflare-ips.sh
CONF=/etc/nginx/conf.d/chord-realip.conf
W=/tmp/w; mkdir -p $W
fail=0
pass() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }

grep '^set_real_ip_from [0-9]*\.' /t/templates/nginx-chord-realip.conf | sed 's/set_real_ip_from //; s/;$//' > $W/v4
grep '^set_real_ip_from [0-9a-f]*:' /t/templates/nginx-chord-realip.conf | sed 's/set_real_ip_from //; s/;$//' > $W/v6

run() { # $1 v4 file, $2 v6 file, rest: extra env
  v4="$1"; v6="$2"; shift 2
  env CHORD_REALIP_CONF=$CONF CF_IPS_V4_URL="file://$v4" CF_IPS_V6_URL="file://$v6" \
    NGINX_RELOAD="touch $W/reloaded" "$@" sh $S > $W/out 2>&1
}
reset() { tr -d '\r' < /t/templates/nginx-chord-realip.conf > $CONF; rm -f $W/reloaded; }

# 1. Same ranges as the starting copy: nothing written, no reload.
reset; cp $CONF $W/before
if run $W/v4 $W/v6 && cmp -s $CONF $W/before && [ ! -f $W/reloaded ]; then pass "same list leaves the file alone"; else bad "same list"; cat $W/out; fi

# 2. Cloudflare adds a range (with CRLF and a trailing blank, as a web server might).
reset; { cat $W/v4; echo "198.51.100.0/24"; } | sed 's/$/\r/' > $W/v4plus; echo "" >> $W/v4plus
if run $W/v4plus $W/v6 && grep -q '^set_real_ip_from 198.51.100.0/24;$' $CONF && [ -f $W/reloaded ] && nginx -t >/dev/null 2>&1
then pass "a new range is added, nginx accepts it and is reloaded"; else bad "new range"; cat $W/out; fi

# 3. Bad downloads: the file must stay exactly as it was, and the run must fail.
for c in html empty few missing; do
  reset; cp $CONF $W/before
  case $c in
    html) printf '<!DOCTYPE html>\n<html>Just a moment...</html>\n' > $W/x ;;
    empty) : > $W/x ;;
    few) head -n 2 $W/v4 > $W/x ;;
    missing) rm -f $W/x ;;
  esac
  if run $W/x $W/v6; then bad "$c list was accepted"; cat $W/out
  elif cmp -s $CONF $W/before && [ ! -f $W/reloaded ]; then pass "$c IPv4 list leaves the file alone"
  else bad "$c list changed the file"; fi
done

# 4. nginx rejects the new file: the old one is put back, no reload.
reset; cp $CONF $W/before
if run $W/v4plus $W/v6 NGINX=false; then bad "nginx rejection was ignored"
elif cmp -s $CONF $W/before && [ ! -f $W/reloaded ]; then pass "a list nginx rejects is put back"
else bad "rejected list stayed"; fi

exit $fail
