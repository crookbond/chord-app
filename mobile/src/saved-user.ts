/**
 * ADR 0311 - who was last signed in on this device, so a launch with no
 * network opens the app (with whatever each screen saved) instead of the
 * sign-in page. Written whenever the server confirms the user; removed by
 * sign-out with every other key (not on the ADR 0269 keep-list) and when the
 * server says the session is over.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import { meCheckSettled, type MeOutcome, type User } from '@chord/kernel';

import { forgetRejectedSession, getMeOutcome } from './api';
import { onNetworkChange } from './network';
import { useApp } from './store';

const SAVED_USER_KEY = 'chord.savedUser.v1';

export async function loadSavedUser(): Promise<User | null> {
  try {
    const raw = await AsyncStorage.getItem(SAVED_USER_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw) as User;
    return u && typeof u.id === 'string' ? u : null;
  } catch {
    return null;
  }
}

export async function forgetSavedUser(): Promise<void> {
  await AsyncStorage.removeItem(SAVED_USER_KEY).catch(() => {});
}

let enteredFromSaved = false;

useApp.subscribe((s, prev) => {
  if (s.user && s.user !== prev.user && !enteredFromSaved) {
    void AsyncStorage.setItem(SAVED_USER_KEY, JSON.stringify(s.user)).catch(() => {});
  }
});

/**
 * Open the app as the saved user. When the server is next reachable, ask it
 * who this is: a fresh answer replaces the saved copy, a rejected session goes
 * back to the sign-in page.
 */
export function enterAsSavedUser(
  user: User,
  opts: {
    /** Ask the server now (a launch that has not asked yet), not only on reconnect. */
    checkNow?: boolean;
    /** The answer to a `/me` the caller already started, used instead of a second one. */
    pending?: Promise<{ outcome: MeOutcome; user: User | null }>;
  } = {},
): void {
  enteredFromSaved = true;
  useApp.getState().setUser(user);
  let checking = false;
  let settled = false;
  const ask = (answer?: Promise<{ outcome: MeOutcome; user: User | null }>) => {
    if (checking || settled) return;
    checking = true;
    (answer ?? getMeOutcome())
      .then(async ({ outcome, user: fresh }) => {
        if (!meCheckSettled(outcome)) return;
        settled = true;
        stop();
        enteredFromSaved = false;
        if (outcome === 'signed-in' && fresh) useApp.getState().setUser(fresh);
        else if (outcome === 'rejected') {
          await forgetSavedUser();
          await forgetRejectedSession();
          useApp.getState().setUser(null);
          router.replace('/');
        }
      })
      .catch((e) => console.warn('[saved-user] session check failed', e))
      .finally(() => {
        checking = false;
      });
  };
  // Kept until the server answers about the session (kernel meCheckSettled):
  // a check that found no network, or a server error, asks again next time.
  const stop = onNetworkChange((online) => {
    if (online) ask();
  });
  if (opts.pending || opts.checkNow) ask(opts.pending);
}

const AI_CONSENT_AGREED_KEY = 'chord.aiConsentAgreed.v1';

/** Who this device last saw agree to ADR 0283's question (removed by sign-out). */
export async function loadAiConsentAgreedUser(): Promise<string | null> {
  return AsyncStorage.getItem(AI_CONSENT_AGREED_KEY).catch(() => null);
}

export async function rememberAiConsent(userId: string, agreed: boolean): Promise<void> {
  if (agreed) await AsyncStorage.setItem(AI_CONSENT_AGREED_KEY, userId).catch(() => {});
  else await AsyncStorage.removeItem(AI_CONSENT_AGREED_KEY).catch(() => {});
}
