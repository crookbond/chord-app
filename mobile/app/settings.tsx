/**
 * User-level Settings - top-level tab.
 *
 * PR-D scope: persists listening mode and BYO model key.
 * Runtime wiring (bot honoring listening_mode, llm factory using the
 * stored key, passive memory extraction) ships in a follow-up PR.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Stack, router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { MainBottomNav } from '@/group-nav';
import { useScrollTopOnReselect } from '@/tab-reselect';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { TextInput } from '@/text-input';
import { KeyboardScrollView } from '@/keyboard';
import { clearParamsWhenReady } from '@/router-ready';
import { TimeField } from '@/time-field';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import type {
  CalendarSource,
  ConnectorPlatform,
  MeConnectorsResponse,
  EmailRoutingRuleDto,
  EmailSwipeAction,
  EmailAfterRemove,
  EmailVacationSettings,
  MeSettings,
  ModelProvider,
  PermissionRequest,
  TrustCandidate,
  TrustGrant,
  BlockedUser,
  ConnectedAiApp,
  TrustScope,
  User,
} from '@chord/kernel';
import {
  greetingName,
  deleteAccountPlanNote,
  formatTimeOfDay,
  parseTimeOfDay,
  MAILBOX_NICKNAME_MAX,
  formatWhatsappNumber,
  whatsappChatUrl,
} from '@chord/kernel';

import {
  type CalendarStatus,
  clearModelKey,
  deleteAccount,
  getBilling,
  getCalendarStatus,
  getMe,
  getMeConnectors,
  listEmailRoutes,
  addEmailRoute,
  deleteEmailRoute,
  getEmailVacation,
  setEmailVacation,
  getSettings,
  grantCalendarScope,
  listCalendarSources,
  getDefaultCalendar,
  setDefaultCalendar,
  listPermissionRequests,
  listTrustCandidates,
  listTrustGrants,
  respondToPermissionRequest,
  revokeTrustGrant,
  runProactiveScan,
  setCalendarColor,
  forgetDeviceCalendar,
  setMailboxColor,
  setMailboxSignature,
  setCalendarSourceOverride,
  setModelKey,
  startOpenRouterConnect,
  setMyName,
  setNudge,
  setWeatherLocation,
  setBriefingChannelMuted,
  setNotificationPrefs,
  setTrustGrant,
  disconnectCalendar,
  signOut,
  syncCalendar,
  CalendarReconnectError,
  getEmailStatus,
  syncEmail,
  disconnectEmail,
  grantGmailScope,
  GmailReconnectError,
  setEmailPrefs,
  setEmailAccountPrefs,
  connectOutlookAccount,
  connectGmailAccount,
  connectImapAccount,
  deleteEmailAccount,
  syncEmailAccount,
  retryEmailAccount,
  getAiConsentStatus,
  setAiConsent,
  listBlockedUsers,
  listAiApps,
  disconnectAiApp,
  unblockUser,
} from '@/api';
import type {
  AiConsentStatus,
  BillingStatus,
  EmailAccountSummary,
  EmailStatus,
  ImapPresetKey,
} from '@chord/kernel';
import {
  DEFAULT_EMAIL_SIGNATURE,
  formatTokenCount,
  IMAP_PRESETS,
  plainTextToSignatureHtml,
  setSignatureLinkHref,
  signatureLinkInput,
  usageIsFreeAllowance,
} from '@chord/kernel';
import { RichSignatureEditor } from '@/signature-editor';
import {
  pickSignaturePicture,
  readNativeClipboard,
  signatureFromPaste,
  useWebSignaturePaste,
  type ClipboardContent,
  type PasteTarget,
} from '@/signature-paste';
import { LocationSetting } from '@/location-setting';
import { PhoneSection } from '@/phone-section';
import {
  getRemindersSyncEnabled,
  getSelectedCalendarIds,
  listDeviceCalendars,
  runAppleSync,
  setRemindersSyncEnabled,
  setSelectedCalendarIds,
  type DeviceCalendarChoice,
} from '@/applesync';
import { GOOGLE_CLIENT_ID, GOOGLE_NATIVE_REDIRECT } from '@/google-auth';
import {
  getPermissionStatus,
  isPushEnabledLocally,
  registerForPush,
  unregisterForPush,
} from '@/push';
import { useApp } from '@/store';
import { colors, themed } from '@/theme';
import { useBusyKeys } from '@/busy-keys';
import { setColorSchemePreference, useColorSchemePreference } from '@/color-scheme';
import { ColorChoiceRow, ColorSwatch } from '@/color-choices';
import { confirmDestructive } from '@/confirm';
import { setAfterRemovePref } from '@/email-thread-nav';
import { useEmailCategoryOrder } from '@/email-category-order';
import { setEmailRemoveAction } from '@/email-remove-action';
import { FamilyCard } from '@/family-card';
import {
  MS_ADD_ACCOUNT_PROMPT,
  MS_DISCOVERY,
  OUTLOOK_CALENDAR_SCOPE,
  OUTLOOK_SCOPES,
  microsoftRedirectUri,
} from '@/microsoft-auth';
import {
  BILLING_LINK_OUT,
  isEitherSubscriptionPaid,
  pollBillingAfterCheckout,
  PlanCard,
} from '@/plan-card';

WebBrowser.maybeCompleteAuthSession();

const GOOGLE_DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
};

const IMAP_PRESET_CHOICES: ImapPresetKey[] = ['yahoo', 'aol', 'icloud'];

// Full `calendar` (not `.readonly` or `.events`) so the server can
// also create the dedicated "Chord" calendar via calendars.insert on
// first push. `calendar` covers both read + write.
const CALENDAR_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar',
];

// ADR 0062 - Gmail reader. gmail.modify covers read + reply + label write-back.
// Requested alongside the calendar scope so a Gmail connect doesn't drop
// calendar access (Google returns the cumulative granted set).
const GMAIL_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify',
];

/** Section separator for the redesigned settings (5 groups, ADR 0078). */
function SectionHeader({ title }: { title: string }) {
  return <Text style={styles.sectionHeader}>{title}</Text>;
}

/**
 * Collapsed-by-default card: title + one-line status summary; tap to expand.
 * `openWhen` forces it open when attention is needed (a reconnect deep link,
 * a disconnected account) so problems are never hidden behind a fold.
 */
function Disclosure({
  title,
  summary,
  openWhen,
  danger,
  compactWhenClosed,
  defaultOpen,
  children,
}: {
  title: string;
  summary?: string;
  openWhen?: boolean;
  danger?: boolean;
  /** Collapsed = content-width chip; expands to full width for the body. */
  compactWhenClosed?: boolean;
  /** Starts open; the header still collapses it. */
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  useEffect(() => {
    if (openWhen) setOpen(true);
  }, [openWhen]);
  return (
    <View
      style={[
        styles.card,
        danger && styles.deleteCard,
        // Compact mode: a content-width chip while closed (so it can sit
        // inline beside other actions); breaks onto its own full-width line
        // when opened (the body needs the room).
        compactWhenClosed &&
          (open ? { width: '100%' } : { alignSelf: 'flex-start', marginTop: 0 }),
      ]}
    >
      <Pressable style={styles.discloseHead} onPress={() => setOpen((o) => !o)}>
        <View
          style={
            compactWhenClosed && !open
              ? { paddingRight: 8 }
              : { flex: 1, minWidth: 0 }
          }
        >
          <Text style={[styles.label, danger && { color: colors.red }]}>{title}</Text>
          {!open && summary ? (
            <Text style={styles.muted} numberOfLines={1}>
              {summary}
            </Text>
          ) : null}
        </View>
        <Text style={styles.chev}>{open ? '▾' : '▸'}</Text>
      </Pressable>
      {open ? <View style={styles.discloseBody}>{children}</View> : null}
    </View>
  );
}

/**
 * One connected-account line: "address · kind" + a switch. Blue/on =
 * connected; slide off to disconnect; slide back on to (re)connect - the
 * same control doubles as the reconnect affordance.
 */
function SwitchRow({
  title,
  sub,
  on,
  busy,
  disabled,
  onToggle,
  onSync,
  syncBusy,
}: {
  title: string;
  sub?: string;
  on: boolean;
  busy?: boolean;
  disabled?: boolean;
  onToggle: () => void;
  /** Renders a compact in-row Sync chip while connected. */
  onSync?: () => void;
  syncBusy?: boolean;
}) {
  return (
    <View style={[styles.toggleRow, { marginTop: 10, gap: 8 }]}>
      <View style={{ flex: 1, minWidth: 0, paddingRight: 4 }}>
        <Text style={styles.value} numberOfLines={1}>
          {title}
        </Text>
        {sub ? <Text style={styles.muted}>{sub}</Text> : null}
      </View>
      {on && onSync ? (
        <Pressable
          onPress={onSync}
          disabled={disabled}
          style={[styles.btnGhost, styles.syncChip, disabled && styles.btnDisabled]}
        >
          {syncBusy ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <Text style={styles.btnGhostTxt}>Sync</Text>
          )}
        </Pressable>
      ) : null}
      {busy ? (
        <ActivityIndicator color={colors.accent} />
      ) : (
        <Pressable
          onPress={onToggle}
          disabled={disabled}
          style={[styles.switchTrack, on && styles.switchTrackOn, disabled && styles.btnDisabled]}
        >
          <View style={[styles.switchThumb, on && styles.switchThumbOn]} />
        </Pressable>
      )}
    </View>
  );
}

/**
 * One mailbox's name (ADR 0145).
 *
 * Saved on blur/submit rather than per keystroke: a rename is not worth a
 * request per character, and the draft is local until then. Its own component
 * so each field owns its draft - one shared map would make every field
 * re-render on every keystroke in any of them.
 */
