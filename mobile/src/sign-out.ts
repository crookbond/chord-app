/**
 * Forgetting the signed-out account on this device (ADR 0269).
 *
 * Storage: every key except the layout choices kernel lets stay
 * (`storageKeysToClearOnSignOut`). Memory: modules that cache another
 * account's data for the life of the app register a reset here, so a second
 * person signing in on the same phone never sees the first one's to-dos or
 * reuses their calendar id maps. Web reloads the page after sign-out, which
 * clears memory on its own.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { storageKeysToClearOnSignOut } from '@chord/kernel';

const resets = new Set<() => void | Promise<void>>();

/** A reset may be async (the mail store deletes files, ADR 0302); sign-out waits for it. */
export function onSignOut(reset: () => void | Promise<void>): void {
  resets.add(reset);
}

export async function clearLocalUserData(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const doomed = storageKeysToClearOnSignOut(keys);
    if (doomed.length > 0) await AsyncStorage.multiRemove(doomed);
  } catch {
    // best-effort: a storage failure must not keep someone signed in
  }
  if (Platform.OS === 'web') {
    try {
      globalThis.sessionStorage?.clear();
    } catch {
      /* private mode */
    }
  }
  // One module failing to reset must not stop the rest.
  await Promise.allSettled(
    [...resets].map(async (reset) => {
      await reset();
    }),
  );
}
