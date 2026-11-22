import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Link, Redirect, type Href, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  Linking,
} from 'react-native';
import { TextInput } from '@/text-input';
import { KeyboardScrollView } from '@/keyboard';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as AuthSession from 'expo-auth-session';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';

import {
  API_BASE,
  adoptLegacyWebSession,
  authApple,
  authGoogle,
  authMicrosoft,
  createSession,
  forgetUsername,
  getAiConsentStatus,
  getHealth,
  getMeOutcome,
  getToken,
  getRecentUsernames,
  linkSignupRef,
  rememberUsername,
  syncEmail,
} from '@/api';
import {
  APPLE_NATIVE_RETURN_PATH,
  APPLE_NATIVE_STATE_PREFIX,
  appleWebAuthorizeUrl,
  appleWebState,
  appleWebStateMatches,
  parseAppleWebReturn,
  type AppleWebConfig,
  bootReturnPath,
  bootScreen,
  enterWithSavedUser,
  openFromSavedUserAtLaunch,
  aiConsentKnownAtLaunch,
  formatWhatsappNumber,
  heroTypeScale,
  INTRO_SEEN_KEY,
  shouldShowIntro,
  whatsappChatUrl,
} from '@chord/kernel';
import { GOOGLE_AUTH_ERROR, GOOGLE_CLIENT_ID, GOOGLE_NATIVE_REDIRECT } from '@/google-auth';
import {
  claimGoogleRedirect,
  forgetGoogleAuth,
  hasPendingGoogleAuth,
  rememberGoogleAuth,
} from '@/pending-google-auth';
import { launchTab } from '@/group-nav';
import { onNetworkChange } from '@/network';
import {
  enterAsSavedUser,
  forgetSavedUser,
  loadAiConsentAgreedUser,
  loadSavedUser,
  rememberAiConsent,
} from '@/saved-user';
import { readPendingJoinCode } from '@/join-code';
import { ReviewSignIn } from '@/review-sign-in';
import {
  MS_DISCOVERY,
  OUTLOOK_CALENDAR_SCOPE,
  OUTLOOK_SCOPES,
  microsoftRedirectUri,
} from '@/microsoft-auth';
import { ensureSiteFontLoaded, siteFont } from '@/site-font';
import { useApp } from '@/store';
import { colors, themed } from '@/theme';

WebBrowser.maybeCompleteAuthSession();
ensureSiteFontLoaded();

/** Survives the trip to Apple and back; proves the return is to the browser that left. */
const APPLE_WEB_STATE_KEY = 'chord.appleWebState';

/**
 * How long the browser closing may precede the fallback deep link landing.
 * Long enough for /nativeauth's own `Linking.openURL` to be delivered, short
 * enough that someone who really did back out is not left watching a spinner.
 */
const FALLBACK_GRACE_MS = 2500;

/**
 * Said on Android when the browser came back with nothing and no deep link
 * followed.
 *
 * Covers two cases we cannot tell apart from here - the user backed out, and
 * the ADR 0081 redirect never reached the app - so it states the fact and
 * offers the fix for the second without insisting it is the cause.
 */
const SIGN_IN_INCOMPLETE =
  "Sign-in didn't finish. If you got through the Google screens, allow chordapp.ai links under Settings → Apps → Chord → Open by default, then try again.";

// Official sign-in button art, rasterized from the vendors' SVGs into PNGs
// (scripts can regenerate them): native <Image> cannot render an SVG data
// URI, and react-native-svg would mean a new native build for two glyphs.
// Metro resolves image assets only through require().
// eslint-disable-next-line @typescript-eslint/no-require-imports
const APPLE_LOGO = require('../assets/apple-logo.png');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const GOOGLE_G = require('../assets/google-g.png');

// Full `calendar` so the server can also create a calendar (calendars.insert).
const SIGN_IN_SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/calendar'];
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

const GOOGLE_DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

// Set per-environment in .env / .env.local - e.g.
//   prod:  EXPO_PUBLIC_TELEGRAM_BOT_HANDLE=@gruntworkbot
//   dev:   EXPO_PUBLIC_TELEGRAM_BOT_HANDLE=@doetest_bot
// When unset, the landing copy falls back to the generic phrase "the
// Chord Telegram bot" rather than embedding a stale default.
const TELEGRAM_BOT_HANDLE = (process.env.EXPO_PUBLIC_TELEGRAM_BOT_HANDLE ?? '').trim();
const TELEGRAM_BOT_NAME = TELEGRAM_BOT_HANDLE || 'the Chord Telegram bot';

const SIGNUP_REF_STORAGE_KEY = 'chord.signupRef';

/**
 * On web, the welcome-DM link lands here with `?ref=<token>`. We stash
 * it so it survives Google's OAuth redirect (which drops query params)
 * and pass it on the next authGoogle call. Native deep-link is handled
 * the same way via Linking.getInitialURL upstream; not wired yet - web
 * is the only surface for the bot link today. Returns the cached token
 * if no URL token is present.
 */
async function captureAndStoreSignupRef(): Promise<string | null> {
  try {
    if (typeof window !== 'undefined' && window.location?.search) {
      const params = new URLSearchParams(window.location.search);
      const ref = params.get('ref')?.trim();
      if (ref && ref.length >= 8 && ref.length <= 64) {
        await AsyncStorage.setItem(SIGNUP_REF_STORAGE_KEY, ref);
        return ref;
      }
    }
    return await AsyncStorage.getItem(SIGNUP_REF_STORAGE_KEY);
  } catch {
    return null;
  }
}

async function clearSignupRef(): Promise<void> {
  try {
    await AsyncStorage.removeItem(SIGNUP_REF_STORAGE_KEY);
  } catch {
    /* noop */
  }
}

/** Microsoft's four-square mark, drawn rather than shipped as an image. */
function MicrosoftLogo() {
  return (
    <View style={styles.microsoftLogo}>
      {['#F25022', '#7FBA00', '#00A4EF', '#FFB900'].map((c) => (
        <View key={c} style={[styles.microsoftSquare, { backgroundColor: c }]} />
      ))}
    </View>
  );
}

