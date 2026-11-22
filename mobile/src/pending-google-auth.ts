import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  authRedirectOutcome,
  pendingAuthUsable,
  type AuthRedirectOutcome,
  type PendingAuthRecord,
} from '@chord/kernel';

/**
 * The PKCE verifier for a Google sign-in, parked where a cold start can find it.
 *
 * ADR 0081 redirects the Android build to a verified App Link. When that
 * verification has not taken, /nativeauth hands the app
 * `chord://oauthredirect?code=...` instead, and Android may start a fresh
 * process to deliver it - taking the in-memory `AuthRequest`, and with it the
 * verifier and the promise `promptAsync` was waiting on. Until this existed the
 * code arrived and was dropped on the floor, silently (2026-10-29, prod).
 *
 * Kept on the device only, and only for minutes: a verifier is worthless
 * without the matching code, and the code expires on Google's side anyway.
 */
const KEY = 'chord.pendingGoogleAuth';

export type { PendingAuthRecord };

/** Park a sign-in that is about to leave for the browser. */
export async function rememberGoogleAuth(
  record: Omit<PendingAuthRecord, 'at'>,
): Promise<void> {
  try {
    const stored: PendingAuthRecord = { ...record, at: Date.now() };
    await AsyncStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // Storage being unavailable costs the fallback, not the happy path.
  }
}

/**
 * Decide what an incoming URL means for the parked sign-in, claiming it.
 *
 * Removal happens before the caller spends the grant, so two deliveries of one
 * deep link - the auth session resolving and the Linking event, which both fire
 * on a warm return - cannot exchange the same code twice.
 */
export async function claimGoogleRedirect(
  url: string | null | undefined,
): Promise<AuthRedirectOutcome> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const record = raw ? (JSON.parse(raw) as PendingAuthRecord) : null;
    const outcome = authRedirectOutcome(url, record, Date.now());
    if (outcome.kind !== 'ignore') await AsyncStorage.removeItem(KEY);
    return outcome;
  } catch {
    return { kind: 'ignore' };
  }
}

/** Is a sign-in still out at the browser? Used to tell a cancel from a drop. */
export async function hasPendingGoogleAuth(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return false;
    const record = JSON.parse(raw) as PendingAuthRecord;
    // Any live record counts; this question is not about a particular state.
    return pendingAuthUsable(record, record?.state, Date.now());
  } catch {
    return false;
  }
}

export async function forgetGoogleAuth(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // Nothing to do - a stale record expires on its own.
  }
}
