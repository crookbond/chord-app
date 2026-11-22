/**
 * ADR 0330 — the user's work hours, read by every surface that suggests
 * meeting times (`availability.service`). Stored as one `users.defaults` key
 * (ADR 0255 addendum); unset = `DEFAULT_WORK_HOURS` (9–5, Mon–Fri, US
 * federal holidays off).
 */
import { DEFAULT_WORK_HOURS, parseClock, parseWeekday, type Weekday, type WorkHours } from '@chord/kernel';
import type { Kysely } from 'kysely';
import { z } from 'zod';

import type { DB } from '@/db/schema.js';

import { defineUserDefault } from './user-defaults.service.js';

const stored = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  startMinutes: z.number().int().min(0).max(24 * 60),
  endMinutes: z.number().int().min(0).max(24 * 60),
  observeHolidays: z.boolean(),
});

export const workHoursDefault = defineUserDefault('work_hours', stored);

export async function getWorkHours(db: Kysely<DB>, userId: string): Promise<{ hours: WorkHours; isDefault: boolean }> {
  const saved = await workHoursDefault.get(db, userId);
  if (!saved) return { hours: DEFAULT_WORK_HOURS, isDefault: true };
  return { hours: { ...saved, days: saved.days as Weekday[] }, isDefault: false };
}

export interface WorkHoursPatch {
  days?: string[];
  start?: string;
  end?: string;
  observeHolidays?: boolean;
}

export type SetWorkHoursResult =
  | { ok: true; hours: WorkHours }
  | { ok: false; reason: 'bad_day' | 'bad_time' | 'end_before_start'; detail: string };

/** Omitted fields keep what is there (or the default). */
export async function setWorkHours(db: Kysely<DB>, userId: string, patch: WorkHoursPatch): Promise<SetWorkHoursResult> {
  const { hours: current } = await getWorkHours(db, userId);
  let days = current.days;
  if (patch.days !== undefined) {
    const parsed = patch.days.map(parseWeekday);
    const bad = patch.days.filter((_, i) => parsed[i] === null);
    if (bad.length || parsed.length === 0) {
      return { ok: false, reason: 'bad_day', detail: bad.length ? `not a day: ${bad.join(', ')}` : 'no days given' };
    }
    days = [...new Set(parsed as Weekday[])].sort((a, b) => a - b);
  }
  const start = patch.start !== undefined ? parseClock(patch.start) : current.startMinutes;
  const end = patch.end !== undefined ? parseClock(patch.end) : current.endMinutes;
  if (start === null || end === null) {
    return { ok: false, reason: 'bad_time', detail: `times must be HH:MM (24-hour), got ${patch.start ?? ''} ${patch.end ?? ''}`.trim() };
  }
  if (end <= start) {
    return { ok: false, reason: 'end_before_start', detail: 'the end must be after the start on the same day' };
  }
  const hours: WorkHours = {
    days,
    startMinutes: start,
    endMinutes: end,
    observeHolidays: patch.observeHolidays ?? current.observeHolidays,
  };
  await workHoursDefault.set(db, userId, hours);
  return { ok: true, hours };
}
