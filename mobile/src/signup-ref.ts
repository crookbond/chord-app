import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * AsyncStorage key for a welcome-DM referrer token captured before sign-in.
 * The `/welcome/<ref>` deep-link route (web + native universal/app link)
 * stashes it; the welcome screen reads it after sign-in - including across
 * Google's full-page OAuth redirect - and passes it to `authGoogle`, which
 * soft-links the external identity (Telegram ref / WhatsApp taster). Same
 * pattern as the join code. See ADR 0031 / 0047 / 0053.
 *
 * Note: the string MUST match the key `app/index.tsx` reads from storage, so
 * a token stashed by the deep-link route is picked up by the welcome screen.
 */
export const SIGNUP_REF_STORAGE_KEY = 'chord.signupRef';

/** Opaque nanoid token; bounded to avoid stashing junk from a malformed link. */
export function isValidSignupRef(ref: string | undefined | null): ref is string {
  if (!ref) return false;
  const t = ref.trim();
  return t.length >= 8 && t.length <= 64;
}

export async function readPendingSignupRef(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(SIGNUP_REF_STORAGE_KEY);
  } catch {
    return null;
  }
}

export async function writePendingSignupRef(ref: string): Promise<void> {
  try {
    await AsyncStorage.setItem(SIGNUP_REF_STORAGE_KEY, ref.trim());
  } catch {
    /* noop */
  }
}

export async function clearPendingSignupRef(): Promise<void> {
  try {
    await AsyncStorage.removeItem(SIGNUP_REF_STORAGE_KEY);
  } catch {
    /* noop */
  }
}
