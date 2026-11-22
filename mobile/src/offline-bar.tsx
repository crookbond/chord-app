/**
 * ADR 0311 - one notice that the app is offline and showing saved data, in
 * place of every screen reporting its own failed request. Tapping it checks
 * the server now.
 *
 * A strip above the screens, not a floating pill: anything floating covers a
 * header, a date or a composer on some screen. The strip takes the status-bar
 * inset itself and hands the screens a zero top inset, so their headers sit
 * directly under it instead of padding for the status bar twice.
 */
import { createContext, useContext, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { usePathname } from 'expo-router';

import { checkConnection, useOnline } from '@/network';
import { themed } from '@/theme';

/**
 * How tall the strip is above the screens (0 when hidden). A screen that pads
 * for the keyboard from its header's height must add this, or on iPhone its
 * bottom box ends up under the keyboard by exactly the strip.
 */
const StripHeight = createContext(0);

export function useOfflineStripHeight(): number {
  return useContext(StripHeight);
}

export function OfflineFrame({ children }: { children: ReactNode }) {
  const online = useOnline();
  const path = usePathname();
  const insets = useSafeAreaInsets();
  const [stripHeight, setStripHeight] = useState(0);
  const [checking, setChecking] = useState(false);
  // The landing page says it in its own words. Not keyed on the signed-in
  // user: a web reload of a deep link renders the screen without the launch
  // route ever filling it in.
  const show = !online && path !== '/';

  // Same tree either way: changing its shape would remount the navigator and
  // drop the history every time the network came or went.
  return (
    <View style={styles.root}>
      {show ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Offline, showing saved data. Tap to try again."
          disabled={checking}
          onPress={() => {
            setChecking(true);
            void checkConnection().finally(() => setChecking(false));
          }}
          style={[styles.strip, { paddingTop: insets.top + 3 }]}
          onLayout={(e) => setStripHeight(e.nativeEvent.layout.height)}
        >
          <Text style={styles.text}>
            {checking ? 'Checking…' : 'Offline · showing saved data · tap to retry'}
          </Text>
        </Pressable>
      ) : null}
      <SafeAreaInsetsContext.Provider value={show ? { ...insets, top: 0 } : insets}>
        <StripHeight.Provider value={show ? stripHeight : 0}>
          <View style={styles.root}>{children}</View>
        </StripHeight.Provider>
      </SafeAreaInsetsContext.Provider>
    </View>
  );
}

const styles = themed((colors) => ({
  root: { flex: 1 },
  strip: {
    backgroundColor: colors.amberBg,
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    paddingBottom: 4,
    alignItems: 'center',
  },
  text: { color: colors.text, fontSize: 12, fontWeight: '600' },
}));
