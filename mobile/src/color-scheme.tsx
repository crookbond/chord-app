import { useEffect, useState, useSyncExternalStore } from 'react';
import { Appearance, AppState, Platform, useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { activeColorScheme, colors, setActiveColorScheme, type ColorScheme } from '@/theme';

/** ADR 0282 — follow the phone/browser, or force one. Per device. */
export type ColorSchemePreference = 'system' | 'light' | 'dark';

export const COLOR_SCHEME_KEY = 'app.colorScheme';

function parse(v: string | null | undefined): ColorSchemePreference {
  return v === 'light' || v === 'dark' ? v : 'system';
}

// The web reads its preference synchronously (localStorage is what
// AsyncStorage uses there), so the first paint is already the right colors.
let preference: ColorSchemePreference = 'system';
let loaded = Platform.OS === 'web';
if (Platform.OS === 'web') {
  try {
    preference = parse(globalThis.localStorage?.getItem(COLOR_SCHEME_KEY));
  } catch {
    // Private mode / blocked storage: follow the browser.
  }
}

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function applyNativeOverride(pref: ColorSchemePreference) {
  // Native alerts, keyboards, pickers and web views follow the override too.
  if (Platform.OS !== 'web') Appearance.setColorScheme(pref === 'system' ? null : pref);
}

if (!loaded) {
  void AsyncStorage.getItem(COLOR_SCHEME_KEY)
    .catch(() => null)
    .then((v) => {
      preference = parse(v);
      loaded = true;
      applyNativeOverride(preference);
      emit();
    });
}

export function useColorSchemePreference(): ColorSchemePreference {
  return useSyncExternalStore(subscribe, () => preference, () => preference);
}

export function setColorSchemePreference(pref: ColorSchemePreference): void {
  preference = pref;
  applyNativeOverride(pref);
  emit();
  void AsyncStorage.setItem(COLOR_SCHEME_KEY, pref).catch(() => {});
}

function systemScheme(): ColorScheme {
  if (Platform.OS === 'web') {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  return Appearance.getColorScheme() === 'dark' ? 'dark' : 'light';
}

/**
 * The scheme the app is drawn in, plus an `epoch` that changes whenever it
 * does. The root layout keys its navigator on `epoch`: styles are read
 * through getters, so a remount is what makes every screen pick the new
 * palette up. `ready` is false on native until the stored choice is read.
 */
export function useResolvedColorScheme(): { scheme: ColorScheme; epoch: number; ready: boolean } {
  const pref = useColorSchemePreference();
  const ready = useSyncExternalStore(subscribe, () => loaded, () => loaded);
  // Re-render on OS changes; the value itself is re-read below so an iOS
  // background snapshot (which flips the scheme while inactive) is ignored.
  useColorScheme();
  const [active, setActive] = useState(AppState.currentState === 'active' || Platform.OS === 'web');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    return () => sub.remove();
  }, []);
  const [webSystem, setWebSystem] = useState<ColorScheme>(systemScheme);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setWebSystem(mq.matches ? 'dark' : 'light');
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);

  const os = Platform.OS === 'web' ? webSystem : systemScheme();
  const wanted: ColorScheme = pref === 'system' ? os : pref;
  const [state, setState] = useState(() => {
    setActiveColorScheme(wanted);
    return { scheme: wanted, epoch: 0 };
  });
  useEffect(() => {
    if (!ready || !active || wanted === state.scheme) return;
    setActiveColorScheme(wanted);
    setState((s) => ({ scheme: wanted, epoch: s.epoch + 1 }));
  }, [ready, active, wanted, state.scheme]);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const el = document.documentElement;
    el.style.colorScheme = state.scheme;
    el.style.backgroundColor = colors.bg;
  }, [state.scheme]);

  return { scheme: activeColorScheme(), epoch: state.epoch, ready };
}
