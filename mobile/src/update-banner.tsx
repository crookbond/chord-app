/**
 * ADR 0216 — offer a reload when a new OTA update is downloaded.
 *
 * expo-updates only checks at a cold launch and applies what it downloads at
 * the NEXT cold launch, so someone who never force-quits can run an old build
 * for days. This checks again when the app returns to the foreground and,
 * once an update is downloaded, offers it. It never reloads on its own: a
 * reload drops whatever is on screen, like a half-written message.
 */
import { useEffect, useRef, useState } from 'react';
import { AppState, Platform, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Updates from 'expo-updates';
import { shouldCheckForUpdate, shouldShowUpdateBanner, updateDismissKey } from '@chord/kernel';

import { themed } from '@/theme';

export function UpdateBanner() {
  // Web is served fresh on every load, and a dev build has no update server.
  if (Platform.OS === 'web' || __DEV__ || !Updates.isEnabled) return null;
  return <UpdateBannerInner />;
}

function UpdateBannerInner() {
  const { isUpdatePending, downloadedUpdate } = Updates.useUpdates();
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const lastCheck = useRef(Date.now());
  const insets = useSafeAreaInsets();

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const now = Date.now();
      if (!shouldCheckForUpdate(lastCheck.current, now)) return;
      lastCheck.current = now;
      void (async () => {
        try {
          const result = await Updates.checkForUpdateAsync();
          if (result.isAvailable) await Updates.fetchUpdateAsync();
        } catch {
          // Offline or the update server is down: the next return tries again.
        }
      })();
    });
    return () => sub.remove();
  }, []);

  const pendingUpdateId = downloadedUpdate?.updateId;
  if (!shouldShowUpdateBanner({ isUpdatePending, pendingUpdateId, dismissedKey })) return null;

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { top: insets.top + 8 }]}>
      <View style={styles.banner}>
        <Text style={styles.text}>A new version of Chord is ready.</Text>
        <Pressable
          onPress={() => setDismissedKey(updateDismissKey(pendingUpdateId))}
          hitSlop={8}
          disabled={reloading}
        >
          <Text style={styles.later}>Later</Text>
        </Pressable>
        <Pressable
          onPress={async () => {
            setReloading(true);
            try {
              await Updates.reloadAsync();
            } catch {
              setReloading(false);
            }
          }}
          hitSlop={8}
          disabled={reloading}
          style={styles.reloadBtn}
        >
          <Text style={styles.reloadTxt}>{reloading ? 'Reloading…' : 'Reload'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = themed((colors) => ({
  wrap: { position: 'absolute', left: 12, right: 12, alignItems: 'center' },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
    maxWidth: 520,
  },
  text: { color: colors.text, fontSize: 14, flexShrink: 1 },
  later: { color: colors.muted, fontSize: 14 },
  reloadBtn: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  reloadTxt: { color: colors.onAccent, fontSize: 14, fontWeight: '600' },
}));