function MailboxNameField({
  label,
  placeholder,
  subtitle,
  disabled,
  onSave,
  color,
  pickedColor,
  onPickColor,
}: {
  label: string;
  placeholder: string;
  subtitle: string;
  disabled?: boolean;
  onSave: (value: string) => void;
  /** ADR 0278 — the mailbox's color, and the user's own pick (null = none). */
  color?: string;
  pickedColor?: string | null;
  onPickColor?: (hex: string | null) => void;
}) {
  const [draft, setDraft] = useState(label);
  const [colorOpen, setColorOpen] = useState(false);
  // Re-sync when the server answers with a different value (or another device
  // renamed it): the prop is the truth, the draft is only what is being typed.
  useEffect(() => setDraft(label), [label]);
  return (
    <View style={{ marginTop: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        {onPickColor ? (
          <ColorSwatch
            color={color}
            onPress={() => setColorOpen((o) => !o)}
            disabled={disabled}
            label={`Color for ${subtitle}`}
          />
        ) : null}
        <TextInput
          value={draft}
          onChangeText={setDraft}
          onBlur={() => onSave(draft)}
          onSubmitEditing={() => onSave(draft)}
          returnKeyType="done"
          maxLength={MAILBOX_NICKNAME_MAX}
          editable={!disabled}
          placeholder={placeholder}
          placeholderTextColor={colors.muted}
          style={[styles.input, { flex: 1 }]}
        />
      </View>
      {colorOpen && onPickColor ? (
        <ColorChoiceRow
          picked={pickedColor ?? null}
          disabled={disabled}
          onPick={(hex) => {
            setColorOpen(false);
            onPickColor(hex);
          }}
        />
      ) : null}
      <Text style={styles.muted}>{subtitle}</Text>
    </View>
  );
}
export default function UserSettingsScreen() {
  const colorPref = useColorSchemePreference();
  const user = useApp((s) => s.user);
  const reset = useApp((s) => s.reset);
  const setUser = useApp((s) => s.setUser);

  const [firstNameDraft, setFirstNameDraft] = useState(user?.firstName ?? '');
  const [lastNameDraft, setLastNameDraft] = useState(user?.lastName ?? '');
  const [preferredNameDraft, setPreferredNameDraft] = useState(user?.preferredName ?? '');
  const [nameDirty, setNameDirty] = useState(false);

  const [calStatus, setCalStatus] = useState<CalendarStatus | null>(null);
  const [settings, setSettings] = useState<MeSettings | null>(null);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  // ADR 0283 — whether Chord's AI may use this user's data.
  const [aiConsent, setAiConsentState] = useState<AiConsentStatus | null>(null);
  const [aiConsentBusy, setAiConsentBusy] = useState(false);
  const [aiConsentErr, setAiConsentErr] = useState<string | null>(null);
  useEffect(() => {
    getAiConsentStatus().then(setAiConsentState).catch(() => {});
  }, []);
  const toggleAiConsent = () => {
    const allowed = aiConsent?.consent?.decision === 'granted';
    // A first yes needs the age statement, which only the consent screen asks.
    if (!allowed && !aiConsent?.consent?.ageConfirmed) {
      router.push({ pathname: '/ai-consent', params: { next: '/settings' } });
      return;
    }
    setAiConsentBusy(true);
    setAiConsentErr(null);
    setAiConsent({ decision: allowed ? 'declined' : 'granted' })
      .then(setAiConsentState)
      .catch((e: Error) => setAiConsentErr(e.message))
      .finally(() => setAiConsentBusy(false));
  };
  // True while waiting on invoice.paid to land after a web checkout redirect
  // (see pollBillingAfterCheckout).
  const [checkoutConfirming, setCheckoutConfirming] = useState(false);
  const [connectors, setConnectors] = useState<MeConnectorsResponse | null>(null);
  const [routes, setRoutes] = useState<EmailRoutingRuleDto[]>([]);
  const [vacation, setVacation] = useState<EmailVacationSettings | null>(null);

  const [sigDraft, setSigDraft] = useState('');
  // ADR 0260 - a rich (HTML) signature, edited beside the plain one.
  const [sigHtmlDraft, setSigHtmlDraft] = useState('');
  // ADR 0260 addendum 2026-11-13 - the rich signature is edited as it looks;
  // its HTML stays behind "Edit HTML". The editor page is rebuilt only when
  // the HTML changes from outside it (this key), so typing keeps the caret.
  const [sigEditorKey, setSigEditorKey] = useState(0);
  const [sigShowHtml, setSigShowHtml] = useState(false);
  const [sigLinkEdit, setSigLinkEdit] = useState<{ index: number; href: string; text: string } | null>(null);
  const setSigHtmlOutside = useCallback((next: string | ((cur: string) => string)) => {
    setSigHtmlDraft(next);
    setSigEditorKey((k) => k + 1);
    setSigLinkEdit(null);
  }, []);
  const [sigRich, setSigRich] = useState(false);
  const [sigDirty, setSigDirty] = useState(false);
  // ADR 0260 addendum - which signature is being edited: the one every
  // mailbox shares ('shared'), or one mailbox's own ('primary' / account id).
  const [sigMailbox, setSigMailbox] = useState('shared');

  const [keyProvider, setKeyProvider] = useState<ModelProvider>('openai');
  const [keyModel, setKeyModel] = useState('');
  const [keyValue, setKeyValue] = useState('');
  const [keyBaseUrl, setKeyBaseUrl] = useState('');

  const [busy, setBusy] = useState<
    null | 'connect' | 'sync' | 'disconnect' | 'nudge' | 'nudgeSave' | 'mode' | 'key' | 'clearKey' | 'name' | 'delete' | 'push' | 'gmailConnect' | 'gmailSync' | 'gmailDisconnect' | 'gmailPrefs' | 'signature' | 'olConnect' | 'imapConnect' | 'gm2Connect' | 'acctSync' | 'acctRemove' | 'acctRetry' | 'weather' | 'briefChan' | 'openrouter'
  >(null);
  /** Which mailbox row an acctSync/acctRemove/acctRetry `busy` belongs to —
   *  `busy` alone names the action, not the row, so every row spun. */
  const [busyAccountId, setBusyAccountId] = useState<string | null>(null);
  // ADR 0080 - inline add-mailbox form (Yahoo/AOL/iCloud app password).
  const [imapFormOpen, setImapFormOpen] = useState(false);
  const [imapPreset, setImapPreset] = useState<ImapPresetKey>('yahoo');
  const [imapEmail, setImapEmail] = useState('');
  const [imapPassword, setImapPassword] = useState('');
  const [emailStatus, setEmailStatus] = useState<EmailStatus | null | undefined>(undefined);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [nudgeMsg, setNudgeMsg] = useState<string | null>(null);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  const [permStatus, setPermStatus] = useState<'granted' | 'denied' | 'undetermined'>(
    'undetermined',
  );
  // Quiet-hours time drafts (parsed on save), mirroring the nudge time input.
  const [quietStartDraft, setQuietStartDraft] = useState('');
  const [quietEndDraft, setQuietEndDraft] = useState('');
  const [quietDirty, setQuietDirty] = useState(false);

  // Nudge schedule: a text draft (parsed on save) + dirty flag.
  const [nudgeTimeDraft, setNudgeTimeDraft] = useState('');
  const [nudgeTimeDirty, setNudgeTimeDirty] = useState(false);

  // ADR 0091 - weather location draft, same draft/dirty shape as the time.
  const [weatherDraft, setWeatherDraft] = useState('');
  const [weatherDirty, setWeatherDirty] = useState(false);
  const [weatherMsg, setWeatherMsg] = useState<string | null>(null);

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
      scopes: CALENDAR_SCOPES,
      redirectUri,
      usePKCE: true,
      responseType: AuthSession.ResponseType.Code,
      extraParams: { access_type: 'offline', prompt: 'consent' },
    },
    GOOGLE_DISCOVERY,
  );

  const [gmailRequest, , gmailPromptAsync] = AuthSession.useAuthRequest(
    {
      clientId: GOOGLE_CLIENT_ID,
      scopes: GMAIL_SCOPES,
      redirectUri,
      usePKCE: true,
      responseType: AuthSession.ResponseType.Code,
      extraParams: { access_type: 'offline', prompt: 'consent' },
    },
    GOOGLE_DISCOVERY,
  );

  // ADR 0080 addendum - secondary Gmail: same Google client + scopes as the
  // primary connect, plus select_account so the picker offers OTHER accounts.
  const [gmail2Request, , gmail2PromptAsync] = AuthSession.useAuthRequest(
    {
      clientId: GOOGLE_CLIENT_ID,
      scopes: GMAIL_SCOPES,
      redirectUri,
      usePKCE: true,
      responseType: AuthSession.ResponseType.Code,
      extraParams: { access_type: 'offline', prompt: 'consent select_account' },
    },
    GOOGLE_DISCOVERY,
  );

  // ADR 0080 - the Microsoft client id comes from /me/email/status, so a
  // deploy without MS keys simply hides the Outlook option ('mock' skips
  // the browser flow entirely). Native uses the plain chord:// scheme -
  // the reversed-client-id redirect is a Google-only convention (ADR 0041)
  // and is not registrable in Entra.
  const msRedirectUri = useMemo(microsoftRedirectUri, []);
  const outlookClientId = emailStatus?.outlookClientId ?? null;
  const outlookCalendar = emailStatus?.outlookCalendar === true;
  const outlookScopes = useMemo(
    () => (outlookCalendar ? [...OUTLOOK_SCOPES, OUTLOOK_CALENDAR_SCOPE] : OUTLOOK_SCOPES),
    [outlookCalendar],
  );
  const [outlookRequest, , outlookPromptAsync] = AuthSession.useAuthRequest(
    {
      clientId: outlookClientId && outlookClientId !== 'mock' ? outlookClientId : 'unset',
      scopes: outlookScopes,
      redirectUri: msRedirectUri,
      usePKCE: true,
      responseType: AuthSession.ResponseType.Code,
      extraParams: { prompt: MS_ADD_ACCOUNT_PROMPT },
    },
    MS_DISCOVERY,
  );

  const refreshAll = useCallback(async () => {
    try {
      const [c, s, k, e, b] = await Promise.all([
        getCalendarStatus().catch(() => null),
        getSettings(),
        getMeConnectors().catch(() => null),
        getEmailStatus().catch(() => null),
        getBilling().catch(() => null),
      ]);
      // Separate from the batch above: a mailbox nobody has connected yet has
      // no rules, and a failure here must not blank the rest of Settings.
      setRoutes(await listEmailRoutes().catch(() => []));
      setVacation(await getEmailVacation().catch(() => null));
      setCalStatus(c);
      setEmailStatus(e);
      setSettings(s);
      setConnectors(k);
      setBilling(b);
      setSigDraft(s.emailSignature ?? '');
      setSigHtmlOutside(s.emailSignatureHtml ?? '');
      setSigRich(!!s.emailSignatureHtml);
      setSigDirty(false);
      setSigMailbox('shared');
      setNudgeTimeDraft(formatTimeOfDay(s.nudgeHour, s.nudgeMinute));
      setNudgeTimeDirty(false);
      setWeatherDraft(s.weatherPlace ?? '');
      setWeatherDirty(false);
      setQuietStartDraft(formatTimeOfDay(s.quietStartHour, s.quietStartMinute));
      setQuietEndDraft(formatTimeOfDay(s.quietEndHour, s.quietEndMinute));
      setQuietDirty(false);
      if (s.modelProvider) setKeyProvider(s.modelProvider);
      if (s.modelName) setKeyModel(s.modelName);
      setKeyBaseUrl(s.modelBaseUrl ?? '');
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [setSigHtmlOutside]);

  useEffect(() => {
    void refreshAll();
    void isPushEnabledLocally().then(setPushEnabled);
    void getPermissionStatus().then(setPermStatus);
  }, [refreshAll]);

  // ADR 0156 — a Google consent from an Apple-only session can land in the
  // account that already held that Google identity. The token now answers as
  // that user, so drop the old account's cached chats and show its profile.
  const adoptConsentUser = useCallback(
    (next: User | undefined) => {
      if (!next || next.id === user?.id) return;
      reset();
      setUser(next);
      setFirstNameDraft(next.firstName ?? '');
      setLastNameDraft(next.lastName ?? '');
      setPreferredNameDraft(next.preferredName ?? '');
      setNameDirty(false);
      void refreshAll();
    },
    [refreshAll, reset, setUser, user?.id],
  );

  // Refetch the user on focus so a name set via chat (set_my_name in the
  // personal group) reflects here. Don't clobber in-progress edits.
  useFocusEffect(
    useCallback(() => {
      void getMe()
        .then((fresh) => {
          if (!fresh) return;
          setUser(fresh);
          if (!nameDirty) {
            setFirstNameDraft(fresh.firstName ?? '');
            setLastNameDraft(fresh.lastName ?? '');
            setPreferredNameDraft(fresh.preferredName ?? '');
          }
        })
        .catch(() => {});
    }, [nameDirty, setUser]),
  );

  // ADR 0269 - web starts a fresh page so nothing the last account loaded
  // stays in memory; native has already reset its caches (sign-out.ts).
  const leaveAfterSignOut = () => {
    if (Platform.OS === 'web' && typeof window !== 'undefined') window.location.replace('/');
    else router.replace('/');
  };

  const logout = async () => {
    await signOut();
    reset();
    leaveAfterSignOut();
  };

  const deleteReady = deleteConfirm.trim().toUpperCase() === 'DELETE';
  const deletePlanNote = deleteAccountPlanNote(billing);

  const deleteAccountNow = useCallback(async () => {
    if (!deleteReady) return;
    setBusy('delete');
    setErr(null);
    try {
      await deleteAccount();
      reset();
      leaveAfterSignOut();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  }, [deleteReady, reset]);

  const connectCalendar = useCallback(async () => {
    if (!request) return;
    setErr(null);
    setBusy('connect');
    try {
      const result = await promptAsync();
      if (result.type !== 'success') {
        if (result.type !== 'dismiss' && result.type !== 'cancel') {
          setErr(`google: ${result.type}`);
        }
        return;
      }
      const code = result.params.code;
      const codeVerifier = request.codeVerifier;
      if (!code || !codeVerifier) {
        setErr('google did not return a code');
        return;
      }
      adoptConsentUser((await grantCalendarScope({ code, codeVerifier, redirectUri })).user);
      try {
        const r = await syncCalendar();
        setLastSync(`Pulled ${r.fetched}, added ${r.inserted}.`);
      } catch (e) {
        setErr(
          e instanceof CalendarReconnectError
            ? 'Google Calendar access expired - reconnect to keep syncing.'
            : `connected, but initial sync failed: ${(e as Error).message}`,
        );
      }
      const c = await getCalendarStatus();
      setCalStatus(c);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [adoptConsentUser, promptAsync, redirectUri, request]);

  const connectGmail = useCallback(async () => {
    if (!gmailRequest) return;
    setErr(null);
    setBusy('gmailConnect');
    try {
      const result = await gmailPromptAsync();
      if (result.type !== 'success') {
        if (result.type !== 'dismiss' && result.type !== 'cancel') {
          setErr(`google: ${result.type}`);
        }
        return;
      }
      const code = result.params.code;
      const codeVerifier = gmailRequest.codeVerifier;
      if (!code || !codeVerifier) {
        setErr('google did not return a code');
        return;
      }
      adoptConsentUser((await grantGmailScope({ code, codeVerifier, redirectUri })).user);
      try {
        await syncEmail();
      } catch (e) {
        if (!(e instanceof GmailReconnectError)) {
          setErr(`connected, but initial sync failed: ${(e as Error).message}`);
        }
      }
      setEmailStatus(await getEmailStatus().catch(() => null));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [adoptConsentUser, gmailPromptAsync, gmailRequest, redirectUri]);

  const syncGmailNow = useCallback(async () => {
    setErr(null);
    setBusy('gmailSync');
    try {
      // Per-row semantics: this chip syncs the PRIMARY Gmail only; each
      // attached mailbox row has its own chip.
      await syncEmail({ scope: 'primary' });
      setEmailStatus(await getEmailStatus().catch(() => null));
    } catch (e) {
      setErr(
        e instanceof GmailReconnectError
          ? 'Gmail access expired - reconnect to keep syncing.'
          : (e as Error).message,
      );
    } finally {
      setBusy(null);
    }
  }, []);

  // ── ADR 0080 - additional mailboxes ─────────────────────────────────
  /**
   * A connect that landed on the mailbox already attached (ADR 0320). Said
   * only at the "add a mailbox" door: reaching the same row from the reconnect
   * slide-on is the point of that gesture, not a surprise.
   */
  const [addNote, setAddNote] = useState<string | null>(null);
  const noteIfReattached = useCallback(
    (purpose: 'add' | 'reconnect', account: { emailAddress: string; reattached?: boolean }) => {
      if (purpose !== 'add') return;
      setAddNote(
        account.reattached
          ? `${account.emailAddress} was already connected - its connection was refreshed, and no new mailbox was added. Choose a different account to add one.`
          : null,
      );
    },
    [],
  );

  const connectOutlook = useCallback(async (purpose: 'add' | 'reconnect' = 'add') => {
    setErr(null);
    if (purpose === 'add') setAddNote(null);
    setBusy('olConnect');
    try {
      if (outlookClientId === 'mock') {
        noteIfReattached(
          purpose,
          await connectOutlookAccount({ code: 'mock', codeVerifier: 'mock', redirectUri: msRedirectUri }),
        );
      } else {
        if (!outlookRequest) return;
        const result = await outlookPromptAsync();
        if (result.type !== 'success') {
          if (result.type !== 'dismiss' && result.type !== 'cancel') {
            setErr(`microsoft: ${result.type}`);
          }
          return;
        }
        const code = result.params.code;
        const codeVerifier = outlookRequest.codeVerifier;
        if (!code || !codeVerifier) {
          setErr('microsoft did not return a code');
          return;
        }
        noteIfReattached(purpose, await connectOutlookAccount({ code, codeVerifier, redirectUri: msRedirectUri }));
      }
      setEmailStatus(await getEmailStatus().catch(() => null));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [outlookClientId, outlookPromptAsync, outlookRequest, msRedirectUri, noteIfReattached]);

  const connectAnotherGmail = useCallback(async (purpose: 'add' | 'reconnect' = 'add') => {
    setErr(null);
    if (purpose === 'add') setAddNote(null);
    setBusy('gm2Connect');
    try {
      if (emailStatus?.gmailProviderMock) {
        noteIfReattached(
          purpose,
          await connectGmailAccount({ code: 'mock', codeVerifier: 'mock', redirectUri }),
        );
      } else {
        if (!gmail2Request) return;
        const result = await gmail2PromptAsync();
        if (result.type !== 'success') {
          if (result.type !== 'dismiss' && result.type !== 'cancel') {
            setErr(`google: ${result.type}`);
          }
          return;
        }
        const code = result.params.code;
        const codeVerifier = gmail2Request.codeVerifier;
        if (!code || !codeVerifier) {
          setErr('google did not return a code');
          return;
        }
        noteIfReattached(purpose, await connectGmailAccount({ code, codeVerifier, redirectUri }));
      }
      setEmailStatus(await getEmailStatus().catch(() => null));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [
    emailStatus?.gmailProviderMock,
    gmail2PromptAsync,
    gmail2Request,
    redirectUri,
    noteIfReattached,
  ]);

  const addImapMailbox = useCallback(async () => {
    const emailAddress = imapEmail.trim();
    if (!emailAddress || !imapPassword) return;
    setErr(null);
    setAddNote(null);
    setBusy('imapConnect');
    try {
      // The IMAP form is reused by the reconnect slide-on, which prefills the
      // address - so a re-attach there is expected and says nothing.
      const account = await connectImapAccount({
        emailAddress,
        password: imapPassword,
        preset: imapPreset,
      });
      noteIfReattached(imapForReconnect.current ? 'reconnect' : 'add', account);
      setImapFormOpen(false);
      setImapEmail('');
      setImapPassword('');
      setEmailStatus(await getEmailStatus().catch(() => null));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [imapEmail, imapPassword, imapPreset, noteIfReattached]);

  const syncAccountNow = useCallback(async (id: string) => {
    setErr(null);
    setBusy('acctSync');
    setBusyAccountId(id);
    try {
      await syncEmailAccount(id);
      setEmailStatus(await getEmailStatus().catch(() => null));
    } catch (e) {
      setErr(
        e instanceof GmailReconnectError
          ? 'Mailbox access expired - reconnect it to keep syncing.'
          : (e as Error).message,
      );
    } finally {
      setBusy(null);
      setBusyAccountId(null);
    }
  }, []);

  /**
   * Slide-on for a paused mailbox. The stored credential is usually still
   * good - a provider hiccup flagged the row - so retry with it first and fall
   * back to the connect flow only when the server says it is genuinely dead.
   */
  const reconnectAccount = useCallback(
    async (a: EmailAccountSummary) => {
      setErr(null);
      setBusy('acctRetry');
      setBusyAccountId(a.id);
      let needsUser = false;
      try {
        needsUser = (await retryEmailAccount(a.id)).needsReconnect;
        setEmailStatus(await getEmailStatus().catch(() => null));
      } catch (e) {
        setErr((e as Error).message);
        return;
      } finally {
        setBusy(null);
        setBusyAccountId(null);
      }
      if (!needsUser) return;
      if (a.provider === 'gmail') void connectAnotherGmail('reconnect');
      else if (a.provider === 'outlook') void connectOutlook('reconnect');
      else {
        setImapPreset(a.presetKey ?? 'yahoo');
        setImapEmail(a.emailAddress);
        imapFormScrolled.current = false;
        imapForReconnect.current = true;
        setImapFormOpen(true);
      }
    },
    [connectAnotherGmail, connectOutlook],
  );

  const removeAccount = useCallback((id: string, label: string) => {
    const proceed = async () => {
      setErr(null);
      setBusy('acctRemove');
      setBusyAccountId(id);
      try {
        await deleteEmailAccount(id);
        setEmailStatus(await getEmailStatus().catch(() => null));
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(null);
        setBusyAccountId(null);
      }
    };
    confirmDestructive(
      `Remove ${label}`,
      "Chord will forget this mailbox's mail. Nothing is deleted at the provider.",
      () => void proceed(),
      { confirmLabel: 'Remove' },
    );
  }, []);

  const disconnectGmailNow = useCallback(() => {
    const proceed = async () => {
      setErr(null);
      setBusy('gmailDisconnect');
      try {
        await disconnectEmail();
        setEmailStatus(await getEmailStatus().catch(() => null));
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(null);
      }
    };
    confirmDestructive(
      'Disconnect Gmail',
      "Chord will forget your mail. You can reconnect anytime. This doesn't delete anything in Gmail.",
      () => void proceed(),
      { confirmLabel: 'Disconnect' },
    );
  }, []);

  // Deep link from proactive reconnect nudges
  // (chord://settings?reconnect=calendar|gmail) - kick off the matching connect
  // flow once auth request + status are ready and we're actually disconnected.
  const reconnectParam = useLocalSearchParams<{ reconnect?: string }>().reconnect;
  // ADR 0252 - chord://settings?open=model (the key-health nudge and Email banner).
  const openParam = useLocalSearchParams<{ open?: string }>().open;
  const reconnectHandled = useRef(false);

  // Deep-linked straight at the Gmail section (Email tab CTA / reconnect
  // nudge): scroll its card into view instead of landing at the page top.
  const scrollRef = useRef<ScrollView>(null);
  useScrollTopOnReselect('settings', scrollRef);
  // Opening the IMAP add-mailbox form jumps the screen to it - the form sits
  // mid-page inside the Google card and would otherwise open off-screen.
  const imapFormRef = useRef<View>(null);
  const imapFormScrolled = useRef(false);
  /** The same form serves both doors; only the add door reports a re-attach. */
  const imapForReconnect = useRef(false);
  const scrollToImapForm = useCallback(() => {
    if (imapFormScrolled.current) return;
    imapFormScrolled.current = true;
    const scroll = scrollRef.current;
    const form = imapFormRef.current;
    if (!scroll || !form) return;
    const inner = scroll.getInnerViewNode?.() as Parameters<View['measureLayout']>[0] | undefined;
    if (!inner) return;
    form.measureLayout(
      inner,
      (_x, y) => scroll.scrollTo({ y: Math.max(0, y - 80), animated: true }),
      () => {},
    );
  }, []);
  const planScrolled = useRef(false);
  const gmailY = useRef<number | null>(null);
  const scrolledToGmail = useRef(false);
  const scrollToGmail = useCallback(() => {
    // ?open=mailboxes - the AI-app connector's "connect your mailboxes" link (ADR 0335).
    if (scrolledToGmail.current || gmailY.current == null) return;
    if (reconnectParam !== 'gmail' && openParam !== 'mailboxes') return;
    scrolledToGmail.current = true;
    scrollRef.current?.scrollTo({ y: Math.max(0, gmailY.current - 12), animated: true });
  }, [reconnectParam, openParam]);
  useEffect(() => {
    if (reconnectHandled.current) return;
    if (reconnectParam === 'calendar') {
      if (!request || calStatus === null) return;
      reconnectHandled.current = true;
      if (!calStatus.connected) void connectCalendar();
      return;
    }
    if (reconnectParam === 'gmail') {
      // undefined = still loading; null = feature off / unavailable - mark handled either way
      // so we don't spin forever when GMAIL_ENABLED is false.
      if (!gmailRequest || emailStatus === undefined) return;
      reconnectHandled.current = true;
      if (emailStatus && !emailStatus.connected) void connectGmail();
    }
  }, [
    reconnectParam,
    request,
    calStatus,
    connectCalendar,
    gmailRequest,
    emailStatus,
    connectGmail,
  ]);

  // Web return from Stripe Checkout's full-page redirect
  // (`${WEB_ORIGIN}/settings?checkout=success|cancel`, see PlanCard)
  // - the page just reloaded, so the batch-load effect's one getBilling()
  // read is the same webhook race native guards against; poll here too.
  const checkoutQueryParam = useLocalSearchParams<{ checkout?: string }>().checkout;
  const checkoutQueryHandled = useRef(false);
  useEffect(() => {
    if (checkoutQueryHandled.current) return;
    if (checkoutQueryParam !== 'success' && checkoutQueryParam !== 'cancel') return;
    checkoutQueryHandled.current = true;
    // Strip ?checkout=success so a later remount doesn't re-poll.
    clearParamsWhenReady(['checkout']);
    if (checkoutQueryParam !== 'success') return; // cancelled checkout: nothing changed
    setCheckoutConfirming(true);
    void (async () => {
      setBilling(await pollBillingAfterCheckout(isEitherSubscriptionPaid));
      setCheckoutConfirming(false);
    })();
  }, [checkoutQueryParam]);

  const nudgeNow = useCallback(async () => {
    setErr(null);
    setNudgeMsg(null);
    setBusy('nudge');
    try {
      const { posted } = await runProactiveScan();
      setNudgeMsg(
        posted
          ? 'Posted a briefing in your personal group.'
          : 'Nothing on your calendar needs attention right now.',
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  const saveNudgeTime = useCallback(async () => {
    const parsed = parseTimeOfDay(nudgeTimeDraft);
    if (!parsed) {
      setErr('Could not read that time - try "7:00 AM", "7a", or "19:30".');
      return;
    }
    setErr(null);
    setNudgeMsg(null);
    setBusy('nudgeSave');
    try {
      await setNudge({ hour: parsed.hour, minute: parsed.minute, enabled: true });
      setSettings((s) =>
        s ? { ...s, nudgeHour: parsed.hour, nudgeMinute: parsed.minute, nudgeEnabled: true } : s,
      );
      setNudgeTimeDraft(formatTimeOfDay(parsed.hour, parsed.minute));
      setNudgeTimeDirty(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [nudgeTimeDraft]);

  const saveWeatherLocation = useCallback(async () => {
    setErr(null);
    setWeatherMsg(null);
    setBusy('weather');
    try {
      const res = await setWeatherLocation(weatherDraft.trim());
      setSettings((s) =>
        s ? { ...s, weatherPlace: res.place, weatherPlaceSource: res.source } : s,
      );
      setWeatherDraft(res.place ?? '');
      setWeatherDirty(false);
      setWeatherMsg(
        res.place ? `Using ${res.place}.` : 'Cleared - Chord will detect this for you.',
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [weatherDraft]);

  const toggleBriefingChannel = useCallback(async (id: string, optedOut: boolean) => {
    setErr(null);
    setBusy('briefChan');
    try {
      await setBriefingChannelMuted(id, optedOut);
      setSettings((s) =>
        s
          ? {
              ...s,
              briefingChannels: s.briefingChannels.map((c) =>
                c.id === id ? { ...c, optedOut } : c,
              ),
            }
          : s,
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  const toggleNudgeEnabled = useCallback(async () => {
    if (!settings) return;
    const next = !settings.nudgeEnabled;
    setErr(null);
    setNudgeMsg(null);
    setBusy('nudgeSave');
    try {
      await setNudge({ enabled: next });
      setSettings((s) => (s ? { ...s, nudgeEnabled: next } : s));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [settings]);

  const toggleEmailDigest = useCallback(async () => {
    if (!settings) return;
    const next = !settings.emailDigestEnabled;
    setErr(null);
    setBusy('gmailPrefs');
    try {
      await setEmailPrefs({ emailDigestEnabled: next });
      setSettings((s) => (s ? { ...s, emailDigestEnabled: next } : s));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [settings]);

  const toggleEmailImages = useCallback(async () => {
    if (!settings) return;
    const next = !settings.emailImagesAuto;
    setErr(null);
    setBusy('gmailPrefs');
    try {
      await setEmailPrefs({ emailImagesAuto: next });
      setSettings((s) => (s ? { ...s, emailImagesAuto: next } : s));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [settings]);

  const chooseSwipeAction = useCallback(
    async (next: EmailSwipeAction) => {
      if (!settings || settings.emailSwipeAction === next) return;
      setErr(null);
      setBusy('gmailPrefs');
      try {
        await setEmailPrefs({ emailSwipeAction: next });
        setSettings((s) => (s ? { ...s, emailSwipeAction: next } : s));
        setEmailRemoveAction(next);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [settings],
  );

  // ADR 0266 — the Feed/Cards category order a drag (or chat) pinned.
  const { pinned: pinnedCategories, reset: resetCategoryOrder } = useEmailCategoryOrder();
  const [categoryOrderReset, setCategoryOrderReset] = useState(false);
  const onResetCategoryOrder = useCallback(async () => {
    setErr(null);
    try {
      await resetCategoryOrder();
      setCategoryOrderReset(true);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [resetCategoryOrder]);

  const chooseAfterRemove = useCallback(
    async (next: EmailAfterRemove) => {
      if (!settings || settings.emailAfterRemove === next) return;
      setErr(null);
      setBusy('gmailPrefs');
      try {
        await setEmailPrefs({ emailAfterRemove: next });
        setSettings((s) => (s ? { ...s, emailAfterRemove: next } : s));
        setAfterRemovePref(next);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [settings],
  );

  /** Put the chosen signature in the editor: a mailbox's own, else the shared one. */
  const showSignatureFor = useCallback((key: string, s: MeSettings | null) => {
    const own = key === 'shared' ? null : s?.mailboxSignatures?.[key];
    const text = own ? own.text : s?.emailSignature;
    const html = own ? own.html : s?.emailSignatureHtml;
    setSigMailbox(key);
    setSigDraft(text ?? '');
    setSigHtmlOutside(html ?? '');
    setSigRich(!!html);
    setSigDirty(false);
  }, [setSigHtmlOutside]);

  const revertToSharedSignature = useCallback(async () => {
    setErr(null);
    setBusy('signature');
    try {
      await setMailboxSignature({ mailbox: sigMailbox, useShared: true });
      const fresh = await getSettings();
      setSettings(fresh);
      showSignatureFor(sigMailbox, fresh);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [sigMailbox, showSignatureFor]);

  // ADR 0326 - a signature pasted from another mail app keeps its formatting
  // and pictures: the paste becomes signature HTML, pictures uploaded.
  const [sigPasting, setSigPasting] = useState(false);
  const [sigPasteNote, setSigPasteNote] = useState<string | null>(null);
  const insertPastedSignature = useCallback(
    async (paste: ClipboardContent, at: PasteTarget | null, intoRich: boolean) => {
      setSigPasting(true);
      setSigPasteNote(null);
      try {
        const out = await signatureFromPaste(paste);
        if (!out) {
          setSigPasteNote('There is no formatted signature or picture on the clipboard.');
          return;
        }
        if (intoRich) {
          setSigHtmlOutside((cur) => {
            const start = at?.start ?? cur.length;
            const end = at?.end ?? cur.length;
            return cur.slice(0, start) + out.html + cur.slice(end);
          });
        } else {
          // Pasted into the plain box: the signature becomes a rich one, with
          // the text that was already there kept around the paste.
          // Chord's own default line is not the user's text: a paste replaces it.
          const typed = at?.value ?? sigDraft;
          const value = typed.trim() === DEFAULT_EMAIL_SIGNATURE ? '' : typed;
          const start = value ? (at?.start ?? value.length) : 0;
          const end = value ? (at?.end ?? value.length) : 0;
          setSigHtmlOutside(
            plainTextToSignatureHtml(value.slice(0, start)) + out.html + plainTextToSignatureHtml(value.slice(end)),
          );
          setSigRich(true);
        }
        setSigDirty(true);
        if (out.dropped) {
          setSigPasteNote(
            `${out.dropped === 1 ? 'One picture' : `${out.dropped} pictures`} could not be kept${out.error ? `: ${out.error}` : '.'}`,
          );
        }
      } catch (e) {
        setSigPasteNote((e as Error).message);
      } finally {
        setSigPasting(false);
      }
    },
    [sigDraft, setSigHtmlOutside],
  );
  const sigHtmlPasteRef = useWebSignaturePaste((p, at) => void insertPastedSignature(p, at, true));
  const sigTextPasteRef = useWebSignaturePaste((p, at) => void insertPastedSignature(p, at, false));
  const pasteSignatureFromClipboard = useCallback(async () => {
    const paste = await readNativeClipboard();
    await insertPastedSignature(paste, null, sigRich);
  }, [insertPastedSignature, sigRich]);
  const addSignaturePicture = useCallback(async () => {
    setSigPasting(true);
    setSigPasteNote(null);
    try {
      const url = await pickSignaturePicture();
      if (!url) return;
      const img = `<img src="${url}" alt="" style="max-width: 300px">`;
      if (sigRich) setSigHtmlOutside((cur) => (cur.trim() ? `${cur}<br>${img}` : img));
      else {
        const typed = sigDraft.trim() === DEFAULT_EMAIL_SIGNATURE ? '' : sigDraft.trim();
        setSigHtmlOutside(typed ? `${plainTextToSignatureHtml(typed)}<br>${img}` : img);
        setSigRich(true);
      }
      setSigDirty(true);
    } catch (e) {
      setSigPasteNote((e as Error).message);
    } finally {
      setSigPasting(false);
    }
  }, [sigRich, sigDraft, setSigHtmlOutside]);

  const saveSignature = useCallback(async () => {
    setErr(null);
    setBusy('signature');
    try {
      if (sigMailbox !== 'shared') {
        // One mailbox's own; cleaned on the server like the shared one.
        await setMailboxSignature(
          sigRich ? { mailbox: sigMailbox, html: sigHtmlDraft } : { mailbox: sigMailbox, text: sigDraft },
        );
        const fresh = await getSettings();
        setSettings(fresh);
        showSignatureFor(sigMailbox, fresh);
        return;
      }
      // Rich HTML is cleaned on the server and the plain text derived from it, so read
      // back what was kept rather than assume it.
      if (sigRich) {
        await setEmailPrefs({ emailSignatureHtml: sigHtmlDraft });
        const fresh = await getSettings();
        setSettings(fresh);
        setSigDraft(fresh.emailSignature ?? '');
        setSigHtmlOutside(fresh.emailSignatureHtml ?? '');
        setSigRich(!!fresh.emailSignatureHtml);
      } else {
        await setEmailPrefs({ emailSignature: sigDraft });
        setSettings((s) =>
          s ? { ...s, emailSignature: sigDraft.trim() || null, emailSignatureHtml: null } : s,
        );
        setSigHtmlOutside('');
      }
      setSigDirty(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [sigDraft, sigHtmlDraft, sigRich, sigMailbox, showSignatureFor, setSigHtmlOutside]);

  const toggleGmailSyncLabels = useCallback(async () => {
    if (!settings) return;
    const next = !settings.gmailSyncLabelsEnabled;
    setErr(null);
    setBusy('gmailPrefs');
    try {
      await setEmailPrefs({ gmailSyncLabelsEnabled: next });
      setSettings((s) => (s ? { ...s, gmailSyncLabelsEnabled: next } : s));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [settings]);

  const toggleChordLabelPushPrimary = useCallback(async () => {
    if (!emailStatus?.chordLabelPushSupported) return;
    const next = !emailStatus.chordLabelPushEnabled;
    setErr(null);
    setBusy('gmailPrefs');
    try {
      await setEmailPrefs({ chordLabelPushEnabled: next });
      setEmailStatus((s) => (s ? { ...s, chordLabelPushEnabled: next } : s));
      setSettings((s) => (s ? { ...s, chordLabelPushEnabled: next } : s));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [emailStatus]);

  /**
   * ADR 0145 - rename a mailbox. Empty clears it back to the default name,
   * which is why the value is sent rather than skipped when blank.
   */
  const saveAccountNickname = useCallback(async (a: EmailAccountSummary, value: string) => {
    if ((a.nickname ?? '') === value.trim()) return;
    setErr(null);
    setBusy('gmailPrefs');
    try {
      const updated = await setEmailAccountPrefs(a.id, { nickname: value.trim() || null });
      setEmailStatus((st) =>
        st
          ? {
              ...st,
              accounts: (st.accounts ?? []).map((row) => (row.id === a.id ? updated : row)),
            }
          : st,
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  const savePrimaryNickname = useCallback(async (value: string) => {
    const next = value.trim() || null;
    setErr(null);
    setBusy('gmailPrefs');
    try {
      await setEmailPrefs({ gmailNickname: next });
      setEmailStatus((st) => (st ? { ...st, gmailNickname: next } : st));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  const pickMailboxColor = useCallback(async (mailbox: string, hex: string | null) => {
    setErr(null);
    setBusy('gmailPrefs');
    try {
      const out = await setMailboxColor(mailbox, hex);
      setEmailStatus((st) =>
        st ? { ...st, mailboxColors: out.colors, mailboxColorsPicked: out.picked } : st,
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  const toggleChordLabelPushAccount = useCallback(async (a: EmailAccountSummary) => {
    if (!a.labelPushSupported) return;
    const next = !a.labelPushEnabled;
    setErr(null);
    setBusy('gmailPrefs');
    try {
      const updated = await setEmailAccountPrefs(a.id, { labelPushEnabled: next });
      setEmailStatus((s) =>
        s
          ? {
              ...s,
              accounts: (s.accounts ?? []).map((row) => (row.id === a.id ? updated : row)),
            }
          : s,
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  const togglePush = useCallback(async () => {
    setErr(null);
    setPushMsg(null);
    setBusy('push');
    try {
      if (pushEnabled) {
        await unregisterForPush();
        setPushEnabled(false);
      } else {
        const token = await registerForPush();
        if (token) {
          setPushEnabled(true);
        } else {
          // Permission denied or unsupported surface (simulator / Expo Go).
          setPushMsg(
            Platform.OS === 'web'
              ? 'Push notifications aren’t available on web.'
              : 'Enable notifications for Chord in your device Settings, then try again. (Push needs a real device - not the simulator.)',
          );
        }
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      void getPermissionStatus().then(setPermStatus);
      setBusy(null);
    }
  }, [pushEnabled]);

  const toggleCategory = useCallback(
    async (key: 'notifyMessages' | 'notifyEmail' | 'notifyBot' | 'notifyBriefing') => {
      if (!settings) return;
      const next = !settings[key];
      setErr(null);
      setBusy('push');
      // Optimistic; revert on failure.
      setSettings((s) => (s ? { ...s, [key]: next } : s));
      try {
        await setNotificationPrefs({ [key]: next });
      } catch (e) {
        setSettings((s) => (s ? { ...s, [key]: !next } : s));
        setErr((e as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [settings],
  );

  const toggleQuiet = useCallback(async () => {
    if (!settings) return;
    const next = !settings.quietEnabled;
    setErr(null);
    setBusy('push');
    setSettings((s) => (s ? { ...s, quietEnabled: next } : s));
    try {
      await setNotificationPrefs({ quietEnabled: next });
    } catch (e) {
      setSettings((s) => (s ? { ...s, quietEnabled: !next } : s));
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [settings]);

  const saveQuietHours = useCallback(async () => {
    const start = parseTimeOfDay(quietStartDraft);
    const end = parseTimeOfDay(quietEndDraft);
    if (!start || !end) {
      setErr('Enter valid start and end times (e.g. 10pm and 7am).');
      return;
    }
    setErr(null);
    setBusy('push');
    try {
      await setNotificationPrefs({
        quietStartHour: start.hour,
        quietStartMinute: start.minute,
        quietEndHour: end.hour,
        quietEndMinute: end.minute,
      });
      setSettings((s) =>
        s
          ? {
              ...s,
              quietStartHour: start.hour,
              quietStartMinute: start.minute,
              quietEndHour: end.hour,
              quietEndMinute: end.minute,
            }
          : s,
      );
      setQuietDirty(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [quietStartDraft, quietEndDraft]);

  const syncNow = useCallback(async () => {
    setErr(null);
    setBusy('sync');
    try {
      const r = await syncCalendar();
      setLastSync(`Pulled ${r.fetched}, added ${r.inserted}.`);
      setCalStatus(await getCalendarStatus());
    } catch (e) {
      if (e instanceof CalendarReconnectError) {
        // Server already cleared the dead token - refresh status so the card
        // flips to "Connect Calendar", and tell the user why.
        setErr('Google Calendar access expired - reconnect to keep syncing.');
        setCalStatus(await getCalendarStatus());
      } else {
        setErr((e as Error).message);
      }
    } finally {
      setBusy(null);
    }
  }, []);

  const disconnectNow = useCallback(async () => {
    const proceed = async () => {
      setErr(null);
      setBusy('disconnect');
      try {
        await disconnectCalendar();
        setLastSync(null);
        setCalStatus(await getCalendarStatus());
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(null);
      }
    };
    confirmDestructive(
      'Disconnect Google Calendar',
      'You\'ll need to grant access again to sync. Imported events stay in Chord.',
      () => void proceed(),
      { confirmLabel: 'Disconnect' },
    );
  }, []);

  const saveName = useCallback(async () => {
    setBusy('name');
    setErr(null);
    try {
      const updated = await setMyName({
        firstName: firstNameDraft.trim(),
        lastName: lastNameDraft.trim(),
        preferredName: preferredNameDraft.trim(),
      });
      setUser(updated);
      setFirstNameDraft(updated.firstName ?? '');
      setLastNameDraft(updated.lastName ?? '');
      setPreferredNameDraft(updated.preferredName ?? '');
      setNameDirty(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [firstNameDraft, lastNameDraft, preferredNameDraft, setUser]);

  const saveKey = useCallback(async () => {
    if (!keyValue.trim() || !keyModel.trim()) return;
    setBusy('key');
    setErr(null);
    try {
      const baseUrl = keyProvider === 'openai' && keyBaseUrl.trim().length > 0
        ? keyBaseUrl.trim()
        : undefined;
      await setModelKey({
        provider: keyProvider,
        apiKey: keyValue.trim(),
        model: keyModel.trim(),
        baseUrl,
      });
      setSettings((s) =>
        s
          ? {
              ...s,
              modelProvider: keyProvider,
              modelName: keyModel.trim(),
              modelBaseUrl: baseUrl ?? null,
              hasModelKey: true,
            }
          : s,
      );
      setKeyValue('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [keyProvider, keyModel, keyValue, keyBaseUrl]);

  const clearKey = useCallback(async () => {
    setBusy('clearKey');
    setErr(null);
    try {
      await clearModelKey();
      setSettings((s) =>
        s
          ? {
              ...s,
              modelProvider: null,
              modelName: null,
              modelBaseUrl: null,
              hasModelKey: false,
            }
          : s,
      );
      setKeyModel('');
      setKeyValue('');
      setKeyBaseUrl('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, []);

  // ADR 0235 - connect OpenRouter instead of pasting a key. The server stores
  // the key when the browser comes back; all that returns here is how it went.
  const [byokMsg, setByokMsg] = useState<string | null>(null);
  const finishOpenRouter = useCallback(
    async (status: string | null, message: string | null) => {
      if (status === 'error') {
        setErr(message ?? 'Could not connect OpenRouter.');
        return;
      }
      if (status !== 'ok' && status !== 'needs_credit') return;
      await refreshAll();
      setByokMsg(
        status === 'ok'
          ? 'Connected to OpenRouter. Chord now uses your key.'
          : (message ?? 'Connected. Add credit at openrouter.ai/credits to start using it.'),
      );
    },
    [refreshAll],
  );
  const connectOpenRouter = useCallback(async () => {
    setBusy('openrouter');
    setErr(null);
    setByokMsg(null);
    try {
      // Only a model the user has typed in OpenRouter's vendor/model spelling is
      // sent; otherwise the server starts on the model the app itself runs on.
      const typed = keyModel.trim();
      const model = keyProvider === 'openai' && typed.includes('/') ? typed : undefined;
      const { url } = await startOpenRouterConnect({
        platform: Platform.OS === 'web' ? 'web' : 'native',
        model,
      });
      if (Platform.OS === 'web') {
        window.location.href = url;
        return; // the page leaves; it comes back with ?byok=
      }
      if (BILLING_LINK_OUT) {
        // ADR 0241/0263 - on a phone this leaves the app for the browser, as billing does.
        // It returns on chord://settings?byok=..., handled by the effect below.
        await Linking.openURL(url);
        return;
      }
      const result = await WebBrowser.openAuthSessionAsync(url, 'chord://settings');
      if (result.type !== 'success') return; // closed without finishing: nothing changed
      const q = new URL(result.url).searchParams;
      await finishOpenRouter(q.get('byok'), q.get('message'));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [keyModel, keyProvider, finishOpenRouter]);

  // Web return from OpenRouter (`/settings?byok=ok|needs_credit|error`).
  const byokParams = useLocalSearchParams<{ byok?: string; message?: string }>();
  const byokHandled = useRef(false);
  useEffect(() => {
    if (!byokParams.byok) {
      byokHandled.current = false; // a later connect must be handled too
      return;
    }
    if (byokHandled.current) return;
    byokHandled.current = true;
    clearParamsWhenReady(['byok', 'message']); // so a remount does not re-run this
    void finishOpenRouter(byokParams.byok, byokParams.message ?? null);
  }, [byokParams.byok, byokParams.message, finishOpenRouter]);

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: 'Settings', headerBackVisible: false }} />
      <KeyboardScrollView ref={scrollRef} style={styles.root} contentContainerStyle={styles.scrollContent}>
        <SectionHeader title="Profile" />

        {/* Your name */}
        <Disclosure title="Your name" summary={user ? greetingName(user) : undefined}>
          <Text style={styles.muted}>
            Chord greets you and addresses you by your preferred name, or your first name
            if you haven&rsquo;t set one. You can also just tell Chord in chat - &ldquo;call me
            Ro&rdquo; or &ldquo;use my first name everywhere&rdquo;.
          </Text>

          <Text style={styles.fieldLabel}>First name</Text>
          <TextInput
            value={firstNameDraft}
            onChangeText={(t) => {
              setFirstNameDraft(t);
              setNameDirty(true);
            }}
            placeholder="John"
            placeholderTextColor={colors.muted}
            style={styles.input}
          />

          <Text style={styles.fieldLabel}>Last name</Text>
          <TextInput
            value={lastNameDraft}
            onChangeText={(t) => {
              setLastNameDraft(t);
              setNameDirty(true);
            }}
            placeholder="Doe"
            placeholderTextColor={colors.muted}
            style={styles.input}
          />

          <Text style={styles.fieldLabel}>Preferred name</Text>
          <TextInput
            value={preferredNameDraft}
            onChangeText={(t) => {
              setPreferredNameDraft(t);
              setNameDirty(true);
            }}
            placeholder="What should Chord call you?"
            placeholderTextColor={colors.muted}
            style={styles.input}
          />

          <View style={styles.btnRow}>
            <Pressable
              style={[styles.btn, styles.btnFlex, (!nameDirty || busy !== null) && styles.btnDisabled]}
              disabled={!nameDirty || busy !== null}
              onPress={() => void saveName()}
            >
              {busy === 'name' ? (
                <ActivityIndicator color={colors.onAccent} />
              ) : (
                <Text style={styles.btnText}>Save</Text>
              )}
            </Pressable>
          </View>
        </Disclosure>

        {/* Phone number (ADR 0064) - verified identity attribute; the key
            contact discovery (ADR 0065) matches on. */}
        <Disclosure title="Phone number">
          <PhoneSection whatsappNumber={settings?.whatsappNumber ?? null} />
        </Disclosure>

        {/* People - content, not configuration; lives on its own screen. */}
        <Pressable style={styles.card} onPress={() => router.push('/people' as never)}>
          <Text style={styles.label}>People &amp; birthdays</Text>
          <Text style={styles.linkTxt}>Open ›</Text>
        </Pressable>

        {/* Trust list - who can put tasks/events on my plate. Named by the
            owner: these people coordinate with you through Chord. */}
        <Disclosure title="Chordinators">
          <Text style={styles.muted}>
            People who can put tasks and calendar events on your plate. Anyone else who
            tries needs your approval first.
          </Text>
          <TrustSection />
        </Disclosure>

        {/* ADR 0298 - people blocked from a chat (long-press a message or tap
            a name there). Unblocking is here, or by asking Chord. */}
        <Disclosure title="Blocked people">
          <BlockedPeopleSection />
        </Disclosure>

        {/* ADR 0335 - AI apps (Claude, ChatGPT) connected to Chord over MCP.
            Disconnecting is here, or by asking Chord. */}
        <Disclosure title="Connected AI apps">
          <ConnectedAiAppsSection />
        </Disclosure>

        <View
          onLayout={(e) => {
            if (openParam !== 'plan' || planScrolled.current) return;
            planScrolled.current = true;
            scrollRef.current?.scrollTo({ y: Math.max(0, e.nativeEvent.layout.y - 12), animated: true });
          }}
        >
          <SectionHeader title="AI Plan" />
        </View>

        {/* Chord subscription (ADR 0063/0075/0194/0195/0231) - only on
            billing-enabled deploys. Individual or family, monthly or annual,
            sold by the App Store on iOS and by Stripe on the web. */}
        {billing?.billingEnabled && user ? (
          <>
            <PlanCard
              billing={billing}
              userId={user.id}
              confirming={checkoutConfirming}
              onBilling={setBilling}
              onUseChordPlan={() =>
                confirmDestructive(
                  'Stop using your own key?',
                  "Chord's own AI will answer instead, under a Chord plan. Your key is removed from Chord.",
                  () => {
                    void clearKey().then(() => getBilling().then(setBilling).catch(() => {}));
                  },
                  { confirmLabel: 'Remove key' },
                )
              }
            />
            <FamilyCard reloadKey={billing.plan ?? billing.entitlement} />
          </>
        ) : null}

        {/* ADR 0193 - token usage counter, visibility only. Shown whenever
            billing status has loaded, independent of billingEnabled: a
            team/dev deploy still wants to see its own usage. Never gates
            anything - balance/entitlement above still do that. */}
        {billing ? (
          <View style={styles.card}>
            <Text style={styles.label}>
              {billing.family ? 'Family token usage' : 'Token usage'}
            </Text>
            {billing.tier === 'byok' ? (
              <Text style={styles.muted}>Using your own key - usage isn't tracked by Chord.</Text>
            ) : (
              <View style={styles.systemRow}>
                <Text style={styles.systemTxt}>
                  <Text style={styles.systemTxtBold}>
                    {formatTokenCount(billing.tokensUsedThisMonth ?? 0)}
                  </Text>
                  {' / '}
                  {formatTokenCount(billing.tokensQuotaPerMonth ?? 0)}{' '}
                  {usageIsFreeAllowance(billing) ? 'free tokens used' : 'tokens this month'}
                </Text>
              </View>
            )}
          </View>
        ) : null}

        {/* LLM model - system default vs BYO. Collapsed: power-user territory. */}
        <Disclosure
          title="AI model"
          summary={
            aiConsent?.required && aiConsent.consent?.decision !== 'granted'
              ? 'AI is off'
              : billing?.byokKeyIssue
              ? billing.byokKeyIssue.kind === 'credit'
                ? 'Your key is out of credit'
                : 'Your key was rejected'
              : settings?.hasModelKey
              ? 'Using your own key'
              : settings?.systemLlm
                ? 'System default'
                : 'Not configured'
          }
          openWhen={!!byokMsg || openParam === 'model' || !!billing?.byokKeyIssue}
        >
          {aiConsent?.required ? (
            <View style={{ marginBottom: 12 }}>
              <SwitchRow
                title="Let Chord’s AI use my data"
                sub={
                  aiConsent.consent?.decision === 'granted'
                    ? `Sent to ${aiConsent.recipient}. Allowed ${new Date(aiConsent.consent.at).toLocaleDateString()}.`
                    : `Off. Chord will not answer, suggest or summarize. Turning it on sends your messages, email, calendar and files to ${aiConsent.recipient}.`
                }
                on={aiConsent.consent?.decision === 'granted'}
                busy={aiConsentBusy}
                disabled={aiConsentBusy}
                onToggle={toggleAiConsent}
              />
              {aiConsentErr ? <Text style={[styles.muted, { color: colors.red }]}>{aiConsentErr}</Text> : null}
            </View>
          ) : null}
          {billing?.byokKeyIssue ? (
            <Text style={[styles.muted, { color: colors.warn, marginBottom: 8 }]}>
              {billing.byokKeyIssue.message}
            </Text>
          ) : null}
          <Text style={styles.muted}>
            Which language model Chord uses for your turns. Use the system default when one is
            configured, or bring your own provider, model, and key.
          </Text>

          {/* System status row */}
          <View style={styles.systemRow}>
            {settings?.systemLlm ? (
              <>
                <Text style={styles.systemDotOk}>● </Text>
                <Text style={styles.systemTxt}>
                  System default:{' '}
                  <Text style={styles.systemTxtBold}>
                    {labelProvider(settings.systemLlm.provider)} · {settings.systemLlm.model}
                  </Text>
                  {settings.systemLlm.baseUrl ? ` · ${settings.systemLlm.baseUrl}` : ''}
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.systemDotOff}>○ </Text>
                <Text style={styles.systemTxt}>
                  No system default configured. Bring your own key below.
                </Text>
              </>
            )}
          </View>
          {settings?.hasModelKey && (
            <Text style={[styles.muted, { marginTop: 6 }]}>
              Currently using: <Text style={styles.systemTxtBold}>your BYO</Text> ·{' '}
              {settings.modelProvider ? labelProvider(settings.modelProvider) : '-'} ·{' '}
              {settings.modelName ?? '-'}
              {settings.modelBaseUrl ? ` · ${settings.modelBaseUrl}` : ''}
            </Text>
          )}
          {!settings?.hasModelKey && settings?.systemLlm && (
            <Text style={[styles.muted, { marginTop: 6 }]}>
              Currently using: <Text style={styles.systemTxtBold}>system default</Text>
            </Text>
          )}

          <View style={styles.byokHeader}>
            <Text style={[styles.fieldLabel, styles.byokLabel]}>Bring your own key</Text>
            <Pressable
              style={[styles.btnSmall, busy !== null && styles.btnDisabled]}
              disabled={busy !== null}
              onPress={() => void connectOpenRouter()}
              accessibilityLabel="Connect OpenRouter"
            >
              {busy === 'openrouter' ? (
                <ActivityIndicator size="small" color={colors.onAccent} />
              ) : (
                <Text style={styles.btnSmallTxt}>Connect OpenRouter</Text>
              )}
            </Pressable>
          </View>
          <Text style={[styles.muted, { marginTop: 4 }]}>
            Connect OpenRouter to skip copying a key. It starts on the model Chord uses now; to pick
            another, type an OpenRouter model (like anthropic/claude-sonnet-4.6) in Model first.
          </Text>
          {byokMsg ? <Text style={[styles.muted, { marginTop: 6 }]}>{byokMsg}</Text> : null}

          <View style={styles.providerRow}>
            {(['openai', 'gemini', 'anthropic'] as ModelProvider[]).map((p) => {
              const active = keyProvider === p;
              return (
                <Pressable
                  key={p}
                  onPress={() => setKeyProvider(p)}
                  style={[styles.providerChip, active && styles.providerChipActive]}
                >
                  <Text style={[styles.providerChipTxt, active && styles.providerChipTxtActive]}>
                    {labelProvider(p)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.fieldLabel}>Model</Text>
          <TextInput
            value={keyModel}
            onChangeText={setKeyModel}
            placeholder={modelPlaceholder(keyProvider)}
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />

          {keyProvider === 'openai' && (
            <>
              <Text style={styles.fieldLabel}>Base URL (optional)</Text>
              <TextInput
                value={keyBaseUrl}
                onChangeText={setKeyBaseUrl}
                placeholder="https://api.openai.com/v1"
                placeholderTextColor={colors.muted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                style={styles.input}
              />
              <Text style={styles.muted}>
                Leave blank for OpenAI. For an OpenAI-compatible endpoint, set the base URL and use
                that endpoint's model slug above - e.g. OpenRouter https://openrouter.ai/api/v1
                (model deepseek/deepseek-chat), DeepSeek https://api.deepseek.com (model
                deepseek-chat), or a local Ollama/vLLM.
              </Text>
            </>
          )}

          <Text style={styles.fieldLabel}>API key</Text>
          <TextInput
            value={keyValue}
            onChangeText={setKeyValue}
            placeholder={settings?.hasModelKey ? '•••••• (replace stored key)' : 'sk-…'}
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            style={styles.input}
          />

          <View style={styles.btnRow}>
            <Pressable
              style={[
                styles.btnSmall,
                (busy !== null || !keyValue.trim() || !keyModel.trim()) && styles.btnDisabled,
              ]}
              disabled={busy !== null || !keyValue.trim() || !keyModel.trim()}
              onPress={() => void saveKey()}
            >
              {busy === 'key' ? (
                <ActivityIndicator size="small" color={colors.onAccent} />
              ) : (
                <Text style={styles.btnSmallTxt}>Save</Text>
              )}
            </Pressable>
            {settings?.hasModelKey && (
              <Pressable
                style={[styles.btnGhostSmall, busy !== null && styles.btnDisabled]}
                disabled={busy !== null}
                onPress={() => void clearKey()}
              >
                {busy === 'clearKey' ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : (
                  <Text style={styles.btnGhostSmallTxt}>
                    {settings?.systemLlm ? 'Use system default' : 'Clear'}
                  </Text>
                )}
              </Pressable>
            )}
          </View>
        </Disclosure>

        <SectionHeader title="Connected accounts" />

        {/* Google - ONE grant covers Calendar + Gmail; one card owns both
            statuses, both connect flows, and the nested Calendars list. */}
        <Disclosure
          title="Google"
          defaultOpen
          summary={
            calStatus === null
              ? 'Checking…'
              : `${
                  emailStatus == null
                    ? ''
                    : emailStatus.connected || (emailStatus.accounts ?? []).length > 0
                      ? 'email ✓ · '
                      : 'email off · '
                }${calStatus.connected ? 'calendar ✓' : 'calendar off'}`
          }
          openWhen={
            reconnectParam != null ||
            openParam === 'mailboxes' ||
            (calStatus !== null && !calStatus.connected)
          }
        >
        {/* Email FIRST (owner request 2026-07-25): one row per mailbox, one
            switch each - blue/on = connected, slide off to disconnect, slide
            back on to (re)connect. The switch replaces the old
            Connect/Disconnect button pairs. */}
        {emailStatus != null && (
          <View
            onLayout={(e) => {
              gmailY.current = e.nativeEvent.layout.y;
              scrollToGmail();
            }}
          >
            <Text style={styles.subLabel}>Email</Text>

            <SwitchRow
              title={emailStatus.connected && emailStatus.gmailAddress ? `${emailStatus.gmailAddress} · Gmail` : 'Gmail'}
              sub={
                emailStatus.connected
                  ? emailStatus.backfillDone
                    ? emailStatus.lastSyncedAt
                      ? `Last synced ${new Date(emailStatus.lastSyncedAt).toLocaleString()}`
                      : 'Not yet synced'
                    : 'Importing your recent mail…'
                  : 'Off - slide on to connect'
              }
              on={emailStatus.connected}
              busy={busy === 'gmailConnect' || busy === 'gmailDisconnect'}
              disabled={busy !== null || (!emailStatus.connected && !gmailRequest)}
              onToggle={() => {
                if (emailStatus.connected) disconnectGmailNow();
                else void connectGmail();
              }}
              onSync={() => void syncGmailNow()}
              syncBusy={busy === 'gmailSync'}
            />

            {(emailStatus.accounts ?? []).map((a) => (
              <SwitchRow
                key={a.id}
                title={`${a.emailAddress} · ${
                  a.provider === 'gmail'
                    ? 'Gmail'
                    : a.provider === 'outlook'
                      ? 'Outlook'
                      : IMAP_PRESETS[a.presetKey ?? 'custom'].label
                }`}
                sub={
                  (a.status === 'reconnect'
                    ? 'Paused - slide on to retry'
                    : a.backfillDone
                      ? a.lastSyncedAt
                        ? `Last synced ${new Date(a.lastSyncedAt).toLocaleString()}`
                        : 'Not yet synced'
                      : 'Importing your recent mail…') +
                  (a.provider === 'outlook' && outlookCalendar
                    ? a.calendarEnabled
                      ? ' · mail + calendar'
                      : ' · mail only - add Outlook again to include its calendar'
                    : '')
                }
                on={a.status === 'ok'}
                busy={
                  busyAccountId === a.id && (busy === 'acctRemove' || busy === 'acctRetry')
                }
                disabled={busy !== null}
                onToggle={() => {
                  if (a.status === 'ok') removeAccount(a.id, a.emailAddress);
                  else void reconnectAccount(a);
                }}
                onSync={() => void syncAccountNow(a.id)}
                syncBusy={busy === 'acctSync' && busyAccountId === a.id}
              />
            ))}

            {/* ADR 0145 - name your mailboxes. The chips on the Email tab
                otherwise read as address local parts, which say little once
                you have more than two. */}
            <Text style={styles.fieldLabel}>Mailbox names</Text>
            <Text style={styles.muted}>
              What each mailbox is called in Chord. Leave blank to use the
              address.
            </Text>
            {emailStatus.connected ? (
              <MailboxNameField
                key="primary"
                label={emailStatus.gmailNickname ?? ''}
                placeholder="Gmail"
                subtitle="Primary Gmail"
                disabled={busy !== null}
                onSave={(v) => void savePrimaryNickname(v)}
                color={emailStatus.mailboxColors?.primary}
                pickedColor={emailStatus.mailboxColorsPicked?.primary ?? null}
                onPickColor={(hex) => void pickMailboxColor('primary', hex)}
              />
            ) : null}
            {(emailStatus.accounts ?? []).map((a) => (
              <MailboxNameField
                key={`nick-${a.id}`}
                label={a.nickname ?? ''}
                placeholder={a.emailAddress.split('@')[0] || a.emailAddress}
                subtitle={a.emailAddress}
                disabled={busy !== null}
                onSave={(v) => void saveAccountNickname(a, v)}
                color={emailStatus.mailboxColors?.[a.id]}
                pickedColor={emailStatus.mailboxColorsPicked?.[a.id] ?? null}
                onPickColor={(hex) => void pickMailboxColor(a.id, hex)}
              />
            ))}

            {(emailStatus.accounts ?? [])
              .filter((a) => a.labelPushSupported)
              .map((a) => (
                <View key={`push-${a.id}`} style={styles.toggleRow}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={styles.value}>
                      Also tag these in{' '}
                      {a.provider === 'gmail'
                        ? 'Gmail'
                        : a.provider === 'outlook'
                          ? 'Outlook'
                          : 'this mailbox'}
                    </Text>
                    <Text style={styles.muted}>
                      {a.emailAddress} — tags appear in your mail app if this is
                      on; removing them there does not clear the Chord label.
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => void toggleChordLabelPushAccount(a)}
                    disabled={busy !== null}
                    style={[
                      styles.switchTrack,
                      a.labelPushEnabled && styles.switchTrackOn,
                      busy !== null && styles.btnDisabled,
                    ]}
                  >
                    <View
                      style={[styles.switchThumb, a.labelPushEnabled && styles.switchThumbOn]}
                    />
                  </Pressable>
                </View>
              ))}

            {/* Compact add row - each opens its provider's connect flow. */}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
              <Pressable
                style={[
                  styles.btnGhost,
                  (busy !== null || (!emailStatus.gmailProviderMock && !gmail2Request)) &&
                    styles.btnDisabled,
                ]}
                disabled={busy !== null || (!emailStatus.gmailProviderMock && !gmail2Request)}
                onPress={() => void connectAnotherGmail()}
              >
                {busy === 'gm2Connect' ? (
                  <ActivityIndicator color={colors.accent} />
                ) : (
                  <Text style={styles.btnGhostTxt}>+ Gmail</Text>
                )}
              </Pressable>
              {outlookClientId ? (
                <Pressable
                  style={[styles.btnGhost, busy !== null && styles.btnDisabled]}
                  disabled={busy !== null}
                  onPress={() => void connectOutlook()}
                >
                  {busy === 'olConnect' ? (
                    <ActivityIndicator color={colors.accent} />
                  ) : (
                    <Text style={styles.btnGhostTxt}>+ Outlook / 365</Text>
                  )}
                </Pressable>
              ) : null}
              <Pressable
                style={[styles.btnGhost, busy !== null && styles.btnDisabled]}
                disabled={busy !== null}
                onPress={() => {
                  imapFormScrolled.current = false;
                  imapForReconnect.current = false;
                  setImapFormOpen(true);
                }}
              >
                <Text style={styles.btnGhostTxt}>+ Yahoo / IMAP</Text>
              </Pressable>
            </View>
            {addNote ? <Text style={[styles.muted, { marginTop: 8 }]}>{addNote}</Text> : null}

            {emailStatus.connected && (
              <>
                <View style={styles.toggleRow}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={styles.value}>Inbox digest</Text>
                    <Text style={styles.muted}>
                      Posts an inbox summary to your personal group after the morning briefing
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => void toggleEmailDigest()}
                    disabled={busy !== null || !settings}
                    style={[
                      styles.switchTrack,
                      settings?.emailDigestEnabled && styles.switchTrackOn,
                      (busy !== null || !settings) && styles.btnDisabled,
                    ]}
                  >
                    <View
                      style={[
                        styles.switchThumb,
                        settings?.emailDigestEnabled && styles.switchThumbOn,
                      ]}
                    />
                  </Pressable>
                </View>

                <View style={styles.toggleRow}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={styles.value}>Show images in email</Text>
                    <Text style={styles.muted}>
                      Chord fetches them, so senders never see your device or location. Off asks
                      per sender instead.
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => void toggleEmailImages()}
                    disabled={busy !== null || !settings}
                    style={[
                      styles.switchTrack,
                      settings?.emailImagesAuto && styles.switchTrackOn,
                      (busy !== null || !settings) && styles.btnDisabled,
                    ]}
                  >
                    <View
                      style={[styles.switchThumb, settings?.emailImagesAuto && styles.switchThumbOn]}
                    />
                  </Pressable>
                </View>

                <View style={styles.toggleRow}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={styles.value}>Swiping an email left</Text>
                    <Text style={styles.muted}>
                      Swiping right marks it read or unread. Trash moves it to your mailbox's Trash, where your mail app can still restore
                      it until it empties the Trash.
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    {(['archive', 'trash'] as const).map((a) => {
                      const on = (settings?.emailSwipeAction ?? 'archive') === a;
                      return (
                        <Pressable
                          key={a}
                          onPress={() => void chooseSwipeAction(a)}
                          disabled={busy !== null || !settings}
                          style={[styles.chip, on && styles.chipOn]}
                        >
                          <Text style={[styles.chipText, on && styles.chipTextOn]}>
                            {a === 'archive' ? 'Archive' : 'Trash'}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                <View style={styles.toggleRow}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={styles.value}>Category order in Feed and Cards</Text>
                    <Text style={styles.muted}>
                      {pinnedCategories.length > 0
                        ? `${pinnedCategories.length} placed by you. Reset puts them back in the default order.`
                        : categoryOrderReset
                          ? 'Back to the default order.'
                          : 'Default order. Press and hold a category, then drag it, to move it.'}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => void onResetCategoryOrder()}
                    disabled={pinnedCategories.length === 0}
                    style={[styles.chip, pinnedCategories.length === 0 && { opacity: 0.4 }]}
                  >
                    <Text style={styles.chipText}>Reset</Text>
                  </Pressable>
                </View>

                <View style={styles.toggleRow}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={styles.value}>After archiving or deleting an open email</Text>
                    <Text style={styles.muted}>
                      Open the next email, or go back to the list.
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    {(['next', 'list'] as const).map((a) => {
                      const on = (settings?.emailAfterRemove ?? 'next') === a;
                      return (
                        <Pressable
                          key={a}
                          onPress={() => void chooseAfterRemove(a)}
                          disabled={busy !== null || !settings}
                          style={[styles.chip, on && styles.chipOn]}
                        >
                          <Text style={[styles.chipText, on && styles.chipTextOn]}>
                            {a === 'next' ? 'Next email' : 'List'}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                <View style={styles.toggleRow}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={styles.value}>Sync tiles to Gmail labels</Text>
                    <Text style={styles.muted}>
                      Creates Gmail labels matching AI categories (Chord/…)
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => void toggleGmailSyncLabels()}
                    disabled={busy !== null || !settings}
                    style={[
                      styles.switchTrack,
                      settings?.gmailSyncLabelsEnabled && styles.switchTrackOn,
                      (busy !== null || !settings) && styles.btnDisabled,
                    ]}
                  >
                    <View
                      style={[
                        styles.switchThumb,
                        settings?.gmailSyncLabelsEnabled && styles.switchThumbOn,
                      ]}
                    />
                  </Pressable>
                </View>

                {emailStatus.chordLabelPushSupported ? (
                  <View style={styles.toggleRow}>
                    <View style={{ flex: 1, paddingRight: 12 }}>
                      <Text style={styles.value}>Also tag these in Gmail</Text>
                      <Text style={styles.muted}>
                        Pushes Chord labels into Gmail as Chord/…. Removing them
                        there does not clear the Chord label.
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => void toggleChordLabelPushPrimary()}
                      disabled={busy !== null}
                      style={[
                        styles.switchTrack,
                        emailStatus.chordLabelPushEnabled && styles.switchTrackOn,
                        busy !== null && styles.btnDisabled,
                      ]}
                    >
                      <View
                        style={[
                          styles.switchThumb,
                          emailStatus.chordLabelPushEnabled && styles.switchThumbOn,
                        ]}
                      />
                    </Pressable>
                  </View>
                ) : null}
              </>
            )}

            {/* The signature is for every mailbox, so it shows with any one
                connected - not only the main Gmail. */}
            {(emailStatus.connected || (emailStatus.accounts?.length ?? 0) > 0) && (
              <>
                <Text style={[styles.value, { marginTop: 8 }]}>Signature</Text>
                {(() => {
                  // One signature for all mailboxes, or a different one per mailbox.
                  const mailboxes = [
                    ...(emailStatus?.connected
                      ? [{ key: 'primary', label: emailStatus.gmailNickname || emailStatus.gmailAddress || 'Gmail' }]
                      : []),
                    ...(emailStatus?.accounts ?? []).map((a) => ({ key: a.id, label: a.nickname || a.emailAddress })),
                  ];
                  if (mailboxes.length < 2) return null;
                  const own = sigMailbox !== 'shared' && !!settings?.mailboxSignatures?.[sigMailbox];
                  return (
                    <>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 4 }}>
                        {[{ key: 'shared', label: 'All mailboxes' }, ...mailboxes].map((m) => {
                          const on = sigMailbox === m.key;
                          const hasOwn = m.key !== 'shared' && !!settings?.mailboxSignatures?.[m.key];
                          return (
                            <Pressable
                              key={m.key}
                              onPress={() => showSignatureFor(m.key, settings)}
                              disabled={busy !== null}
                              style={[styles.chip, on && styles.chipOn]}
                            >
                              <Text style={[styles.chipText, on && styles.chipTextOn]}>
                                {hasOwn ? `${m.label} ✎` : m.label}
                              </Text>
                            </Pressable>
                          );
                        })}
                      </View>
                      {sigMailbox === 'shared' ? (
                        <Text style={styles.muted}>Used by every mailbox that has no signature of its own (✎).</Text>
                      ) : own ? (
                        <Pressable onPress={() => void revertToSharedSignature()} disabled={busy !== null}>
                          <Text style={styles.link}>Use the signature for all mailboxes instead</Text>
                        </Pressable>
                      ) : (
                        <Text style={styles.muted}>
                          This mailbox uses the signature for all mailboxes. Change it below and save to give it its own.
                        </Text>
                      )}
                    </>
                  );
                })()}
                <Text style={styles.muted}>
                  {sigRich
                    ? 'A rich signature, added to everything you send from Chord.'
                    : 'Added to everything you send from Chord. Write [my site](https://example.com) to make a link.'}
                </Text>
                <Text style={[styles.muted, { fontSize: 11 }]}>
                  {Platform.OS === 'web'
                    ? 'Copied your signature from Gmail, Outlook or Apple Mail? Paste it here. Its formatting and pictures come with it.'
                    : 'Copied your signature from another mail app? Tap Paste signature. Its formatting and pictures come with it.'}
                </Text>
                {sigRich ? (
                  <>
                    {sigShowHtml ? (
                      <TextInput
                        ref={sigHtmlPasteRef}
                        value={sigHtmlDraft}
                        onChangeText={(t) => {
                          setSigHtmlDraft(t);
                          setSigDirty(true);
                        }}
                        placeholder={'<b>John Doe</b><br><a href="https://chordapp.ai">chordapp.ai</a>'}
                        placeholderTextColor={colors.muted}
                        multiline
                        autoCapitalize="none"
                        autoCorrect={false}
                        style={[styles.textarea, { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12 }]}
                      />
                    ) : (
                      <>
                        <RichSignatureEditor
                          html={sigHtmlDraft}
                          resetKey={sigEditorKey}
                          onChange={(h) => {
                            setSigHtmlDraft(h);
                            setSigDirty(true);
                          }}
                          onLink={(index, href, text) => setSigLinkEdit({ index, href, text })}
                        />
                        <Text style={[styles.muted, { fontSize: 11 }]}>
                          {Platform.OS === 'web' ? 'Click' : 'Tap'} into your signature to change the words.{' '}
                          {Platform.OS === 'web' ? 'Click' : 'Tap'} a link to change where it goes.
                        </Text>
                      </>
                    )}
                    {sigLinkEdit && !sigShowHtml ? (
                      <View style={{ gap: 6, marginTop: 4 }}>
                        <Text style={styles.muted}>
                          Link{sigLinkEdit.text.trim() ? ` "${sigLinkEdit.text.trim()}"` : ''} goes to:
                        </Text>
                        <TextInput
                          value={sigLinkEdit.href}
                          onChangeText={(t) => setSigLinkEdit((cur) => (cur ? { ...cur, href: t } : cur))}
                          autoCapitalize="none"
                          autoCorrect={false}
                          placeholder="https://… or mailto:you@example.com"
                          placeholderTextColor={colors.muted}
                          style={styles.input}
                        />
                        <View style={{ flexDirection: 'row', gap: 16 }}>
                          <Pressable
                            onPress={() => {
                              const href = signatureLinkInput(sigLinkEdit.href);
                              if (!href) return;
                              setSigHtmlOutside((cur) => setSignatureLinkHref(cur, sigLinkEdit.index, href));
                              setSigDirty(true);
                            }}
                          >
                            <Text style={styles.link}>Update link</Text>
                          </Pressable>
                          <Pressable
                            onPress={() => {
                              setSigHtmlOutside((cur) => setSignatureLinkHref(cur, sigLinkEdit.index, null));
                              setSigDirty(true);
                            }}
                          >
                            <Text style={styles.link}>Remove link</Text>
                          </Pressable>
                          <Pressable onPress={() => setSigLinkEdit(null)}>
                            <Text style={styles.muted}>Cancel</Text>
                          </Pressable>
                        </View>
                        {!signatureLinkInput(sigLinkEdit.href) && sigLinkEdit.href.trim() ? (
                          <Text style={[styles.muted, { color: colors.red }]}>
                            Use a web address, an email address or a phone number.
                          </Text>
                        ) : null}
                      </View>
                    ) : null}
                    <Text style={[styles.muted, { fontSize: 11 }]}>
                      Links, bold, colours, simple tables and pictures are kept. Anything else is removed when you save.
                    </Text>
                    <Pressable
                      onPress={() => {
                        if (sigShowHtml) setSigEditorKey((k) => k + 1);
                        setSigLinkEdit(null);
                        setSigShowHtml((v) => !v);
                      }}
                    >
                      <Text style={styles.link}>{sigShowHtml ? 'Done editing HTML' : 'Edit HTML'}</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        setSigRich(false);
                        setSigDirty(true);
                      }}
                    >
                      <Text style={styles.link}>Use plain text instead</Text>
                    </Pressable>
                  </>
                ) : (
                  <>
                    <TextInput
                      ref={sigTextPasteRef}
                      value={sigDraft}
                      onChangeText={(t) => {
                        setSigDraft(t);
                        setSigDirty(true);
                      }}
                      placeholder={'e.g., John\nSent from Chord'}
                      placeholderTextColor={colors.muted}
                      multiline
                      style={styles.textarea}
                    />
                    <Pressable onPress={() => setSigRich(true)}>
                      <Text style={styles.link}>Use a rich (HTML) signature</Text>
                    </Pressable>
                  </>
                )}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 16, marginTop: 4 }}>
                  {Platform.OS !== 'web' ? (
                    <Pressable onPress={() => void pasteSignatureFromClipboard()} disabled={sigPasting}>
                      <Text style={styles.link}>Paste signature</Text>
                    </Pressable>
                  ) : null}
                  <Pressable onPress={() => void addSignaturePicture()} disabled={sigPasting}>
                    <Text style={styles.link}>Add picture</Text>
                  </Pressable>
                  {sigPasting ? <ActivityIndicator size="small" color={colors.muted} /> : null}
                </View>
                {sigPasteNote ? <Text style={[styles.muted, { color: colors.red }]}>{sigPasteNote}</Text> : null}
                <Pressable
                  style={[
                    styles.btn,
                    styles.compactBtn,
                    (!sigDirty || busy !== null) && styles.btnDisabled,
                  ]}
                  disabled={!sigDirty || busy !== null}
                  onPress={() => void saveSignature()}
                >
                  {busy === 'signature' ? (
                    <ActivityIndicator color={colors.onAccent} />
                  ) : (
                    <Text style={styles.btnText}>Save signature</Text>
                  )}
                </Pressable>

              </>
            )}

            {imapFormOpen ? (
              <View
                ref={imapFormRef}
                style={{ marginTop: 8 }}
                onLayout={() => scrollToImapForm()}
              >
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                  {IMAP_PRESET_CHOICES.map((p) => (
                    <Pressable
                      key={p}
                      onPress={() => setImapPreset(p)}
                      style={[styles.chip, imapPreset === p && styles.chipOn]}
                    >
                      <Text style={[styles.chipText, imapPreset === p && styles.chipTextOn]}>
                        {IMAP_PRESETS[p].label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <TextInput
                  value={imapEmail}
                  onChangeText={setImapEmail}
                  placeholder="you@yahoo.com"
                  placeholderTextColor={colors.muted}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  autoFocus
                  style={styles.input}
                />
                <TextInput
                  value={imapPassword}
                  onChangeText={setImapPassword}
                  placeholder="App password"
                  placeholderTextColor={colors.muted}
                  autoCapitalize="none"
                  secureTextEntry
                  style={[styles.input, { marginTop: 8 }]}
                />
                <Text style={styles.muted}>
                  Not your normal password - {IMAP_PRESETS[imapPreset].appPasswordHint}.
                </Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Pressable
                    style={[
                      styles.btn,
                      { flex: 1 },
                      (busy !== null || !imapEmail.trim() || !imapPassword) && styles.btnDisabled,
                    ]}
                    disabled={busy !== null || !imapEmail.trim() || !imapPassword}
                    onPress={() => void addImapMailbox()}
                  >
                    {busy === 'imapConnect' ? (
                      <ActivityIndicator color={colors.onAccent} />
                    ) : (
                      <Text style={styles.btnText}>Connect mailbox</Text>
                    )}
                  </Pressable>
                  <Pressable
                    style={[styles.btnGhost, { flex: 1, marginTop: 12 }]}
                    disabled={busy !== null}
                    onPress={() => setImapFormOpen(false)}
                  >
                    <Text style={styles.btnGhostTxt}>Cancel</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
          </View>
        )}

        {/* Calendar - same switch pattern, after Email (owner request). */}
        <Text style={[styles.subLabel, { marginTop: 16 }]}>Calendar</Text>
        {calStatus === null ? (
          <Text style={styles.muted}>Checking…</Text>
        ) : (
          <>
            <SwitchRow
              title="Google Calendar"
              sub={
                calStatus.connected
                  ? calStatus.lastSyncedAt
                    ? `Last synced ${new Date(calStatus.lastSyncedAt).toLocaleString()}`
                    : 'Not yet synced'
                  : 'Off - slide on to connect'
              }
              on={calStatus.connected}
              busy={busy === 'connect' || busy === 'disconnect'}
              disabled={busy !== null || (!calStatus.connected && !request)}
              onToggle={() => {
                if (calStatus.connected) void disconnectNow();
                else void connectCalendar();
              }}
              onSync={() => void syncNow()}
              syncBusy={busy === 'sync'}
            />
            {calStatus.connected && lastSync ? (
              <Text style={styles.muted}>{lastSync}</Text>
            ) : null}
          </>
        )}

        {/* Calendars - ONE list for every source (ADR 0072): Google + device
            calendars each get a Block switch (default: informational) and a
            device-mirror switch; Google-backed device calendars fold into
            their Google row so nothing imports twice. */}
        <View>
          <Text style={styles.subLabel}>Calendars</Text>
          <Text style={styles.muted}>
            Chord judges each calendar from its source: ones you can write to block your
            time in conflict checks; read-only and subscribed ones (holidays, partner,
            teams) are informational. Flip Block to override either way - and events
            marked &ldquo;free&rdquo; never block regardless. Mirror pulls a phone calendar
            into Chord; calendars already synced via Google aren&rsquo;t mirrored twice.
          </Text>
          <UnifiedCalendarsSection
            connected={calStatus?.connected === true || calStatus?.outlookConnected === true}
          />
        </View>
        </Disclosure>

        {/* Connected apps - IM bridges, grouped by chat. ADR 0010 + 0025.
            Per-group mirroring itself lives in each group's settings. */}
        <Disclosure title="Mail rules" summary={`${routes.length || 'No'} rule${routes.length === 1 ? '' : 's'}`}>
          <MailRulesSection routes={routes} setRoutes={setRoutes} />
        </Disclosure>

        <Disclosure title="Vacation reply" summary={vacation?.enabled ? 'On' : 'Off'}>
          <VacationSection vacation={vacation} setVacation={setVacation} />
        </Disclosure>

        <Disclosure
          title="Connected apps"
          summary={settings?.whatsappNumber ? 'Telegram · WhatsApp' : 'Telegram'}
        >
          {settings?.whatsappNumber ? (
            <View style={{ marginBottom: 14 }}>
              <Text style={styles.value}>WhatsApp</Text>
              <Text style={styles.muted}>
                Chat with Chord on WhatsApp: ask it things, add to your lists and calendar, and get
                your morning briefing there. Message {formatWhatsappNumber(settings.whatsappNumber)} from
                the number you verified above.
              </Text>
              {settings.briefingChannels?.some((c) => c.platform === 'whatsapp') ? (
                <Text style={[styles.muted, { marginTop: 6 }]}>✓ Connected</Text>
              ) : null}
              <Pressable
                style={[styles.btn, { marginTop: 8 }]}
                onPress={() => {
                  const url = whatsappChatUrl(settings.whatsappNumber, 'Hi Chord');
                  if (url) void Linking.openURL(url);
                }}
              >
                <Text style={styles.btnText}>Open WhatsApp</Text>
              </Pressable>
            </View>
          ) : null}
          <Text style={styles.muted}>
            Bridge a Telegram group into a Chord chat. One Chord bot relays each chat to the
            Telegram group you bind below; whether messages mirror back is a per-group switch
            in that chat's settings.
          </Text>
          <MessagingSection connectors={connectors} />
        </Disclosure>

        <SectionHeader title="Briefings & notifications" />

        {/* Push notifications */}
        <Disclosure title="Notifications" summary={pushEnabled ? 'On · this device' : 'Off'}>
          <Text style={styles.muted}>
            Get a push notification on this device for new messages, bot replies, and your
            daily briefing - even when Chord is closed.
          </Text>

          <View style={styles.toggleRow}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={styles.value}>Push notifications</Text>
              <Text style={styles.muted}>{pushEnabled ? 'On · this device' : 'Off'}</Text>
            </View>
            <Pressable
              onPress={() => void togglePush()}
              disabled={busy !== null}
              style={[
                styles.switchTrack,
                pushEnabled && styles.switchTrackOn,
                busy !== null && styles.btnDisabled,
              ]}
            >
              <View style={[styles.switchThumb, pushEnabled && styles.switchThumbOn]} />
            </Pressable>
          </View>
          {pushMsg && <Text style={[styles.muted, { fontSize: 11 }]}>{pushMsg}</Text>}

          {/* OS permission status - only meaningful once denied. */}
          {permStatus === 'denied' && Platform.OS !== 'web' && (
            <View style={{ marginTop: 8 }}>
              <Text style={[styles.muted, { fontSize: 11 }]}>
                Notifications are turned off for Chord in your device Settings.
              </Text>
              <Pressable
                style={[styles.btnGhost, { marginTop: 8 }]}
                onPress={() => void Linking.openSettings()}
              >
                <Text style={styles.btnGhostTxt}>Open device Settings</Text>
              </Pressable>
            </View>
          )}

          {/* Per-category toggles. These persist server-side regardless of the
              master switch; they only take effect once push is on. */}
          <Text style={[styles.fieldLabel, { marginTop: 16 }]}>What to notify me about</Text>
          {(
            [
              ['notifyMessages', 'New messages'],
              ['notifyEmail', 'New email'],
              ['notifyBot', 'Bot replies & @mentions'],
              ['notifyBriefing', 'Daily briefing'],
            ] as const
          ).map(([key, label]) => (
            <View style={styles.toggleRow} key={key}>
              <View style={{ flex: 1, paddingRight: 12 }}>
                <Text style={styles.value}>{label}</Text>
              </View>
              <Pressable
                onPress={() => void toggleCategory(key)}
                disabled={busy !== null || !settings}
                style={[
                  styles.switchTrack,
                  settings?.[key] && styles.switchTrackOn,
                  (busy !== null || !settings) && styles.btnDisabled,
                ]}
              >
                <View style={[styles.switchThumb, settings?.[key] && styles.switchThumbOn]} />
              </Pressable>
            </View>
          ))}

          {/* Quiet hours - suppresses new-message + bot-reply pushes in a window.
              The daily briefing has its own schedule and is exempt. */}
          <View style={[styles.toggleRow, { marginTop: 16 }]}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={styles.value}>Quiet hours</Text>
              <Text style={styles.muted}>
                {settings?.quietEnabled
                  ? `${settings ? formatTimeOfDay(settings.quietStartHour, settings.quietStartMinute) : ''} – ${settings ? formatTimeOfDay(settings.quietEndHour, settings.quietEndMinute) : ''} (your local time)`
                  : 'Off'}
              </Text>
            </View>
            <Pressable
              onPress={() => void toggleQuiet()}
              disabled={busy !== null || !settings}
              style={[
                styles.switchTrack,
                settings?.quietEnabled && styles.switchTrackOn,
                (busy !== null || !settings) && styles.btnDisabled,
              ]}
            >
              <View style={[styles.switchThumb, settings?.quietEnabled && styles.switchThumbOn]} />
            </Pressable>
          </View>
          {settings?.quietEnabled && (
            <>
              <View style={styles.btnRow}>
                <TimeField value={parseTimeOfDay(quietStartDraft)} onChange={(t) => {
  if (!t) return;
  setQuietStartDraft(formatTimeOfDay(t.hour, t.minute));
  setQuietDirty(true);
}} style={{ flex: 1 }} />
                <TimeField value={parseTimeOfDay(quietEndDraft)} onChange={(t) => {
  if (!t) return;
  setQuietEndDraft(formatTimeOfDay(t.hour, t.minute));
  setQuietDirty(true);
}} style={{ flex: 1 }} />
              </View>
              <Pressable
                style={[
                  styles.btn,
                  { marginTop: 8 },
                  (!quietDirty || busy !== null) && styles.btnDisabled,
                ]}
                disabled={!quietDirty || busy !== null}
                onPress={() => void saveQuietHours()}
              >
                <Text style={styles.btnText}>Save quiet hours</Text>
              </Pressable>
              <Text style={[styles.muted, { fontSize: 11 }]}>
                Start and end time. The daily briefing still arrives on its own schedule.
              </Text>
            </>
          )}
        </Disclosure>

        {/* Daily briefing (nudges) */}
        <Disclosure
          title="Daily briefing"
          summary={
            settings?.nudgeEnabled
              ? `On · ${formatTimeOfDay(settings.nudgeHour, settings.nudgeMinute)}`
              : 'Off'
          }
        >
          <Text style={styles.muted}>
            Each morning Chord posts a daily briefing in your personal group - conflicts,
            this week&rsquo;s events, and heads-up reminders. You can also tell Chord in chat,
            e.g. &ldquo;nudge me at 7am daily&rdquo; or &ldquo;stop nudging me&rdquo;.
          </Text>

          <View style={styles.toggleRow}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={styles.value}>Daily briefing</Text>
              <Text style={styles.muted}>
                {settings?.nudgeEnabled
                  ? `On · ${settings ? formatTimeOfDay(settings.nudgeHour, settings.nudgeMinute) : ''} (your local time)`
                  : 'Off'}
              </Text>
            </View>
            <Pressable
              onPress={() => void toggleNudgeEnabled()}
              disabled={busy !== null || !settings}
              style={[
                styles.switchTrack,
                settings?.nudgeEnabled && styles.switchTrackOn,
                (busy !== null || !settings) && styles.btnDisabled,
              ]}
            >
              <View
                style={[styles.switchThumb, settings?.nudgeEnabled && styles.switchThumbOn]}
              />
            </Pressable>
          </View>

          <Text style={styles.fieldLabel}>Briefing time</Text>
          <View style={styles.btnRow}>
            <TimeField value={parseTimeOfDay(nudgeTimeDraft)} onChange={(t) => {
  if (!t) return;
  setNudgeTimeDraft(formatTimeOfDay(t.hour, t.minute));
  setNudgeTimeDirty(true);
}} style={{ flex: 1 }} />
            <Pressable
              style={[
                styles.btn,
                { marginTop: 0, paddingHorizontal: 20 },
                (!nudgeTimeDirty || busy !== null) && styles.btnDisabled,
              ]}
              disabled={!nudgeTimeDirty || busy !== null}
              onPress={() => void saveNudgeTime()}
            >
              {busy === 'nudgeSave' ? (
                <ActivityIndicator color={colors.onAccent} />
              ) : (
                <Text style={styles.btnText}>Save</Text>
              )}
            </Pressable>
          </View>
          <Text style={[styles.muted, { fontSize: 11 }]}>
            Accepts 7a, 7:30am, 19:00, or 7 PM.
          </Text>

          <Pressable
            style={[styles.btnGhost, { marginTop: 16 }, busy === 'nudge' && styles.btnDisabled]}
            disabled={busy !== null}
            onPress={nudgeNow}
          >
            {busy === 'nudge' ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <Text style={styles.btnGhostTxt}>Send me a briefing now</Text>
            )}
          </Pressable>
          {nudgeMsg && <Text style={styles.muted}>{nudgeMsg}</Text>}

          {/* ADR 0091 - where the briefing's weather line is measured. Shows
              the RESOLVED place, so a wrong automatic guess is visible. */}
          <LocationSetting
            onChanged={() => void getSettings().then(setSettings).catch(() => {})}
          />
          <Text style={styles.fieldLabel}>Weather location</Text>
          <View style={styles.btnRow}>
            <TextInput
              value={weatherDraft}
              onChangeText={(t) => {
                setWeatherDraft(t);
                setWeatherDirty(true);
              }}
              placeholder="Brooklyn"
              placeholderTextColor={colors.muted}
              autoCorrect={false}
              style={[styles.input, { flex: 1 }]}
            />
            <Pressable
              style={[
                styles.btn,
                { marginTop: 0, paddingHorizontal: 20 },
                (!weatherDirty || busy !== null) && styles.btnDisabled,
              ]}
              disabled={!weatherDirty || busy !== null}
              onPress={() => void saveWeatherLocation()}
            >
              {busy === 'weather' ? (
                <ActivityIndicator color={colors.onAccent} />
              ) : (
                <Text style={styles.btnText}>Save</Text>
              )}
            </Pressable>
          </View>
          <Text style={[styles.muted, { fontSize: 11 }]}>
            {settings?.weatherPlaceSource === 'user'
              ? 'Your choice. Clear the box and save to let Chord detect it again.'
              : settings?.weatherPlaceSource === 'device' && settings.weatherPlace
                ? `From your phone's location (${settings.weatherPlace}). Type a city to set it yourself instead.`
                : settings?.weatherPlace
                ? `Detected automatically (${settings.weatherPlace}). Type a city to correct it.`
                : 'Chord detects this automatically. Type a city to set it yourself.'}
          </Text>
          {weatherMsg && <Text style={styles.muted}>{weatherMsg}</Text>}

          {/* ADR 0091 - per-channel mute. ADR 0089's "Stop these" button set
              this with no in-app way back; this row is that way back. */}
          {settings?.briefingChannels && settings.briefingChannels.length > 0 && (
            <>
              <Text style={styles.fieldLabel}>Also send to</Text>
              {settings.briefingChannels.map((c) => (
                <View key={c.id} style={styles.toggleRow}>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text style={styles.value}>
                      {c.platform === 'whatsapp' ? 'WhatsApp' : c.platform} · {c.groupName}
                    </Text>
                    <Text style={styles.muted}>
                      {c.optedOut ? 'Muted here - still in the app' : 'On'}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => void toggleBriefingChannel(c.id, !c.optedOut)}
                    disabled={busy !== null}
                    style={[
                      styles.switchTrack,
                      !c.optedOut && styles.switchTrackOn,
                      busy !== null && styles.btnDisabled,
                    ]}
                  >
                    <View
                      style={[styles.switchThumb, !c.optedOut && styles.switchThumbOn]}
                    />
                  </Pressable>
                </View>
              ))}
            </>
          )}
        </Disclosure>

        <SectionHeader title="Appearance" />

        <View style={styles.card}>
          <View style={styles.toggleRow}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={styles.value}>Theme</Text>
              <Text style={styles.muted}>
                {colorPref === 'system'
                  ? "Follows this device's light or dark setting."
                  : `Always ${colorPref} on this device.`}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 6 }}>
              {(['system', 'light', 'dark'] as const).map((p) => {
                const on = colorPref === p;
                return (
                  <Pressable
                    key={p}
                    onPress={() => setColorSchemePreference(p)}
                    style={[styles.chip, on && styles.chipOn]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: on }}
                  >
                    <Text style={[styles.chipText, on && styles.chipTextOn]}>
                      {p === 'system' ? 'System' : p === 'light' ? 'Light' : 'Dark'}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>

        <SectionHeader title="Account" />

        <View style={styles.card}>
          <Text style={styles.label}>Signed in as</Text>
          <Text style={styles.value}>{user ? greetingName(user) : '(unknown)'}</Text>
          {user?.email && <Text style={styles.muted}>{user.email}</Text>}
          <Pressable
            onPress={() => router.push({ pathname: '/intro', params: { replay: '1' } })}
            accessibilityRole="button"
            style={{ marginTop: 12 }}
          >
            <Text style={[styles.value, { textDecorationLine: 'underline' }]}>What Chord does ›</Text>
          </Pressable>
        </View>

        {err && <Text style={styles.errTxt}>{err}</Text>}

        {/* Delete account left, Sign out right on ONE row; the delete
            disclosure wraps onto its own full-width line while expanded. */}
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            alignItems: 'center',
            rowGap: 12,
          }}
        >
          {/* Delete account - irreversible. Collapsed by default; expanding
              still requires typing DELETE before the button enables. */}
          <Disclosure title="Delete account" danger compactWhenClosed>
          <Text style={styles.muted}>
            Permanently deletes your account and everything tied to it - your personal chat,
            tasks, lists, saved items, calendar events, people, and uploaded files - and revokes
            Chord&rsquo;s access to your Google account. Shared groups stay for their other members,
            with your name removed. This cannot be undone.
          </Text>
          {deletePlanNote ? (
            <Text style={[styles.muted, { color: colors.red, marginTop: 8 }]}>{deletePlanNote}</Text>
          ) : null}
          <Text style={styles.fieldLabel}>Type DELETE to confirm</Text>
          <TextInput
            value={deleteConfirm}
            onChangeText={setDeleteConfirm}
            placeholder="DELETE"
            placeholderTextColor={colors.muted}
            autoCapitalize="characters"
            autoCorrect={false}
            editable={busy !== 'delete'}
            style={styles.input}
          />
          <Pressable
            style={[
              styles.btn,
              styles.btnDanger,
              styles.compactBtn,
              (!deleteReady || busy !== null) && styles.btnDisabled,
            ]}
            disabled={!deleteReady || busy !== null}
            onPress={() => void deleteAccountNow()}
          >
            {busy === 'delete' ? (
              <ActivityIndicator color={colors.onAccent} />
            ) : (
              <Text style={styles.btnText}>Delete my account</Text>
            )}
          </Pressable>
          </Disclosure>

          <Pressable style={[styles.dangerBtn, styles.compactBtn]} onPress={() => void logout()}>
            <Text style={styles.dangerBtnTxt}>Sign out</Text>
          </Pressable>
        </View>
      </KeyboardScrollView>
      <MainBottomNav current="settings" />
    </View>
  );
}

const PLATFORM_LABEL: Record<ConnectorPlatform, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  whatsapp: 'WhatsApp',
};

function labelProvider(p: 'openai' | 'gemini' | 'anthropic' | 'mock'): string {
  if (p === 'openai') return 'OpenAI';
  if (p === 'gemini') return 'Gemini';
  if (p === 'anthropic') return 'Claude';
  return 'Mock';
}

function modelPlaceholder(p: ModelProvider): string {
  if (p === 'gemini') return 'gemini-2.5-flash';
  if (p === 'anthropic') return 'claude-sonnet-4-6';
  return 'gpt-5.4-mini';
}

/**
 * ADR 0033 - settings UI for per-calendar busyness policy. One row per
 * Google calendar the user has synced from; each row resolves to one
 * of three states (auto, override-on, override-off) and shows a
 * "Needs your input" badge when the auto value is unknown.
 */
/** One row of the unified calendar list (ADR 0072). */
interface UnifiedCalRow {
  key: string;
  title: string;
  meta: string;
  color: string | null;
  /** Server calendar_sources row - Block switch works when present. */
  source: CalendarSource | null;
  /** Device calendar id - Mirror switch works when present. */
  deviceId: string | null;
  /** Google-backed device calendar still mirrored on top of Google sync. */
  duplicate: boolean;
}

const normTitle = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/**
 * ADR 0072 - ONE calendar list. Merges server `calendar_sources` (Google +
 * mirrored device calendars) with the phone's calendar list: every row gets a
 * Block switch (informational by default) and - where a device calendar backs
 * it - a Mirror switch. A device calendar that is really a Google calendar
 * already synced via Google folds into the Google row (its Mirror switch only
 * shows while it's still double-imported, so the user can turn the dup off).
 * Absorbs the old AppleSync section, including the iOS Reminders switch.
 */
function UnifiedCalendarsSection({ connected }: { connected: boolean }) {
  const [sources, setSources] = useState<CalendarSource[] | null>(null);
  const [deviceCals, setDeviceCals] = useState<DeviceCalendarChoice[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [remindersOn, setRemindersOn] = useState(false);
  // One key per control with a save in flight (`block:<id>`, `color:<id>`,
  // `mirror:<deviceId>`, `reminders`, `default`): a switch waits only on its
  // own save, never on another calendar's.
  const busyKeys = useBusyKeys();
  const { start: startBusy, end: endBusy, hasNow: busyNow } = busyKeys;
  const [error, setError] = useState<string | null>(null);

  const [defaultCalId, setDefaultCalId] = useState<string | null>(null);

  const refreshSources = useCallback(async () => {
    try {
      const fresh = await listCalendarSources();
      // A row whose own save is still running keeps what this screen shows:
      // the list may have been read before that save landed.
      setSources((prev) =>
        fresh.map((f) => {
          const pending = busyNow(`block:${f.id}`) || busyNow(`color:${f.id}`);
          return (pending && prev?.find((p) => p.id === f.id)) || f;
        }),
      );
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
    try {
      setDefaultCalId((await getDefaultCalendar()).calendarId);
    } catch {
      // The picker just shows Primary; the list above still works.
    }
  }, [busyNow]);

  const chooseDefault = useCallback(async (calendarId: string | null) => {
    startBusy('default');
    try {
      setDefaultCalId((await setDefaultCalendar(calendarId)).calendarId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      endBusy('default');
    }
  }, [startBusy, endBusy]);

  useEffect(() => {
    void refreshSources();
    if (Platform.OS === 'web') return;
    void (async () => {
      try {
        const [cals, sel, rem] = await Promise.all([
          listDeviceCalendars(),
          getSelectedCalendarIds(),
          getRemindersSyncEnabled(),
        ]);
        setDeviceCals(cals);
        setSelected(new Set(sel));
        setRemindersOn(rem);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [refreshSources]);

  const toggleBlock = useCallback(async (s: CalendarSource) => {
    const key = `block:${s.id}`;
    startBusy(key);
    try {
      const updated = await setCalendarSourceOverride(s.id, !s.countsForBusyEffective);
      setSources((prev) => prev?.map((r) => (r.id === s.id ? updated : r)) ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      endBusy(key);
    }
  }, [startBusy, endBusy]);

  // ADR 0278 — which calendar's color palette is open, if any.
  const [colorOpen, setColorOpen] = useState<string | null>(null);
  const pickColor = useCallback(async (s: CalendarSource, choice: string | null) => {
    const key = `color:${s.id}`;
    startBusy(key);
    try {
      const updated = await setCalendarColor(s.id, choice);
      // Clearing or picking can change which palette colors other calendars get.
      setSources((prev) => prev?.map((r) => (r.id === s.id ? updated : r)) ?? null);
      setColorOpen(null);
      void refreshSources();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      endBusy(key);
    }
  }, [refreshSources, startBusy, endBusy]);

  // Mirror taps on different calendars may overlap. Each builds on the latest
  // selection (not the one its render saw), and the saves + phone syncs run
  // one after another, so a later tap can never be undone by an earlier one.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const mirrorChain = useRef<Promise<void>>(Promise.resolve());
  const toggleMirror = useCallback(
    (deviceId: string) => {
      const next = new Set(selectedRef.current);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      selectedRef.current = next;
      setSelected(next);
      const key = `mirror:${deviceId}`;
      startBusy(key);
      const run = mirrorChain.current.then(async () => {
        try {
          await setSelectedCalendarIds([...selectedRef.current]);
          // Switched off: its copies leave Chord now. Checked again here, since
          // a quick off-then-on must not forget a calendar that is back on.
          if (!selectedRef.current.has(deviceId)) await forgetDeviceCalendar(deviceId);
          await runAppleSync();
          await refreshSources(); // a fresh mirror gains a server row (Block becomes live)
        } catch (e) {
          setError((e as Error).message);
        } finally {
          endBusy(key);
        }
      });
      mirrorChain.current = run;
      return run;
    },
    [refreshSources, startBusy, endBusy],
  );

  const toggleReminders = useCallback(async () => {
    const next = !remindersOn;
    setRemindersOn(next);
    startBusy('reminders');
    try {
      await setRemindersSyncEnabled(next);
      if (next) await runAppleSync();
    } catch (e) {
      setRemindersOn(!next);
      setError((e as Error).message);
    } finally {
      endBusy('reminders');
    }
  }, [remindersOn, startBusy, endBusy]);

  if (error) return <Text style={[styles.muted, { color: colors.red }]}>{error}</Text>;
  if (sources === null) return <Text style={styles.muted}>Loading…</Text>;

  // ADR 0256 — what the server will accept as a default: a Google/Outlook
  // calendar the user can write to. The Google primary is the "Primary" chip.
  const defaultChoices = sources
    .filter(
      (s) =>
        (s.provider === 'google' || s.provider === 'outlook') &&
        (s.accessRole === 'owner' || s.accessRole === 'writer') &&
        !(s.provider === 'google' && s.isPrimary),
    )
    .map((s) => ({
      id: s.googleCalendarId as string | null,
      label:
        s.provider === 'outlook'
          ? `${s.summary ?? 'Calendar'} (Outlook)`
          : (s.summary ?? s.googleCalendarId),
    }));

  // ── merge server sources + device calendars into one row set ─────────
  const googleSources = sources.filter((s) => s.provider === 'google');
  const deviceSourceByCalId = new Map(
    sources.filter((s) => s.provider === 'device').map((s) => [s.googleCalendarId, s]),
  );
  // A device calendar that is really one of the connected Google calendars.
  const googleSourceForDevice = (c: DeviceCalendarChoice): CalendarSource | undefined =>
    c.isGoogle
      ? googleSources.find(
          (g) => normTitle(g.summary) === normTitle(c.title) || g.googleCalendarId === c.title,
        )
      : undefined;

  const rows: UnifiedCalRow[] = [];
  const claimedDeviceIds = new Set<string>();

  for (const g of googleSources) {
    const dup = deviceCals.find((c) => googleSourceForDevice(c) === g && selected.has(c.id));
    if (dup) claimedDeviceIds.add(dup.id);
    rows.push({
      key: g.id,
      title: g.summary ?? g.googleCalendarId,
      meta: `Google${g.isPrimary ? ' · Primary' : ''}`,
      color: g.displayColor,
      source: g,
      deviceId: dup?.id ?? null,
      duplicate: !!dup,
    });
  }
  // ADR 0228 - Outlook calendars are synced by the server like Google's.
  for (const o of sources.filter((s) => s.provider === 'outlook')) {
    rows.push({
      key: o.id,
      title: o.summary ?? 'Calendar',
      meta: `Outlook${o.accountEmail ? ` · ${o.accountEmail}` : ''}`,
      color: o.displayColor,
      source: o,
      deviceId: null,
      duplicate: false,
    });
  }
  for (const c of deviceCals) {
    if (claimedDeviceIds.has(c.id)) continue;
    const gs = googleSourceForDevice(c);
    if (gs) continue; // synced via Google and not double-mirrored - one row is enough
    const src = deviceSourceByCalId.get(c.id) ?? null;
    rows.push({
      key: `dev:${c.id}`,
      title: c.title,
      meta: c.sourceName || c.sourceType || 'Device',
      color: src?.displayColor ?? c.color,
      source: src,
      deviceId: c.id,
      duplicate: false,
    });
  }
  // Mirrored device calendars whose device row disappeared (web, or calendar
  // removed on the phone) still get their Block switch.
  for (const [calId, src] of deviceSourceByCalId) {
    if (rows.some((r) => r.source?.id === src.id)) continue;
    rows.push({
      key: src.id,
      title: src.summary ?? calId,
      meta: 'Device (mirrored)',
      color: src.displayColor,
      source: src,
      deviceId: null,
      duplicate: false,
    });
  }

  return (
    <View style={{ marginTop: 4 }}>
      {Platform.OS === 'ios' && (
        <View style={styles.toggleRow}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={styles.value}>Sync with Reminders</Text>
            <Text style={styles.muted}>
              {remindersOn ? 'On · tasks & lists ↔ Reminders' : 'Off'}
            </Text>
          </View>
          <Pressable
            onPress={() => void toggleReminders()}
            disabled={busyKeys.has('reminders')}
            style={[
              styles.switchTrack,
              remindersOn && styles.switchTrackOn,
              busyKeys.has('reminders') && styles.btnDisabled,
            ]}
          >
            <View style={[styles.switchThumb, remindersOn && styles.switchThumbOn]} />
          </Pressable>
        </View>
      )}

      {defaultChoices.length > 0 && (
        <View style={{ marginBottom: 10 }}>
          <Text style={styles.value}>Default calendar</Text>
          <Text style={[styles.muted, { marginBottom: 6 }]}>
            New events go here unless you name a calendar.
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {[{ id: null as string | null, label: 'Primary' }, ...defaultChoices].map((c) => {
              const on = defaultCalId === c.id;
              return (
                <Pressable
                  key={c.id ?? 'primary'}
                  onPress={() => void chooseDefault(c.id)}
                  disabled={busyKeys.has('default') || on}
                  style={[styles.chip, on && styles.chipOn]}
                >
                  <Text style={[styles.chipText, on && styles.chipTextOn]}>{c.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}

      {rows.length === 0 ? (
        <Text style={styles.muted}>
          {connected
            ? 'No calendars synced yet. Tap "Sync now" above and come back.'
            : Platform.OS === 'web'
              ? 'No calendars yet. Connect Google or Outlook above, or mirror a phone calendar from the app.'
              : 'No calendars yet. Connect Google or Outlook above, or grant calendar access to mirror a phone calendar.'}
        </Text>
      ) : (
        <>
          <View style={calStyles.headRow}>
            <View style={{ flex: 1 }} />
            <Text style={calStyles.colHead}>Block</Text>
            <Text style={calStyles.colHead}>Mirror</Text>
          </View>
          {rows.map((r) => {
            const blockBusy = !!r.source && busyKeys.has(`block:${r.source.id}`);
            const colorBusy = !!r.source && busyKeys.has(`color:${r.source.id}`);
            const mirrorBusy = r.deviceId !== null && busyKeys.has(`mirror:${r.deviceId}`);
            const blockOn = r.source?.countsForBusyEffective === true;
            const mirrorOn = r.deviceId !== null && selected.has(r.deviceId);
            const src = r.source;
            return (
              <View key={r.key}>
              <View style={calStyles.row}>
                {src ? (
                  <View style={{ marginRight: 10 }}>
                    <ColorSwatch
                      color={r.color}
                      onPress={() => setColorOpen(colorOpen === src.id ? null : src.id)}
                      disabled={colorBusy}
                      label={`Color for ${r.title}`}
                    />
                  </View>
                ) : (
                  <View style={[calStyles.swatch, { backgroundColor: r.color ?? colors.border }]} />
                )}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={calStyles.title} numberOfLines={1}>
                    {r.title}
                  </Text>
                  <Text style={[styles.muted, { fontSize: 11 }]} numberOfLines={1}>
                    {r.meta}
                    {r.duplicate ? ' · also mirrored from phone - turn Mirror off' : ''}
                  </Text>
                </View>
                <View style={calStyles.switchCol}>
                  {r.source ? (
                    <Pressable
                      onPress={() => void toggleBlock(r.source!)}
                      disabled={blockBusy}
                      style={[
                        styles.switchTrack,
                        blockOn && styles.switchTrackOn,
                        blockBusy && styles.btnDisabled,
                      ]}
                    >
                      <View style={[styles.switchThumb, blockOn && styles.switchThumbOn]} />
                    </Pressable>
                  ) : (
                    <Text style={calStyles.colOff}>-</Text>
                  )}
                </View>
                <View style={calStyles.switchCol}>
                  {r.deviceId ? (
                    <Pressable
                      onPress={() => void toggleMirror(r.deviceId!)}
                      disabled={mirrorBusy}
                      style={[
                        styles.switchTrack,
                        mirrorOn && styles.switchTrackOn,
                        mirrorBusy && styles.btnDisabled,
                      ]}
                    >
                      <View style={[styles.switchThumb, mirrorOn && styles.switchThumbOn]} />
                    </Pressable>
                  ) : (
                    <Text style={calStyles.colOff}>
                      {r.source?.provider === 'google' || r.source?.provider === 'outlook' ? '✓' : '-'}
                    </Text>
                  )}
                </View>
              </View>
              {src && colorOpen === src.id && (
                <View style={{ paddingLeft: 28 }}>
                  <ColorChoiceRow
                    picked={src.colorChoice}
                    disabled={colorBusy}
                    onPick={(hex) => void pickColor(src, hex)}
                  />
                </View>
              )}
              </View>
            );
          })}
          <Text style={[styles.muted, { fontSize: 11, marginTop: 6 }]}>
            Tap a color square to change how that calendar shows in Chord (Default = its Google,
            Outlook or phone color). Block = counts in conflict checks. Mirror = pulled from this
            phone. ✓ = synced via Google or Outlook already. Informational calendars still appear in
            listings and briefings.
          </Text>
        </>
      )}
    </View>
  );
}

const calStyles = themed((colors) => ({
  row: {
    flexDirection: 'row',
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    alignItems: 'center',
  },
  title: { color: colors.text, fontWeight: '600', marginBottom: 2 },
  swatch: {
    width: 12,
    height: 12,
    borderRadius: 3,
    marginRight: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  colHead: {
    width: 56,
    textAlign: 'center',
    color: colors.muted,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  switchCol: { width: 56, alignItems: 'center' },
  colOff: { color: colors.muted, fontSize: 13 },
}));

/**
 * The vacation responder (ADR 0124). Chord's own rather than the provider's,
 * so the same switch works on a Gmail, an Outlook and an IMAP mailbox.
 */
function VacationSection({
  vacation,
  setVacation,
}: {
  vacation: EmailVacationSettings | null;
  setVacation: (v: EmailVacationSettings) => void;
}) {
  const [body, setBody] = useState(vacation?.body ?? '');
  const [subject, setSubject] = useState(vacation?.subject ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const on = vacation?.enabled === true;

  const save = async (enabled: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      setVacation(
        await setEmailVacation({
          enabled,
          subject: subject.trim() || null,
          body: body.trim() || null,
          startsAt: vacation?.startsAt ?? null,
          endsAt: vacation?.endsAt ?? null,
        }),
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View>
      <Text style={styles.muted}>
        Chord replies once to each person who writes to you, on every mailbox you have
        connected. It never answers mailing lists, no-reply addresses, or anything already
        automatic &mdash; and an auto-reply does not mark the mail read.
      </Text>
      <TextInput
        style={[styles.input, { marginTop: 12 }]}
        value={subject}
        onChangeText={setSubject}
        placeholder="Subject (optional)"
        placeholderTextColor={colors.muted}
      />
      <TextInput
        style={styles.textarea}
        value={body}
        onChangeText={setBody}
        placeholder="I'm away until the 3rd and will reply when I'm back."
        placeholderTextColor={colors.muted}
        multiline
      />
      <View style={styles.btnRow}>
        <Pressable
          style={[styles.btn, styles.btnFlex, (busy || !body.trim()) && styles.btnDisabled]}
          disabled={busy || !body.trim()}
          onPress={() => void save(true)}
        >
          <Text style={styles.btnText}>{on ? 'Update' : 'Turn on'}</Text>
        </Pressable>
        {on ? (
          <Pressable
            style={[styles.btn, styles.btnFlex, styles.btnDanger, busy && styles.btnDisabled]}
            disabled={busy}
            onPress={() => void save(false)}
          >
            <Text style={styles.btnText}>Turn off</Text>
          </Pressable>
        ) : null}
      </View>
      {on ? (
        <Text style={styles.muted}>
          On. Turning it off and on again starts a fresh trip, so everyone hears once more.
        </Text>
      ) : null}
      {err ? <Text style={styles.errTxt}>{err}</Text> : null}
    </View>
  );
}

/**
 * The ADR 0077 routing rules, made editable (ADR 0123). The kind is inferred
 * from the pattern, so the editor shows what it decided rather than asking a
 * question the user has no way to answer.
 */
function MailRulesSection({
  routes,
  setRoutes,
}: {
  routes: EmailRoutingRuleDto[];
  setRoutes: (r: EmailRoutingRuleDto[]) => void;
}) {
  const groups = useApp((st) => st.groups).filter((g) => g.kind !== 'personal');
  const [pattern, setPattern] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const add = async () => {
    if (!pattern.trim() || !target) return;
    setBusy(true);
    setErr(null);
    try {
      setRoutes(await addEmailRoute({ pattern: pattern.trim(), targetGroupId: target }));
      setPattern('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      setRoutes(await deleteEmailRoute(id));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (groups.length === 0) {
    return (
      <Text style={styles.muted}>
        Mail rules send matching email to one of your shared groups. Create a group first.
      </Text>
    );
  }

  return (
    <View>
      <Text style={styles.muted}>
        Send matching mail to a group instead of keeping it to yourself. A domain like
        &ldquo;lcps.org&rdquo; matches the sender; anything else matches the category name.
      </Text>

      {routes.map((r) => (
        <View key={r.id} style={styles.ruleRow}>
          <View style={styles.ruleMain}>
            <Text style={styles.ruleTxt} numberOfLines={1}>
              {r.pattern} → {r.targetGroupName}
            </Text>
            <Text style={styles.ruleKind}>
              {r.kind === 'sender_domain' ? 'sender domain' : 'category'}
            </Text>
          </View>
          <Pressable onPress={() => void remove(r.id)} disabled={busy} hitSlop={8}>
            <Text style={styles.ruleDel}>Remove</Text>
          </Pressable>
        </View>
      ))}

      <TextInput
        style={[styles.input, { marginTop: 12 }]}
        value={pattern}
        onChangeText={setPattern}
        placeholder="lcps.org  or  school"
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <View style={styles.ruleChips}>
        {groups.map((g) => (
          <Pressable
            key={g.id}
            style={[styles.chip, target === g.id && styles.chipOn]}
            onPress={() => setTarget(g.id)}
          >
            <Text style={[styles.chipText, target === g.id && styles.chipTextOn]}>{g.name}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable
        style={[styles.btn, styles.compactBtn, (!pattern.trim() || !target || busy) && styles.btnDisabled]}
        disabled={!pattern.trim() || !target || busy}
        onPress={() => void add()}
      >
        <Text style={styles.btnText}>Add rule</Text>
      </Pressable>
      {err ? <Text style={styles.errTxt}>{err}</Text> : null}
    </View>
  );
}

function MessagingSection({ connectors }: { connectors: MeConnectorsResponse | null }) {
  if (!connectors) {
    return <Text style={styles.muted}>Loading…</Text>;
  }
  // Sort: groups with bindings first, then alpha within each bucket.
  const groups = [...connectors.groups].sort((a, b) => {
    const aHas = a.bindings.length > 0 ? 0 : 1;
    const bHas = b.bindings.length > 0 ? 0 : 1;
    if (aHas !== bHas) return aHas - bHas;
    return a.groupName.localeCompare(b.groupName, undefined, { sensitivity: 'base' });
  });

  if (groups.length === 0) {
    return <Text style={styles.muted}>No groups yet. Create one to add a bridge.</Text>;
  }

  return (
    <View style={{ marginTop: 8 }}>
      {groups.map((g) => (
        <Pressable
          key={g.groupId}
          style={messagingStyles.row}
          onPress={() => router.push(`/groups/${g.groupId}/settings` as never)}
        >
          <View style={{ flex: 1 }}>
            <Text style={messagingStyles.groupName}>
              {g.groupName}
              {g.groupKind === 'personal' ? ' · Personal' : ''}
            </Text>
            {g.bindings.length === 0 ? (
              <Text style={styles.muted}>No bridges yet</Text>
            ) : (
              <View style={messagingStyles.bindingsRow}>
                {g.bindings.map((b) => {
                  const state = b.runtime?.state ?? null;
                  const dot =
                    state === 'ok'
                      ? '●'
                      : state === 'warn'
                        ? '⚠'
                        : state === 'error'
                          ? '⚠'
                          : '○';
                  const dotStyle =
                    state === 'ok'
                      ? messagingStyles.dotOk
                      : state === 'warn'
                        ? messagingStyles.dotWarn
                        : state === 'error'
                          ? messagingStyles.dotError
                          : messagingStyles.dotMuted;
                  return (
                    <Text
                      key={`${b.platform}:${b.externalChannelId}`}
                      style={messagingStyles.bindingChip}
                    >
                      <Text style={dotStyle}>{dot} </Text>
                      {PLATFORM_LABEL[b.platform]} · {b.alias}
                      {b.byo ? ' · BYO' : ''}
                    </Text>
                  );
                })}
              </View>
            )}
          </View>
          <Text style={styles.linkTxt}>Manage ›</Text>
        </Pressable>
      ))}
    </View>
  );
}

const ALL_SCOPES: TrustScope[] = ['task', 'event'];
const SCOPE_LABEL: Record<TrustScope, string> = {
  task: 'Tasks',
  event: 'Calendar events',
};

function ConnectedAiAppsSection() {
  const [apps, setApps] = useState<ConnectedAiApp[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    listAiApps()
      .then(setApps)
      .catch((e) => setErr((e as Error).message));
  }, []);

  const disconnect = useCallback((app: ConnectedAiApp) => {
    const proceed = async () => {
      setBusyId(app.id);
      setErr(null);
      try {
        await disconnectAiApp(app.id);
        setApps((as) => as?.filter((a) => a.id !== app.id) ?? []);
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusyId(null);
      }
    };
    confirmDestructive(
      `Disconnect ${app.name}`,
      `${app.name} loses access to your Chord account at once. You can connect it again from ${app.name}.`,
      () => void proceed(),
      { confirmLabel: 'Disconnect' },
    );
  }, []);

  return (
    <View style={{ marginTop: 4 }}>
      <Text style={styles.muted}>
        AI apps such as Claude or ChatGPT that you let use Chord. They can read your mail, to-dos, lists and
        calendar, and suggest things that wait in Action Items for you to confirm.
      </Text>
      {err && <Text style={styles.errTxt}>{err}</Text>}
      {apps === null ? (
        <Text style={[styles.muted, { marginTop: 8 }]}>Loading…</Text>
      ) : apps.length === 0 ? (
        <Text style={[styles.muted, { marginTop: 8 }]}>No apps are connected.</Text>
      ) : (
        apps.map((a) => (
          <View key={a.id} style={trustStyles.grantRow}>
            <View style={{ flex: 1 }}>
              <Text style={trustStyles.grantName}>{a.name}</Text>
              <Text style={styles.muted}>
                {a.scopes.includes('suggest') ? 'Reads and suggests' : 'Reads only'} ·{' '}
                {a.lastUsedAt ? `last used ${new Date(a.lastUsedAt).toLocaleDateString()}` : 'not used yet'}
              </Text>
            </View>
            <Pressable
              onPress={() => disconnect(a)}
              disabled={busyId === a.id}
              style={trustStyles.revokeBtn}
              accessibilityLabel={`Disconnect ${a.name}`}
            >
              {busyId === a.id ? (
                <ActivityIndicator color={colors.accent} />
              ) : (
                <Text style={styles.linkTxt}>Disconnect</Text>
              )}
            </Pressable>
          </View>
        ))
      )}
    </View>
  );
}

function BlockedPeopleSection() {
  const [blocked, setBlocked] = useState<BlockedUser[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    listBlockedUsers()
      .then(setBlocked)
      .catch((e) => setErr((e as Error).message));
  }, []);

  const unblock = useCallback(async (userId: string) => {
    setBusyId(userId);
    setErr(null);
    try {
      await unblockUser(userId);
      setBlocked((bs) => bs?.filter((b) => b.userId !== userId) ?? []);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }, []);

  return (
    <View style={{ marginTop: 4 }}>
      <Text style={styles.muted}>
        You do not see messages from people you block, in any chat, and get no notifications
        for them. They are not told. To block someone, long-press one of their messages or tap
        their name in a chat.
      </Text>
      {err && <Text style={styles.errTxt}>{err}</Text>}
      {blocked === null ? (
        <Text style={[styles.muted, { marginTop: 8 }]}>Loading…</Text>
      ) : blocked.length === 0 ? (
        <Text style={[styles.muted, { marginTop: 8 }]}>You have not blocked anyone.</Text>
      ) : (
        blocked.map((b) => (
          <View key={b.userId} style={trustStyles.grantRow}>
            <View style={{ flex: 1 }}>
              <Text style={trustStyles.grantName}>{b.name}</Text>
            </View>
            <Pressable
              onPress={() => void unblock(b.userId)}
              disabled={busyId === b.userId}
              style={trustStyles.revokeBtn}
              accessibilityLabel={`Unblock ${b.name}`}
            >
              {busyId === b.userId ? (
                <ActivityIndicator color={colors.accent} />
              ) : (
                <Text style={styles.linkTxt}>Unblock</Text>
              )}
            </Pressable>
          </View>
        ))
      )}
    </View>
  );
}

function TrustSection() {
  const [grants, setGrants] = useState<TrustGrant[] | null>(null);
  const [candidates, setCandidates] = useState<TrustCandidate[] | null>(null);
  const [pending, setPending] = useState<PermissionRequest[]>([]);
  const [picking, setPicking] = useState<boolean>(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const candidateById = useMemo(() => {
    const m = new Map<string, TrustCandidate>();
    for (const c of candidates ?? []) m.set(c.userId, c);
    return m;
  }, [candidates]);

  const refresh = useCallback(async () => {
    try {
      const [g, c, p] = await Promise.all([
        listTrustGrants(),
        listTrustCandidates(),
        listPermissionRequests(),
      ]);
      setGrants(g);
      setCandidates(c);
      setPending(p.incoming);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleScope = useCallback(
    async (senderUserId: string, scope: TrustScope) => {
      setBusyId(senderUserId);
      setErr(null);
      try {
        const current = grants?.find((g) => g.senderUserId === senderUserId);
        const next = new Set<TrustScope>(current?.scopes ?? []);
        if (next.has(scope)) next.delete(scope);
        else next.add(scope);
        const updated = await setTrustGrant(senderUserId, [...next]);
        setGrants((gs) => {
          const base = gs?.filter((g) => g.senderUserId !== senderUserId) ?? [];
          return updated ? [...base, updated] : base;
        });
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusyId(null);
      }
    },
    [grants],
  );

  const revoke = useCallback(async (senderUserId: string) => {
    setBusyId(senderUserId);
    setErr(null);
    try {
      await revokeTrustGrant(senderUserId);
      setGrants((gs) => gs?.filter((g) => g.senderUserId !== senderUserId) ?? []);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }, []);

  const grant = useCallback(async (c: TrustCandidate) => {
    setBusyId(c.userId);
    setErr(null);
    try {
      const updated = await setTrustGrant(c.userId, ['task', 'event']);
      if (updated) {
        setGrants((gs) => [...(gs ?? []).filter((g) => g.senderUserId !== c.userId), updated]);
      }
      setPicking(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }, []);

  const respond = useCallback(
    async (req: PermissionRequest, decision: 'approve' | 'deny') => {
      setBusyId(req.id);
      setErr(null);
      try {
        await respondToPermissionRequest(req.id, decision);
        setPending((ps) => ps.filter((p) => p.id !== req.id));
        if (decision === 'approve') {
          // refresh grants to pick up the new row
          const g = await listTrustGrants();
          setGrants(g);
        }
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusyId(null);
      }
    },
    [],
  );

  if (grants === null || candidates === null) {
    return <Text style={styles.muted}>Loading…</Text>;
  }

  const grantedIds = new Set(grants.map((g) => g.senderUserId));
  const addable = candidates.filter((c) => !grantedIds.has(c.userId));

  return (
    <View style={{ marginTop: 8 }}>
      {grants.length === 0 ? (
        <Text style={styles.muted}>No one trusted yet.</Text>
      ) : (
        grants.map((g) => {
          const c = candidateById.get(g.senderUserId);
          const name = c?.displayName ?? g.senderUserId;
          return (
            <View key={g.id} style={trustStyles.grantRow}>
              <View style={{ flex: 1 }}>
                <Text style={trustStyles.grantName}>{name}</Text>
                {c?.email && <Text style={styles.muted}>{c.email}</Text>}
                <View style={trustStyles.scopeRow}>
                  {ALL_SCOPES.map((s) => {
                    const active = g.scopes.includes(s);
                    return (
                      <Pressable
                        key={s}
                        onPress={() => void toggleScope(g.senderUserId, s)}
                        disabled={busyId === g.senderUserId}
                        style={[trustStyles.scopeChip, active && trustStyles.scopeChipActive]}
                      >
                        <Text
                          style={[
                            trustStyles.scopeChipTxt,
                            active && trustStyles.scopeChipTxtActive,
                          ]}
                        >
                          {active ? '✓ ' : ''}
                          {SCOPE_LABEL[s]}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
              <Pressable
                onPress={() => void revoke(g.senderUserId)}
                disabled={busyId === g.senderUserId}
                style={trustStyles.revokeBtn}
              >
                {busyId === g.senderUserId ? (
                  <ActivityIndicator color={colors.red} />
                ) : (
                  <Text style={trustStyles.revokeTxt}>Revoke</Text>
                )}
              </Pressable>
            </View>
          );
        })
      )}

      {picking ? (
        addable.length === 0 ? (
          <View style={trustStyles.pickerEmpty}>
            <Text style={styles.muted}>
              No more candidates - everyone you share a group with is already trusted.
            </Text>
            <Pressable onPress={() => setPicking(false)}>
              <Text style={[styles.linkTxt, { marginTop: 8 }]}>Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ marginTop: 12 }}>
            <Text style={styles.fieldLabel}>Pick someone you share a group with</Text>
            {addable.map((c) => (
              <Pressable
                key={c.userId}
                onPress={() => void grant(c)}
                disabled={busyId === c.userId}
                style={trustStyles.candidateRow}
              >
                <View style={{ flex: 1 }}>
                  <Text style={trustStyles.grantName}>{c.displayName}</Text>
                  <Text style={styles.muted}>
                    {c.email ? `${c.email} · ` : ''}
                    {c.sharedGroups.join(', ')}
                  </Text>
                </View>
                {busyId === c.userId ? (
                  <ActivityIndicator color={colors.accent} />
                ) : (
                  <Text style={styles.linkTxt}>Grant ›</Text>
                )}
              </Pressable>
            ))}
            <Pressable onPress={() => setPicking(false)}>
              <Text style={[styles.linkTxt, { marginTop: 8 }]}>Cancel</Text>
            </Pressable>
          </View>
        )
      ) : (
        <Pressable
          style={[styles.btn, { marginTop: 12 }, busyId !== null && styles.btnDisabled]}
          disabled={busyId !== null}
          onPress={() => setPicking(true)}
        >
          <Text style={styles.btnText}>Add someone</Text>
        </Pressable>
      )}

      {pending.length > 0 && (
        <View style={{ marginTop: 16 }}>
          <Text style={[styles.fieldLabel, { marginTop: 0 }]}>
            Pending requests ({pending.length})
          </Text>
          {pending.map((req) => {
            const c = candidateById.get(req.senderUserId);
            const name = c?.displayName ?? req.senderUserId;
            return (
              <View key={req.id} style={trustStyles.requestRow}>
                <View style={{ flex: 1 }}>
                  <Text style={trustStyles.grantName}>{name}</Text>
                  <Text style={styles.muted}>
                    wants to{' '}
                    {req.scopes
                      .map((s) => (s === 'task' ? 'assign tasks' : 'add calendar events'))
                      .join(' and ')}
                  </Text>
                  {req.reason && (
                    <Text style={[styles.muted, { fontStyle: 'italic' }]}>“{req.reason}”</Text>
                  )}
                </View>
                <View style={trustStyles.requestBtnCol}>
                  <Pressable
                    onPress={() => void respond(req, 'approve')}
                    disabled={busyId === req.id}
                    style={trustStyles.approveBtn}
                  >
                    {busyId === req.id ? (
                      <ActivityIndicator color={colors.onAccent} />
                    ) : (
                      <Text style={trustStyles.approveTxt}>Approve</Text>
                    )}
                  </Pressable>
                  <Pressable
                    onPress={() => void respond(req, 'deny')}
                    disabled={busyId === req.id}
                    style={trustStyles.denyBtn}
                  >
                    <Text style={trustStyles.denyTxt}>Deny</Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </View>
      )}

      {err && <Text style={styles.errTxt}>{err}</Text>}
    </View>
  );
}

const trustStyles = themed((colors) => ({
  grantRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: 8,
  },
  grantName: { color: colors.text, fontWeight: '600', fontSize: 14 },
  scopeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  scopeChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  scopeChipActive: { backgroundColor: colors.accentLight, borderColor: colors.accent },
  scopeChipTxt: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  scopeChipTxtActive: { color: colors.accent },
  revokeBtn: { paddingHorizontal: 10, paddingVertical: 6 },
  revokeTxt: { color: colors.red, fontSize: 12, fontWeight: '600' },
  candidateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  pickerEmpty: {
    marginTop: 12,
    padding: 12,
    backgroundColor: colors.bg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  requestRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: 8,
  },
  requestBtnCol: { flexDirection: 'column', gap: 6 },
  approveBtn: {
    backgroundColor: colors.accent,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    alignItems: 'center',
  },
  approveTxt: { color: colors.onAccent, fontSize: 12, fontWeight: '600' },
  denyBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  denyTxt: { color: colors.muted, fontSize: 12, fontWeight: '600' },
}));

const messagingStyles = themed((colors) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  groupName: { color: colors.text, fontWeight: '600', fontSize: 14 },
  bindingsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  bindingChip: {
    color: colors.muted,
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontSize: 11,
    fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
  },
  dotOk: { color: colors.green },
  dotWarn: { color: colors.warn },
  dotError: { color: colors.red },
  dotMuted: { color: colors.muted },
}));

const styles = themed((colors) => ({
  link: { color: colors.accent, fontSize: 13, textDecorationLine: 'underline', marginTop: 8 },
  screen: { flex: 1, backgroundColor: colors.bg },
  root: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 24 },

  sectionHeader: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginTop: 18,
    marginBottom: 6,
    marginLeft: 4,
  },
  discloseHead: { flexDirection: 'row', alignItems: 'center' },
  chev: { color: colors.muted, fontSize: 14, fontWeight: '700', marginLeft: 8 },
  discloseBody: { marginTop: 4 },
  subLabel: { color: colors.text, fontSize: 13.5, fontWeight: '700', marginTop: 14 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 16,
  },
  label: { color: colors.muted, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6 },
  value: { color: colors.text, fontSize: 18, fontWeight: '600', marginTop: 4 },
  muted: { color: colors.muted, fontSize: 13, marginTop: 4 },
  ruleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  ruleMain: { flex: 1 },
  ruleTxt: { color: colors.text, fontSize: 14 },
  ruleKind: { color: colors.muted, fontSize: 12, marginTop: 2 },
  ruleDel: { color: colors.red, fontSize: 13 },
  ruleChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  errTxt: { color: colors.red, fontSize: 13, marginTop: 8, marginBottom: 8 },
  fieldLabel: { color: colors.muted, fontSize: 11, fontWeight: '600', marginTop: 12, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.4 },
  linkTxt: { color: colors.accent, fontSize: 14, fontWeight: '600', marginTop: 8 },

  modeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 10,
    marginTop: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  modeRowActive: {
    backgroundColor: colors.accentLight,
    borderColor: colors.accent,
  },
  modeRowDisabled: { opacity: 0.5 },
  modeRadio: { color: colors.accent, fontSize: 16, marginTop: 1 },
  modeLabel: { color: colors.text, fontSize: 15, fontWeight: '600' },
  modeLabelDisabled: { color: colors.muted },

  systemRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  systemTxt: { color: colors.text, fontSize: 13, flex: 1 },
  systemTxtBold: { fontWeight: '700' },
  systemDotOk: { color: colors.green, fontSize: 13, fontWeight: '700' },
  systemDotOff: { color: colors.muted, fontSize: 13, fontWeight: '700' },

  providerRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  providerChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  providerChipActive: { backgroundColor: colors.accentLight, borderColor: colors.accent },
  providerChipTxt: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  providerChipTxtActive: { color: colors.accent },

  input: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 14,
  },
  textarea: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 14,
    minHeight: 120,
    marginTop: 8,
    textAlignVertical: 'top',
  },

  btnRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  btn: {
    backgroundColor: colors.accent,
    padding: 12,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 12,
  },
  btnFlex: { flex: 1, marginTop: 0 },
  // Compact actions (bring-your-own-key header and its Save): content-width pills
  // rather than a full-width bar, so a secondary shortcut does not read as the
  // screen's main action.
  btnSmall: {
    backgroundColor: colors.accent,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnSmallTxt: { color: colors.onAccent, fontSize: 12, fontWeight: '600' },
  btnGhostSmall: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnGhostSmallTxt: { color: colors.accent, fontSize: 12, fontWeight: '600' },
  byokHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 16,
  },
  byokLabel: { marginTop: 0, marginBottom: 0, flexShrink: 1 },
  btnDisabled: { opacity: 0.4 },
  btnDanger: { backgroundColor: colors.red },
  btnText: { color: colors.onAccent, fontWeight: '600' },
  btnGhost: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnGhostTxt: { color: colors.accent, fontWeight: '600' },
  // ADR 0080 - IMAP preset picker chips.
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.card },
  chipText: { color: colors.muted, fontSize: 13 },
  chipTextOn: { color: colors.accent, fontWeight: '600' },
  /** In-row Sync chip - tighter than btnGhost so it fits beside a switch. */
  syncChip: { paddingHorizontal: 12, paddingVertical: 6 },
  /** Content-width variant for actions that don't deserve a full-width bar. */
  compactBtn: { alignSelf: 'flex-start', paddingHorizontal: 18 },

  toggleRow: { flexDirection: 'row', alignItems: 'center' },
  switchTrack: {
    width: 44,
    height: 26,
    borderRadius: 13,
    backgroundColor: colors.border,
    padding: 2,
    justifyContent: 'center',
  },
  switchTrackOn: { backgroundColor: colors.accent },
  switchThumb: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#fff',
  },
  switchThumbOn: { transform: [{ translateX: 18 }] },

  dangerBtn: {
    backgroundColor: colors.card,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.red,
  },
  dangerBtnTxt: { color: colors.red, fontWeight: '600' },
  deleteCard: { marginTop: 16, borderColor: colors.red },
}));
