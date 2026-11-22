/**
 * ADR 0057 — Layer-0 dedup helper.
 *
 * `expo-calendar` exposes only a device-internal event id, not EventKit's
 * `calendarItemExternalIdentifier` (the calendar-server UID that is stable
 * across device copies of the same event). This thin native module surfaces it
 * so the device-calendar read-up can dedup a Google event mirrored onto the
 * device against the same event the server already pulled via the Google API.
 *
 * Degrades gracefully: on web/Android, in Expo Go, or before a dev build links
 * the native side, the module is absent and every helper returns empty — the
 * read-up then relies on the source-exclusion + fuzzy dedup layers instead.
 */
import { requireNativeModule } from 'expo-modules-core';

interface ChordEventKitNative {
  /** Map of device event id → calendarItemExternalIdentifier (omits ids with none). */
  externalIdsForEvents(eventIds: string[]): Promise<Record<string, string>>;
}

let native: ChordEventKitNative | null = null;
try {
  native = requireNativeModule<ChordEventKitNative>('ChordEventKit');
} catch {
  native = null;
}

export function isAvailable(): boolean {
  return native !== null;
}

export async function externalIdsForEvents(
  eventIds: string[],
): Promise<Record<string, string>> {
  if (!native || eventIds.length === 0) return {};
  try {
    return await native.externalIdsForEvents(eventIds);
  } catch {
    return {};
  }
}
