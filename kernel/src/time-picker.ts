/**
 * ADR 0297 — the rules behind the wheel time picker: 12-hour columns, the
 * end following a moved start, and turning a clock time in a chosen time
 * zone into an instant. Pure, so the server's test harness covers it.
 */

export interface TimeOfDay {
  hour: number; // 0-23
  minute: number; // 0-59
}

export const HOURS_12 = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
export const MINUTES = Array.from({ length: 60 }, (_, i) => i);

/** 24-hour time as the three wheel values. */
export function toWheel(t: TimeOfDay): { hour12: number; minute: number; pm: boolean } {
  const h = t.hour % 12;
  return { hour12: h === 0 ? 12 : h, minute: t.minute, pm: t.hour >= 12 };
}

/** The three wheel values back to 24-hour time. */
export function fromWheel(hour12: number, minute: number, pm: boolean): TimeOfDay {
  const h = hour12 % 12;
  return { hour: pm ? h + 12 : h, minute };
}

const DAY = 24 * 60;
const toMin = (t: TimeOfDay) => t.hour * 60 + t.minute;
const fromMin = (m: number): TimeOfDay => {
  const x = ((m % DAY) + DAY) % DAY;
  return { hour: Math.floor(x / 60), minute: x % 60 };
};

/**
 * Moving the start drags the end along so the event keeps its length. An end
 * at or before the start reads as running past midnight, as the editor saves
 * it, so the length is measured the same way. No end stays no end.
 */
export function moveEndWithStart(
  prevStart: TimeOfDay,
  prevEnd: TimeOfDay | null,
  nextStart: TimeOfDay,
): TimeOfDay | null {
  if (!prevEnd) return null;
  let length = toMin(prevEnd) - toMin(prevStart);
  if (length <= 0) length += DAY;
  return fromMin(toMin(nextStart) + length);
}

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

function partsIn(ms: number, zone: string): WallTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
  };
}

/** Minutes the zone is ahead of UTC at that instant (New York in summer: -240). */
export function zoneOffsetMinutes(zone: string, ms: number): number {
  const w = partsIn(ms, zone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return Math.round((asUtc - Math.floor(ms / 60000) * 60000) / 60000);
}

/** The clock time an instant shows in a zone. */
export function wallTimeIn(ms: number, zone: string): WallTime {
  return partsIn(ms, zone);
}

/**
 * The instant a clock time names in a zone. A time skipped by a clock change
 * lands just after the jump; a repeated one takes the first.
 */
export function instantOfWallTime(w: WallTime, zone: string): Date {
  const naive = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  let guess = naive - zoneOffsetMinutes(zone, naive) * 60000;
  guess = naive - zoneOffsetMinutes(zone, guess) * 60000;
  return new Date(guess);
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Zones offered in the picker; the device's own and the event's are added. */
export const COMMON_TIME_ZONES = [
  'Pacific/Honolulu',
  'America/Anchorage',
  'America/Los_Angeles',
  'America/Denver',
  'America/Phoenix',
  'America/Chicago',
  'America/New_York',
  'America/Halifax',
  'America/Sao_Paulo',
  'Atlantic/Reykjavik',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Athens',
  'Africa/Cairo',
  'Africa/Nairobi',
  'Europe/Moscow',
  'Asia/Dubai',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Dhaka',
  'Asia/Bangkok',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Australia/Perth',
  'Australia/Sydney',
  'Pacific/Auckland',
];

/**
 * The zone an event should be shown and edited in: its stored zone when it
 * has one; else, when its time carries an offset this device's zone does not
 * have at that moment, a common zone with that offset; else this device's.
 * `Z` and floating times say nothing about a place, so they stay on the device.
 */
export function zoneForEvent(
  startsAt: string,
  eventZone: string | null | undefined,
  deviceZone: string,
): string {
  if (eventZone && isValidTimeZone(eventZone)) return eventZone;
  const m = startsAt.match(/([+-])(\d{2}):?(\d{2})$/);
  const ms = Date.parse(startsAt);
  if (!m || Number.isNaN(ms)) return deviceZone;
  const stated = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  if (zoneOffsetMinutes(deviceZone, ms) === stated) return deviceZone;
  return COMMON_TIME_ZONES.find((z) => zoneOffsetMinutes(z, ms) === stated) ?? deviceZone;
}

/** "New York (GMT-4)" at the given instant. */
export function timeZoneLabel(zone: string, ms: number): string {
  const city = (zone.split('/').pop() ?? zone).replace(/_/g, ' ');
  const off = zoneOffsetMinutes(zone, ms);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  const hm = a % 60 === 0 ? String(a / 60) : `${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
  return `${city} (GMT${sign}${hm})`;
}

/** The picker's list: extras first (device, event), then the common ones, no repeats. */
export function timeZoneChoices(extras: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  for (const z of [...extras, ...COMMON_TIME_ZONES]) {
    if (z && !out.includes(z) && isValidTimeZone(z)) out.push(z);
  }
  return out;
}
