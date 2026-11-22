/**
 * Device-calendar sync (ADR 0012, gated by ADR 0015/0040). Pushes events and
 * trips into the user's native calendar so Chord-created items show up
 * alongside everything else they already use.
 *
 * FALLBACK ONLY: when the user has connected Google Calendar with write scope,
 * the server pushes their events to Google (ADR 0040) and the OS mirrors them
 * onto the device automatically - writing here too would double every entry,
 * and the device copy is invisible to the server (so Telegram + nudges can't
 * see it). So this client write runs only for users WITHOUT Google connected.
 * The gate is set from the calendar-status fetch via setGoogleHandlesDeviceSync.
 *
 * One-way: Chord → device. We never read back, never delete, never reconcile.
 * Idempotent on event/trip id via AsyncStorage so repeated SSE deliveries
 * (same group open in multiple places, reconnects) don't double-add.
 *
 * Web is a no-op - expo-calendar isn't supported there.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Calendar from 'expo-calendar';
import { Platform } from 'react-native';

import { isGoogleBackedSource, pickAndroidWriteCalendar, type GroupEvent, type Trip } from '@chord/kernel';

import { allEntries, getByChordId, removeByChordId, setMapping } from './applesync/idmap';
import { onSignOut } from './sign-out';

const SYNCED_KEY = 'chord:calendar:synced';
/** ADR 0057 - the namespace for the Chord-event → device-event id-map (used so
 *  event.updated/deleted can address the device copy, not just first-write). */
const EVENT_NS = 'event';
export const CHORD_CALENDAR_TITLE = 'Chord';

let cachedCalendarId: string | undefined;
let permissionPromise: Promise<boolean> | undefined;
let syncedIds: Set<string> | undefined;

// When true, the server is syncing this user's events to Google and the OS
// mirrors them onto the device - so the client-side writes below are skipped to
// avoid duplicates. Defaults false (write) so users without Google connected
// still get device entries. Kept fresh by the calendar-status fetch (api.ts).
let googleHandlesDeviceSync = false;
onSignOut(() => {
  cachedCalendarId = undefined;
  syncedIds = undefined;
  googleHandlesDeviceSync = false;
});
export function setGoogleHandlesDeviceSync(handled: boolean): void {
  googleHandlesDeviceSync = handled;
}

async function loadSyncedIds(): Promise<Set<string>> {
  if (syncedIds) return syncedIds;
  try {
    const raw = await AsyncStorage.getItem(SYNCED_KEY);
    syncedIds = new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    syncedIds = new Set();
  }
  return syncedIds;
}

async function markSynced(id: string): Promise<void> {
  const set = await loadSyncedIds();
  if (set.has(id)) return;
  set.add(id);
  try {
    await AsyncStorage.setItem(SYNCED_KEY, JSON.stringify([...set]));
  } catch {
    // best-effort; in-memory dedupe still holds for the session
  }
}

async function ensurePermission(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  if (permissionPromise) return permissionPromise;
  permissionPromise = (async () => {
    const { status } = await Calendar.requestCalendarPermissionsAsync();
    return status === 'granted';
  })();
  return permissionPromise;
}

/**
 * Returns iOS calendar source ids ordered by likelihood of accepting a
 * new writable calendar: existing-Chord-calendar's source first (we
 * already wrote there), then the default source, then any LOCAL source,
 * then iCloud / CalDAV. Subscribed/Birthday/Exchange sources are
 * skipped - they reliably throw "That account does not allow calendars
 * to be added or removed."
 */
