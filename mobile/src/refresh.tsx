/**
 * Screen refresh, ADR 0082 companion.
 *
 * Two gaps this closes:
 *
 * 1. `useFocusEffect` is a *navigator* event - it does not fire when the app
 *    returns from the background to an already-focused screen. Combined with
 *    SSE streams that now park while backgrounded (and a hub with no replay,
 *    ADR 0002), a screen left open overnight would show yesterday's fetch until
 *    you switched tabs.
 * 2. There was no manual refresh anywhere. Pull-down is the gesture people
 *    reach for by reflex when something looks stale or wrong.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { AppState, RefreshControl, type RefreshControlProps } from 'react-native';

import { checkConnection, isOnline, onNetworkChange } from '@/network';
import { colors } from '@/theme';

/**
 * Re-run `load` when the app comes back from the background, but only for the
 * focused screen - every mounted screen firing at once would stampede the API.
 * `load` must be stable (wrap it in `useCallback`).
 */
export function useForegroundRefresh(load: () => void | Promise<void>): void {
  const focused = useRef(false);
  const backgrounded = useRef(false);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
      };
    }, []),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      // Only a real background round-trip counts. 'inactive' fires for the app
      // switcher and Control Centre, and the 'active' that follows it is not a
      // return from anywhere - refetching there would hit the API on a glance.
      if (state === 'background') {
        backgrounded.current = true;
      } else if (state === 'active' && backgrounded.current) {
        backgrounded.current = false;
        // Offline, the saved data stays; the reconnect below reloads (ADR 0311).
        if (focused.current && isOnline()) void load();
      }
    });
    const stop = onNetworkChange((online) => {
      if (online && focused.current) void load();
    });
    return () => {
      sub.remove();
      stop();
    };
  }, [load]);
}

/**
 * Pull-to-refresh state plus the foreground refetch above - the two manual/
 * automatic halves of "show me current data". Spread the returned control onto
 * a scrollable: `<FlatList refreshControl={refreshControl} />`.
 */
export function useScreenRefresh(load: () => void | Promise<void>): {
  refreshing: boolean;
  onRefresh: () => void;
  refreshControl: React.ReactElement<RefreshControlProps>;
} {
  const [refreshing, setRefreshing] = useState(false);
  // A pull that resolves instantly reads as "nothing happened" - the spinner
  // has to be visible long enough to register as a response to the gesture.
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    // Offline, a pull checks the server once; if it is back, the reconnect
    // reloads the screen through `useForegroundRefresh`.
    const work = isOnline() ? load() : checkConnection();
    void Promise.all([work, new Promise((r) => setTimeout(r, 350))]).finally(() =>
      setRefreshing(false),
    );
  }, [load]);

  useForegroundRefresh(load);

  return {
    refreshing,
    onRefresh,
    refreshControl: (
      <RefreshControl
        refreshing={refreshing}
        onRefresh={onRefresh}
        tintColor={colors.muted}
        colors={[colors.accent]}
        progressBackgroundColor={colors.card}
      />
    ),
  };
}
