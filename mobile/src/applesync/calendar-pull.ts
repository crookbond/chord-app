/**
 * ADR 0057 - device-calendar read-up.
 *
 * Reads the user's *selected* device calendars over a −30/+60 day window and
 * posts them to the Chord DB (`/me/device-calendar/sync`) so web and the bot
 * see the user's real schedule even when Google isn't connected.
 *
 * Dedup against the server's own Google pull is handled server-side; here we
 * (a) exclude the connected-Google account's calendars (Layer 1 - they'd
 * duplicate the server's `gcal:` rows) and the dedicated "Chord" write
 * calendar, and (b) attach EventKit's `calendarItemExternalIdentifier` via the
 * chord-eventkit native module (Layer 0 dedup key) when available.
 *
 * Web is a no-op (no device calendar). iOS + Android only.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Calendar from 'expo-calendar';
import { Platform } from 'react-native';

import { isGoogleBackedSource, type DeviceCalendarSyncRequest } from '@chord/kernel';

import { externalIdsForEvents } from '../../modules/chord-eventkit';
import { getCalendarStatus, getMe, syncDeviceCalendar } from '../api';
import { CHORD_CALENDAR_TITLE } from '../calendar';
import { useApp } from '../store';

const SELECTED_KEY = 'chord:applesync:selectedCalendars';
// −30/+90: symmetric with the Google pull (ADR 0072). The sync batch cap
// (5,000 events) has ample headroom at this width.
const PAST_DAYS = 30;
const FUTURE_DAYS = 90;

export interface DeviceCalendarChoice {
  id: string;
  title: string;
  sourceName: string;
  sourceType: string;
  allowsModifications: boolean;
  /** Calendar display color (hex), when the platform exposes it. */
  color: string | null;
  /** Heuristic: looks like a Google (CalDAV) account calendar. */
  isGoogle: boolean;
}

// ADR 0263 - one rule for both phones: an Android Google calendar is not CalDAV.
const looksGoogle = isGoogleBackedSource;

/** All device calendars the user could opt into (for the settings UI). */
export async function listDeviceCalendars(): Promise<DeviceCalendarChoice[]> {
  if (Platform.OS === 'web') return [];
  const { status } = await Calendar.requestCalendarPermissionsAsync();
  if (status !== 'granted') return [];
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  return calendars
    .filter((c) => c.title !== CHORD_CALENDAR_TITLE)
    .map((c) => ({
      id: c.id,
      title: c.title,
      sourceName: c.source?.name ?? '',
      sourceType: c.source?.type ?? 'unknown',
      allowsModifications: c.allowsModifications !== false,
      color: c.color ?? null,
      isGoogle: looksGoogle(c.source),
    }));
}

export async function getSelectedCalendarIds(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(SELECTED_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export async function setSelectedCalendarIds(ids: string[]): Promise<void> {
  await AsyncStorage.setItem(SELECTED_KEY, JSON.stringify([...new Set(ids)]));
}

/**
 * A phone-only event rendered locally as a "ghost" block in the calendar grid
 * (ADR 0072 addendum). Read on-device at render time, NEVER uploaded - the
 * ADR 0057 posture (nothing leaves the device without opt-in) holds; the user
 * just gets to SEE their whole day instead of a bare conflict glyph.
 */
export interface DeviceGhostEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  calendarTitle: string;
  /** The device calendar's display color (hex), when the platform exposes it. */
  calendarColor: string | null;
}

/**
 * Timed events for [dayStart, dayEnd) from phone calendars Chord does NOT
 * already ingest: skips the Chord write calendar, mirrored calendars (their
 * events arrive via the device sync), and the connected Google account's
 * calendars (they arrive via the Google sync). Fails soft to [] - ghosts are
 * garnish, never worth an error state.
 */
export async function getDeviceGhostEventsForDay(
  dayStart: Date,
  dayEnd: Date,
): Promise<DeviceGhostEvent[]> {
  if (Platform.OS === 'web') return [];
  try {
    const { status } = await Calendar.getCalendarPermissionsAsync();
    if (status !== 'granted') return [];

    const [calendars, mirroredIds] = await Promise.all([
      Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT),
      getSelectedCalendarIds(),
    ]);
    const mirrored = new Set(mirroredIds);

    let connectedGoogleEmail: string | null = null;
    try {
      const [me, calStatus] = await Promise.all([
        useApp.getState().user ?? getMe(),
        getCalendarStatus(),
      ]);
      if (calStatus.connected) connectedGoogleEmail = (me?.email ?? '').toLowerCase() || null;
    } catch {
      connectedGoogleEmail = null;
    }

    const titleById = new Map(calendars.map((c) => [c.id, c.title]));
    const colorById = new Map(calendars.map((c) => [c.id, c.color ?? null]));
    const eligible = calendars.filter((c) => {
      if (c.title === CHORD_CALENDAR_TITLE) return false;
      if (mirrored.has(c.id)) return false;
      if (connectedGoogleEmail) {
        const name = (c.source?.name ?? '').toLowerCase();
        if (looksGoogle(c.source) && name.includes(connectedGoogleEmail)) return false;
      }
      return true;
    });
    if (eligible.length === 0) return [];

    const events = await Calendar.getEventsAsync(
      eligible.map((c) => c.id),
      dayStart,
      dayEnd,
    );
    return events
      .filter((e) => !e.allDay)
      .map((e) => {
        const occ = e as typeof e & { instanceStartDate?: string | Date };
        return {
          id: occ.instanceStartDate ? `${e.id}:${toIso(occ.instanceStartDate)}` : e.id,
          title: e.title ?? '(untitled)',
          startsAt: toIso(e.startDate),
          endsAt: e.endDate ? toIso(e.endDate) : null,
          allDay: false,
          calendarTitle: titleById.get(e.calendarId) ?? '',
          calendarColor: colorById.get(e.calendarId) ?? null,
        };
      });
  } catch {
    return [];
  }
}

