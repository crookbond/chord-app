#!/usr/bin/env bash
# Runs ON THE VM, piped in by `cloudsql.sh retire-old`. Exit 0 only if the app is really on the new
# database. It asks the app's own ENVIRONMENT, not /srv/chord/.env: once secrets live in Secret Manager
# (ADR 0211) DATABASE_URL is no longer in that file, and reading the file would report a false failure.
if command -v chord-with-env >/dev/null 2>&1; then
  u="$(chord-with-env sh -c 'printf %s "$DATABASE_URL"' 2>/dev/null </dev/null)"
else
  u="$(grep -m1 '^DATABASE_URL=' /srv/chord/.env 2>/dev/null | cut -d= -f2- | tr -d '\r')"
fi
if [ -z "$u" ]; then echo "the app's environment has no DATABASE_URL"; exit 2; fi
if printf '%s' "$u" | grep -qE '@(127\.0\.0\.1|localhost)[:/]'; then echo "DATABASE_URL points at this VM"; exit 1; fi
# Belt and braces: the URL says where it WOULD connect; this says where anything is connected right now.
n="$(ss -tn 2>/dev/null | awk '$1=="ESTAB" && $5=="127.0.0.1:5432"' | wc -l)"
if [ "$n" -gt 0 ]; then echo "$n connection(s) to the local Postgres are open right now"; exit 3; fi
echo "the app's DATABASE_URL points off this VM, and nothing is connected to the local Postgres"