async function iosWritableSourceCandidates(): Promise<string[]> {
  if (Platform.OS !== 'ios') return [];
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  const ids = new Set<string>();

  // 1. Source of the Chord calendar if it already exists.
  const existing = calendars.find((c) => c.title === CHORD_CALENDAR_TITLE);
  if (existing?.source?.id) ids.add(existing.source.id);

  // 2. Default source (most users - but the source we crashed on).
  try {
    const def = await Calendar.getDefaultCalendarAsync();
    if (def.source?.id) ids.add(def.source.id);
  } catch {
    // No default calendar configured - nothing to add.
  }

  // 3. Walk every calendar's source. LOCAL is preferred (always
  // writable, lives only on the device), then CALDAV/iCloud.
  const score = (s: { type?: string } | undefined) => {
    if (!s?.type) return 5;
    if (s.type === Calendar.SourceType.LOCAL) return 1;
    if (s.type === Calendar.SourceType.CALDAV) return 2;
    if (s.type === Calendar.SourceType.EXCHANGE) return 4;
    if (s.type === Calendar.SourceType.SUBSCRIBED) return 9; // likely fails
    if (s.type === Calendar.SourceType.BIRTHDAYS) return 9;
    return 5;
  };
  const sorted = [...calendars]
    .filter((c) => c.allowsModifications !== false && c.source?.id)
    .sort((a, b) => score(a.source) - score(b.source));
  for (const c of sorted) {
    if (c.source?.id) ids.add(c.source.id);
  }
  return Array.from(ids);
}

async function ensureChordCalendar(): Promise<string | null> {
  if (cachedCalendarId) return cachedCalendarId;
  try {
    const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
    const existing = calendars.find((c) => c.title === CHORD_CALENDAR_TITLE);
    if (existing) {
      cachedCalendarId = existing.id;
      return existing.id;
    }

    // Create a dedicated Chord calendar so users can show/hide / delete
    // it without touching their other calendars. iOS rejects creation
    // on Subscribed / Birthday / read-only sources with "That account
    // does not allow calendars to be added or removed" - fall through
    // candidates until one accepts.
    if (Platform.OS === 'ios') {
      const candidates = await iosWritableSourceCandidates();
      for (const sourceId of candidates) {
        try {
          const id = await Calendar.createCalendarAsync({
            title: CHORD_CALENDAR_TITLE,
            color: '#7C5CFF',
            entityType: Calendar.EntityTypes.EVENT,
            sourceId,
            name: CHORD_CALENDAR_TITLE,
            ownerAccount: 'chord',
            accessLevel: Calendar.CalendarAccessLevel.OWNER,
          });
          cachedCalendarId = id;
          return id;
        } catch (err) {
          console.warn(
            `ensureChordCalendar: source ${sourceId} rejected, trying next`,
            err,
          );
        }
      }
      console.warn(
        'ensureChordCalendar: no iOS calendar source accepted creation; calendar sync disabled',
      );
      return null;
    }

    // Android: a fresh LOCAL source always works.
    const id = await Calendar.createCalendarAsync({
      title: CHORD_CALENDAR_TITLE,
      color: '#7C5CFF',
      entityType: Calendar.EntityTypes.EVENT,
      source: { isLocalAccount: true, name: 'Chord', type: Calendar.SourceType.LOCAL },
      name: CHORD_CALENDAR_TITLE,
      ownerAccount: 'chord',
      accessLevel: Calendar.CalendarAccessLevel.OWNER,
    });
    cachedCalendarId = id;
    return id;
  } catch (err) {
    console.warn('ensureChordCalendar failed; calendar sync disabled', err);
    return null;
  }
}

/** A Google account calendar on the phone - the phone syncs writes to it up to
 *  Google, so a Chord event written here reaches the user's real Google
 *  calendar with no OAuth token (ADR 0057). */
const looksGoogleSource = isGoogleBackedSource;

/**
 * ADR 0057 - pick the calendar Chord writes events into. Resolution order:
 *   1. the user's Google-backed (CalDAV) writable calendar - so iOS pushes the
 *      event up to their real Google calendar without an OAuth token;
 *   2. their default/primary device calendar;
 *   3. the dedicated "Chord" calendar (created on a local/iCloud source).
 * Only runs in the no-Google-connected path (the caller gates on
 * googleHandlesDeviceSync). Returns null when nothing is writable.
 */