function toIso(d: string | Date): string {
  return (d instanceof Date ? d : new Date(d)).toISOString();
}

function mapStatus(s: string | undefined): 'confirmed' | 'tentative' | 'cancelled' | undefined {
  if (s === Calendar.EventStatus.CONFIRMED) return 'confirmed';
  if (s === Calendar.EventStatus.TENTATIVE) return 'tentative';
  if (s === Calendar.EventStatus.CANCELED) return 'cancelled';
  return undefined;
}

type Availability = 'busy' | 'free' | 'tentative' | 'unavailable' | 'notSupported';

/** EventKit's per-event show-me-as signal - 'free' means "never a conflict". */
function mapAvailability(a: string | undefined): Availability | undefined {
  switch (a) {
    case Calendar.Availability.BUSY:
      return 'busy';
    case Calendar.Availability.FREE:
      return 'free';
    case Calendar.Availability.TENTATIVE:
      return 'tentative';
    case Calendar.Availability.UNAVAILABLE:
      return 'unavailable';
    case Calendar.Availability.NOT_SUPPORTED:
      return 'notSupported';
    default:
      return undefined;
  }
}

export interface PullResult {
  pulled: boolean;
  inserted?: number;
  updated?: number;
  deduped?: number;
  deleted?: number;
}

/**
 * Read the selected device calendars and push them to the server. No-op (and
 * `pulled: false`) on web, without permission, or when the user hasn't selected
 * any calendars yet.
 */
export async function pullDeviceCalendar(): Promise<PullResult> {
  if (Platform.OS === 'web') return { pulled: false };

  const selected = new Set(await getSelectedCalendarIds());
  if (selected.size === 0) return { pulled: false };

  const { status } = await Calendar.requestCalendarPermissionsAsync();
  if (status !== 'granted') return { pulled: false };

  // Layer 1 - exclude the connected-Google account's calendars (the server
  // already pulls those via the Google API) and the Chord write calendar.
  let connectedGoogleEmail: string | null = null;
  try {
    const [me, calStatus] = await Promise.all([
      useApp.getState().user ?? getMe(),
      getCalendarStatus(),
    ]);
    if (calStatus.connected) connectedGoogleEmail = (me?.email ?? '').toLowerCase() || null;
  } catch {
    connectedGoogleEmail = null;
  }

  const allCalendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const syncing = allCalendars.filter((c) => {
    if (!selected.has(c.id)) return false;
    if (c.title === CHORD_CALENDAR_TITLE) return false;
    if (connectedGoogleEmail) {
      const name = (c.source?.name ?? '').toLowerCase();
      if (looksGoogle(c.source) && name.includes(connectedGoogleEmail)) return false;
    }
    return true;
  });
  if (syncing.length === 0) return { pulled: false };

  const now = Date.now();
  const windowStart = new Date(now - PAST_DAYS * 86_400_000);
  const windowEnd = new Date(now + FUTURE_DAYS * 86_400_000);

  const calendarIds = syncing.map((c) => c.id);
  const rawEvents = await Calendar.getEventsAsync(calendarIds, windowStart, windowEnd);

  // Layer 0 - attach the stable server UID when the native module is present.
  const externalIds = await externalIdsForEvents(rawEvents.map((e) => e.id));

  const events: DeviceCalendarSyncRequest['events'] = rawEvents.map((e) => {
    // Recurring events: expo-calendar returns each occurrence as a separate
    // object that SHARES the series `id` (they differ by instanceStartDate).
    // Key the row by id+occurrence so occurrences don't collapse onto one
    // external_uid (which silently hid every instance but the last).
    const occ = e as typeof e & { instanceStartDate?: string | Date };
    const deviceEventId = occ.instanceStartDate
      ? `${e.id}:${toIso(occ.instanceStartDate)}`
      : e.id;
    return {
    deviceCalendarId: e.calendarId,
    deviceEventId,
    externalId: externalIds[e.id] ?? null,
    title: e.title ?? '(untitled)',
    startsAt: toIso(e.startDate),
    endsAt: e.endDate ? toIso(e.endDate) : null,
    allDay: e.allDay ?? false,
    location: e.location ?? null,
    description: e.notes ?? null,
    status: mapStatus(e.status),
    availability: mapAvailability(e.availability),
    updatedAt: e.lastModifiedDate ? toIso(e.lastModifiedDate) : null,
    };
  });

  const batch: DeviceCalendarSyncRequest = {
    calendars: syncing.map((c) => ({
      deviceCalendarId: c.id,
      title: c.title,
      color: c.color ?? null,
      allowsModifications: c.allowsModifications !== false,
    })),
    events,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    // iOS sends an all-day event as the instant of local midnight, Android as
    // UTC midnight; the server needs this zone to read the iOS one's date.
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };

  const result = await syncDeviceCalendar(batch);
  return { pulled: true, ...result };
}
