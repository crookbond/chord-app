/**
 * ADR 0091 — check the real GeoLite2 database against a live IP.
 *
 * The unit tests drive `cityForIp` against fixture responses, because the
 * database is 60MB and licensed so it is not committed. This is the other
 * half: point it at the actual `.mmdb` and see what a real address resolves
 * to, including the fields Chord deliberately ignores.
 *
 *   npm run geoip:check --workspace=server -- 108.31.44.7
 *
 * Note the direction: GeoLite2 maps IP -> location. A postal code is
 * something it returns, never something you can look up.
 */
import fs from 'node:fs';

import type { CityResponse } from 'maxmind';

import { env } from '../config/env.js';
import { cityForIp } from '../services/geo/geoip.js';

async function main(): Promise<void> {
  const ip = process.argv[2];
  if (!ip) {
    console.error('usage: npm run geoip:check --workspace=server -- <ip>');
    process.exit(2);
  }

  const path = env.GEOIP_DB_PATH.trim();
  if (!path) {
    console.error('GEOIP_DB_PATH is not set — nothing to check.');
    console.error('Download GeoLite2-City.mmdb from MaxMind and point GEOIP_DB_PATH at it.');
    process.exit(1);
  }
  if (!fs.existsSync(path)) {
    console.error(`No database at ${path}`);
    process.exit(1);
  }

  const maxmind = await import('maxmind');
  const reader = await maxmind.open<CityResponse>(path);
  const raw = reader.get(ip);

  console.log(`\nIP        ${ip}`);
  console.log(`database  ${path}\n`);

  if (!raw) {
    console.log('Not in the database. Chord would fall back to the timezone tier.');
    return;
  }

  console.log('--- what the database returns ---');
  console.log(`city        ${raw.city?.names?.en ?? '(none)'}`);
  console.log(`subdivision ${raw.subdivisions?.[0]?.names?.en ?? '(none)'}`);
  console.log(`country     ${raw.country?.names?.en ?? '(none)'}`);
  console.log(`postal      ${raw.postal?.code ?? '(none)'}`);
  console.log(`lat,lon     ${raw.location?.latitude ?? '?'}, ${raw.location?.longitude ?? '?'}`);
  console.log(`accuracy    ${raw.location?.accuracy_radius ?? '?'} km radius`);

  const hit = await cityForIp(ip);
  console.log('\n--- what Chord stores ---');
  console.log(
    hit
      ? `place "${hit.place}" at ${hit.lat}, ${hit.lon}\n(the postal code is deliberately unused — a city is the right weather label,\nand the forecast is fetched by coordinates)`
      : '(nothing — falls back to the timezone tier)',
  );
  console.log('\nThe IP itself is never stored: only the place and coordinates above.\n');
}

void main();
