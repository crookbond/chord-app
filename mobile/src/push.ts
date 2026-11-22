/**
 * Device push-notification registration (Expo push). The presence of a
 * registered token on the server is the per-device enable signal - the
 * Settings toggle calls `registerForPush()` / `unregisterForPush()`, and a
 * local AsyncStorage flag remembers the user's choice so we can re-register
 * (tokens can rotate) on launch.
 *
 * Push requires a real device + a dev-client/TestFlight/production build -
 * it is a no-op in the iOS simulator and in Expo Go on SDK 54.
 */
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { router } from 'expo-router';

import { registerPushToken, unregisterPushToken } from './api';

const ENABLED_KEY = 'chord.push.enabled';
const TOKEN_KEY = 'chord.push.token';

// Foreground presentation: show the banner even while the app is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function projectId(): string | undefined {
  return (
    Constants.expoConfig?.extra?.eas?.projectId ??
    Constants.easConfig?.projectId
  );
}

export async function isPushEnabledLocally(): Promise<boolean> {
  return (await AsyncStorage.getItem(ENABLED_KEY)) === '1';
}

/** Current OS notification permission for this app. */
export async function getPermissionStatus(): Promise<
  'granted' | 'denied' | 'undetermined'
> {
  const { status } = await Notifications.getPermissionsAsync();
  if (status === 'granted') return 'granted';
  if (status === 'denied') return 'denied';
  return 'undetermined';
}

/**
 * Request permission (if needed), fetch the Expo push token, and register it
 * with the server. Returns the token, or null if push is unavailable / the
 * user declined. Safe to call repeatedly - registration upserts server-side.
 */
export async function registerForPush(): Promise<string | null> {
  if (!Device.isDevice) return null;

  if (Platform.OS === 'android') {
    // HIGH shows a banner, as on an iPhone; DEFAULT only adds to the shade.
    // The server addresses this channel by name (ANDROID_PUSH_CHANNEL).
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Chord',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  let status = existing.status;
  if (status !== 'granted') {
    status = (await Notifications.requestPermissionsAsync()).status;
  }
  if (status !== 'granted') return null;

  const pid = projectId();
  const { data: token } = await Notifications.getExpoPushTokenAsync(
    pid ? { projectId: pid } : undefined,
  );

  await registerPushToken({ token, platform: Platform.OS as 'ios' | 'android' | 'web' });
  await AsyncStorage.multiSet([
    [ENABLED_KEY, '1'],
    [TOKEN_KEY, token],
  ]);
  return token;
}

/** Unregister this device's token server-side and clear the local flag. */
export async function unregisterForPush(): Promise<void> {
  const token = await AsyncStorage.getItem(TOKEN_KEY);
  try {
    await unregisterPushToken(token ? { token } : {});
  } finally {
    await AsyncStorage.multiRemove([ENABLED_KEY, TOKEN_KEY]);
  }
}

/**
 * If the user previously enabled push, refresh the token on launch (Expo
 * tokens can rotate). No-op when disabled or permission was revoked.
 */
export async function refreshPushRegistration(): Promise<void> {
  if (!(await isPushEnabledLocally())) return;
  try {
    await registerForPush();
  } catch {
    /* best-effort - a failed refresh just means the next attempt retries */
  }
}

/**
 * Route a tapped notification to its group. Call once at app root; returns an
 * unsubscribe handle.
 */
export function addNotificationTapHandler(): { remove: () => void } {
  return Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data as
      | { groupId?: string }
      | undefined;
    if (data?.groupId) {
      router.push(`/groups/${data.groupId}`);
    }
  });
}