async function resolveWriteCalendarId(): Promise<string | null> {
  if (Platform.OS === 'android') {
    // ADR 0263 - same order as below; Android has no "default calendar" call.
    try {
      const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
      const picked = pickAndroidWriteCalendar(calendars, CHORD_CALENDAR_TITLE);
      if (picked) return picked;
    } catch (err) {
      console.warn('resolveWriteCalendarId failed; falling back to Chord calendar', err);
    }
    return ensureChordCalendar();
  }
  if (Platform.OS !== 'ios') return ensureChordCalendar();
  try {
    const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
    const writable = calendars.filter(
      (c) => c.allowsModifications !== false && c.title !== CHORD_CALENDAR_TITLE,
    );

    // 1. Prefer a writable Google calendar; the default one first if it's Google.
    let def: Calendar.Calendar | undefined;
    try {
      def = await Calendar.getDefaultCalendarAsync();
    } catch {
      def = undefined;
    }
    if (def && looksGoogleSource(def.source) && def.allowsModifications !== false) return def.id;
    const googleWritable = writable.find((c) => looksGoogleSource(c.source));
    if (googleWritable) return googleWritable.id;

    // 2. The default/primary device calendar.
    if (def && def.allowsModifications !== false) return def.id;
  } catch (err) {
    console.warn('resolveWriteCalendarId failed; falling back to Chord calendar', err);
  }
  // 3. Sandboxed Chord calendar.
  return ensureChordCalendar();
}

/** Find the existing "Chord" device calendar without creating it. */
async function findChordCalendarId(): Promise<string | null> {
  const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  return calendars.find((c) => c.title === CHORD_CALENDAR_TITLE)?.id ?? null;
}

/**
 * ADR 0057 migration shim - adopt an event the *old* one-way write-down already
 * put on the device (tracked only in the legacy `chord:calendar:synced` Set, with
 * no stored device id) into the id-map, so the upgraded client patches it instead
 * of creating a duplicate. The old path stamped `… (event:<id>)` in the notes and
 * always wrote to the "Chord" calendar, so we find it there by that marker, in a
 * window around the event's date. Returns the device event id, or null if it's
 * gone (user deleted it) - in which case the caller creates fresh.
 */
