import { Platform } from 'react-native';

/**
 * Per-platform Google OAuth config shared by the login screen and the
 * calendar / Gmail connect flows.
 *
 * Three platforms, two clients:
 *   web     → web client, https origin redirect
 *   iOS     → iOS public client, reversed-client-id scheme (ADR 0041)
 *   Android → web client, https App Link redirect (ADR 0081)
 *
 * Android deliberately has no client of its own. Google dropped custom-scheme
 * redirects for the Android client type, which is now reachable only through
 * Play services' Authorization API - a second native SDK and a second auth
 * code path. Instead Android runs the same browser flow as web against the web
 * client and catches the redirect with a verified App Link. That link points at
 * /nativeauth, not the /oauthredirect the web flow uses, so a mobile-browser
 * login on a phone that also has the app installed isn't hijacked into it.
 */
const WEB = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_WEB ?? '';
const IOS = process.env.EXPO_PUBLIC_GOOGLE_CLIENT_ID_IOS ?? '';
const WEB_BASE = (process.env.EXPO_PUBLIC_WEB_BASE ?? '').replace(/\/+$/, '');

/** Path the Android build redirects to. Must be registered on the web client's
 *  authorized-redirect list and claimed by the App Link intent filter. */
export const ANDROID_REDIRECT_PATH = '/nativeauth';

/** OAuth client id for the platform the bundle is running on. */
export const GOOGLE_CLIENT_ID =
  Platform.select({ web: WEB, ios: IOS, android: WEB }) ?? '';

/**
 * Native redirect override for `AuthSession.makeRedirectUri({ native })`.
 * Undefined on web so the default applies (the origin URL).
 */
export const GOOGLE_NATIVE_REDIRECT: string | undefined = Platform.select({
  ios: IOS
    ? `com.googleusercontent.apps.${IOS.replace(/\.apps\.googleusercontent\.com$/, '')}:/oauthredirect`
    : undefined,
  android: WEB_BASE ? `${WEB_BASE}${ANDROID_REDIRECT_PATH}` : undefined,
});

/**
 * Why Google sign-in can't run on this build, or null if it can.
 *
 * Android needs EXPO_PUBLIC_WEB_BASE as well as a client id: without it
 * `makeRedirectUri` silently falls back to the `chord://` scheme, which Google
 * rejects at the consent screen with a bare `400 invalid_request` that gives
 * the user nothing to act on.
 */
export const GOOGLE_AUTH_ERROR: string | null = !GOOGLE_CLIENT_ID
  ? 'EXPO_PUBLIC_GOOGLE_CLIENT_ID_* not set'
  : Platform.OS === 'android' && !WEB_BASE
    ? 'EXPO_PUBLIC_WEB_BASE not set - Android sign-in needs it for the OAuth redirect'
    : null;
