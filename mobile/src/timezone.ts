/**
 * Report the device's IANA zone to the server on launch and on every
 * foreground.
 *
 * The daily briefing fires at `nudge_hour` in the user's `last_tz`, and that
 * column used to be written *only* when the user posted a chat message - so a
 * traveller who did not chat kept getting briefed on the zone they left. This
 * runs app-wide (not per screen): the zone is a global fact, and the screen
 * that happens to be focused says nothing about where the phone is.
 */
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { hasSession, setTimezone } from '@/api';

export function deviceTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function useReportTimezone(): void {
  // Last zone this launch successfully reported - avoids a PUT on every
  // foreground when nothing moved. Deliberately not persisted: re-reporting
  // once per launch is what catches a zone that changed while the app was
  // closed (the flight case).
  const reported = useRef<string | null>(null);

  useEffect(() => {
    const report = async () => {
      const tz = deviceTimezone();
      if (!tz || tz === reported.current) return;
      if (!(await hasSession())) return;
      try {
        await setTimezone({ tz });
        reported.current = tz;
      } catch {
        // Offline or signed out - the next foreground retries.
      }
    };
    void report();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void report();
    });
    return () => sub.remove();
  }, []);
}
