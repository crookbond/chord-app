import { sql } from 'kysely';

/**
 * Timestamps are stored as TEXT in three shapes - UTC "…Z" (REST, .ics timed,
 * new Date().toISOString()), the value's own offset "…-04:00" (Google pull,
 * bot tools via normalizeDatetimes, itinerary extraction) and floating
 * "…T00:00:00" or a bare date (all-day, ADR 0040). Comparing or sorting the
 * raw strings is wrong by up to a day's offset: "10:00-04:00" (14:00Z) sorts
 * before "12:00Z", and a floating all-day row sorts below a same-day
 * "…T00:00:00.000Z" bound. Anything that compares, filters or orders by one
 * of these columns goes through here.
 */

/** A valid IANA zone for floating values, else UTC. */
export function validZone(tz: string | null | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/**
 * `column` (a trusted "table.column" reference, never user input) as a
 * timestamptz. Zoned values cast directly; floating ones are wall time in
 * `tz`; anything unparseable is NULL rather than failing the whole query.
 */
export function textInstant(column: string, tz?: string | null) {
  const zone = validZone(tz);
  const col = sql.ref(column);
  return sql<string>`(CASE
    WHEN ${col} ~ '^\\d{4}-\\d{2}-\\d{2}T.*(Z|[+-]\\d{2}:?\\d{2})$' THEN ${col}::timestamptz
    WHEN ${col} ~ '^\\d{4}-\\d{2}-\\d{2}' THEN ${col}::timestamp AT TIME ZONE ${zone}
  END)`;
}

/**
 * The same rule in JS, for sorting rows already fetched. Floating values are
 * read as UTC wall time - consistent with each other, which is what a sort
 * needs; unparseable values sort last.
 */
export function instantMs(iso: string | null | undefined): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(iso);
  const ms = Date.parse(zoned || !/T/.test(iso) ? iso : `${iso}Z`);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/** Ascending comparator on an ISO-ish field, by instant. */
export function byInstant<T>(get: (row: T) => string | null | undefined) {
  return (a: T, b: T) => {
    const x = instantMs(get(a));
    const y = instantMs(get(b));
    return x === y ? 0 : x < y ? -1 : 1;
  };
}
