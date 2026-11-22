/**
 * ADR 0057 - Apple sync orchestrator.
 *
 * Runs the on-device reconciles in order on app foreground:
 *   1. device calendar → Chord DB (so web + bot see the user's schedule),
 *   2. Chord tasks/lists → iOS Reminders (write),
 *   3. iOS Reminders changes → Chord (read-back).
 * Each step is best-effort and self-gating (no-op off iOS / web, without
 * permission, or with nothing selected), so this is safe to call unconditionally.
 */
import { useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';

import { hasSession, liveEventIds } from '../api';
import { reconcileCalendarDeletes } from '../calendar';
import { pullDeviceCalendar } from './calendar-pull';
import { pullRemindersToChord } from './reminders-pull';
import { syncRemindersFromChord } from './reminders';

export { pullDeviceCalendar } from './calendar-pull';
export {
  getDeviceGhostEventsForDay,
  listDeviceCalendars,
  getSelectedCalendarIds,
  setSelectedCalendarIds,
  type DeviceCalendarChoice,
  type DeviceGhostEvent,
} from './calendar-pull';

// Reminders sync is opt-in: it asks for the Reminders permission, so we don't
// run it (or prompt) until the user turns it on in Settings. Calendar pull is
// independently gated by the per-calendar selection.
const REMINDERS_ENABLED_KEY = 'chord:applesync:remindersEnabled';

export async function getRemindersSyncEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem(REMINDERS_ENABLED_KEY)) === '1';
}

export async function setRemindersSyncEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(REMINDERS_ENABLED_KEY, enabled ? '1' : '0');
}

let running = false;

export async function runAppleSync(): Promise<void> {
  if (running) return; // coalesce overlapping foreground events
  // Signed-out (sign-in screen, post-logout): skip - the API calls would 401
  // and we must not prompt for calendar/reminders access before login.
  if (!(await hasSession())) return;
  running = true;
  try {
    await pullDeviceCalendar().catch(() => {});
    // Chord→device delete reconcile: drop device copies for events removed in
    // Chord while the app was closed (the live SSE path can't catch those).
    // A failed lookup throws out of the reconcile - it must never read as
    // "nothing is live" and delete every device copy.
    await reconcileCalendarDeletes(liveEventIds).catch(() => {});
    if (await getRemindersSyncEnabled()) {
      await syncRemindersFromChord().catch(() => {});
      await pullRemindersToChord().catch(() => {});
    }
  } finally {
    running = false;
  }
}

// A glance at Control Centre or the app switcher passes through 'inactive'
// and back without leaving; only a return from the background counts, and not
// more often than this.
const FOREGROUND_SYNC_MIN_GAP_MS = 5 * 60_000;
let lastStartedAt = 0;

/** Run the Apple sync on mount and on a return from the background. Drop into the root layout. */
export function useAppleSync(): void {
  useEffect(() => {
    lastStartedAt = Date.now();
    void runAppleSync();
    let wasBackground = AppState.currentState === 'background';
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        wasBackground = true;
      } else if (state === 'active' && wasBackground) {
        wasBackground = false;
        if (Date.now() - lastStartedAt < FOREGROUND_SYNC_MIN_GAP_MS) return;
        lastStartedAt = Date.now();
        void runAppleSync();
      }
    });
    return () => sub.remove();
  }, []);
}