export default function Welcome() {
  const user = useApp((s) => s.user);
  const setUser = useApp((s) => s.setUser);
  // A screen that needed a user and had none (a web refresh) sends people here
  // with where they were, so boot returns them there.
  const { next: returnTo, signin: signInParam } = useLocalSearchParams<{ next?: string; signin?: string }>();
  // ADR 0335 - an AI app's consent link sent a signed-out person here.
  const connectingAiApp = typeof returnTo === 'string' && returnTo.startsWith('/connect?');
  const { width } = useWindowDimensions();
  const isWide = width >= 860;
  // A fixed 44pt wrapped the hero onto four lines on a ~360dp Android phone
  // and filled the screen. Every current iPhone is at or past the wide mark,
  // so the page the owner compared against does not move.
  const hero = useMemo(() => heroTypeScale(width), [width]);

  const [bootState, setBootState] = useState<'pending' | 'ready' | 'offline'>('pending');
  // Fail CLOSED to google. `/health` tells us the real mode, but until it
  // answers — or if it never does — the safe guess is the one every real
  // deployment runs. Defaulting to 'demo' rendered the username form against
  // an AUTH_MODE=google server, and every submit came back
  // "demo login disabled; sign in with Google".
  const [authMode, setAuthMode] = useState<'demo' | 'google'>('google');
  // ADR 0156 — shown only on an iOS device that supports it AND a server that
  // can complete the flow (it needs Apple keys to exchange and later revoke).
  const [appleAvailable, setAppleAvailable] = useState(false);
  // The same sign-in from a browser: offered when the server names a Services ID.
  const [appleWeb, setAppleWeb] = useState<AppleWebConfig | null>(null);
  const [whatsappNumber, setWhatsappNumber] = useState<string | null>(null);
  // ADR 0254 - is there a session on this device? null until storage answers.
  // Web has no token to read (the session is an httpOnly cookie); kernel
  // `bootScreen` then waits for `/me` instead.
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  useEffect(() => {
    void getToken()
      .then((t) => setHasToken(!!t))
      .catch(() => setHasToken(false));
  }, []);
  const appleOffered = appleAvailable || appleWeb !== null;
  // ADR 0293 - offered on every platform when the server can complete it; the
  // same consent also connects the Outlook mailbox.
  const [msSignIn, setMsSignIn] = useState<{ clientId: string; calendar: boolean } | null>(null);
  const signInNames = [appleOffered && 'Apple', msSignIn && 'Microsoft', 'Google'].filter(
    (n): n is string => !!n,
  );
  const signInNamesText =
    signInNames.length > 1
      ? `${signInNames.slice(0, -1).join(', ')} or ${signInNames[signInNames.length - 1]}`
      : signInNames[0];
  // ADR 0230 - one Google consent covers Calendar and Gmail. Off only when the
  // server says it does not read Gmail.
  const [gmailAtSignIn, setGmailAtSignIn] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [reviewSignIn, setReviewSignIn] = useState(false);
  const [busy, setBusy] = useState(false);

  // demo sign-in
  const [username, setUsername] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  const [showRecent, setShowRecent] = useState(false);

  const scrollRef = useRef<ScrollView | null>(null);
  const signInY = useRef(0);
  const jumpedToSignIn = useRef(false);
  const signupRefRef = useRef<string | null>(null);
  const [signupRefBanner, setSignupRefBanner] = useState(false);

  // A code captured from a `/join/<CODE>` invite link before sign-in. Once
  // the user signs in we bounce back to the join route to complete it.
  // `joinChecked` gates the post-auth redirect so a freshly signed-in user
  // never flashes past a pending join into /groups.
  const [pendingJoinCode, setPendingJoinCode] = useState<string | null>(null);
  const [joinChecked, setJoinChecked] = useState(false);
  // ADR 0283 — a signed-in user who has not answered the AI question is
  // asked before landing anywhere. A failed check never blocks the app.
  const [consentState, setConsentState] = useState<'unknown' | 'needed' | 'ok'>('unknown');
  // ADR 0327 — the intro plays once on this device, before that question.
  const [introSeen, setIntroSeen] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    AsyncStorage.getItem(INTRO_SEEN_KEY)
      .then((v) => live && setIntroSeen(v === '1'))
      .catch(() => live && setIntroSeen(true));
    return () => {
      live = false;
    };
  }, []);

  const redirectUri = useMemo(
    () =>
      AuthSession.makeRedirectUri({
        scheme: 'chord',
        path: 'oauthredirect',
        native: GOOGLE_NATIVE_REDIRECT,
      }),
    [],
  );

  const [request, , promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: GOOGLE_CLIENT_ID,
      scopes: gmailAtSignIn ? [...SIGN_IN_SCOPES, GMAIL_SCOPE] : SIGN_IN_SCOPES,
      redirectUri,
      usePKCE: true,
      responseType: AuthSession.ResponseType.Code,
      extraParams: { access_type: 'offline', prompt: 'consent' },
    },
    GOOGLE_DISCOVERY,
  );

  const msRedirectUri = useMemo(microsoftRedirectUri, []);
  const [msRequest, , msPromptAsync] = AuthSession.useAuthRequest(
    {
      clientId: msSignIn?.clientId ?? 'unset',
      scopes: [
        ...OUTLOOK_SCOPES,
        'profile',
        ...(msSignIn?.calendar ? [OUTLOOK_CALENDAR_SCOPE] : []),
      ],
      redirectUri: msRedirectUri,
      usePKCE: true,
      responseType: AuthSession.ResponseType.Code,
      extraParams: { prompt: 'select_account' },
    },
    MS_DISCOVERY,
  );

  // A launch that found the server unreachable asks again when it comes back.
  const [bootRun, setBootRun] = useState(0);
  useEffect(() => {
    if (bootState !== 'offline' || user) return;
    return onNetworkChange((online) => {
      if (online) {
        setBootState('pending');
        setBootRun((n) => n + 1);
      }
    });
  }, [bootState, user]);

  useEffect(() => {
    (async () => {
      // Ask who this is at the same time as asking how the server is set up: the
      // two used to run one after the other, which is how long a signed-in
      // person looked at the sign-in page.
      // Web: a token an older build stored becomes the cookie first, so that
      // person's `/me` below is already signed in by it.
      const meRequest = adoptLegacyWebSession().then(() => getMeOutcome());
      // The first screen comes from what this device saved: someone signed in
      // here opens the app now and `/me` answers in the background (kernel
      // openFromSavedUserAtLaunch). The sign-in options below only matter to
      // the landing page, which they will not see.
      const [token, saved] = await Promise.all([getToken().catch(() => null), loadSavedUser()]);
      if (
        saved &&
        openFromSavedUserAtLaunch({ hasToken: !!token, hasSavedUser: true, web: Platform.OS === 'web' })
      ) {
        enterAsSavedUser(saved, { pending: meRequest });
        setBootState('ready');
        return;
      }
      try {
        const health = await getHealth();
        setAuthMode(health.authMode);
        setGmailAtSignIn(health.gmail !== false);
        setWhatsappNumber(health.whatsappNumber ?? null);
        if (Platform.OS === 'ios' && health.authMode === 'google' && health.appleSignIn) {
          void AppleAuthentication.isAvailableAsync()
            .then(setAppleAvailable)
            .catch(() => setAppleAvailable(false));
        }
        if (
          (Platform.OS === 'web' || Platform.OS === 'android') &&
          health.authMode === 'google' &&
          health.appleWeb
        ) {
          setAppleWeb(health.appleWeb);
        }
        if (health.authMode === 'google' && health.microsoftSignIn) {
          setMsSignIn(health.microsoftSignIn);
        }
        setReviewSignIn(health.authMode === 'google' && health.reviewSignIn === true);
      } catch {
        // Only the landing page's sign-in options come from here; their
        // defaults stand until the server can be asked.
      }
      const { outcome, user: me } = await meRequest;
      if (me) {
        setUser(me);
        setBootState('ready');
        return;
      }
      if (outcome === 'rejected') {
        await forgetSavedUser();
        setBootState('ready');
        return;
      }
      // ADR 0311 - no server: someone signed in on this device opens the app
      // with what it saved, not the sign-in page.
      if (
        saved &&
        enterWithSavedUser({ hasToken: !!token, outcome, hasSavedUser: true, web: Platform.OS === 'web' })
      ) {
        enterAsSavedUser(saved);
      }
      setBootState('offline');
    })();
  }, [setUser, bootRun]);

  useEffect(() => {
    setConsentState('unknown');
    if (!user) return;
    let live = true;
    const userId = user.id;
    // Agreed on this device before: go on now, and let the server's answer
    // only update what the next launch remembers (the server still gates AI).
    void loadAiConsentAgreedUser().then((agreed) => {
      if (live && aiConsentKnownAtLaunch({ userId, agreedUserId: agreed })) {
        setConsentState((c) => (c === 'unknown' ? 'ok' : c));
      }
    });
    getAiConsentStatus()
      .then((s) => {
        const needed = s.required && !s.consent;
        void rememberAiConsent(userId, !needed);
        if (live) setConsentState(needed ? 'needed' : 'ok');
      })
      .catch(() => {
        if (live) setConsentState('ok');
      });
    return () => {
      live = false;
    };
  }, [user]);

  useEffect(() => {
    void getRecentUsernames().then(setRecent);
  }, []);

  useEffect(() => {
    void captureAndStoreSignupRef().then((ref) => {
      signupRefRef.current = ref;
      if (ref) setSignupRefBanner(true);
    });
  }, []);

  // Already-signed-in user clicked a welcome-DM link: authGoogle never
  // re-runs for them, so consume the stashed referrer token here to merge
  // their WhatsApp taster shadow / Telegram identity into this account
  // (ADR 0053 / 0031). Best-effort + idempotent (the server no-ops a
  // stale/consumed token); cleared after so a refresh doesn't retry.
  useEffect(() => {
    if (!user) return;
    void (async () => {
      const ref = await captureAndStoreSignupRef();
      if (!ref) return;
      try {
        await linkSignupRef(ref);
      } catch {
        /* best-effort */
      } finally {
        signupRefRef.current = null;
        await clearSignupRef();
      }
    })();
  }, [user]);

  useEffect(() => {
    void readPendingJoinCode().then((c) => {
      setPendingJoinCode(c);
      setJoinChecked(true);
    });
  }, []);

  const scrollToSignIn = useCallback(() => {
    scrollRef.current?.scrollTo({ y: signInY.current - 16, animated: true });
  }, []);

  const signInDemo = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      setErr(null);
      setBusy(true);
      try {
        const res = await createSession({ username: trimmed });
        const next = await rememberUsername(trimmed);
        setRecent(next);
        setUser(res.user);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [setUser],
  );

  const submitDemo = useCallback(() => {
    void signInDemo(username);
  }, [signInDemo, username]);

  const pickRecent = useCallback(
    (name: string) => {
      setUsername(name);
      setShowRecent(false);
      void signInDemo(name);
    },
    [signInDemo],
  );

  const deleteRecent = useCallback(async (name: string) => {
    const next = await forgetUsername(name);
    setRecent(next);
  }, []);

  /**
   * Spend an authorization code for a session.
   *
   * Both ways in share this: the auth session resolving normally, and the
   * ADR 0081 fallback deep link arriving afterwards. Two copies of one token
   * exchange is how the two paths would drift.
   */
  const completeGoogleCode = useCallback(
    async (grant: { code: string; codeVerifier: string; redirectUri: string; gmail: boolean }) => {
      // Re-resolve the referrer token from AsyncStorage here, not the
      // useRef. On web, Google's OAuth flow does a full page navigation
      // (/ → Google → /oauthredirect → /), so by the time this callback
      // resolves we're on a remount with `signupRefRef.current === null`.
      // The useEffect repopulates it from AsyncStorage but only after
      // an async tick, which races with promptAsync resolving. Reading
      // straight from storage is deterministic.
      const signupRef =
        signupRefRef.current ?? (await captureAndStoreSignupRef()) ?? undefined;
      const res = await authGoogle({
        code: grant.code,
        codeVerifier: grant.codeVerifier,
        redirectUri: grant.redirectUri,
        signupRef: signupRef ?? undefined,
      });
      // Token is single-use; clear before navigating so a refresh on
      // the post-login page doesn't try to re-consume it.
      if (signupRef) {
        signupRefRef.current = null;
        await clearSignupRef();
      }
      setUser(res.user);
      // Start the first mail read now rather than on the next background
      // pass. Fails quietly when the Gmail box was left unticked.
      if (grant.gmail) void syncEmail().catch(() => undefined);
    },
    [setUser],
  );

  const signInWithGoogle = useCallback(async () => {
    if (!request) return;
    if (GOOGLE_AUTH_ERROR) {
      setErr(GOOGLE_AUTH_ERROR);
      return;
    }
    setErr(null);
    setBusy(true);
    // Set when the deep-link listener took the sign-in over, so this call does
    // not clear the spinner out from under an exchange still in flight.
    let handedOff = false;
    try {
      if (Platform.OS !== 'web') {
        // Load the crypto state and park the verifier BEFORE the browser can
        // send anything back: on the ADR 0081 fallback path Android may start
        // a fresh process to deliver the redirect, and this object does not
        // survive that. Idempotent - promptAsync reuses what this sets up.
        await request.getAuthRequestConfigAsync();
        if (request.codeVerifier) {
          await rememberGoogleAuth({
            state: request.state,
            codeVerifier: request.codeVerifier,
            redirectUri,
            gmail: gmailAtSignIn,
          });
        }
      }

      const result = await promptAsync();
      if (result.type !== 'success') {
        if (result.type !== 'dismiss' && result.type !== 'cancel') {
          setErr(`google sign-in: ${result.type}`);
          return;
        }
        // The browser closing is not proof the sign-in failed. When the App
        // Link has not verified, /nativeauth dismisses the Custom Tab and
        // hands the code over as a deep link a moment later; the listener
        // below claims the parked record when it lands. Judge by whether it
        // was claimed rather than by the tab closing.
        if (Platform.OS === 'web') return;
        await new Promise((resolve) => setTimeout(resolve, FALLBACK_GRACE_MS));
        if (await hasPendingGoogleAuth()) {
          await forgetGoogleAuth();
          // Android is the only platform where a completed consent can fail to
          // come back (ADR 0081 - the App Link). On iOS the browser closing
          // really is a cancel, and saying otherwise would be noise.
          if (Platform.OS === 'android') setErr(SIGN_IN_INCOMPLETE);
        } else {
          handedOff = true;
        }
        return;
      }
      const code = result.params.code;
      const codeVerifier = request.codeVerifier;
      if (!code || !codeVerifier) {
        setErr('google did not return a code');
        return;
      }
      // Claimed here so the listener below cannot spend the same code again.
      await forgetGoogleAuth();
      await completeGoogleCode({
        code,
        codeVerifier,
        redirectUri,
        gmail: gmailAtSignIn,
      });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      if (!handedOff) setBusy(false);
    }
  }, [completeGoogleCode, gmailAtSignIn, promptAsync, redirectUri, request]);

  // ADR 0081 - the redirect can arrive as a deep link rather than resolving the
  // auth session: /nativeauth hands over `chord://oauthredirect?code=...` when
  // App Link verification has not taken, and Android may cold-start the app to
  // deliver it. Until this existed the code was dropped on the floor and the
  // user was returned to this page with nothing said (2026-10-29, prod).
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let dropped = false;

    const handle = async (url: string | null) => {
      if (dropped) return;
      // `ignore` covers an ordinary deep link and a redirect with no live
      // record behind it - neither is ours to answer.
      const outcome = await claimGoogleRedirect(url);
      if (outcome.kind === 'ignore' || dropped) return;
      if (outcome.kind === 'error') {
        setErr(`google sign-in: ${outcome.error}`);
        return;
      }
      setErr(null);
      setBusy(true);
      try {
        await completeGoogleCode(outcome.grant);
      } catch (e) {
        if (!dropped) setErr((e as Error).message);
      } finally {
        if (!dropped) setBusy(false);
      }
    };

    // A cold start delivers the redirect as the launch URL, a warm one as an
    // event; the fallback page can produce either.
    void Linking.getInitialURL()
      .then(handle)
      .catch(() => undefined);
    const sub = Linking.addEventListener('url', (e) => void handle(e.url));
    return () => {
      dropped = true;
      sub.remove();
    };
  }, [completeGoogleCode]);

  // ADR 0293 - the browser flow on every platform (a Custom Tab on Android,
  // ASWebAuthenticationSession on iOS, a popup on web). The server connects
  // the Outlook mailbox from the same grant and starts its first sync.
  const signInWithMicrosoft = useCallback(async () => {
    if (!msRequest || !msSignIn || busy) return;
    setErr(null);
    setBusy(true);
    try {
      const result = await msPromptAsync();
      if (result.type !== 'success') {
        if (result.type !== 'dismiss' && result.type !== 'cancel') {
          setErr(`microsoft sign-in: ${result.type}`);
        }
        return;
      }
      const code = result.params.code;
      const codeVerifier = msRequest.codeVerifier;
      if (!code || !codeVerifier) {
        setErr('microsoft did not return a code');
        return;
      }
      const signupRef = signupRefRef.current ?? (await captureAndStoreSignupRef()) ?? undefined;
      const res = await authMicrosoft({ code, codeVerifier, redirectUri: msRedirectUri, signupRef });
      if (signupRef) {
        signupRefRef.current = null;
        await clearSignupRef();
      }
      setUser(res.user);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [busy, msPromptAsync, msRedirectUri, msRequest, msSignIn, setUser]);

  const signInWithApple = useCallback(async () => {
    if (busy) return;
    setErr(null);
    setBusy(true);
    try {
      const cred = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      if (!cred.authorizationCode) {
        setErr('Apple did not return a sign-in code');
        return;
      }
      const signupRef =
        signupRefRef.current ?? (await captureAndStoreSignupRef()) ?? undefined;
      // Apple shares the name on the first authorization only; forward it.
      const res = await authApple({
        authorizationCode: cred.authorizationCode,
        givenName: cred.fullName?.givenName ?? undefined,
        familyName: cred.fullName?.familyName ?? undefined,
        signupRef,
      });
      if (signupRef) {
        signupRefRef.current = null;
        await clearSignupRef();
      }
      setUser(res.user);
    } catch (e) {
      if ((e as { code?: string }).code === 'ERR_REQUEST_CANCELED') return;
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [busy, setUser]);

  const signInWithAppleWeb = useCallback(() => {
    if (!appleWeb || busy) return;
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    const state = appleWebState(
      window.location.origin,
      Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''),
    );
    try {
      window.sessionStorage.setItem(APPLE_WEB_STATE_KEY, state);
    } catch {
      setErr('Sign in with Apple needs browser storage, which is blocked here.');
      return;
    }
    window.location.assign(appleWebAuthorizeUrl(appleWeb, state));
  }, [appleWeb, busy]);

  // ADR 0263 - Android runs the browser flow in a Custom Tab. The server
  // returns a marked state to the /nativeauth App Link (the one Google's
  // Android sign-in already uses), which hands the URL back to this tab.
  const signInWithAppleAndroid = useCallback(async () => {
    if (!appleWeb || busy) return;
    setErr(null);
    const bytes = Crypto.getRandomBytes(16);
    const state =
      APPLE_NATIVE_STATE_PREFIX + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    const returnUrl = `${new URL(appleWeb.redirectUri).origin}${APPLE_NATIVE_RETURN_PATH}`;
    setBusy(true);
    try {
      const result = await WebBrowser.openAuthSessionAsync(appleWebAuthorizeUrl(appleWeb, state), returnUrl);
      if (result.type !== 'success') return;
      const hashAt = result.url.indexOf('#');
      const back = parseAppleWebReturn(hashAt >= 0 ? result.url.slice(hashAt) : '');
      if (!back) {
        setErr('Apple sign-in did not complete.');
        return;
      }
      if (!back.code) {
        if (back.error !== 'user_cancelled_authorize') setErr('Apple sign-in did not complete.');
        return;
      }
      if (!appleWebStateMatches(back.state, state)) {
        setErr('Apple sign-in could not be verified. Please try again.');
        return;
      }
      const signupRef =
        signupRefRef.current ?? (await captureAndStoreSignupRef()) ?? undefined;
      const res = await authApple({
        authorizationCode: back.code,
        client: 'web',
        givenName: back.givenName,
        familyName: back.familyName,
        signupRef,
      });
      if (signupRef) {
        signupRefRef.current = null;
        await clearSignupRef();
      }
      setUser(res.user);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [appleWeb, busy, setUser]);

  // Back from Apple: the server's callback put the code in the URL fragment.
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const back = parseAppleWebReturn(window.location.hash);
    if (!back) return;
    // Out of the address bar before anything else: a code is single-use, and a
    // refresh must not replay it.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    let stored: string | null = null;
    try {
      stored = window.sessionStorage.getItem(APPLE_WEB_STATE_KEY);
      window.sessionStorage.removeItem(APPLE_WEB_STATE_KEY);
    } catch {
      /* treated as a mismatch below */
    }
    if (!back.code) {
      if (back.error !== 'user_cancelled_authorize') setErr('Apple sign-in did not complete.');
      return;
    }
    if (!appleWebStateMatches(back.state, stored)) {
      setErr('Apple sign-in could not be verified. Please try again.');
      return;
    }
    setBusy(true);
    void (async () => {
      try {
        const signupRef = (await captureAndStoreSignupRef()) ?? undefined;
        const res = await authApple({
          authorizationCode: back.code!,
          client: 'web',
          givenName: back.givenName,
          familyName: back.familyName,
          signupRef,
        });
        if (signupRef) {
          signupRefRef.current = null;
          await clearSignupRef();
        }
        setUser(res.user);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  }, [setUser]);

  if (user) {
    // Wait until we've checked storage so we don't skip past a pending join.
    if (!joinChecked || consentState === 'unknown' || introSeen === null) {
      return (
        <View style={[styles.root, { alignItems: 'center', justifyContent: 'center' }]}>
          <ActivityIndicator color={colors.accent} />
        </View>
      );
    }
    // A launch lands on Action Items on a phone and on Email on the web
    // (ADR 0254), never on the chat list.
    const next = pendingJoinCode ? `/join/${pendingJoinCode}` : bootReturnPath(returnTo, launchTab());
    // ADR 0335 - someone mid-way through connecting an AI app is not sent through
    // the twelve-page intro first (the authorization would expire); the consent
    // question is short and still asked.
    if (!connectingAiApp && shouldShowIntro({ introSeen, signedIn: true, consentNeeded: consentState === 'needed', native: Platform.OS !== 'web' })) {
      return <Redirect href={{ pathname: '/intro', params: { next, consent: '1' } }} />;
    }
    if (consentState === 'needed') {
      return <Redirect href={{ pathname: '/ai-consent', params: { next } }} />;
    }
    return <Redirect href={next as Href} />;
  }

  // Someone who was signed in must not see the sign-in page while we check.
  if (bootScreen({ signedIn: false, hasToken, boot: bootState, web: Platform.OS === 'web' }) === 'splash') {
    return (
      <View style={[styles.root, { alignItems: 'center', justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  // ADR 0327 — on a fresh phone the intro comes before the sign-in page.
  const native = Platform.OS !== 'web';
  if (native && introSeen === null) {
    return (
      <View style={[styles.root, { alignItems: 'center', justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  if (shouldShowIntro({ introSeen: introSeen ?? true, signedIn: false, consentNeeded: false, native })) {
    return <Redirect href={{ pathname: '/intro', params: { signin: '1' } }} />;
  }

  return (
    <SafeAreaView style={styles.root} edges={['top', 'left', 'right']}>
      <View style={styles.navbar}>
        <Text style={styles.navLogo}>Chord</Text>
        <View style={styles.navRight}>
          <Pressable onPress={scrollToSignIn} style={styles.navBtn}>
            <Text style={styles.navBtnText}>Sign in</Text>
          </Pressable>
        </View>
      </View>

      <KeyboardScrollView
        ref={scrollRef}
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {bootState === 'offline' && (
          <Text style={styles.warnBanner}>⚠ can&apos;t reach {API_BASE}</Text>
        )}

        {/* Hero */}
        <View style={[styles.hero, isWide && styles.heroWide]}>
          <View style={[styles.heroCopy, isWide && { flex: 1, paddingRight: 32 }]}>
            <Text style={styles.kicker}>Active mail reader</Text>
            <Text style={[styles.title, hero]}>
              Convert your email to action items.
            </Text>
            <Text style={styles.lede}>
              Emails for family, school and kids get auto-classified. Never
              miss the next health form, or next playdate email. Track your
              packages. Chord makes your grocery and shopping lists, remembers
              birthdays, trips, interesting places, recipes and reminds you
              when needed. It reads what comes in, sorts, and suggests the
              actions and to-dos hiding inside - the school signup, the form,
              the flight change. Never miss one, and never stress over a
              last-minute deadline because an email wasn&rsquo;t flagged. It
              proposes; you confirm.
            </Text>
            <View style={styles.heroCtaRow}>
              <Pressable style={styles.btnPrimary} onPress={scrollToSignIn}>
                <Text style={styles.btnPrimaryText}>Sign in</Text>
              </Pressable>
            </View>
          </View>
          <View style={[styles.heroVisual, isWide && { flex: 1 }]}>
            <MorningPreview />
          </View>
        </View>

        {/* The four surfaces */}
        <Section
          title="Four surfaces, one shared brain"
          subtitle="They are the app's tabs - and they all feed each other."
          id="how"
        >
          <View style={[styles.cards, styles.cardsWrap]}>
            <SurfaceCard
              icon="✉"
              title="Email"
              body="Your mail laid out by where your attention actually needs to go, not by arrival time. Chord reads and classifies every thread, and docks what it wants to do about it on the mail that produced it."
            />
            <SurfaceCard
              icon="📅"
              title="Calendar"
              body="Two-way Google sync. An invite that arrives for something you already agreed in email is recognised as the same thing - so an agreed-then-invited dinner never lands on your calendar twice."
            />
            <SurfaceCard
              icon="⚡"
              title="Action Items"
              body="Action items first: what Chord pulled out of your mail and is waiting on a yes or no. Then tasks, lists, trips, and every attachment it filed along the way."
            />
            <SurfaceCard
              icon="💬"
              title="Messages"
              body="The coordination add-on. Ask Chord anything and it answers from everything above - and share a group with your small circle, in the app or from Telegram and WhatsApp where they already talk."
            />
          </View>
        </Section>

        {/* Consent model - the differentiator */}
        <Section
          title="Nothing lands without your confirmation"
          subtitle="The whole point: an assistant that asks, not one that just does things."
        >
          <Bullet>
            <Text style={styles.bold}>Every write is a proposal.</Text> Chord
            drafts the event, the task, the reply - and waits. Nothing reaches
            your calendar or your to-do list until you confirm it.
          </Bullet>
          <Bullet>
            <Text style={styles.bold}>Every suggestion shows its source.</Text>{' '}
            Each one links back to the exact email it came from, so you can
            check the thing before you agree to it.
          </Bullet>
          <Bullet>
            <Text style={styles.bold}>Groups stay separate.</Text> What Chord
            knows in one group never leaks into another. Your personal
            context is used to answer for you, and you can switch that off.
          </Bullet>
        </Section>

        {/* Getting started */}
        <Section title="Getting started" subtitle="Three steps, about two minutes.">
          <View style={styles.stepList}>
            <Step
              n="1"
              title={`Sign in with ${signInNamesText}`}
              body="That's the whole sign-up. No password, no pair codes."
            />
            <Step
              n="2"
              title="Connect Gmail and Calendar"
              body="Chord starts reading and sorting straight away. You'll see your mail mapped by attention within a minute or two, with the first suggestions already waiting."
            />
            <Step
              n="3"
              title="Confirm what it found - then let it run"
              body="Work through the action items it pulled out. From then on it briefs you each morning at whatever time you pick, in whatever time zone you're in."
            />
          </View>
          <Text style={styles.fineprint}>
            Free for 30 days. After that it&rsquo;s a paid plan - or bring your
            own model key, which is always free.
          </Text>
        </Section>

        {/* Group chat - no longer the hero path, still supported */}
        <Section
          title="Also works where your circle already chats"
          subtitle="Telegram and WhatsApp, if that's easier than getting everyone into an app."
        >
          <Text style={styles.body}>
            Add {TELEGRAM_BOT_NAME} to a Telegram group and run{' '}
            <Text style={styles.bold}>/chord pair</Text>. Once any paired member
            posts, Chord mirrors that conversation into the matching Chord group
            - so anyone can stay in Telegram while everyone else uses the app,
            and it&rsquo;s all the same shared brain underneath.
          </Text>
          <Text style={styles.body}>
            Mention it to ask for something (
            <Text style={styles.bold}>&ldquo;@Chord add milk to the Costco
            list&rdquo;</Text>
            ), and it stays in the conversation for a few messages afterwards so
            you don&rsquo;t have to keep re-mentioning it.
          </Text>
          {whatsappNumber ? (
            <Text style={styles.body}>
              On WhatsApp, just message Chord at{' '}
              <Text
                style={styles.bold}
                onPress={() => {
                  const url = whatsappChatUrl(whatsappNumber, 'Hi Chord');
                  if (url) void Linking.openURL(url);
                }}
              >
                {formatWhatsappNumber(whatsappNumber)}
              </Text>
              . Verify the same number in Settings and it&rsquo;s your Chord chat.
            </Text>
          ) : null}
        </Section>

        {/* Sign in card */}
        <View
          onLayout={(e) => {
            signInY.current = e.nativeEvent.layout.y;
            // The website's Sign in links land on "/?signin=1": go straight to
            // the sign-in card instead of the long page above it.
            if ((signInParam === '1' || connectingAiApp) && !jumpedToSignIn.current) {
              jumpedToSignIn.current = true;
              scrollRef.current?.scrollTo({ y: signInY.current - 16, animated: false });
            }
          }}
          style={styles.signInWrap}
        >
          <View style={styles.signInCard}>
            {signupRefBanner && (
              <View style={styles.refBanner}>
                <Text style={styles.refBannerText}>
                  Linking your chat with Chord - sign in and we&rsquo;ll
                  connect it to your account automatically.
                </Text>
              </View>
            )}
            {connectingAiApp && (
              <View style={styles.refBanner}>
                <Text style={styles.refBannerText}>
                  Connecting Chord to Claude or ChatGPT - sign in below. New to Chord? Signing in creates
                  your free account, and then you come straight back to finish connecting.
                </Text>
              </View>
            )}
            {pendingJoinCode && (
              <View style={styles.refBanner}>
                <Text style={styles.refBannerText}>
                  You&rsquo;ve been invited to a group - sign in and we&rsquo;ll
                  add you automatically.
                </Text>
              </View>
            )}
            <Text style={styles.signInTitle}>Sign in to get started</Text>
            <Text style={styles.signInSub}>
              {authMode !== 'google'
                ? 'Demo mode is on - pick a username to try Chord locally.'
                : signInNames.length > 1
                  ? `Use your ${signInNamesText} account. With Google, Chord writes events to the one calendar you pick - your primary by default - and never touches the others.${msSignIn ? ' With Microsoft, your Outlook mailbox is connected in the same step.' : ''}`
                  : 'Use your Google account. Chord writes events to the one calendar you pick - your primary by default - and never touches the others.'}
            </Text>

            {bootState === 'pending' ? (
              <ActivityIndicator style={{ marginVertical: 16 }} />
            ) : authMode === 'google' ? (
              <>
                {err && <Text style={styles.err}>{err}</Text>}
                {appleAvailable && (
                  <AppleAuthentication.AppleAuthenticationButton
                    buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
                    buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
                    cornerRadius={10}
                    style={styles.appleBtn}
                    onPress={signInWithApple}
                  />
                )}
                {appleWeb && (
                  <Pressable
                    style={[styles.appleWebBtn, busy && styles.btnDisabled]}
                    disabled={busy}
                    onPress={Platform.OS === 'android' ? signInWithAppleAndroid : signInWithAppleWeb}
                    accessibilityRole="button"
                    accessibilityLabel="Sign in with Apple"
                  >
                    <Image source={APPLE_LOGO} style={styles.appleWebLogo} />
                    <Text style={styles.btnPrimaryText}>Sign in with Apple</Text>
                  </Pressable>
                )}
                <Pressable
                  style={[styles.googleBtn, (busy || !request) && styles.btnDisabled]}
                  disabled={busy || !request}
                  onPress={signInWithGoogle}
                  accessibilityRole="button"
                  accessibilityLabel="Sign in with Google"
                >
                  {busy ? (
                    <ActivityIndicator color={colors.text} />
                  ) : (
                    <>
                      <Image source={GOOGLE_G} style={styles.googleLogo} />
                      <Text style={styles.googleBtnText}>Sign in with Google</Text>
                    </>
                  )}
                </Pressable>
                {msSignIn && (
                  <Pressable
                    style={[styles.microsoftBtn, (busy || !msRequest) && styles.btnDisabled]}
                    disabled={busy || !msRequest}
                    onPress={signInWithMicrosoft}
                    accessibilityRole="button"
                    accessibilityLabel="Sign in with Microsoft"
                  >
                    <MicrosoftLogo />
                    <Text style={styles.microsoftBtnText}>Sign in with Microsoft</Text>
                  </Pressable>
                )}
                {reviewSignIn && <ReviewSignIn disabled={busy} onSignedIn={setUser} />}
                <Text style={styles.consentLine}>
                  By signing in you agree to our{' '}
                  <Link href="/tos">
                    <Text style={styles.link}>Terms of Service</Text>
                  </Link>{' '}
                  and{' '}
                  <Link href="/privacy">
                    <Text style={styles.link}>Privacy Policy</Text>
                  </Link>
                  . Chord is provided as is, with no warranty - the assistant
                  can be wrong, so check anything that matters.
                </Text>
                <Text style={styles.fineprintTight}>
                  {gmailAtSignIn
                    ? 'With Google, we ask for calendar and Gmail access together so Chord can start on your mail straight away. You can untick either on Google’s screen - Chord works without them, and you can connect them later in Settings.'
                    : 'We ask for calendar access at sign-in so the assistant lands ready to use.'}
                </Text>
              </>
            ) : (
              <DemoSignIn
                username={username}
                setUsername={setUsername}
                err={err}
                busy={busy}
                recent={recent}
                showRecent={showRecent}
                setShowRecent={setShowRecent}
                submit={submitDemo}
                pickRecent={pickRecent}
                deleteRecent={deleteRecent}
              />
            )}
          </View>
        </View>

        {/* About us */}
        <Section title="About us">
          <Text style={styles.body}>
            Chord is built by a small team that got tired of the things that
            actually mattered - the school signup, the form, the deadline -
            sitting unread in a crowded inbox while reminders lived in five
            other apps. We wanted a mail reader that actually reads: one place
            that goes through everything and hands back a short list of things
            to decide.
          </Text>
          <Text style={styles.body}>
            Chord is operated by Family Grocery Trip Chat Agent LLC d/b/a
            Chordapp.ai.
          </Text>
          <Text style={styles.body}>
            If you want to talk to the people making this, email{' '}
            <Text style={styles.link}>hello@chordapp.ai</Text>.
          </Text>
        </Section>

        {/* Privacy */}
        <Section title="Privacy" subtitle="The short version. Long version on request.">
          <Bullet>
            <Text style={styles.bold}>Your chat stays yours.</Text> Messages in
            a Chord group are visible to its members and to the assistant.
            They are not used to train any third-party model and are never
            sold or shared with advertisers.
          </Bullet>
          <Bullet>
            <Text style={styles.bold}>Google data is scoped.</Text> Chord
            writes events to your own Google Calendar - your personal
            (primary) calendar by default, or any calendar you choose (pick
            one when you create an event, or set a per-group default). It
            only writes to the calendar you select and never hijacks others.
            Events you share with a group are your own copies; other members
            are invited to their own calendars.
          </Bullet>
          <Bullet>
            <Text style={styles.bold}>Email access powers the magic.</Text>{' '}
            If you connect Gmail, Chord reads your mail to sort it and to
            surface suggestions - the events, tasks, and reminders hiding in
            it. Every suggestion waits for your confirmation, replies are
            only sent when you write and confirm them, and your mail is never
            sold, used for advertising, or used to train AI models.
          </Bullet>
          <Bullet>
            <Text style={styles.bold}>Cross-platform context is opt-in.</Text>
            Personal context (your own tasks, lists, important dates) is only
            used to answer for you, and you can turn that off in Settings.
          </Bullet>
          <Bullet>
            <Text style={styles.bold}>Delete on request.</Text> You can
            disconnect Google, unpair Telegram, and delete your account at
            any time. Email <Text style={styles.link}>privacy@chordapp.ai</Text>{' '}
            and we will purge within 30 days.
          </Bullet>
          <Bullet>
            <Text style={styles.bold}>LLM providers.</Text> By default Chord
            uses the model configured by the deployment. You can bring your
            own key in Settings; in that case prompts go to your provider
            under your account.
          </Bullet>
        </Section>

        {/* Pricing */}
        <Section title="Pricing" subtitle="Free to start, then pick how you pay for the model.">
          <Bullet>
            <Text style={styles.bold}>Free to start.</Text> Every account
            starts with a free allowance of AI use - email sorting,
            suggestions, the morning briefing. No card up front.
          </Bullet>
          <Bullet>
            <Text style={styles.bold}>After that, a paid plan.</Text> The AI
            features pause until you start one; your mail, calendar and
            to-do&rsquo;s stay readable, and the morning briefing keeps
            arriving in a shorter form. A family plan covers up to four
            people.
          </Bullet>
          <Bullet>
            <Text style={styles.bold}>Or bring your own key.</Text> Point Chord
            at your own OpenAI, Anthropic or Gemini key in Settings and it is
            free to use, permanently - you just pay your provider.
          </Bullet>
        </Section>

        <View style={styles.footer}>
          <Text style={styles.footerText}>
            © 2026 Family Grocery Trip Chat Agent LLC d/b/a Chordapp.ai - the
            active mail reader
          </Text>
          <Link href="/privacy" style={styles.footerLink}>
            <Text style={styles.link}>Privacy Policy</Text>
          </Link>
          <Link href="/tos" style={styles.footerLink}>
            <Text style={styles.link}>Terms of Service</Text>
          </Link>
          <Link href="/delete-account" style={styles.footerLink}>
            <Text style={styles.link}>Delete your account</Text>
          </Link>
        </View>
      </KeyboardScrollView>
    </SafeAreaView>
  );
}

// ── sub-components ─────────────────────────────────────────────────

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {subtitle && <Text style={styles.sectionSub}>{subtitle}</Text>}
      <View style={{ marginTop: 16 }}>{children}</View>
    </View>
  );
}

function SurfaceCard({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <View style={styles.surfaceCard}>
      <View style={styles.featureBadge}>
        <Text style={styles.featureBadgeText}>{icon}</Text>
      </View>
      <Text style={styles.featureTitle}>{title}</Text>
      <Text style={styles.featureBody}>{body}</Text>
    </View>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepNum}>
        <Text style={styles.stepNumText}>{n}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.stepTitle}>{title}</Text>
        <Text style={styles.stepBody}>{body}</Text>
      </View>
    </View>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.bullet}>
      <View style={styles.bulletDot} />
      <Text style={styles.bulletText}>{children}</Text>
    </View>
  );
}

/**
 * Hero visual. Deliberately not a chat transcript: the page's job is to show
 * that Chord works the inbox and the calendar, and that each thing it found is
 * waiting on a confirm rather than already done.
 */
function MorningPreview() {
  return (
    <View style={styles.preview}>
      <Text style={styles.previewHead}>This morning</Text>
      <PreviewRow
        icon="✉"
        from="Lincoln Elementary"
        text="Permission slip due Friday"
        action="Add to-do"
      />
      <PreviewRow
        icon="✈"
        from="United"
        text="UA512 moved to 6:40am Thursday"
        action="Update event"
      />
      <PreviewRow
        icon="🎂"
        from="Priya"
        text="Maya's party - Sat 2pm, RSVP by Tue"
        action="Add to calendar"
      />
      <Text style={styles.previewFoot}>3 suggestions · nothing saved yet</Text>
    </View>
  );
}

function PreviewRow({
  icon,
  from,
  text,
  action,
}: {
  icon: string;
  from: string;
  text: string;
  action: string;
}) {
  return (
    <View style={styles.previewRow}>
      <Text style={styles.previewIcon}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={styles.previewFrom}>{from}</Text>
        <Text style={styles.previewText}>{text}</Text>
      </View>
      <View style={styles.previewChip}>
        <Text style={styles.previewChipText}>{action}</Text>
      </View>
    </View>
  );
}

interface DemoProps {
  username: string;
  setUsername: (s: string) => void;
  err: string | null;
  busy: boolean;
  recent: string[];
  showRecent: boolean;
  setShowRecent: (v: boolean | ((v: boolean) => boolean)) => void;
  submit: () => void;
  pickRecent: (name: string) => void;
  deleteRecent: (name: string) => void;
}

function DemoSignIn(p: DemoProps) {
  const filtered = p.username.trim()
    ? p.recent.filter(
        (n) =>
          n.toLowerCase().includes(p.username.trim().toLowerCase()) &&
          n !== p.username.trim(),
      )
    : p.recent;
  return (
    <View>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.fieldInput}
          placeholder="username"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          value={p.username}
          onChangeText={(t) => {
            p.setUsername(t);
            p.setShowRecent(true);
          }}
          onFocus={() => p.setShowRecent(true)}
          onSubmitEditing={p.submit}
        />
        {p.recent.length > 0 && (
          <Pressable
            style={styles.caret}
            onPress={() => p.setShowRecent((v) => !v)}
            hitSlop={8}
          >
            <Text style={styles.caretTxt}>{p.showRecent ? '▲' : '▼'}</Text>
          </Pressable>
        )}
      </View>
      {p.showRecent && filtered.length > 0 && (
        <View style={styles.dropdown}>
          <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 180 }}>
            {filtered.map((name) => (
              <View key={name} style={styles.dropdownRow}>
                <Pressable style={styles.dropdownPick} onPress={() => p.pickRecent(name)}>
                  <Text style={styles.dropdownText}>{name}</Text>
                </Pressable>
                <Pressable
                  style={styles.dropdownDel}
                  onPress={() => p.deleteRecent(name)}
                  hitSlop={8}
                  accessibilityLabel={`remove ${name}`}
                >
                  <Text style={styles.dropdownDelTxt}>×</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        </View>
      )}
      {p.err && <Text style={styles.err}>{p.err}</Text>}
      <Pressable
        style={[styles.btnPrimary, (!p.username || p.busy) && styles.btnDisabled]}
        disabled={!p.username || p.busy}
        onPress={p.submit}
      >
        {p.busy ? (
          <ActivityIndicator color={colors.onAccent} />
        ) : (
          <Text style={styles.btnPrimaryText}>Enter</Text>
        )}
      </Pressable>
    </View>
  );
}

// ── styles ─────────────────────────────────────────────────────────

const MAX_W = 1080;

const styles = themed((colors) => ({
  root: { flex: 1, backgroundColor: colors.bg },
  navbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  navLogo: { fontFamily: siteFont, fontSize: 22, fontWeight: '800', color: colors.accent, letterSpacing: -0.5 },
  navRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  navLink: { paddingHorizontal: 8, paddingVertical: 6 },
  navLinkText: { fontFamily: siteFont, color: colors.muted, fontSize: 14, fontWeight: '500' },
  navBtn: {
    backgroundColor: colors.accent,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  navBtnText: { fontFamily: siteFont, color: colors.onAccent, fontWeight: '600', fontSize: 14 },

  scroll: {
    paddingHorizontal: 24,
    paddingBottom: 64,
    maxWidth: MAX_W,
    width: '100%',
    alignSelf: 'center',
  },
  warnBanner: {
    fontFamily: siteFont,
    color: colors.warn,
    backgroundColor: colors.warnBg,
    padding: 10,
    borderRadius: 8,
    marginTop: 16,
    fontSize: 13,
  },

  hero: { paddingVertical: 56 },
  heroWide: { flexDirection: 'row', alignItems: 'center' },
  heroCopy: {},
  heroVisual: { marginTop: 32 },

  kicker: {
    fontFamily: siteFont,
    color: colors.accent,
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  title: {
    fontFamily: siteFont,
    fontSize: 44,
    lineHeight: 50,
    fontWeight: '800',
    color: colors.text,
    letterSpacing: -1,
  },
  lede: {
    fontFamily: siteFont,
    fontSize: 17,
    lineHeight: 26,
    color: colors.muted,
    marginTop: 18,
    maxWidth: 560,
  },
  heroCtaRow: { flexDirection: 'row', gap: 12, marginTop: 28, flexWrap: 'wrap' },

  btnPrimary: {
    backgroundColor: colors.accent,
    paddingHorizontal: 22,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    minWidth: 180,
  },
  btnPrimaryText: { fontFamily: siteFont, color: colors.onAccent, fontWeight: '700', fontSize: 15 },
  btnGhost: {
    paddingHorizontal: 22,
    paddingVertical: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: 'center',
    minWidth: 180,
  },
  btnGhostText: { fontFamily: siteFont, color: colors.text, fontWeight: '600', fontSize: 15 },
  btnDisabled: { opacity: 0.5 },
  // Apple's own button (its HIG forbids restyling); matched to btnPrimary's height.
  appleBtn: { height: 48, marginBottom: 10 },
  // The browser has no native Apple button; Apple's web guidance is black, logo, this wording.
  appleWebBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#000',
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 22,
    paddingVertical: 14,
    borderRadius: 10,
    minWidth: 180,
    marginBottom: 10,
  },
  appleWebLogo: { width: 16, height: 16, marginTop: -2 },
  // Google's light button spec: white fill, #747775 border, dark label, the
  // multicolor G at ~18px. Corner radius matched to the Apple button above;
  // paddingVertical is one less than its 14 so the 1px border keeps the two
  // buttons the same height.
  googleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#747775',
    paddingHorizontal: 22,
    paddingVertical: 13,
    borderRadius: 10,
    minWidth: 180,
  },
  googleBtnText: { fontFamily: siteFont, color: '#1F1F1F', fontWeight: '500', fontSize: 15 },
  googleLogo: { width: 18, height: 18 },
  // Microsoft's light sign-in button: white fill, #8C8C8C border, #5E5E5E
  // label, the four-square mark. Same size as the Google button above.
  microsoftBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#8C8C8C',
    paddingHorizontal: 22,
    paddingVertical: 13,
    borderRadius: 10,
    minWidth: 180,
    marginTop: 10,
  },
  microsoftBtnText: { fontFamily: siteFont, color: '#5E5E5E', fontWeight: '600', fontSize: 15 },
  microsoftLogo: { width: 18, height: 18, flexDirection: 'row', flexWrap: 'wrap', gap: 2 },
  microsoftSquare: { width: 8, height: 8 },

  preview: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 16,
    gap: 10,
    borderWidth: 1,
    borderColor: colors.border,
    boxShadow: '0 12px 32px rgba(0,0,0,0.06)',
  },
  previewHead: {
    fontFamily: siteFont,
    fontSize: 12,
    fontWeight: '700',
    color: colors.muted,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  previewIcon: { fontSize: 18 },
  previewFrom: { fontFamily: siteFont, fontSize: 12, color: colors.muted, marginBottom: 2 },
  previewText: { fontFamily: siteFont, fontSize: 14, color: colors.text, fontWeight: '600' },
  previewChip: {
    backgroundColor: colors.accentLight,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  previewChipText: { fontFamily: siteFont, color: colors.accent, fontSize: 12, fontWeight: '700' },
  previewFoot: { fontFamily: siteFont, fontSize: 12, color: colors.muted, fontStyle: 'italic' },

  section: { paddingVertical: 40, borderTopWidth: 1, borderTopColor: colors.border },
  sectionTitle: {
    fontFamily: siteFont,
    fontSize: 28,
    fontWeight: '800',
    color: colors.text,
    letterSpacing: -0.5,
  },
  sectionSub: { fontFamily: siteFont, color: colors.muted, marginTop: 6, fontSize: 15 },

  cards: { gap: 16 },
  // Four surface cards. Wrap + a basis is self-responsive - one column on a
  // phone, two-up on a laptop - so this needs no isWide probe, and two-up
  // beats four-across, which squeezes each body into two-word lines.
  cardsWrap: { flexDirection: 'row', flexWrap: 'wrap' },
  surfaceCard: {
    flexGrow: 1,
    // Basis > a third of the 1032 max content width, so four cards land 2x2
    // rather than 3-up with a stretched orphan. flexShrink must be set
    // explicitly: RN defaults it to 0, and a 400 basis would otherwise
    // overflow a phone screen instead of collapsing to one column.
    flexBasis: 400,
    flexShrink: 1,
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 22,
    borderWidth: 1,
    borderColor: colors.border,
  },
  featureBadge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.accentLight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  featureBadgeText: { color: colors.accent, fontWeight: '700' },
  featureTitle: { fontFamily: siteFont, fontSize: 17, fontWeight: '700', color: colors.text, marginBottom: 8 },
  featureBody: { fontFamily: siteFont, color: colors.muted, fontSize: 14, lineHeight: 21 },

  stepList: { gap: 18 },
  step: { flexDirection: 'row', gap: 14, alignItems: 'flex-start' },
  stepNum: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  stepNumText: { fontFamily: siteFont, color: colors.onAccent, fontWeight: '700' },
  stepTitle: { fontFamily: siteFont, fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 4 },
  stepBody: { fontFamily: siteFont, color: colors.muted, fontSize: 14, lineHeight: 21 },

  fineprint: { fontFamily: siteFont, color: colors.muted, fontSize: 13, marginTop: 18, fontStyle: 'italic' },
  fineprintTight: { fontFamily: siteFont, color: colors.muted, fontSize: 12, marginTop: 10, lineHeight: 17 },
  // Sits directly under the sign-in button: this is the acceptance moment, so
  // it reads a step darker than the fine print below it rather than being
  // tucked away as boilerplate.
  consentLine: { fontFamily: siteFont, color: colors.text, fontSize: 12, marginTop: 12, lineHeight: 18 },

  signInWrap: { paddingVertical: 32, alignItems: 'center' },
  signInCard: {
    width: '100%',
    maxWidth: 460,
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 28,
    borderWidth: 1,
    borderColor: colors.border,
    boxShadow: '0 8px 24px rgba(0,0,0,0.06)',
  },
  signInTitle: { fontFamily: siteFont, fontSize: 22, fontWeight: '700', color: colors.text },
  signInSub: { fontFamily: siteFont, color: colors.muted, fontSize: 14, marginTop: 6, marginBottom: 18, lineHeight: 20 },
  refBanner: {
    backgroundColor: colors.accentLight,
    padding: 12,
    borderRadius: 10,
    marginBottom: 16,
  },
  refBannerText: { fontFamily: siteFont, color: colors.accentDark, fontSize: 13, lineHeight: 19 },

  body: { fontFamily: siteFont, fontSize: 15, lineHeight: 23, color: colors.text, marginBottom: 14 },
  bold: { fontWeight: '700' },
  link: { fontFamily: siteFont, color: colors.accent, textDecorationLine: 'underline' },

  bullet: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  bulletDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.accent,
    marginTop: 10,
  },
  bulletText: { fontFamily: siteFont, flex: 1, color: colors.text, fontSize: 15, lineHeight: 22 },

  fieldInput: {
    fontFamily: siteFont,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    backgroundColor: colors.card,
    color: colors.text,
  },
  fieldArea: { minHeight: 80, textAlignVertical: 'top' },

  inputRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  caret: { position: 'absolute', right: 8, padding: 6 },
  caretTxt: { color: colors.muted, fontSize: 10 },
  dropdown: {
    marginTop: -6,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: colors.card,
    overflow: 'hidden',
  },
  dropdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  dropdownPick: { flex: 1, padding: 10 },
  dropdownText: { fontFamily: siteFont, fontSize: 15, color: colors.text },
  dropdownDel: { paddingHorizontal: 12, paddingVertical: 10 },
  dropdownDelTxt: { fontSize: 18, color: colors.muted, fontWeight: '600' },

  err: { fontFamily: siteFont, color: colors.red, marginBottom: 8, fontSize: 13 },

  footer: {
    paddingVertical: 32,
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: colors.border,
    marginTop: 16,
  },
  footerText: { fontFamily: siteFont, color: colors.muted, fontSize: 13 },
  footerLink: { marginTop: 8 },
}));
