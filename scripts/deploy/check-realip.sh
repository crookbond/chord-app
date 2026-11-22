#!/bin/bash
# Checks templates/nginx-chord-realip.conf against a real nginx (Docker).
# Prints the address the app sees as req.ip (Express `trust proxy 1` takes the
# last X-Forwarded-For entry) three ways:
#   before  no realip file          -> the proxy's address (the prod bug)
#   after   file + bridge trusted   -> 203.0.113.7, the visitor
#   forged  file, bridge NOT a CF   -> the proxy's address (header ignored)
# Exits non-zero when any line is not what it should be.
# On Git Bash run with MSYS_NO_PATHCONV=1.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
S="$(mktemp -d)"
trap 'docker rm -f chord-realip-check >/dev/null 2>&1; rm -rf "$S"' EXIT
cp "$DIR/templates/nginx-chord-realip.conf" "$S/realip.conf"
WS="$(cygpath -w "$S" 2>/dev/null || echo "$S")"
VISITOR=203.0.113.7
fail=0
for mode in before after forged; do
  {
    echo 'events {}'
    echo 'http {'
    [ "$mode" != before ] && echo '  include /etc/nginx/t/realip.conf;'
    # The Docker bridge stands in for a Cloudflare edge, except in "forged".
    [ "$mode" != forged ] && echo '  set_real_ip_from 172.16.0.0/12;'
    cat <<'EOF'
  server { listen 80;
    location / { proxy_pass http://127.0.0.1:81;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; } }
  server { listen 81; location / { return 200 "$http_x_forwarded_for\n"; } }
}
EOF
  } > "$S/$mode.conf"
  docker rm -f chord-realip-check >/dev/null 2>&1
  docker run -d --name chord-realip-check -p 18080:80 -v "$WS:/etc/nginx/t:ro" \
    nginx:1.27-alpine nginx -g 'daemon off;' -c "/etc/nginx/t/$mode.conf" >/dev/null
  xff=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    xff=$(curl -s -H "CF-Connecting-IP: $VISITOR" http://127.0.0.1:18080/) && [ -n "$xff" ] && break
    sleep 1
  done
  ip="${xff##*, }"
  want_visitor=no; [ "$mode" = after ] && want_visitor=yes
  ok=yes
  if [ -z "$ip" ]; then ok=no
  elif [ "$want_visitor" = yes ] && [ "$ip" != "$VISITOR" ]; then ok=no
  elif [ "$want_visitor" = no ] && [ "$ip" = "$VISITOR" ]; then ok=no
  fi
  echo "$mode: req.ip=$ip ($ok)"
  [ "$ok" = yes ] || fail=1
done
exit $fail
