/**
 * ADR 0258 - ask the phone (or browser) where it is, and tell the server.
 *
 * Chord asks, once, for the approximate location. If the person allows it the
 * forecast in their morning briefing follows them; if they do not, the server
 * falls back to the network address and then the time zone, as before. Nothing
 * here runs, and nothing is sent, until they have said yes.
 *
 * `expo-location` is a native module, so a phone running a build made before it
 * shipped does not have it. It is loaded lazily and every function degrades to
 * "unsupported" rather than throwing - an OTA update must not crash an old build.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';

import { hasSession, reportDeviceLocation, stopDeviceLocation } from '@/api';
import { importIfNative } from '@/optional-native';

export type LocationPermission = 'granted' | 'denied' | 'undetermined' | 'unsupported';

const ENABLED_KEY = 'chord.location.enabled'; // '1' = the person turned it on, '0' = off
const ASKED_KEY = 'chord.location.asked'; // the one-time ask has been shown
const SYNC_MIN_GAP_MS = 30 * 60 * 1000;

type LocationModule = typeof import('expo-location');
let nativeModule: LocationModule | null | undefined;

async function native(): Promise<LocationModule | null> {
  if (Platform.OS === 'web') return null;
  if (nativeModule !== undefined) return nativeModule;
  // A build that predates the module gets null, not a fatal load (see optional-native).
  nativeModule = await importIfNative('ExpoLocation', () => import('expo-location'));
  return nativeModule;
}

const hasBrowserLocation = (): boolean =>
  Platform.OS === 'web' && typeof navigator !== 'undefined' && !!navigator.geolocation;

export async function locationSupported(): Promise<boolean> {
  return hasBrowserLocation() || !!(await native());
}

export async function locationPermission(): Promise<LocationPermission> {
  if (hasBrowserLocation()) {
    try {
      const status = await (navigator as Navigator).permissions?.query({ name: 'geolocation' as PermissionName });
      if (status?.state === 'granted') return 'granted';
      if (status?.state === 'denied') return 'denied';
    } catch {
      /* some browsers cannot be asked without prompting */
    }
    return 'undetermined';
  }
  const mod = await native();
  if (!mod) return 'unsupported';
  try {
    const p = await mod.getForegroundPermissionsAsync();
    return p.granted ? 'granted' : p.canAskAgain ? 'undetermined' : 'denied';
  } catch {
    return 'unsupported';
  }
}

export interface Fix {
  lat: number;
  lon: number;
  place?: string;
}

/** The phone's approximate position and, when it can name it, the city. */
async function currentFix(): Promise<Fix | null> {
  if (hasBrowserLocation()) {
    return await new Promise<Fix | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: false, maximumAge: 6 * 60 * 60 * 1000, timeout: 10_000 },
      );
    });
  }
  const mod = await native();
  if (!mod) return null;
  try {
    // A city is all a forecast needs, so ask for the least precise fix there is.
    const pos =
      (await mod.getLastKnownPositionAsync({ maxAge: 6 * 60 * 60 * 1000 })) ??
      (await mod.getCurrentPositionAsync({ accuracy: mod.Accuracy.Low }));
    if (!pos) return null;
    const fix: Fix = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    try {
      const [r] = await mod.reverseGeocodeAsync({ latitude: fix.lat, longitude: fix.lon });
      const name = r?.city ?? r?.subregion ?? r?.region;
      if (name) fix.place = name;
    } catch {
      /* the server names it from the time zone instead */
    }
    return fix;
  } catch {
    return null;
  }
}

export async function locationAsked(): Promise<boolean> {
  return (await AsyncStorage.getItem(ASKED_KEY).catch(() => null)) === '1';
}

export async function markLocationAsked(): Promise<void> {
  await AsyncStorage.setItem(ASKED_KEY, '1').catch(() => {});
}

export async function locationEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem(ENABLED_KEY).catch(() => null)) === '1';
}

let lastSyncAt = 0;

/** Send the current fix to the server, if the person turned this on and the OS still allows it. */
export async function syncDeviceLocation(opts: { force?: boolean } = {}): Promise<boolean> {
  if (!(await locationEnabled())) return false;
  if (!opts.force && Date.now() - lastSyncAt < SYNC_MIN_GAP_MS) return false;
  if (!(await hasSession())) return false;

  if ((await locationPermission()) !== 'granted') {
    // Revoked in the phone's settings: stop using a fix we are no longer allowed to read.
    await disableDeviceLocation();
    return false;
  }
  const fix = await currentFix();
  if (!fix) return false;
  try {
    await reportDeviceLocation(fix);
    lastSyncAt = Date.now();
    return true;
  } catch {
    return false; // offline; the next foreground retries
  }
}

/** The person said yes: ask the OS, and if it agrees, start using the fix. */
export async function enableDeviceLocation(): Promise<LocationPermission> {
  await markLocationAsked();
  if (hasBrowserLocation()) {
    // The browser prompts the first time we read a position.
    const fix = await currentFix();
    if (!fix) return (await locationPermission()) === 'denied' ? 'denied' : 'undetermined';
    await AsyncStorage.setItem(ENABLED_KEY, '1').catch(() => {});
    await syncDeviceLocation({ force: true });
    return 'granted';
  }
  const mod = await native();
  if (!mod) return 'unsupported';
  let granted = false;
  try {
    granted = (await mod.requestForegroundPermissionsAsync()).granted;
  } catch {
    return 'unsupported';
  }
  if (!granted) return 'denied';
  await AsyncStorage.setItem(ENABLED_KEY, '1').catch(() => {});
  await syncDeviceLocation({ force: true });
  return 'granted';
}

/** Turn it off in Chord (the OS permission itself is the phone's to revoke). */
export async function disableDeviceLocation(): Promise<void> {
  await AsyncStorage.setItem(ENABLED_KEY, '0').catch(() => {});
  try {
    await stopDeviceLocation();
  } catch {
    /* offline: the server keeps the last fix until the next call */
  }
}

/** Keep the server's fix fresh while the app is in use (launch + every foreground). */
export function useSyncDeviceLocation(): void {
  useEffect(() => {
    void syncDeviceLocation();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void syncDeviceLocation();
    });
    return () => sub.remove();
  }, []);
}
