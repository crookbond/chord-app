import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import { Platform, Share } from 'react-native';

/**
 * AsyncStorage key for an invite code captured before sign-in. The join
 * route (`/join/<CODE>`) stashes it when a signed-out user follows an invite
 * link; the welcome screen reads it after sign-in (including across Google's
 * full-page OAuth redirect) and redirects back to complete the join. Same
 * pattern as the Telegram `?ref=` referrer - see ADR 0047 / 0031.
 */
export const PENDING_JOIN_CODE_KEY = 'chord.pendingJoinCode';

export async function readPendingJoinCode(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(PENDING_JOIN_CODE_KEY);
  } catch {
    return null;
  }
}

export async function writePendingJoinCode(code: string): Promise<void> {
  try {
    await AsyncStorage.setItem(PENDING_JOIN_CODE_KEY, code);
  } catch {
    /* noop */
  }
}

export async function clearPendingJoinCode(): Promise<void> {
  try {
    await AsyncStorage.removeItem(PENDING_JOIN_CODE_KEY);
  } catch {
    /* noop */
  }
}

/**
 * Accept either a bare invite code or a full `/join/<CODE>` link (so pasting
 * a shared URL into the "Join by code" box works). Returns the trimmed code.
 */
export function extractInviteCode(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/\/join\/([^/?#\s]+)/i);
  return (match ? match[1] : trimmed).trim();
}

/**
 * Open the OS share sheet for an invite link so the user can send it via
 * iMessage / WhatsApp / Mail / etc. Native uses React Native's `Share`;
 * mobile web uses the Web Share API; desktop web (no share API) falls back to
 * copying the link and invokes `onCopiedFallback` so the caller can show
 * feedback. Swallows the dismiss/cancel rejection.
 */
export async function shareInviteLink(
  url: string,
  onCopiedFallback?: () => void,
): Promise<void> {
  const text = `Join my Chord group: ${url}`;
  try {
    if (Platform.OS === 'web') {
      const nav =
        typeof navigator !== 'undefined'
          ? (navigator as unknown as {
              share?: (d: { title?: string; text?: string; url?: string }) => Promise<void>;
            })
          : undefined;
      if (nav?.share) {
        await nav.share({ title: 'Join my Chord group', text, url });
        return;
      }
      await Clipboard.setStringAsync(url);
      onCopiedFallback?.();
      return;
    }
    await Share.share(Platform.OS === 'ios' ? { url, message: text } : { message: text });
  } catch {
    /* user dismissed the sheet or share is unavailable - noop */
  }
}
