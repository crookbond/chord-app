/**
 * What signing out leaves on the device (ADR 0269).
 *
 * Everything the app keeps in AsyncStorage (localStorage on web) is removed on
 * sign-out except a short list of layout choices that say nothing about the
 * person: which way a screen is drawn. Mail and calendar caches, the session
 * token, the Apple Calendar/Reminders id maps (which point at the old
 * account's events), location consent, push registration, pending invite and
 * referral codes all go — on a shared device the next person must not see
 * them, and a stale id map would write the next account's events against the
 * previous one's.
 *
 * An allow-list rather than a deny-list: a key added later is cleared unless
 * someone decides it is harmless, which is the safe default.
 */
export const KEPT_ON_SIGN_OUT: readonly string[] = ['email.viewMode', 'email.aiViewStyle', 'calendar.viewMode', 'app.colorScheme', 'app.introSeen'];

export function storageKeysToClearOnSignOut(keys: readonly string[]): string[] {
  const keep = new Set(KEPT_ON_SIGN_OUT);
  return keys.filter((k) => !keep.has(k));
}