async function adoptLegacyDeviceEvent(event: GroupEvent): Promise<string | null> {
  const chordCalId = await findChordCalendarId();
  if (!chordCalId) return null;
  const start = new Date(event.startsAt);
  const endBase = event.endsAt ? new Date(event.endsAt) : start;
  const lo = new Date(start.getTime() - 3 * 86_400_000);
  const hi = new Date(endBase.getTime() + 3 * 86_400_000);
  const marker = `(event:${event.id})`;
  try {
    const events = await Calendar.getEventsAsync([chordCalId], lo, hi);
    return events.find((e) => (e.notes ?? '').includes(marker))?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Write a Chord event to the device (upsert). On first sight it's created and
 * the device id is remembered (id-map); a later `event.updated` patches that
 * same device event instead of adding a duplicate. Targets the user's Google
 * calendar when present (ADR 0057). No-op when Google is connected to Chord
 * (the server pushes to Google and the OS mirrors it back).
 */
export async function syncEventToCalendar(event: GroupEvent): Promise<void> {
  if (Platform.OS === 'web') return;
  if (googleHandlesDeviceSync) return; // Google → device sync covers it

  if (!(await ensurePermission())) return;

  const start = new Date(event.startsAt);
  // GroupEvent's optional end; default to a 1h block when absent.
  const end = event.endsAt ? new Date(event.endsAt) : new Date(start.getTime() + 60 * 60 * 1000);
  const details = {
    title: event.title,
    startDate: start,
    endDate: end,
    location: event.location,
    notes: `Synced from Chord (event:${event.id})`,
    timeZone: undefined,
    // Free when the server says so - e.g. a family member's ticket you are not
    // travelling on (ADR 0289 addendum). Both iOS and Android honour it.
    availability:
      event.transparency === 'transparent' ? Calendar.Availability.FREE : Calendar.Availability.BUSY,
  };

  try {
    const existing = await getByChordId(EVENT_NS, event.id);
    if (existing) {
      await Calendar.updateEventAsync(existing.ekId, details);
      return;
    }

    // Pre-upgrade adoption: if the legacy one-way path already wrote this event
    // to the device, reuse that copy rather than duplicating it.
    const legacy = await loadSyncedIds();
    if (legacy.has(`event:${event.id}`)) {
      const adoptedId = await adoptLegacyDeviceEvent(event);
      if (adoptedId) {
        await Calendar.updateEventAsync(adoptedId, details);
        await setMapping(EVENT_NS, event.id, adoptedId);
        return;
      }
      // Not found on the device anymore - fall through and create fresh.
    }

    const ekId = await resolveWriteCalendarId().then((calendarId) =>
      calendarId ? Calendar.createEventAsync(calendarId, details) : null,
    );
    if (ekId) await setMapping(EVENT_NS, event.id, ekId);
  } catch (err) {
    // Best-effort. Calendar can fail for permission revocation, locked DB, a
    // since-deleted device event (stale id-map), etc.
    console.warn('syncEventToCalendar failed', err);
  }
}

/**
 * ADR 0057 - remove a Chord event's device copy on `event.deleted`. Best-effort:
 * a missing id-map entry or already-deleted device event is a no-op.
 */
export async function removeEventFromCalendar(eventId: string): Promise<void> {
  if (Platform.OS === 'web') return;
  if (googleHandlesDeviceSync) return;
  const existing = await getByChordId(EVENT_NS, eventId);
  if (!existing) return;
  try {
    await Calendar.deleteEventAsync(existing.ekId);
  } catch (err) {
    console.warn('removeEventFromCalendar failed', err);
  } finally {
    await removeByChordId(EVENT_NS, eventId);
  }
}

/**
 * ADR 0057 - reconcile Chord→device deletes. The per-event `event.deleted` SSE
 * (removeEventFromCalendar) only fires when the app is live; a delete that lands
 * while it's closed would otherwise leave a stale device copy forever. Run every
 * foreground: any Chord event we wrote to the device (id-map) that no longer
 * exists in Chord gets removed from the device. Mirrors the Reminders sync's
 * delete-detection. `whichAreLive` asks the server about exactly the ids we
 * wrote - never a diff against `/me/events`, which is a date window: an event
 * outside it is not deleted, just not listed. No-op when Google handles
 * device sync (deletes propagate Google→device via the OS).
 */
export async function reconcileCalendarDeletes(
  whichAreLive: (ids: string[]) => Promise<Set<string>>,
): Promise<void> {
  if (Platform.OS === 'web') return;
  if (googleHandlesDeviceSync) return;
  if (!(await ensurePermission())) return;
  const entries = await allEntries(EVENT_NS);
  if (entries.length === 0) return;
  const live = await whichAreLive(entries.map((e) => e.chordId));
  for (const { chordId, entry } of entries) {
    if (live.has(chordId)) continue;
    try {
      await Calendar.deleteEventAsync(entry.ekId);
    } catch {
      // already gone on the device
    }
    await removeByChordId(EVENT_NS, chordId);
  }
}

export async function syncTripToCalendar(trip: Trip): Promise<void> {
  if (Platform.OS === 'web') return;
  if (googleHandlesDeviceSync) return; // Google → device sync covers it
  const synced = await loadSyncedIds();
  const key = `trip:${trip.id}`;
  if (synced.has(key)) return;

  if (!(await ensurePermission())) return;
  const calendarId = await ensureChordCalendar();
  if (!calendarId) return;

  const start = new Date(`${trip.startDate}T00:00:00`);
  // expo-calendar all-day events expect endDate exclusive on Android/iOS;
  // add a day to make the block inclusive of the user-stated end date.
  const end = new Date(`${trip.endDate}T00:00:00`);
  end.setDate(end.getDate() + 1);
  try {
    await Calendar.createEventAsync(calendarId, {
      title: `${trip.name} - ${trip.destination}`,
      startDate: start,
      endDate: end,
      allDay: true,
      notes: `Synced from Chord (trip:${trip.id})`,
    });
    await markSynced(key);
  } catch (err) {
    console.warn('syncTripToCalendar failed', err);
  }
}
