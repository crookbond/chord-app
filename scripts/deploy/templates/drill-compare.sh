#!/usr/bin/env bash
# Runs ON THE VM, piped in by `cloudsql.sh drill`. Compares production with the point-in-time
# clone. Needs DRILL_IP (clone's private IP) and DRILL_AGE (minutes the clone is behind).
# The database credential is the one the app already uses, read from /srv/chord/.env into this
# process only: never printed, never written to a file.
# DATABASE_URL comes from the environment when run under chord-with-env (secrets in Secret Manager),
# otherwise from the app's .env.
u="${DATABASE_URL:-$(grep -m1 '^DATABASE_URL=' /srv/chord/.env | cut -d= -f2-)}"
u=$(printf '%s' "$u" | tr -d "\"'\r")
re='^postgres(ql)?://([^:]+):([^@]+)@([^:/]+)(:[0-9]+)?/([^?]+)'
[[ $u =~ $re ]] || { echo "cannot parse DATABASE_URL"; exit 1; }
US=${BASH_REMATCH[2]}; export PGPASSWORD=${BASH_REMATCH[3]}; PH=${BASH_REMATCH[4]}; DB=${BASH_REMATCH[6]}; export PGSSLMODE=require
q="select table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I', table_name), false, true, '')))[1]::text as n from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1"
# psql must not read this script's stdin, hence </dev/null.
psql -At -F" " -h "$PH" -U "$US" -d "$DB" -c "$q" </dev/null > /tmp/drill.prod
psql -At -F" " -h "$DRILL_IP" -U "$US" -d "$DB" -c "$q" </dev/null > /tmp/drill.clone
echo "tables: prod $(wc -l < /tmp/drill.prod), clone $(wc -l < /tmp/drill.clone)"
echo "== per-table rows, only where prod and clone differ (the clone is $DRILL_AGE minutes behind, so recent writes are expected)"
join -a1 -a2 -e MISSING -o 0,1.2,2.2 /tmp/drill.prod /tmp/drill.clone | awk '$2!=$3 {printf "  %-40s prod=%s clone=%s\n", $1, $2, $3; d=1} END{if(!d) print "  none: every table matches"}'
echo "== is anything readable on the clone? (sealed values start enc1.)"
psql -At -h "$DRILL_IP" -U "$US" -d "$DB" -c "select (select count(*) from email_messages where body_text <> '' and body_text not like 'enc1.%') as readable_bodies, (select count(*) from email_messages where subject <> '' and subject not like 'enc1.%') as readable_subjects" </dev/null
rm -f /tmp/drill.prod /tmp/drill.clone
