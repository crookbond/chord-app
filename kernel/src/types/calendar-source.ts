/**
 * ADR 0033 — surfaced to the mobile settings UI.
 */
import { z } from 'zod';

export interface CalendarSource {
  id: string;
  /** ADR 0057 — which backend this calendar comes from. Lets the UI tell a
   *  Google "Family" apart from a device/iCloud "Family" of the same name. */
  provider: 'google' | 'device' | 'outlook';
  /** ADR 0228 — the mailbox an Outlook calendar belongs to. */
  accountEmail?: string | null;
  googleCalendarId: string;
  summary: string | null;
  /** Display color (hex, e.g. "#4287f5") from the source calendar, when known. */
  color: string | null;
  /** ADR 0278 — the color the user picked in Chord; null = not picked. */
  colorChoice: string | null;
  /** ADR 0278 — the color Chord shows: the pick, else `color`, else Chord's palette. */
  displayColor: string;
  accessRole: string;
  isPrimary: boolean;
  selectedInGoogle: boolean;
  countsForBusyAuto: boolean | null;
  countsForBusyOverride: boolean | null;
  countsForBusyEffective: boolean;
}

export const UpdateCalendarSourceRequest = z
  .object({
    /**
     * `true` → always block time. `false` → never block. `null` → clear
     * the override and fall back to the auto value. Omitted = unchanged.
     */
    countsForBusyOverride: z.boolean().nullable().optional(),
    /** ADR 0278 — a hex color or color name; null clears the pick. Omitted = unchanged. */
    colorChoice: z.string().max(32).nullable().optional(),
  })
  .refine((b) => b.countsForBusyOverride !== undefined || b.colorChoice !== undefined, {
    message: 'nothing to change',
  });
export type UpdateCalendarSourceRequest = z.infer<typeof UpdateCalendarSourceRequest>;

/** The calendar an event with no named calendar goes on. */
export interface DefaultCalendar {
  /** The chosen calendar's id, or null when events go to the primary. */
  calendarId: string | null;
  /** Its name as Settings shows it ("primary" for the primary). */
  label: string;
}

export const SetDefaultCalendarRequest = z.object({
  /** A Google or Outlook calendar id from the sources list; null resets to the primary. */
  calendarId: z.string().max(500).nullable(),
});
export type SetDefaultCalendarRequest = z.infer<typeof SetDefaultCalendarRequest>;
