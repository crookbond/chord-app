import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { router } from 'expo-router';
import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  syncEventToCalendar,
  syncTripToCalendar,
  removeEventFromCalendar,
  setGoogleHandlesDeviceSync,
} from './calendar';
import { handleContactLookup as handleDeviceContactLookup } from './device-contact-lookup';
import {
  OfflineError,
  SlowServerError,
  checkConnection,
  isOnline,
  noteNetworkFailure,
  noteServerAnswered,
  onNetworkChange,
  setConnectionProbe,
} from './network';
import { importIfNative } from './optional-native';
import { openInFileViewer } from './viewer-files';
import { clearLocalUserData, onSignOut } from './sign-out';
import {
  API,
  CSRF_HEADER,
  SESSION_HEADER,
  bytesMatchFormat,
  fileFormat,
  fileViewerPlan,
  fetchFailedOffline,
  requestTimeoutMs,
  meOutcomeForStatus,
  applyPendingProposalAnswers,
  pendingAnsweredIds,
  readWithSavedCopy,
  StreamSupervisor,
  streamEndIsFinal,
  type StreamTransportHooks,
  type MeOutcome,
  type PendingProposalAnswer,
  type SavedCopyStore,
  resolveConditional,
  viewerFileName,
  viewerMimeType,
  type ConditionalEntry,
  type Attachment,
  type AiAppDecisionResult,
  type AiAppRequestView,
  type BlockedUser,
  type ConnectedAiApp,
  type ReportMessageResponse,
  type CalendarSource,
  type DefaultCalendar,
  type CreateGroupRequest,
  type CreateSaveRequest,
  type CreateSessionRequest,
  type CreateTaskRequest,
  type DeviceCalendarSyncRequest,
  type DeviceCalendarSyncResult,
  type EmailModifyRequest,
  type ConnectImapRequest,
  type EmailAccountRetryResult,
  type EmailAccountSummary,
  type JunkMessage,
  type EmailStatus,
  type EmailSyncResult,
  type EmailThreadDetail,
  type EmailAction,
  type EmailDraft,
  type EmailDraftRequest,
  type EmailFolder,
  type EmailForwardPreview,
  type EmailForwardRequest,
  type EmailReplyRequest,
  type EmailImageSenderRequest,
  type EmailBulkModifyRequest,
  type EmailBulkModifyResult,
  type EmailLabelSummary,
  type EmailSendAsAddress,
  type EmailRouteRequest,
  type EmailVacationRequest,
  type EmailVacationSettings,
  type EmailRoutingRuleDto,
  type EmailUnsubscribeResult,
  type EmailMailingList,
  type EmailUnsubscribeManyResult,
  type EmailFilingRule,
  type AddEmailFilingRuleRequest,
  type EmailQueueRequest,
  type EmailQueuedResult,
  type EmailComposeNewRequest,
  type EmailComposeNewResult,
  type EmailComposeReplyRequest,
  type EmailComposeReplyResult,
  type EmailCategoryOrder,
  type EmailReplyAsksResult,
  type EmailSummarizeResult,
  type EmailRecipientSuggestion,
  type EmailReceiptsOverview,
  type FindingsChatRequest,
  type FindingsChatResult,
  type EmailSendRequest,
  type EmailSendResult,
  type EmailThreadSummary,
  type EmailThreadUpdatedEvent,
  type EmailTileLevel,
  type EmailDecisionsResponse,
  type GoogleConsentResponse,
  type Group,
  type GroupEvent,
  type EventAnswerResponse,
  type EventGuestsResponse,
  type EventVideoCallResponse,
  type LiveEventIdsRequest,
  type LiveEventIdsResponse,
  type JoinGroupRequest,
  type ChatInvite,
  type InviteByEmailRequest,
  type InviteByEmailResponse,
  type UpdateGroupRequest,
  type List,
  type MovableSaveKind,
  type MoveListToSavesResult,
  type ListItem,
  type BotCardPayload,
  type BotReceiptEvent,
  type BotStartEvent,
  type BotSaveOffer,
  type BotSourcesEvent,
  type BotToolEvent,
  type ConnectorPlatform,
  type ConnectorBoundEvent,
  type ConnectorRenamedEvent,
  type ConnectorUnboundEvent,
  type GroupReadEvent,
  type GroupConnectorsResponse,
  type MeConnectorsResponse,
  type PairingStatusResponse,
  type PendingPersonSuggestion,
  type PersonWithDates,
  type PhoneStatus,
  type DeviceContactLookupRequest,
  type DeviceContactLookupResponse,
  type ResolveContactsRequest,
  type ResolveContactsResponse,
  type StartPhoneVerificationRequest,
  type StartPhoneVerificationResponse,
  type VerifyPhoneRequest,
  type StartPairingRequest,
  type StartPairingResponse,
  type AddImportantDateRequest,
  type BillingStatus,
  type AddFamilyMemberRequest,
  type BillingInterval,
  type BillingPortalResponse,
  type SetRenewalResponse,
  type ChangePlanResponse,
  type CheckoutSessionResponse,
  type FamilyInviteResult,
  type FamilyMember,
  type FamilyOverview,
  type ShareEmailToGroupRequest,
  type ShareEmailToGroupResult,
  type SubscriptionPlan,
  type UpdateFamilyMemberRequest,
  type CreatePersonRequest,
  type ImportantDate,
  type ImportantDay,
  type IngestDoneEvent,
  type IngestProgressEvent,
  type MeSettings,
  type ModelProvider,
  type SetMyNameRequest,
  type SetModelKeyRequest,
  type StartOpenRouterConnectRequest,
  type StartOpenRouterConnectResult,
  type SetNudgeRequest,
  type SetTimezoneRequest,
  type SetNotificationPrefsRequest,
  type SetEmailAccountPrefsRequest,
  type SetEmailPrefsRequest,
  type SetMailboxSignatureRequest,
  type RegisterPushTokenRequest,
  type UnregisterPushTokenRequest,
  type SetGroupMutedRequest,
  type TrustCandidate,
  type TrustCandidatesResponse,
  type TrustGrant,
  type TrustGrantsResponse,
  type TrustScope,
  type PermissionRequest,
  type PermissionRequestsResponse,
  type GroupMember,
  type Memory,
  type FamilyProfile,
  type Persona,
  type CreatePersonaRequest,
  type UpdatePersonaRequest,
  type CreateFactRequest,
  type UpdateFactRequest,
  type PromotePersonResult,
  type Accommodation,
  type Message,
  type Trip,
  type TravelLeg,
  type TripStatus,
  type PostMessageRequest,
  type DeleteMessagesRequest,
  type DeleteMessagesResponse,
  type Proposal,
  type RouteSuggestion,
  type RsvpProposalRequest,
  type OverlapAnswerRequest,
  type MeetingHold,
  type RsvpResultDto,
  type ProposalResolvedEvent,
  type Save,
  type SessionResponse,
  type StreamEndEvent,
  type StreamEndReason,
  type Task,
  type TodoSyncRequest,
  type TodoSyncResult,
  type UpdateSaveRequest,
  type UpdateTaskRequest,
  type User,
  type AppleWebConfig,
  type AiConsentStatus,
  type SetAiConsentRequest,
  createSharedReads,
  requestErrorText,
  webApiBase,
} from '@chord/kernel';

const TOKEN_KEY = 'chord.token';
const USERNAMES_KEY = 'chord.recentUsernames';
const MAX_RECENT_USERNAMES = 8;

/**
 * The web app's session is the httpOnly `chord.sid` cookie the server sets at
 * sign-in: page script never sees the token, so a script injected into the
 * page cannot carry the session away. Phones keep the token and send it in
 * the `x-chord-token` header, as before.
 */
const IS_WEB = Platform.OS === 'web';

function resolveBase(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_BASE;
  // Web: the API must be the same site as the page or the session cookie is
  // not sent (ADR 0316); a dev API on this machine moves to the page's host.
  if (IS_WEB && typeof window !== 'undefined' && window.location?.hostname) {
    return webApiBase(fromEnv, window.location);
  }
  if (fromEnv && fromEnv.length > 0) return fromEnv.replace(/\/$/, '');
  const hostUri = Constants.expoConfig?.hostUri ?? '';
  const host = hostUri.split(':')[0];
  if (host) return `http://${host}:4000`;
  return 'http://127.0.0.1:4000';
}

export const API_BASE = resolveBase();

/**
 * Identical GETs already on the wire share one request, until a write: a read
 * after a write must not be handed the answer from before it
 * (kernel/src/shared-reads.ts).
 */
const sharedGets = createSharedReads();

/**
 * Every call to Chord's server goes through here (ADR 0311). Offline, it fails
 * at once without touching the network; a request that never reached the
 * server asks for a check, and any answer at all marks the server reachable.
 */
async function apiFetch(
  url: string,
  init?: RequestInit,
  opts: { long?: boolean } = {},
): Promise<Response> {
  if (!isOnline()) throw new OfflineError();
  // A write (incl. a mailbox sync, which bypasses `request`) ends the sharing
  // of reads already on the wire, when it is sent and when it is answered.
  const writes = (init?.method ?? 'GET').toUpperCase() !== 'GET';
  if (writes) sharedGets.forget();
  // A stalled connection gives up (kernel `requestTimeoutMs`) and is treated
  // as no network, instead of hanging whoever waits on it. It bounds the wait
  // for the answer to start, not the reading of a long body.
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(
    () => {
      timedOut = true;
      ctl.abort();
    },
    requestTimeoutMs({ method: init?.method, long: opts.long }),
  );
  const outer = init?.signal;
  const forwardAbort = () => ctl.abort();
  if (outer) {
    if (outer.aborted) ctl.abort();
    else outer.addEventListener('abort', forwardAbort);
  }
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: withWebHeaders(init?.headers), signal: ctl.signal });
  } catch (e) {
    if (!fetchFailedOffline({ error: e, timedOut })) throw e;
    // A request that ran out of time while the server still answers is a
    // slow server, not a lost network: say so (ADR 0334).
    if (timedOut && (await checkConnection())) throw new SlowServerError();
    noteNetworkFailure();
    throw new OfflineError();
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', forwardAbort);
    if (writes) sharedGets.forget();
  }
  noteServerAnswered();
  return res;
}

/**
 * Web: every request carries the CSRF header (the server refuses a write
 * signed in by the cookie without it) and never a session token.
 */
function withWebHeaders(headers: HeadersInit | undefined): HeadersInit | undefined {
  if (!IS_WEB) return headers;
  const h = new Headers(headers);
  h.delete(SESSION_HEADER);
  h.set(CSRF_HEADER, '1');
  return h;
}

const PROBE_TIMEOUT_MS = 10_000;

setConnectionProbe(async () => {
  // Not through apiFetch: this is the one request that must run while offline.
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch(`${API_BASE}${API.health}`, { cache: 'no-store', signal: ctl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
});

/**
 * ADR 0311 addendum - reads a screen needs to show anything offline (the mail
 * status behind the compose button, the AI view's decisions and categories,
 * Action Items) keep a sealed copy of their last answer, used only when the
 * server cannot be reached. The sealed device store registers itself here,
 * since it imports this module.
 */
let savedCopyStore: SavedCopyStore | null = null;
const lastSaved = new Map<string, string>();

export function setSavedCopyStore(store: SavedCopyStore): void {
  savedCopyStore = store;
}

onSignOut(() => lastSaved.clear());

/**
 * The copy `withSavedCopy(name, …)` last saved on this device, or null. Read
 * by screens so their first paint comes from the phone (kernel
 * `showSavedThenFresh`), not a spinner.
 */
export async function readSavedCopy<T>(name: string): Promise<T | null> {
  if (!savedCopyStore) return null;
  const copy = await savedCopyStore.read<T>(name).catch(() => null);
  return copy ? copy.value : null;
}

export function withSavedCopy<T>(name: string, fetch: () => Promise<T>): Promise<T> {
  if (!savedCopyStore) return fetch();
  return readWithSavedCopy(
    name,
    fetch,
    savedCopyStore,
    (e) => e instanceof OfflineError,
    lastSaved,
  );
}

/**
 * ADR 0311 addendum - a queued send carries the queue's id for it, so a repeat
 * after a lost answer is done once by the server.
 */
function sendIdHeaders(sendId?: string): Record<string, string> {
  return sendId ? { 'Idempotency-Key': sendId } : {};
}

/** ADR 0311 addendum - replay one to-do or list change made offline. */
export async function syncTodoChange(body: TodoSyncRequest, sendId?: string): Promise<TodoSyncResult> {
  return request<TodoSyncResult>(API.meTodoSync, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: sendIdHeaders(sendId),
  });
}

/** The server answered with an error status. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A failed response as an ApiError worded for the person (`requestErrorText`). */
async function errorFromResponse(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => '');
  return new ApiError(requestErrorText(res.status, res.statusText, text), res.status);
}

let memoryToken: string | null = null;

/**
 * Web: whether the cookie session is known to hold. Page script cannot read
 * the cookie, so this is what the server last said: in after a sign-in or a
 * good `/me`, out after sign-out or a rejected one, unknown before either.
 */
let webSession: 'unknown' | 'in' | 'out' = 'unknown';
/** Bumped on every sign-in and sign-out, so per-account caches never cross accounts on web. */
let webSessionEpoch = 0;

/** The session token on a phone. Always null on web, where the token lives in an httpOnly cookie. */
export async function getToken(): Promise<string | null> {
  if (IS_WEB) return null;
  if (memoryToken) return memoryToken;
  memoryToken = await AsyncStorage.getItem(TOKEN_KEY);
  return memoryToken;
}

/**
 * Could someone be signed in here? A phone: a token is stored. Web: the
 * server has not said otherwise (a request made on a wrong guess just
 * answers 401).
 */
export async function hasSession(): Promise<boolean> {
  if (IS_WEB) return webSession !== 'out';
  return !!(await getToken());
}

/** A key that changes when the signed-in account does, for caches held in memory. */
async function sessionKey(): Promise<string> {
  if (IS_WEB) return `web:${webSessionEpoch}`;
  return (await getToken()) ?? '';
}

function noteWebSession(state: 'in' | 'out'): void {
  if (!IS_WEB) return;
  if (state !== webSession) webSessionEpoch += 1;
  webSession = state;
}

async function setToken(t: string | null): Promise<void> {
  if (IS_WEB) {
    // The server set (or cleared) the cookie with this answer; nothing to
    // keep, and a token an older build stored is deleted, never rewritten.
    noteWebSession(t ? 'in' : 'out');
    await AsyncStorage.removeItem(TOKEN_KEY).catch(() => {});
    return;
  }
  memoryToken = t;
  if (t) await AsyncStorage.setItem(TOKEN_KEY, t);
  else await AsyncStorage.removeItem(TOKEN_KEY);
}

/**
 * Web, once per load before anything asks who this is: a browser signed in on
 * a build that stored the token in web storage hands it to the server, which
 * sets the cookie for it, and the stored copy is deleted. Never signs anyone
 * out: with no network (or a server error) the token stays for the next load;
 * any other answer (the cookie set, or the token no longer valid) ends it.
 */
let adoptRun: Promise<void> | null = null;

export function adoptLegacyWebSession(): Promise<void> {
  if (!IS_WEB) return Promise.resolve();
  adoptRun ??= (async () => {
    const legacy = await AsyncStorage.getItem(TOKEN_KEY).catch(() => null);
    if (!legacy) return;
    try {
      // Not through apiFetch: that strips the token header on web, and this
      // is the one request that must send it.
      const res = await fetch(`${API_BASE}${API.sessionAdopt}`, {
        method: 'POST',
        headers: { [SESSION_HEADER]: legacy, [CSRF_HEADER]: '1' },
        credentials: 'include',
      });
      if (res.status >= 500) return;
      await AsyncStorage.removeItem(TOKEN_KEY).catch(() => {});
    } catch {
      // No network: try again on the next load.
    }
  })();
  return adoptRun;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getToken();
  return token ? { [SESSION_HEADER]: token } : {};
}


async function request<T>(
  path: string,
  init: RequestInit = {},
  opts: { long?: boolean } = {},
): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method === 'GET' && init.body == null && init.signal == null) {
    const token = await sessionKey();
    return sharedGets.share(`req ${token} ${path} ${JSON.stringify(init.headers ?? {})}`, () =>
      sendRequest<T>(path, init, opts),
    );
  }
  // A write may change what a cached read answered; the next read asks again.
  forgetCachedReads();
  return sendRequest<T>(path, init, opts).finally(forgetCachedReads);
}

/**
 * Reads several screens ask for on every mount or focus, held briefly. Any
 * write through this module, and sign-out, drops them.
 */
const SETTINGS_FRESH_MS = 30_000;
const CALENDAR_STATUS_FRESH_MS = 5 * 60_000;
let settingsCache: { at: number; value: Promise<MeSettings> } | null = null;
let calendarStatusCache: { at: number; value: Promise<CalendarStatus> } | null = null;

function forgetCachedReads(): void {
  settingsCache = null;
  calendarStatusCache = null;
}

onSignOut(forgetCachedReads);

async function sendRequest<T>(
  path: string,
  init: RequestInit = {},
  opts: { long?: boolean } = {},
): Promise<T> {
  const headers = {
    'Content-Type': 'application/json',
    ...(await authHeaders()),
    ...(init.headers ?? {}),
  };
  const res = await apiFetch(`${API_BASE}${path}`, { ...init, headers, credentials: 'include' }, opts);
  if (!res.ok) throw await errorFromResponse(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * A GET that downloads the list only when it changed: the last answer's ETag
 * goes back as `If-None-Match`, and an unchanged list comes back as an empty
 * 304 that hands back the object already held. For the lists a background
 * event refetches (email decisions, tiles), where most refetches find nothing
 * new. `no-store` keeps the browser's own cache out of it, so the 304 reaches
 * this code on web exactly as it does on a phone. The explicit Cache-Control
 * is load-bearing: without one, fetch itself appends `Cache-Control: no-cache`
 * to a `no-store` request (Fetch spec, HTTP-network-or-cache fetch) and the
 * server then answers 200 with the full list every time. Keyed by session
 * token, so a second account on the device never revalidates against the
 * first's list.
 */
let conditionalCache: { token: string; entries: Map<string, ConditionalEntry<unknown>> } | null =
  null;

async function conditionalGet<T>(path: string): Promise<T> {
  const token = await sessionKey();
  return sharedGets.share(`cond ${token} ${path}`, () => sendConditionalGet<T>(path));
}

async function sendConditionalGet<T>(path: string): Promise<T> {
  const auth = await authHeaders();
  const token = await sessionKey();
  if (!conditionalCache || conditionalCache.token !== token) {
    conditionalCache = { token, entries: new Map() };
  }
  const entries = conditionalCache.entries;
  const cached = entries.get(path) as ConditionalEntry<T> | undefined;
  const res = await apiFetch(`${API_BASE}${path}`, {
    headers: {
      ...auth,
      'Cache-Control': 'max-age=0',
      ...(cached ? { 'If-None-Match': cached.etag } : {}),
    },
    credentials: 'include',
    cache: 'no-store',
  });
  if (res.status !== 304 && !res.ok) {
    // Same error shape as `request`; re-asking without a validator does it.
    entries.delete(path);
    return request<T>(path);
  }
  const body = res.status === 304 ? undefined : ((await res.json()) as T);
  const out = resolveConditional(cached, res.status, res.headers.get('etag'), body);
  if (out.entry) entries.set(path, out.entry);
  else entries.delete(path);
  return out.body;
}

// ── session ──────────────────────────────────────────────────────────

export async function ping(): Promise<{ ok: boolean; t: number }> {
  return request(API.health);
}

export async function createSession(body: CreateSessionRequest): Promise<SessionResponse> {
  const res = await request<SessionResponse>(API.session, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  await setToken(res.token);
  return res;
}

export async function getMe(): Promise<User | null> {
  return (await getMeOutcome()).user;
}

/**
 * `/me`, telling "the session is over" apart from "the server could not be
 * asked" (ADR 0311): only the first may send someone to the sign-in page.
 */
export async function getMeOutcome(): Promise<{ outcome: MeOutcome; user: User | null }> {
  try {
    const user = await request<User>(API.me);
    noteWebSession('in');
    return { outcome: 'signed-in', user };
  } catch (e) {
    if (e instanceof ApiError) {
      const outcome = meOutcomeForStatus(e.status);
      if (outcome === 'rejected') noteWebSession('out');
      return { outcome, user: null };
    }
    return { outcome: 'unreachable', user: null };
  }
}

export async function signOut(): Promise<void> {
  try {
    // Drop this account's push tokens so the device stops receiving its
    // notifications after logout (key strings mirror src/push.ts). Best-effort.
    await unregisterPushToken({});
    await AsyncStorage.multiRemove(['chord.push.enabled', 'chord.push.token']);
  } catch {
    /* best-effort */
  }
  try {
    await request(API.sessionLogout, { method: 'POST' });
  } catch {
    // server may be unreachable; clearing local state is still useful
  }
  await setToken(null);
  await clearLocalUserData();
}

/**
 * The server said this device's session is over (a 401/403 to `/me`): forget
 * it the way sign-out does - the token, every key not on the keep-list, and
 * every module's in-memory copy (queued sends, phone drafts, saved reads) - so
 * nothing of that account is shown to, or sent as, whoever signs in next.
 */
export async function forgetRejectedSession(): Promise<void> {
  await setToken(null);
  await clearLocalUserData();
}

/**
 * Permanently delete the signed-in account and all its data (ADR 0043).
 * Irreversible. Clears the local token on success so the app falls back to
 * the sign-in screen.
 */
export async function deleteAccount(): Promise<void> {
  await request(API.me, { method: 'DELETE' });
  await setToken(null);
  await clearLocalUserData();
}

export async function getRecentUsernames(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(USERNAMES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}

export async function rememberUsername(name: string): Promise<string[]> {
  const trimmed = name.trim();
  if (!trimmed) return getRecentUsernames();
  const current = await getRecentUsernames();
  const next = [trimmed, ...current.filter((n) => n !== trimmed)].slice(0, MAX_RECENT_USERNAMES);
  await AsyncStorage.setItem(USERNAMES_KEY, JSON.stringify(next));
  return next;
}

export async function forgetUsername(name: string): Promise<string[]> {
  const current = await getRecentUsernames();
  const next = current.filter((n) => n !== name);
  await AsyncStorage.setItem(USERNAMES_KEY, JSON.stringify(next));
  return next;
}

export interface HealthResponse {
  ok: boolean;
  t: number;
  demoMode: boolean;
  authMode: 'demo' | 'google';
  /** ADR 0156 — the server can complete (and later revoke) Sign in with Apple. */
  appleSignIn?: boolean;
  /** What a browser needs to start Sign in with Apple; null/absent = not offered on the web. */
  appleWeb?: AppleWebConfig | null;
  /** ADR 0293 - Sign in with Microsoft is offered; `calendar` = also ask for Outlook calendars. */
  microsoftSignIn?: { clientId: string; calendar: boolean } | null;
  /** ADR 0230 - the server reads Gmail, so sign-in asks for it. Absent = on. */
  gmail?: boolean;
  /** ADR 0345 - the app-review email + password sign-in is on. */
  reviewSignIn?: boolean;
  /** ADR 0253 - the E.164 number Chord answers on WhatsApp; null/absent = not offered. */
  whatsappNumber?: string | null;
}

export async function getHealth(): Promise<HealthResponse> {
  return request<HealthResponse>(API.health);
}

/** Sign in with Apple (ADR 0156): the iOS app, or `client: 'web'` from a browser. */
export async function authApple(body: {
  authorizationCode: string;
  givenName?: string;
  familyName?: string;
  signupRef?: string;
  client?: 'ios' | 'web';
}): Promise<SessionResponse> {
  const res = await request<SessionResponse>(API.authApple, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  await setToken(res.token);
  return res;
}

export async function authGoogle(body: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  /** UUID-style referrer token from a TG welcome-DM link (ADR 0031). */
  signupRef?: string;
}): Promise<SessionResponse> {
  const res = await request<SessionResponse>(API.authGoogle, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  await setToken(res.token);
  return res;
}

/** Sign in with Microsoft (ADR 0293); the server also connects the Outlook mailbox. */
export async function authMicrosoft(body: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  signupRef?: string;
}): Promise<SessionResponse> {
  const res = await request<SessionResponse>(API.authMicrosoft, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  await setToken(res.token);
  return res;
}

/** ADR 0345 - the app-review account's email + password sign-in. */
export async function authReview(body: { email: string; password: string }): Promise<SessionResponse> {
  const res = await request<SessionResponse>(API.authReview, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  await setToken(res.token);
  return res;
}

/**
 * Link a welcome-DM referrer token to the current (already signed-in)
 * session - merges a WhatsApp taster shadow / Telegram identity into this
 * account (ADR 0053 / 0031). Used when a returning user clicks the welcome
 * link: they never re-run Google OAuth, so `authGoogle`'s signupRef path
 * doesn't fire. Best-effort; the server treats stale tokens as a no-op.
 */
export async function linkSignupRef(
  signupRef: string,
): Promise<{ ok: boolean; linked: boolean }> {
  return request(API.meLinkSignupRef, {
    method: 'POST',
    body: JSON.stringify({ signupRef }),
  });
}

export async function signupWaitlist(body: {
  email: string;
  name?: string;
  note?: string;
}): Promise<{ ok: true; alreadyOnList: boolean }> {
  return request(API.waitlist, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function grantCalendarScope(body: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<GoogleConsentResponse> {
  const res = await request<GoogleConsentResponse>(API.authGoogleCalendar, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  setGoogleHandlesDeviceSync(hasCalendarWriteScope(res.scopes));
  return res;
}

/** Incremental consent for the Gmail reader (ADR 0062). */
export async function grantGmailScope(body: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<GoogleConsentResponse> {
  return request<GoogleConsentResponse>(API.authGoogleGmail, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export interface CalendarStatus {
  connected: boolean;
  /** ADR 0228 - an Outlook mailbox's calendar is being synced. */
  outlookConnected?: boolean;
  lastSyncedAt: string | null;
  scopes: string | null;
}

// Mirrors the server's WRITE_SCOPE_RE (calendar-write.service.ts): a granted
// `calendar` or `calendar.events` scope means the server pushes this user's
// events to Google, so the OS handles device sync and the client must not.
const CALENDAR_WRITE_SCOPE_RE =
  /(?:^|\s)https:\/\/www\.googleapis\.com\/auth\/calendar(?:\.events|)(?:$|\s)/;

function hasCalendarWriteScope(scopes: string | null): boolean {
  return CALENDAR_WRITE_SCOPE_RE.test(scopes ?? '');
}

export async function getCalendarStatus(): Promise<CalendarStatus> {
  const status = await request<CalendarStatus>(API.meCalendarStatus);
  // ADR 0228 - the server pushing to Outlook covers the phone the same way:
  // the OS brings the event down, so the client must not also write it.
  setGoogleHandlesDeviceSync(
    (status.connected && hasCalendarWriteScope(status.scopes)) || status.outlookConnected === true,
  );
  return status;
}

/** Sets the device-sync gate at most once per five minutes. */
function primeCalendarStatus(): Promise<CalendarStatus> {
  const now = Date.now();
  if (calendarStatusCache && now - calendarStatusCache.at < CALENDAR_STATUS_FRESH_MS) {
    return calendarStatusCache.value;
  }
  const entry = { at: now, value: getCalendarStatus() };
  calendarStatusCache = entry;
  entry.value.catch(() => {
    if (calendarStatusCache === entry) calendarStatusCache = null;
  });
  return calendarStatusCache.value;
}

export interface CalendarSyncResult {
  fetched: number;
  inserted: number;
  skippedExisting: number;
  skippedCancelled: number;
  calendars?: number;
}

/** Thrown when a sync fails because the stored Google refresh token is dead -
 *  the server has already cleared it (409 needsReconnect), so the calendar is
 *  now disconnected and the user must reconnect. Distinguishes "reconnect" from
 *  a transient sync failure at the call site. */
export class CalendarReconnectError extends Error {
  constructor(message = 'Google Calendar disconnected - reconnect to continue') {
    super(message);
    this.name = 'CalendarReconnectError';
  }
}

export async function syncCalendar(): Promise<CalendarSyncResult> {
  const res = await apiFetch(`${API_BASE}${API.meCalendarSync}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    credentials: 'include',
  }, { long: true });
  if (res.status === 409) {
    // The refresh token died; the server cleared it and asked us to reconnect.
    const body = (await res.json().catch(() => ({}))) as { needsReconnect?: boolean };
    if (body.needsReconnect) throw new CalendarReconnectError();
  }
  if (!res.ok) {
    throw await errorFromResponse(res);
  }
  return (await res.json()) as CalendarSyncResult;
}

export async function disconnectCalendar(): Promise<{ ok: true }> {
  const res = await request<{ ok: true }>(API.meCalendarDisconnect, { method: 'POST' });
  setGoogleHandlesDeviceSync(false); // device fallback resumes
  return res;
}

// ── Email (in-app Gmail reader, ADR 0060) ──────────────────────────────

/** Thrown when a Gmail action fails because the stored token is dead (409). */
export class GmailReconnectError extends Error {
  constructor(message = 'Gmail disconnected - reconnect to continue') {
    super(message);
    this.name = 'GmailReconnectError';
  }
}

export async function getEmailStatus(): Promise<EmailStatus> {
  return withSavedCopy('email-status', () => request<EmailStatus>(API.meEmailStatus));
}

export async function syncEmail(opts: { scope?: 'primary' } = {}): Promise<EmailSyncResult> {
  const suffix = opts.scope ? `?scope=${opts.scope}` : '';
  const res = await apiFetch(`${API_BASE}${API.meEmailSync}${suffix}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    credentials: 'include',
  }, { long: true });
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { needsReconnect?: boolean };
    if (body.needsReconnect) throw new GmailReconnectError();
  }
  if (!res.ok) {
    throw await errorFromResponse(res);
  }
  return (await res.json()) as EmailSyncResult;
}

export async function disconnectEmail(): Promise<{ ok: true }> {
  return request<{ ok: true }>(API.meEmailDisconnect, { method: 'POST' });
}

// ── Additional mailboxes (ADR 0080) ────────────────────────────────────

export async function connectOutlookAccount(body: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<EmailAccountSummary> {
  return request<EmailAccountSummary>(API.meEmailAccountsOutlook, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function connectGmailAccount(body: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<EmailAccountSummary> {
  return request<EmailAccountSummary>(API.meEmailAccountsGmail, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function connectImapAccount(body: ConnectImapRequest): Promise<EmailAccountSummary> {
  return request<EmailAccountSummary>(API.meEmailAccountsImap, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function deleteEmailAccount(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(API.meEmailAccount(id), { method: 'DELETE' });
}

/** Per-mailbox prefs: ADR 0142 label push, ADR 0145 nickname. */
export async function setEmailAccountPrefs(
  id: string,
  body: SetEmailAccountPrefsRequest,
): Promise<EmailAccountSummary> {
  return request<EmailAccountSummary>(API.meEmailAccount(id), {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function syncEmailAccount(id: string): Promise<EmailSyncResult> {
  return request<EmailSyncResult>(API.meEmailAccountSync(id), { method: 'POST' }, { long: true });
}

/** Retry a flagged mailbox with its stored credential before asking the user
 *  to type an app password that may never have been wrong. */
export async function retryEmailAccount(id: string): Promise<EmailAccountRetryResult> {
  return request<EmailAccountRetryResult>(API.meEmailAccountReconnect(id), { method: 'POST' });
}

/** Web-only: fetch a file route with the session header (never a URL token, ADR 0269). */
async function fetchAuthedBlob(path: string): Promise<Blob> {
  const res = await apiFetch(`${API_BASE}${path}`, {
    headers: { ...(await authHeaders()) },
    credentials: 'include',
  }, { long: true });
  if (!res.ok) throw await errorFromResponse(res);
  return res.blob();
}

/** Web-only: auth-fetch an email attachment and return a `blob:` URL. */
export async function fetchEmailAttachmentBlobUrl(
  messageId: string,
  attId: string,
): Promise<string> {
  return URL.createObjectURL(await fetchAuthedBlob(API.meEmailMessageAttachment(messageId, attId)));
}

/**
 * Web-only: show a file in Chord's viewer (`app/file-viewer.tsx`) instead of
 * a new tab or a download (ADR 0310). The bytes are fetched with the session
 * header; a file the browser draws itself (PDF, image, media) is relabelled
 * with that format's type (a sender's `octet-stream` label is what made
 * Chrome download it), anything Chord draws stays as bytes. A file whose
 * first bytes do not match its format is downloaded instead of shown. The
 * viewer revokes the URL on close.
 */
async function showInViewerOnWeb(blob: Blob, filename: string, mimeType?: string): Promise<void> {
  const plan = fileViewerPlan(mimeType ?? blob.type, filename, 'web');
  const head = new Uint8Array(await blob.slice(0, 1024).arrayBuffer());
  if (!plan || !bytesMatchFormat(plan.format, head)) {
    downloadBlobOnWeb(blob, filename);
    return;
  }
  const type = (plan.renderer === 'native' && viewerMimeType(plan.format, filename)) || 'application/octet-stream';
  const uri = URL.createObjectURL(new Blob([blob], { type }));
  openInFileViewer({ uri, name: filename, mime: mimeType ?? blob.type, owned: true });
}

export function downloadBlobOnWeb(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function openEmailFileOnWeb(
  messageId: string,
  attId: string,
  filename: string,
  mimeType?: string,
): Promise<void> {
  await showInViewerOnWeb(await fetchAuthedBlob(API.meEmailMessageAttachment(messageId, attId)), filename, mimeType);
}

export async function openAttachmentFileOnWeb(id: string, filename: string, mimeType?: string): Promise<void> {
  await showInViewerOnWeb(await fetchAuthedBlob(API.attachment(id)), filename, mimeType);
}

const FLAG_GRANT_READ_URI_PERMISSION = 1;

/** The first bytes of a downloaded file, for `bytesMatchFormat`. */
async function headBytes(uri: string): Promise<Uint8Array> {
  const b64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
    position: 0,
    length: 1024,
  });
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Show a file just downloaded to the cache. A file Chord can show opens in
 * its own viewer (`app/file-viewer.tsx`, ADR 0310) once its first bytes
 * match its format. Otherwise iOS opens the share sheet. Android's share
 * sheet only SENDS a file, so there it is opened with whichever app views
 * that type (ADR 0263), and the share sheet is the fallback when no app can
 * view it.
 */
/**
 * Native: attachments downloaded to be shown or shared are never kept. They go
 * in a folder of their own (still under the cache, so the viewer's own delete
 * applies), emptied on sign-out and at every launch, so a file someone opened
 * is not left readable for whoever uses the phone next.
 */
const DOWNLOADS_DIR =
  Platform.OS !== 'web' && FileSystem.cacheDirectory
    ? `${FileSystem.cacheDirectory}downloads/`
    : null;

async function emptyDownloads(): Promise<void> {
  if (!DOWNLOADS_DIR) return;
  await FileSystem.deleteAsync(DOWNLOADS_DIR, { idempotent: true }).catch(() => {});
}

const launchDownloadsWipe = emptyDownloads();
onSignOut(emptyDownloads);

async function downloadTarget(name: string): Promise<string> {
  await launchDownloadsWipe;
  if (!DOWNLOADS_DIR) throw new Error('Opening files is not available on this device');
  await FileSystem.makeDirectoryAsync(DOWNLOADS_DIR, { intermediates: true }).catch(() => {});
  return `${DOWNLOADS_DIR}${name}`;
}

async function presentDownloadedFile(uri: string, safeName: string, mimeType?: string): Promise<void> {
  const isPdf = mimeType === 'application/pdf' || safeName.toLowerCase().endsWith('.pdf');
  const plan = fileViewerPlan(mimeType, safeName, Platform.OS);
  if (plan && bytesMatchFormat(plan.format, await headBytes(uri).catch(() => new Uint8Array()))) {
    openInFileViewer({ uri, name: safeName, mime: mimeType ?? '', owned: true });
    return;
  }
  const IntentLauncher =
    Platform.OS === 'android'
      ? await importIfNative('ExpoIntentLauncher', () => import('expo-intent-launcher'))
      : null;
  if (IntentLauncher) {
    try {
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: await FileSystem.getContentUriAsync(uri),
        type: mimeType || (isPdf ? 'application/pdf' : '*/*'),
        flags: FLAG_GRANT_READ_URI_PERMISSION,
      });
      return;
    } catch {
      // no app opens this type; offer the share sheet instead
    }
  }
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Opening files is not available on this device');
  }
  await Sharing.shareAsync(uri, {
    mimeType,
    UTI: isPdf ? 'com.adobe.pdf' : undefined,
  });
}

/** Native: download an email attachment to cache and open the share/preview
 *  sheet (mirrors openAttachmentNative for chat files). */
export async function openEmailAttachmentNative(att: {
  messageId: string;
  attId: string;
  filename: string;
  mimeType?: string;
}): Promise<void> {
  const safeName = viewerFileName(att.filename.replace(/[^\w.-]+/g, '_') || 'attachment', fileFormat(att.mimeType, att.filename));
  const target = await downloadTarget(`email-${att.messageId}-${safeName}`);
  const { status, uri } = await FileSystem.downloadAsync(
    `${API_BASE}${API.meEmailMessageAttachment(att.messageId, att.attId)}`,
    target,
    { headers: await authHeaders() },
  );
  if (status !== 200) throw new Error(`Download failed (${status})`);
  await presentDownloadedFile(uri, safeName, att.mimeType);
}

/** Live junk peek across all mailboxes (codes/password-resets land there). */
export async function listJunkMail(): Promise<JunkMessage[]> {
  return request<JunkMessage[]>(API.meEmailJunk);
}

export async function rescueJunkMail(key: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(API.meEmailJunkRescue, {
    method: 'POST',
    body: JSON.stringify({ key }),
  });
}

export async function listEmailThreads(opts: {
  mode?: 'traditional' | 'category';
  category?: string;
  /** Action-axis filter; independent of category, so it composes with both
   *  modes. Omit or pass empty for "everything". */
  actions?: EmailAction[];
  /** Unread threads only. */
  unreadOnly?: boolean;
  /** Which folder to read (ADR 0108). Omit for the inbox. */
  folder?: EmailFolder;
  label?: string;
  /** One mailbox only; `'primary'` is the Gmail on the user row (ADR 0119). */
  account?: string;
  cursor?: string;
  /** ADR 0134 — exactly these threads, archived included. Used by the
   *  coverage footer, whose sets the client cannot derive and which are not
   *  reliably inside the newest page. */
  ids?: string[];
} = {}): Promise<EmailThreadSummary[]> {
  const qs = new URLSearchParams();
  if (opts.mode) qs.set('mode', opts.mode);
  if (opts.category) qs.set('category', opts.category);
  if (opts.actions?.length) qs.set('action', opts.actions.join(','));
  if (opts.unreadOnly) qs.set('unread', '1');
  if (opts.folder && opts.folder !== 'inbox') qs.set('folder', opts.folder);
  if (opts.label) qs.set('label', opts.label);
  if (opts.account) qs.set('account', opts.account);
  if (opts.cursor) qs.set('cursor', opts.cursor);
  if (opts.ids?.length) qs.set('ids', opts.ids.join(','));
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request<EmailThreadSummary[]>(`${API.meEmailThreads}${suffix}`);
}

/** The `cursor` for the page after `last`: its time and, to break ties
 *  between threads with the same time, its id. */
export function threadPageCursor(last: { lastMessageAt: string; id: string }): string {
  return `${last.lastMessageAt}|${last.id}`;
}

export async function getEmailThread(
  id: string,
  opts: { prefetch?: boolean | 'cache' } = {},
): Promise<EmailThreadDetail> {
  // `prefetch` = warming an email the user has not opened (ADR 0218);
  // `'cache'` = filling the phone's store, which starts no early check (ADR 0302).
  const q = opts.prefetch === 'cache' ? '?prefetch=cache' : opts.prefetch ? '?prefetch=1' : '';
  return request<EmailThreadDetail>(API.meEmailThread(id) + q);
}

/** The local thread a `gmail:<id>` provenance points at; throws when it's gone. */
export async function findSourceEmailThread(provenance: string): Promise<string> {
  const r = await request<{ threadId: string }>(
    `${API.meEmailSourceThread}?provenance=${encodeURIComponent(provenance)}`,
  );
  return r.threadId;
}

export async function replyEmailThread(
  id: string,
  reply: EmailReplyRequest,
  sendId?: string,
): Promise<EmailThreadDetail> {
  return request<EmailThreadDetail>(API.meEmailThreadReply(id), {
    method: 'POST',
    body: JSON.stringify(reply),
    headers: sendIdHeaders(sendId),
  });
}

/** ADR 0266 — the user's own order for the AI view's email categories. */
export async function getEmailCategoryOrder(): Promise<EmailCategoryOrder> {
  return request<EmailCategoryOrder>(API.meEmailCategoryOrder);
}

export async function setEmailCategoryOrder(titles: string[]): Promise<EmailCategoryOrder> {
  return request<EmailCategoryOrder>(API.meEmailCategoryOrder, {
    method: 'PUT',
    body: JSON.stringify({ titles }),
  });
}

/** ADR 0346 phase 4 - slots held in Chord while an invitation is on its way. */
export async function listMeetingHolds(): Promise<MeetingHold[]> {
  return request<MeetingHold[]>(API.meHolds);
}

/** ADR 0346 phase 5 - wait for their invite instead of sending one. */
export async function waitForInvite(proposalId: string): Promise<void> {
  await request<{ ok: true }>(API.proposalWaitForInvite(proposalId), { method: 'POST' });
}

export async function dropMeetingHold(meetingId: string): Promise<void> {
  await request<{ ok: true }>(API.meHold(meetingId), { method: 'DELETE' });
}

/** ADR 0346 - answer an email event card's question about an overlapping event. */
export async function answerOverlap(proposalId: string, body: OverlapAnswerRequest): Promise<void> {
  await request<{ ok: true }>(API.proposalOverlap(proposalId), { method: 'POST', body: JSON.stringify(body) });
}

/** ADR 0197 — Chord writes a reply for the user to review; nothing is sent. */
export async function composeEmailReply(
  id: string,
  input: EmailComposeReplyRequest,
): Promise<EmailComposeReplyResult> {
  return request<EmailComposeReplyResult>(
    API.meEmailThreadCompose(id),
    { method: 'POST', body: JSON.stringify(input) },
    { long: true },
  );
}

/** ADR 0261 — a few lines on what an email says and asks; nothing stored. */
export async function summarizeEmailThread(id: string): Promise<EmailSummarizeResult> {
  return request<EmailSummarizeResult>(
    API.meEmailThreadSummarize(id),
    { method: 'POST' },
    { long: true },
  );
}

export async function fetchEmailReplyAsks(id: string): Promise<EmailReplyAsksResult> {
  return request<EmailReplyAsksResult>(
    API.meEmailThreadReplyAsks(id),
    { method: 'POST' },
    { long: true },
  );
}

/** The same ask on a new message, which has no thread. Nothing is sent. */
export async function composeEmailNew(
  input: EmailComposeNewRequest,
): Promise<EmailComposeNewResult> {
  return request<EmailComposeNewResult>(
    API.meEmailCompose,
    { method: 'POST', body: JSON.stringify(input) },
    { long: true },
  );
}

/**
 * Hand a saved draft to the outbox (ADR 0115). The hold is the server's, so
 * the message goes whether or not this app is still running.
 */
export async function queueEmailSend(
  input: EmailQueueRequest,
): Promise<EmailQueuedResult> {
  return request<EmailQueuedResult>(API.meEmailOutbox, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/** Undo. Throws when the message already went — which the caller should say,
 *  rather than implying it stopped something it did not. */
export async function cancelEmailSend(draftId: string): Promise<void> {
  await request<void>(API.meEmailOutboxItem(draftId), { method: 'DELETE' });
}

/** Remote images from this sender, from now on (ADR 0120). */
export async function setEmailImageSender(input: EmailImageSenderRequest): Promise<void> {
  await request<void>(API.meEmailImageSenders, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * Ask this thread's sender to stop (ADR 0122). The result says what actually
 * happened - only a one-click POST comes back `unsubscribed`, and a `link`
 * comes back with a page for the reader to finish.
 */
export async function unsubscribeEmailThread(threadId: string): Promise<EmailUnsubscribeResult> {
  return request<EmailUnsubscribeResult>(API.meEmailThreadUnsubscribe(threadId), {
    method: 'POST',
  });
}

/** The mailing lists the user is on, busiest first. */
export async function listMailingLists(): Promise<EmailMailingList[]> {
  return request<EmailMailingList[]>(API.meEmailSubscriptions);
}

/** ADR 0309 — the user's filing rules. */
export async function listMailFilters(): Promise<EmailFilingRule[]> {
  return request<EmailFilingRule[]>(API.meEmailFilters);
}

export async function addMailFilter(input: AddEmailFilingRuleRequest): Promise<EmailFilingRule[]> {
  return request<EmailFilingRule[]>(API.meEmailFilters, { method: 'POST', body: JSON.stringify(input) });
}

export async function removeMailFilter(id: string): Promise<EmailFilingRule[]> {
  return request<EmailFilingRule[]>(API.meEmailFilter(id), { method: 'DELETE' });
}

/** Send these senders' future mail to Trash (on) or stop (off). */
export async function setMailAutoTrash(senderEmails: string[], on: boolean): Promise<{ senders: string[] }> {
  return request<{ senders: string[] }>(API.meEmailAutoTrash, {
    method: 'POST',
    body: JSON.stringify({ senderEmails, on }),
  });
}

/** Leave several lists at once; one result per list, each saying what really happened. */
export async function unsubscribeFromLists(senderEmails: string[]): Promise<EmailUnsubscribeManyResult> {
  return request<EmailUnsubscribeManyResult>(API.meEmailSubscriptionsUnsubscribe, {
    method: 'POST',
    body: JSON.stringify({ senderEmails }),
  });
}

/**
 * Put a thread aside until a moment, or wake it now (ADR 0129). Local to
 * Chord: Gmail's own snooze has no API, so the thread stays visible there.
 */
export async function snoozeEmailThread(
  threadId: string,
  until: string | null,
): Promise<EmailThreadSummary> {
  return request<EmailThreadSummary>(API.meEmailThreadSnooze(threadId), {
    method: 'POST',
    body: JSON.stringify({ until }),
  });
}

/**
 * Triage several threads at once (ADR 0128). The result names what did NOT
 * change, so a batch that half-worked can say so.
 */
export async function modifyEmailThreads(
  input: EmailBulkModifyRequest,
): Promise<EmailBulkModifyResult> {
  return request<EmailBulkModifyResult>(API.meEmailThreadsModify, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

/**
 * Addresses the primary mailbox may send as (ADR 0130). Verified only, so
 * every entry is one the provider will actually honour.
 */
export async function listEmailSendAs(): Promise<EmailSendAsAddress[]> {
  return request<EmailSendAsAddress[]>(API.meEmailSendAs);
}

/** Labels you can browse (ADR 0125), derived from the mirror. */
export async function listEmailLabels(): Promise<EmailLabelSummary[]> {
  return request<EmailLabelSummary[]>(API.meEmailLabels);
}

/** The vacation responder (ADR 0124). Chord's own, so every mailbox has one. */
export async function getEmailVacation(): Promise<EmailVacationSettings> {
  return request<EmailVacationSettings>(API.meEmailVacation);
}

export async function setEmailVacation(
  input: EmailVacationRequest,
): Promise<EmailVacationSettings> {
  return request<EmailVacationSettings>(API.meEmailVacation, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

/** Mail routing rules, as the Settings editor sees them (ADR 0123). */
export async function listEmailRoutes(): Promise<EmailRoutingRuleDto[]> {
  return request<EmailRoutingRuleDto[]>(API.meEmailRoutes);
}

/** Each write returns the whole list, so the editor never patches a row. */
export async function addEmailRoute(input: EmailRouteRequest): Promise<EmailRoutingRuleDto[]> {
  return request<EmailRoutingRuleDto[]>(API.meEmailRoutes, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function deleteEmailRoute(id: string): Promise<EmailRoutingRuleDto[]> {
  return request<EmailRoutingRuleDto[]>(API.meEmailRoute(id), { method: 'DELETE' });
}

/** Receipts read from the user's mail, for the Finance tab (ADR 0246). */
export async function getEmailReceipts(): Promise<EmailReceiptsOverview> {
  return withSavedCopy('email-receipts', () =>
    request<EmailReceiptsOverview>(API.meEmailReceipts),
  );
}

/** One turn of the Findings tab's own chat about mail (ADR 0277). Stores nothing. */
export async function findingsChat(body: FindingsChatRequest): Promise<FindingsChatResult> {
  return request<FindingsChatResult>(
    API.meFindingsChat,
    { method: 'POST', body: JSON.stringify(body) },
    { long: true },
  );
}

/** Recipient suggestions for the composer (ADR 0114). */
export async function suggestEmailRecipients(
  q: string,
): Promise<EmailRecipientSuggestion[]> {
  return request<EmailRecipientSuggestion[]>(
    `${API.meEmailRecipients}?q=${encodeURIComponent(q)}`,
  );
}

/** Drafts (ADR 0113). Save is an upsert: with an id, or with a thread for a
 *  reply or forward, it rewrites the row rather than adding one. */
export async function saveEmailDraft(input: EmailDraftRequest): Promise<EmailDraft> {
  return request<EmailDraft>(API.meEmailDrafts, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function listEmailDrafts(): Promise<EmailDraft[]> {
  return request<EmailDraft[]>(API.meEmailDrafts);
}

export async function getEmailDraft(id: string): Promise<EmailDraft> {
  return request<EmailDraft>(API.meEmailDraft(id));
}

/** The reply or forward draft a thread already has, if any. */
export async function getEmailThreadDraft(
  threadId: string,
  kind: 'reply' | 'forward',
): Promise<EmailDraft | null> {
  return request<EmailDraft | null>(`${API.meEmailThreadDraft(threadId)}?kind=${kind}`);
}

export async function deleteEmailDraft(id: string): Promise<void> {
  await request<void>(API.meEmailDraft(id), { method: 'DELETE' });
}

/**
 * Forward a thread (ADR 0112). The server refuses rather than sending a
 * forward it cannot send whole, so a rejection here has a message worth
 * showing the sender verbatim.
 */
export async function forwardEmailThread(
  id: string,
  input: EmailForwardRequest,
  sendId?: string,
): Promise<EmailSendResult> {
  return request<EmailSendResult>(API.meEmailThreadForward(id), {
    method: 'POST',
    body: JSON.stringify(input),
    headers: sendIdHeaders(sendId),
  });
}

/** What a forward of this thread will quote under the note (ADR 0112
 *  addendum). `messageId` = the message selected in the reader. */
export async function getEmailForwardPreview(
  id: string,
  messageId?: string,
): Promise<EmailForwardPreview> {
  const q = messageId ? `?messageId=${encodeURIComponent(messageId)}` : '';
  return request<EmailForwardPreview>(`${API.meEmailThreadForwardPreview(id)}${q}`);
}

/** Compose a new message (ADR 0107). `accountId` omitted = primary Gmail. */
export async function sendEmail(input: EmailSendRequest, sendId?: string): Promise<EmailSendResult> {
  return request<EmailSendResult>(API.meEmailSend, {
    method: 'POST',
    body: JSON.stringify(input),
    headers: sendIdHeaders(sendId),
  });
}
export async function modifyEmailThread(
  id: string,
  patch: EmailModifyRequest,
): Promise<EmailThreadSummary> {
  return request<EmailThreadSummary>(API.meEmailThreadModify(id), {
    method: 'POST',
    body: JSON.stringify(patch),
  });
}

/** AI tile level (ADR 0061). `parent` omitted = root tiles; `deep` nests the
 *  whole subtree into `children` for the one-rectangle map (ADR 0068). */
export async function listEmailTiles(
  parent?: string,
  opts: { deep?: boolean } = {},
): Promise<EmailTileLevel> {
  const qs = new URLSearchParams();
  if (parent) qs.set('parent', parent);
  if (opts.deep) qs.set('deep', '1');
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return withSavedCopy(`email-tiles-${parent ?? 'root'}-${opts.deep ? 'deep' : 'flat'}`, () =>
    conditionalGet<EmailTileLevel>(`${API.meEmailTiles}${suffix}`),
  );
}

/** Open email decisions for the AI shell (ADR 0083). */
export async function listEmailDecisions(): Promise<EmailDecisionsResponse> {
  const res = await withSavedCopy('email-decisions', () =>
    conditionalGet<EmailDecisionsResponse>(API.meEmailDecisions),
  );
  return withoutAnsweredDecisions(res);
}

/** The decisions this phone saved last, for a first paint; null when none. */
export async function readSavedEmailDecisions(): Promise<EmailDecisionsResponse | null> {
  const saved = await readSavedCopy<EmailDecisionsResponse>('email-decisions');
  return saved ? withoutAnsweredDecisions(saved) : null;
}

function withoutAnsweredDecisions(res: EmailDecisionsResponse): EmailDecisionsResponse {
  const answered = pendingAnsweredIds(pendingProposalAnswers());
  return answered.size === 0
    ? res
    : { ...res, decisions: res.decisions.filter((d) => !answered.has(d.proposalId)) };
}

export async function setEmailPrefs(body: SetEmailPrefsRequest): Promise<{ ok: true }> {
  return request(API.meEmailPrefs, { method: 'PUT', body: JSON.stringify(body) });
}

/** ADR 0278 — a mailbox's color ('primary' or an account id); null = default. */
export async function setMailboxColor(
  mailbox: string,
  color: string | null,
): Promise<{ colors: Record<string, string>; picked: Record<string, string> }> {
  return request(API.meEmailMailboxColor, { method: 'PUT', body: JSON.stringify({ mailbox, color }) });
}

/** ADR 0260 addendum - one mailbox's own signature; `useShared` drops it. */
export async function setMailboxSignature(
  body: SetMailboxSignatureRequest,
): Promise<{ mailbox: string; signature: string | null; own: boolean }> {
  return request(API.meEmailMailboxSignature, { method: 'PUT', body: JSON.stringify(body) });
}

/** ADR 0326 - keep a signature picture; answers its public link. */
export async function uploadSignatureImage(data: string): Promise<{ url: string }> {
  return request(API.meEmailSignatureImages, { method: 'POST', body: JSON.stringify({ data }) });
}

export async function getPhoneStatus(): Promise<PhoneStatus> {
  return request<PhoneStatus>(API.mePhone);
}

export async function startPhoneVerification(
  body: StartPhoneVerificationRequest,
): Promise<StartPhoneVerificationResponse> {
  return request(API.mePhoneStart, { method: 'POST', body: JSON.stringify(body) });
}

export async function verifyPhone(body: VerifyPhoneRequest): Promise<PhoneStatus> {
  return request(API.mePhoneVerify, { method: 'POST', body: JSON.stringify(body) });
}

export async function releasePhone(): Promise<PhoneStatus> {
  return request(API.mePhone, { method: 'DELETE' });
}

export async function listContactLinks(): Promise<ResolveContactsResponse> {
  return request<ResolveContactsResponse>(API.meContacts);
}

export async function resolveContacts(
  body: ResolveContactsRequest,
): Promise<ResolveContactsResponse> {
  return request(API.meContactsResolve, { method: 'POST', body: JSON.stringify(body) });
}

/** ADR 0212 - this phone's answer to the bot's `contact.lookup`. */
export async function answerContactLookup(
  requestId: string,
  body: DeviceContactLookupResponse,
): Promise<void> {
  await request<void>(API.meContactLookup(requestId), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function listCalendarSources(): Promise<CalendarSource[]> {
  return request<CalendarSource[]>(API.meCalendarSources);
}

/**
 * ADR 0057 - push a batch of the user's selected device-calendar events
 * (−30/+60 window) up to the Chord DB so web + the bot can see them. Returns
 * the upsert/dedup/delete tallies. Caller (applesync/calendar-pull) builds the
 * batch from EventKit; this is just the transport.
 */
export async function syncDeviceCalendar(
  body: DeviceCalendarSyncRequest,
): Promise<DeviceCalendarSyncResult> {
  return request<DeviceCalendarSyncResult>(API.meDeviceCalendarSync, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** Mirror switched off: the server forgets that phone calendar's copies now. */
export async function forgetDeviceCalendar(
  deviceCalendarId: string,
): Promise<{ events: number; calendar: boolean }> {
  return request<{ events: number; calendar: boolean }>(API.meDeviceCalendar(deviceCalendarId), {
    method: 'DELETE',
  });
}

export async function setCalendarSourceOverride(
  id: string,
  countsForBusyOverride: boolean | null,
): Promise<CalendarSource> {
  return request<CalendarSource>(API.meCalendarSource(id), {
    method: 'PATCH',
    body: JSON.stringify({ countsForBusyOverride }),
  });
}

/** ADR 0278 — a calendar's color in Chord; null goes back to the default. */
export async function setCalendarColor(id: string, colorChoice: string | null): Promise<CalendarSource> {
  return request<CalendarSource>(API.meCalendarSource(id), {
    method: 'PATCH',
    body: JSON.stringify({ colorChoice }),
  });
}

/** ADR 0256 — the calendar new events go on when none is named. */
export async function getDefaultCalendar(): Promise<DefaultCalendar> {
  return request<DefaultCalendar>(API.meDefaultCalendar);
}

/** `null` resets to the primary calendar. */
export async function setDefaultCalendar(calendarId: string | null): Promise<DefaultCalendar> {
  return request<DefaultCalendar>(API.meDefaultCalendar, {
    method: 'PUT',
    body: JSON.stringify({ calendarId }),
  });
}

/** ADR 0298 — the people this user has blocked, newest first. */
export async function listBlockedUsers(): Promise<BlockedUser[]> {
  return request<BlockedUser[]>(API.meBlocks);
}

export async function blockUser(userId: string): Promise<BlockedUser> {
  return request<BlockedUser>(API.meBlocks, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
}

export async function unblockUser(userId: string): Promise<void> {
  await request<void>(API.meBlock(userId), { method: 'DELETE' });
}

/** ADR 0335 — the consent page: one waiting AI-app authorization, and the answer. */
export async function getAiAppRequest(id: string): Promise<AiAppRequestView> {
  return request<AiAppRequestView>(API.meAiAppRequest(id));
}

export async function answerAiAppRequest(id: string, allow: boolean): Promise<AiAppDecisionResult> {
  return request<AiAppDecisionResult>(allow ? API.meAiAppRequestApprove(id) : API.meAiAppRequestDeny(id), {
    method: 'POST',
  });
}

/** ADR 0335 — AI apps connected over MCP (Settings). */
export async function listAiApps(): Promise<ConnectedAiApp[]> {
  return request<ConnectedAiApp[]>(API.meAiApps);
}

export async function disconnectAiApp(id: string): Promise<void> {
  await request<void>(API.meAiApp(id), { method: 'DELETE' });
}

/** ADR 0301 — report a message another member posted in a shared chat. */
export async function reportMessage(messageId: string, reason?: string): Promise<ReportMessageResponse> {
  return request<ReportMessageResponse>(API.meReports, {
    method: 'POST',
    body: JSON.stringify({ messageId, reason }),
  });
}

export async function listImportantDays(): Promise<ImportantDay[]> {
  return request<ImportantDay[]>(API.meImportantDays);
}

// ── people / important dates (manual UI) ─────────────────────────────

export async function listPeople(): Promise<PersonWithDates[]> {
  return withSavedCopy('people', () => request<PersonWithDates[]>(API.mePeople));
}

/** ADR 0078 - staged person/birthday proposals for the People screen. */
export async function listPeoplePending(): Promise<PendingPersonSuggestion[]> {
  return request<PendingPersonSuggestion[]>(API.mePeoplePending);
}

export async function createPerson(body: CreatePersonRequest): Promise<PersonWithDates> {
  return request<PersonWithDates>(API.mePeople, { method: 'POST', body: JSON.stringify(body) });
}

export async function deletePerson(personId: string): Promise<void> {
  await request(API.mePerson(personId), { method: 'DELETE' });
}

export async function addImportantDate(
  personId: string,
  body: AddImportantDateRequest,
): Promise<ImportantDate> {
  return request<ImportantDate>(API.mePersonImportantDates(personId), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function deleteImportantDate(dateId: string): Promise<void> {
  await request(API.meImportantDate(dateId), { method: 'DELETE' });
}

export async function runProactiveScan(): Promise<{ ok: boolean; posted: boolean }> {
  return request(API.devProactiveScan, { method: 'POST' });
}

// ── settings (PR-D) ──────────────────────────────────────────────────

export async function getSettings(): Promise<MeSettings> {
  return request<MeSettings>(API.meSettings);
}

/** `getSettings` for a screen that only reads it; at most one fetch per 30s. */
export function getSettingsCached(): Promise<MeSettings> {
  const now = Date.now();
  if (settingsCache && now - settingsCache.at < SETTINGS_FRESH_MS) return settingsCache.value;
  const entry = { at: now, value: getSettings() };
  settingsCache = entry;
  entry.value.catch(() => {
    if (settingsCache === entry) settingsCache = null;
  });
  return entry.value;
}

/** ADR 0283 — the AI consent decision and who would receive the data. */
export async function getAiConsentStatus(): Promise<AiConsentStatus> {
  return request<AiConsentStatus>(API.meAiConsent);
}

export async function setAiConsent(body: SetAiConsentRequest): Promise<AiConsentStatus> {
  return request<AiConsentStatus>(API.meAiConsent, { method: 'PUT', body: JSON.stringify(body) });
}

export async function setMyName(body: SetMyNameRequest): Promise<User> {
  return request<User>(API.meName, { method: 'PUT', body: JSON.stringify(body) });
}

// ADR 0063/0075 - billing status + Stripe checkout.
export async function getBilling(): Promise<BillingStatus> {
  return request<BillingStatus>(API.meBilling);
}

// ADR 0195 - which subscription: the system-key plan, or the BYOK base plan.
// `platform: 'native'` tells the server to deep-link the success/cancel
// redirect back into the app (`chord://settings?checkout=…`) instead of the
// web `${WEB_ORIGIN}/settings?checkout=…` route.
export async function createBillingCheckout(
  plan: SubscriptionPlan,
  platform: 'web' | 'native' = 'web',
  opts: { interval?: BillingInterval; code?: string } = {},
): Promise<CheckoutSessionResponse> {
  return request<CheckoutSessionResponse>(API.meBillingCheckout, {
    method: 'POST',
    body: JSON.stringify({ plan, platform, interval: opts.interval, code: opts.code?.trim() || undefined }),
  });
}

/** ADR 0231 — Stripe's hosted page to change plan / card / cancel. */
export async function createBillingPortal(platform: 'web' | 'native' = 'web'): Promise<BillingPortalResponse> {
  return request<BillingPortalResponse>(API.meBillingPortal, {
    method: 'POST',
    body: JSON.stringify({ platform }),
  });
}

/** ADR 0236 - one-click cancel: `renew: false` stops renewal at the end of the
 *  paid period (the plan works until then), `renew: true` undoes it. */
export async function setBillingRenewal(renew: boolean): Promise<SetRenewalResponse> {
  return request<SetRenewalResponse>(API.meBillingRenewal, {
    method: 'POST',
    body: JSON.stringify({ renew }),
  });
}

/** ADR 0236 - switch the live Stripe subscription to another plan/interval in
 *  place. Charges (or credits) the difference now and resumes a cancelled one. */
export async function changeBillingPlan(
  plan: 'system' | 'family',
  interval: BillingInterval,
): Promise<ChangePlanResponse> {
  return request<ChangePlanResponse>(API.meBillingPlan, {
    method: 'POST',
    body: JSON.stringify({ plan, interval }),
  });
}

// ── family plan (ADR 0231) ───────────────────────────────────────────

export const getFamily = () => request<FamilyOverview>(API.meFamily);

export const addFamilyMember = (body: AddFamilyMemberRequest) =>
  request<FamilyInviteResult | { member: FamilyMember }>(API.meFamily, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export const updateFamilyMember = (id: string, body: UpdateFamilyMemberRequest) =>
  request<FamilyMember>(API.meFamilyMember(id), { method: 'PATCH', body: JSON.stringify(body) });

export const removeFamilyMember = (id: string) =>
  request<void>(API.meFamilyMember(id), { method: 'DELETE' });

export const inviteFamilyMember = (id: string) =>
  request<FamilyInviteResult>(API.meFamilyInvite(id), { method: 'POST' });

export const acceptFamilyInvite = (code: string) =>
  request<{ ownerName: string; groupId: string }>(API.meFamilyAccept, {
    method: 'POST',
    body: JSON.stringify({ code }),
  });

/** ADR 0234 - post an email thread into the family chat (no `groupId`) or a
 *  group the caller is in. */
export const shareEmailThreadToGroup = (threadId: string, body: ShareEmailToGroupRequest = {}) =>
  request<ShareEmailToGroupResult>(API.meEmailThreadShare(threadId), {
    method: 'POST',
    body: JSON.stringify(body),
  });

export const leaveFamily = () => request<void>(API.meFamilyLeave, { method: 'POST' });

export async function setModelKey(args: {
  provider: ModelProvider;
  apiKey: string;
  model: string;
  baseUrl?: string;
}): Promise<{ ok: true }> {
  const body: SetModelKeyRequest = args;
  return request(API.meModelKey, { method: 'PUT', body: JSON.stringify(body) });
}

/** ADR 0235 - get the OpenRouter sign-in URL; the server stores the key when the
 *  browser comes back, so the app never sees it. */
export async function startOpenRouterConnect(
  body: StartOpenRouterConnectRequest,
): Promise<StartOpenRouterConnectResult> {
  return request(API.meOpenRouterStart, { method: 'POST', body: JSON.stringify(body) });
}

export async function clearModelKey(): Promise<{ ok: true }> {
  return request(API.meModelKey, { method: 'DELETE' });
}

export async function setNudge(body: SetNudgeRequest): Promise<{ ok: true }> {
  return request(API.meNudge, { method: 'PUT', body: JSON.stringify(body) });
}

/** ADR 0091 — set (or clear, with an empty string) the briefing's weather
 *  location. Returns the RESOLVED place, which is what Settings displays. */
export async function setWeatherLocation(
  place: string,
): Promise<{ place: string | null; source: 'device' | 'ip' | 'tz' | 'user' | null }> {
  return request(API.meWeatherLocation, {
    method: 'PUT',
    body: JSON.stringify({ place }),
  });
}

/** ADR 0258 - the phone's approximate location, sent only after the user allowed it. */
export async function reportDeviceLocation(fix: {
  lat: number;
  lon: number;
  place?: string;
}): Promise<{ ok: true; applied: boolean; place: string | null }> {
  return request(API.meLocation, { method: 'PUT', body: JSON.stringify(fix) });
}

/** ADR 0258 - the user turned location off; the server forgets the fix. */
export async function stopDeviceLocation(): Promise<{ ok: true }> {
  return request(API.meLocation, { method: 'DELETE' });
}

/** ADR 0091 — mute/unmute the briefing on one external channel. */
export async function setBriefingChannelMuted(
  id: string,
  optedOut: boolean,
): Promise<{ ok: true }> {
  return request(API.meBriefingChannel(id), {
    method: 'PUT',
    body: JSON.stringify({ optedOut }),
  });
}

export async function setTimezone(
  body: SetTimezoneRequest,
): Promise<{ ok: true; changed: boolean }> {
  return request(API.meTimezone, { method: 'PUT', body: JSON.stringify(body) });
}

export async function registerPushToken(
  body: RegisterPushTokenRequest,
): Promise<{ ok: true }> {
  return request(API.mePushToken, { method: 'POST', body: JSON.stringify(body) });
}

export async function unregisterPushToken(
  body: UnregisterPushTokenRequest = {},
): Promise<{ ok: true }> {
  return request(API.mePushToken, { method: 'DELETE', body: JSON.stringify(body) });
}

export async function setNotificationPrefs(
  body: SetNotificationPrefsRequest,
): Promise<{ ok: true }> {
  return request(API.meNotificationPrefs, { method: 'PUT', body: JSON.stringify(body) });
}

export async function setGroupMuted(
  groupId: string,
  muted: boolean,
): Promise<{ ok: true; muted: boolean }> {
  const body: SetGroupMutedRequest = { muted };
  return request(API.groupNotifications(groupId), {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function resetDemo(): Promise<{ ok: boolean; tablesWiped: number }> {
  return request(API.demoReset, { method: 'POST' });
}

// ── trust + permission requests ──────────────────────────────────────

export async function listTrustGrants(): Promise<TrustGrant[]> {
  const r = await request<TrustGrantsResponse>(API.meTrust);
  return r.grants;
}

export async function listTrustCandidates(): Promise<TrustCandidate[]> {
  const r = await request<TrustCandidatesResponse>(API.meTrustCandidates);
  return r.candidates;
}

export async function setTrustGrant(
  senderUserId: string,
  scopes: TrustScope[],
): Promise<TrustGrant | null> {
  const r = await request<{ grant: TrustGrant | null }>(API.meTrust, {
    method: 'POST',
    body: JSON.stringify({ senderUserId, scopes }),
  });
  return r.grant;
}

export async function revokeTrustGrant(senderUserId: string): Promise<void> {
  await request(API.meTrustSender(senderUserId), { method: 'DELETE' });
}

export async function listPermissionRequests(): Promise<PermissionRequestsResponse> {
  return request<PermissionRequestsResponse>(API.mePermissionRequests);
}

export async function respondToPermissionRequest(
  id: string,
  decision: 'approve' | 'deny',
): Promise<PermissionRequest> {
  const r = await request<{ request: PermissionRequest }>(
    API.mePermissionRequestRespond(id),
    { method: 'POST', body: JSON.stringify({ decision }) },
  );
  return r.request;
}

// ── groups ───────────────────────────────────────────────────────────

export async function listGroups(): Promise<Group[]> {
  return withSavedCopy('groups', () => request<Group[]>(API.groups));
}

export async function createGroup(body: CreateGroupRequest): Promise<Group> {
  return request<Group>(API.groups, { method: 'POST', body: JSON.stringify(body) });
}

export async function joinGroup(body: JoinGroupRequest): Promise<Group> {
  return request<Group>(API.groupJoin, { method: 'POST', body: JSON.stringify(body) });
}

/** ADR 0318 - invite someone to chat by email address. */
export async function inviteByEmail(body: InviteByEmailRequest): Promise<InviteByEmailResponse> {
  return request<InviteByEmailResponse>(API.chatInviteByEmail, { method: 'POST', body: JSON.stringify(body) });
}

export async function listChatInvites(): Promise<ChatInvite[]> {
  return request<ChatInvite[]>(API.meChatInvites);
}

export async function answerChatInvite(id: string, accept: boolean): Promise<{ groupId: string | null }> {
  return request<{ groupId: string | null }>(
    accept ? API.meChatInviteAccept(id) : API.meChatInviteDecline(id),
    { method: 'POST', body: '{}' },
  );
}

/**
 * Absolute web base for invite links. The link always points at the web app
 * (native `https://` deep-linking into the app needs Apple App-Site-Association
 * / Android App Links verification we don't ship yet - see ADR 0047). Resolved
 * so it is *never* a bare relative `/join/...`:
 *  1. web → the live origin (dev / preview / prod work with zero config);
 *  2. native → EXPO_PUBLIC_WEB_BASE when configured;
 *  3. native dev → the Expo dev-server host, which serves the web app from the
 *     same Metro instance, so `http://<hostUri>` is a valid `/join` target;
 *  4. last resort → localhost on the Expo web port.
 */
function webBase(): string {
  const origin =
    typeof window !== 'undefined' ? window.location?.origin : undefined;
  if (origin) return origin.replace(/\/$/, '');
  const fromEnv = process.env.EXPO_PUBLIC_WEB_BASE?.replace(/\/$/, '');
  if (fromEnv) return fromEnv;
  const hostUri = Constants.expoConfig?.hostUri?.replace(/\/$/, '');
  if (hostUri) return `http://${hostUri}`;
  return 'http://127.0.0.1:8081';
}

/**
 * A shareable, clickable invite link for a group: `<web-base>/join/<CODE>`.
 */
export function inviteUrl(code: string): string {
  return `${webBase()}/join/${code}`;
}

/** ADR 0241 - the web app's Settings page: where billing is managed from an iPhone. */
export function webSettingsUrl(): string {
  return `${webBase()}/settings`;
}

export async function getGroup(id: string): Promise<Group> {
  return request<Group>(API.group(id));
}

export async function markGroupRead(
  id: string,
): Promise<{ ok: boolean; lastReadAt: string }> {
  return request<{ ok: boolean; lastReadAt: string }>(API.groupRead(id), {
    method: 'POST',
    body: '{}',
  });
}

export async function updateGroup(
  id: string,
  body: UpdateGroupRequest,
): Promise<Group> {
  return request<Group>(API.group(id), {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function listGroupMembers(id: string): Promise<GroupMember[]> {
  return request<GroupMember[]>(`${API.group(id)}/members`);
}

/** Delete a group and all its content (owner-only; ADR 0045). Irreversible. */
export async function deleteGroup(id: string): Promise<void> {
  await request<void>(API.group(id), { method: 'DELETE' });
}

/**
 * Leave a group (ADR 0045). If the caller was the owner, ownership transfers
 * to the earliest-joined remaining member; if they were the only member, the
 * group is deleted.
 */
export async function leaveGroup(
  id: string,
): Promise<{ ok: boolean; deleted: boolean; newOwnerId?: string }> {
  return request<{ ok: boolean; deleted: boolean; newOwnerId?: string }>(API.groupLeave(id), {
    method: 'POST',
    body: '{}',
  });
}

/** Rotate a group's invite code (owner-only; ADR 0045). The old code stops working. */
export async function regenerateInviteCode(id: string): Promise<{ inviteCode: string }> {
  return request<{ inviteCode: string }>(API.groupInviteRegenerate(id), {
    method: 'POST',
    body: '{}',
  });
}

export async function listGroupFiles(groupId: string): Promise<Attachment[]> {
  return request<Attachment[]>(API.groupFiles(groupId));
}

export async function listAllFiles(): Promise<Attachment[]> {
  return request<Attachment[]>(API.meFiles);
}

export async function deleteFile(attachmentId: string): Promise<void> {
  await request<void>(API.attachment(attachmentId), { method: 'DELETE' });
}

// ── connectors ───────────────────────────────────────────────────────

export async function getGroupConnectors(
  groupId: string,
): Promise<GroupConnectorsResponse> {
  return request<GroupConnectorsResponse>(API.groupConnectors(groupId));
}

export async function getMeConnectors(): Promise<MeConnectorsResponse> {
  return request<MeConnectorsResponse>(API.meConnectors);
}

export async function startPairing(
  groupId: string,
  body: StartPairingRequest,
): Promise<StartPairingResponse> {
  return request<StartPairingResponse>(API.groupConnectorPair(groupId), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function getPairingStatus(
  groupId: string,
  code: string,
): Promise<PairingStatusResponse> {
  return request<PairingStatusResponse>(
    API.groupConnectorPairStatus(groupId, code),
  );
}

export async function unbindConnector(
  groupId: string,
  binding: { platform: ConnectorPlatform; externalChannelId: string },
): Promise<void> {
  await request<void>(
    API.groupConnectorBinding(groupId, binding.platform, binding.externalChannelId),
    { method: 'DELETE' },
  );
}

export async function cancelPairing(
  groupId: string,
  code: string,
): Promise<void> {
  await request<void>(
    API.groupConnectorPairStatus(groupId, code),
    { method: 'DELETE' },
  );
}

export async function renameBinding(
  groupId: string,
  binding: { platform: ConnectorPlatform; externalChannelId: string },
  alias: string,
): Promise<void> {
  await request<void>(
    API.groupConnectorBinding(groupId, binding.platform, binding.externalChannelId),
    { method: 'PATCH', body: JSON.stringify({ alias }) },
  );
}

export type { ConnectorBinding, GroupConnectorsResponse } from '@chord/kernel';

/**
 * Cross-platform Image source for an attachment. On web, fetches the
 * blob with auth and returns a `blob:` URL (caller must revoke). On
 * native (iOS/Android), returns `{ uri, headers }` so React Native's
 * `<Image>` can include the session header on its own fetch - no blob
 * needed. The shape matches what `<Image source={...}>` accepts on
 * either platform.
 */
export async function attachmentImageSource(
  id: string,
): Promise<{ uri: string; headers?: Record<string, string>; cleanup?: () => void }> {
  if (Platform.OS === 'web') {
    const uri = await fetchAttachmentBlobUrl(id);
    return { uri, cleanup: () => URL.revokeObjectURL(uri) };
  }
  return {
    uri: `${API_BASE}${API.attachment(id)}`,
    headers: await authHeaders(),
  };
}

/**
 * Web-only: fetch the attachment with auth and return a `blob:` URL suitable
 * for `window.open(...)`. Caller is responsible for revoking the URL after
 * use (recommend ~60s later so the new tab has time to load it).
 */
export async function fetchAttachmentBlobUrl(id: string): Promise<string> {
  return URL.createObjectURL(await fetchAuthedBlob(API.attachment(id)));
}

/**
 * Native (iOS/Android): a `blob:`/`window.open` flow has no equivalent, and
 * the bare URL isn't openable because the binary needs the session header.
 * So download the attachment to the cache (header rides along) and hand the
 * local file to the OS share/preview sheet - Quick Look on iOS, the app
 * chooser on Android - which is how a PDF actually opens in a reader.
 */
export async function openAttachmentNative(att: {
  id: string;
  filename: string;
  mimeType?: string;
}): Promise<void> {
  const safeName = viewerFileName(att.filename.replace(/[^\w.-]+/g, '_') || `file-${att.id}`, fileFormat(att.mimeType, att.filename));
  const target = await downloadTarget(`${att.id}-${safeName}`);
  const { status, uri } = await FileSystem.downloadAsync(
    `${API_BASE}${API.attachment(att.id)}`,
    target,
    { headers: await authHeaders() },
  );
  if (status !== 200) throw new Error(`Download failed (${status})`);
  await presentDownloadedFile(uri, safeName, att.mimeType);
}

// ── search (ADR 0062) ────────────────────────────────────────────────

// ── messages ─────────────────────────────────────────────────────────

export async function listMessages(groupId: string, opts?: { before?: string; limit?: number }): Promise<Message[]> {
  const qs = new URLSearchParams();
  if (opts?.before) qs.set('before', opts.before);
  if (opts?.limit) qs.set('limit', String(opts.limit));
  const path = `${API.groupMessages(groupId)}${qs.toString() ? `?${qs}` : ''}`;
  return request<Message[]>(path);
}

export async function deleteMessages(
  groupId: string,
  body: DeleteMessagesRequest,
): Promise<DeleteMessagesResponse> {
  return request<DeleteMessagesResponse>(API.groupMessagesDelete(groupId), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function postMessage(
  groupId: string,
  body: PostMessageRequest,
  sendId?: string,
): Promise<Message> {
  return request<Message>(API.groupMessages(groupId), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: sendIdHeaders(sendId),
  });
}

// ── files ────────────────────────────────────────────────────────────

export interface UploadInput {
  uri: string;
  name: string;
  mimeType?: string;
  /** On web, this is the File/Blob object itself. */
  file?: Blob;
}

export async function uploadFile(
  groupId: string,
  input: UploadInput,
): Promise<Attachment> {
  const form = new FormData();
  if (input.file) {
    form.append('file', input.file, input.name);
  } else {
    // React Native: FormData accepts { uri, name, type } objects
    form.append('file', {
      uri: input.uri,
      name: input.name,
      type: input.mimeType ?? 'application/octet-stream',
    } as unknown as Blob);
  }
  // Negate: getTimezoneOffset() is positive for west-of-UTC (EST = +300 → send -300)
  form.append('timezoneOffset', String(-new Date().getTimezoneOffset()));
  const token = await getToken();
  const res = await apiFetch(`${API_BASE}${API.groupFiles(groupId)}`, {
    method: 'POST',
    headers: token ? { [SESSION_HEADER]: token } : undefined,
    body: form,
    credentials: 'include',
  }, { long: true });
  if (!res.ok) throw await errorFromResponse(res);
  return (await res.json()) as Attachment;
}

/** ADR 0013 testability: trigger an immediate morning scan. DEMO_MODE only. */
export async function runDevProactiveScan(): Promise<void> {
  await request<void>(API.devProactiveScan, { method: 'POST' });
}

// ── tasks / lists / saves / events / personal ───────────────────────

export async function listAllTasks(): Promise<Task[]> {
  return request<Task[]>(API.meTasks);
}
export async function createTask(groupId: string, body: CreateTaskRequest): Promise<Task> {
  return request<Task>(API.groupTasks(groupId), { method: 'POST', body: JSON.stringify(body) });
}
export async function updateTask(taskId: string, patch: UpdateTaskRequest): Promise<Task> {
  return request<Task>(API.task(taskId), { method: 'PATCH', body: JSON.stringify(patch) });
}
export async function deleteTask(taskId: string): Promise<void> {
  await request<void>(API.task(taskId), { method: 'DELETE' });
}

export async function listAllLists(): Promise<Array<List & { items: ListItem[] }>> {
  return request<Array<List & { items: ListItem[] }>>(API.meLists);
}

export async function createList(groupId: string, name: string): Promise<List> {
  return request<List>(API.groupLists(groupId), { method: 'POST', body: JSON.stringify({ name }) });
}
export async function addListItem(listId: string, text: string): Promise<ListItem> {
  return request<ListItem>(API.listItems(listId), { method: 'POST', body: JSON.stringify({ text }) });
}
export async function setListItemChecked(itemId: string, checked: boolean): Promise<ListItem> {
  return request<ListItem>(API.listItem(itemId), { method: 'PATCH', body: JSON.stringify({ checked }) });
}
export async function updateListItemText(itemId: string, text: string): Promise<ListItem> {
  return request<ListItem>(API.listItem(itemId), { method: 'PATCH', body: JSON.stringify({ text }) });
}
export async function deleteList(listId: string): Promise<void> {
  await request<void>(API.list(listId), { method: 'DELETE' });
}
/**
 * `merged` is set when the new name collided with an existing list and the two
 * were folded together (ADR 0094) — the returned list is then the SURVIVOR,
 * which may be a different row than `listId`, and the caller must refetch
 * rather than patch a cached row.
 */
export async function renameList(
  listId: string,
  name: string,
): Promise<List & { merged?: { removedListId: string; removedName: string; movedItems: number } | null }> {
  return request(API.list(listId), { method: 'PATCH', body: JSON.stringify({ name }) });
}
/** Every item becomes a save tagged with the list's name; the list is deleted
 *  (ADR 0290). */
export async function moveListToSaves(
  listId: string,
  kind: MovableSaveKind = 'place',
): Promise<MoveListToSavesResult> {
  return request(API.listMoveToSaves(listId), { method: 'POST', body: JSON.stringify({ kind }) });
}
export async function deleteListItem(itemId: string): Promise<void> {
  await request<void>(API.listItem(itemId), { method: 'DELETE' });
}

export async function listAllSaves(): Promise<Save[]> {
  return request<Save[]>(API.meSaves);
}

export async function deleteSave(saveId: string): Promise<void> {
  await request(API.save(saveId), { method: 'DELETE' });
}

export async function updateSave(saveId: string, patch: UpdateSaveRequest): Promise<Save> {
  return request<Save>(API.save(saveId), { method: 'PATCH', body: JSON.stringify(patch) });
}

export async function createSave(groupId: string, body: CreateSaveRequest): Promise<Save> {
  return request<Save>(API.groupSaves(groupId), { method: 'POST', body: JSON.stringify(body) });
}

export async function listAllEvents(futureDays?: number, pastDays?: number): Promise<GroupEvent[]> {
  // futureDays widens the server's Google fetch window past the default 90d
  // so far-future months reflect Google-side adds/deletes as the user scrolls.
  // pastDays is how far back the list reaches - the server returns a date
  // window, not the whole history, so a calendar paged into past months must
  // say so.
  const params = new URLSearchParams();
  if (futureDays) params.set('futureDays', String(Math.trunc(futureDays)));
  if (pastDays != null) params.set('pastDays', String(Math.ceil(pastDays)));
  const qs = params.toString();
  return request<GroupEvent[]>(qs ? `${API.meEvents}?${qs}` : API.meEvents);
}

/** Which of these event ids still exist (the device-calendar delete reconcile). */
export async function liveEventIds(ids: string[]): Promise<Set<string>> {
  const live = new Set<string>();
  for (let i = 0; i < ids.length; i += 2000) {
    const body: LiveEventIdsRequest = { ids: ids.slice(i, i + 2000) };
    const r = await request<LiveEventIdsResponse>(API.meEventsLive, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    for (const id of r.live) live.add(id);
  }
  return live;
}

export async function deleteEvent(eventId: string): Promise<void> {
  await request<void>(API.event(eventId), { method: 'DELETE' });
}
/** ADR 0040 partial edit - drives the two-way Google push on synced events. */
export async function updateEvent(
  eventId: string,
  patch: {
    title?: string;
    location?: string | null;
    startsAt?: string;
    endsAt?: string | null;
    timeZone?: string;
  },
): Promise<GroupEvent> {
  return request<GroupEvent>(API.event(eventId), {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

/** ADR 0157 addendum - the event's guests, read from its calendar. */
export async function getEventGuests(eventId: string): Promise<EventGuestsResponse> {
  return request<EventGuestsResponse>(API.eventGuests(eventId));
}

/** Same calendar write as the bot's update_event invitees (ADR 0295). */
export async function changeEventGuests(
  eventId: string,
  change: { add?: string[]; remove?: string[] },
): Promise<EventGuestsResponse> {
  return request<EventGuestsResponse>(API.eventGuests(eventId), {
    method: 'POST',
    body: JSON.stringify(change),
  });
}

/** ADR 0328 - answer an invitation to a family member's event; same
 *  service as the bot's answer_invitation. */
export async function answerEventInvite(
  eventId: string,
  response: 'accepted' | 'tentative' | 'declined',
): Promise<EventAnswerResponse> {
  return request<EventAnswerResponse>(API.eventAnswer(eventId), {
    method: 'POST',
    body: JSON.stringify({ response }),
  });
}

/** ADR 0317 - same calendar write as the bot's videoCall. */
export async function addEventVideoCall(eventId: string): Promise<EventVideoCallResponse> {
  return request<EventVideoCallResponse>(API.eventVideoCall(eventId), { method: 'POST' });
}

export async function listAllMemories(): Promise<Memory[]> {
  return request<Memory[]>(API.meMemories);
}

export async function confirmMemory(memoryId: string): Promise<Memory> {
  return request<Memory>(API.memoryConfirm(memoryId), { method: 'POST' });
}

export async function rejectMemory(memoryId: string): Promise<void> {
  await request(API.memoryReject(memoryId), { method: 'POST' });
}

// ── Family profile (design doc family-profile-design.md) ──────────────

export async function getGroupProfile(groupId: string): Promise<FamilyProfile> {
  return request<FamilyProfile>(API.groupProfile(groupId));
}

export async function createGroupPersona(
  groupId: string,
  body: CreatePersonaRequest,
): Promise<Persona> {
  return request<Persona>(API.groupPersonas(groupId), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updatePersona(id: string, body: UpdatePersonaRequest): Promise<Persona> {
  return request<Persona>(API.persona(id), { method: 'PATCH', body: JSON.stringify(body) });
}

export async function deletePersona(id: string): Promise<void> {
  await request(API.persona(id), { method: 'DELETE' });
}

export async function sharePersonToGroup(
  groupId: string,
  fromPersonId: string,
): Promise<PromotePersonResult> {
  return request<PromotePersonResult>(API.groupPersonasPromote(groupId), {
    method: 'POST',
    body: JSON.stringify({ fromPersonId }),
  });
}

export async function createFact(groupId: string, body: CreateFactRequest): Promise<Memory> {
  return request<Memory>(`/api/v1/groups/${groupId}/facts`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateFact(id: string, body: UpdateFactRequest): Promise<Memory> {
  return request<Memory>(API.fact(id), { method: 'PATCH', body: JSON.stringify(body) });
}

export async function deleteFact(id: string): Promise<void> {
  await request(API.fact(id), { method: 'DELETE' });
}

export async function listProposalsForGroup(groupId: string): Promise<Proposal[]> {
  return request<Proposal[]>(API.groupProposals(groupId));
}

export async function listAllProposals(): Promise<Proposal[]> {
  const xs = await withSavedCopy('proposals', () => request<Proposal[]>(API.meProposals));
  return applyPendingProposalAnswers(xs, pendingProposalAnswers());
}

/**
 * ADR 0311 addendum - ✓/✕ answers still waiting in the send queue, applied to
 * every read of suggestions. Registered by the queue's module, which imports
 * this one.
 */
let pendingProposalAnswers: () => readonly PendingProposalAnswer[] = () => [];

export function setPendingProposalAnswers(fn: () => readonly PendingProposalAnswer[]): void {
  pendingProposalAnswers = fn;
}

/**
 * `target` routes the confirmed item into one or more of the user's groups
 * (ADR 0097). Omitted, it lands wherever the proposal was staged — the model
 * no longer picks a destination, so this is the only way an email-derived
 * suggestion reaches a shared group without a standing routing rule.
 */
export async function confirmProposal(
  proposalId: string,
  target?: string | string[],
  calendarId?: string | null,
  sendId?: string,
  replaceEventId?: string | null,
  /** ADR 0348 — the card's "Also send invitations" box was ticked. */
  sendInvites?: boolean,
): Promise<{ proposal: Proposal; summary: string; routeSuggestion?: RouteSuggestion }> {
  // ADR 0247 — several groups: each gets its own copy and its own fan-out.
  const ids = target === undefined ? [] : Array.isArray(target) ? target : [target];
  const body = {
    ...(ids.length > 1 ? { targetGroupIds: ids } : ids.length === 1 ? { targetGroupId: ids[0] } : {}),
    // ADR 0312 — the calendar picked on the card for an email event.
    ...(calendarId ? { calendarId } : {}),
    // ADR 0343 — "Move it": move this existing event instead of adding one.
    ...(replaceEventId ? { replaceEventId } : {}),
    ...(sendInvites ? { sendInvites: true } : {}),
  };
  return request(API.proposalConfirm(proposalId), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: sendIdHeaders(sendId),
  });
}

export async function rejectProposal(proposalId: string, sendId?: string): Promise<void> {
  await request(API.proposalReject(proposalId), { method: 'POST', headers: sendIdHeaders(sendId) });
}

/**
 * Answer a calendar invitation (ADR 0104). Not a flavour of confirm: the
 * answer goes to the organizer first, and only then is anything recorded here
 * — so a decline resolves the suggestion without creating an event, and a
 * failure leaves it pending rather than implying a reply was sent.
 */
export async function rsvpProposal(
  proposalId: string,
  response: RsvpProposalRequest['response'],
): Promise<RsvpResultDto> {
  return request<RsvpResultDto>(API.proposalRsvp(proposalId), {
    method: 'POST',
    body: JSON.stringify({ response }),
  });
}

export async function listTripStatuses(): Promise<TripStatus[]> {
  return request<TripStatus[]>(API.meTrips);
}

export async function deleteTrip(groupId: string, tripId: string): Promise<void> {
  await request<void>(API.groupTrip(groupId, tripId), { method: 'DELETE' });
}

export async function restoreTrip(groupId: string, tripId: string): Promise<TripStatus['trip']> {
  return request<TripStatus['trip']>(API.groupTripRestore(groupId, tripId), { method: 'POST' });
}

export async function updateTrip(
  groupId: string,
  tripId: string,
  patch: { name?: string; destination?: string; startDate?: string; endDate?: string },
): Promise<TripStatus['trip']> {
  return request<TripStatus['trip']>(API.groupTrip(groupId, tripId), {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function mergeTrips(
  groupId: string,
  keepTripId: string,
  mergeTripId: string,
): Promise<TripStatus> {
  return request<TripStatus>(API.groupTripMerge(groupId, keepTripId), {
    method: 'POST',
    body: JSON.stringify({ mergeTripId }),
  });
}

export async function unmergeTrips(
  groupId: string,
  keepTripId: string,
  undo: {
    mergeTripId: string;
    legIds: string[];
    accommodationIds: string[];
    reservationIds: string[];
    keepStartDate: string;
    keepEndDate: string;
  },
): Promise<{ keep: TripStatus; restored: TripStatus }> {
  return request<{ keep: TripStatus; restored: TripStatus }>(API.groupTripUnmerge(groupId, keepTripId), {
    method: 'POST',
    body: JSON.stringify(undo),
  });
}

export async function removeTravelLeg(groupId: string, tripId: string, legId: string): Promise<void> {
  await request<void>(API.groupTripLeg(groupId, tripId, legId), { method: 'DELETE' });
}

export async function removeAccommodation(groupId: string, tripId: string, accomId: string): Promise<void> {
  await request<void>(API.groupTripAccommodation(groupId, tripId, accomId), { method: 'DELETE' });
}

/** Move a single leg onto a different trip (Trips tab per-row drag). */
export async function moveTravelLeg(
  groupId: string,
  tripId: string,
  legId: string,
  targetTripId: string,
): Promise<TravelLeg> {
  return request<TravelLeg>(API.groupTripLegMove(groupId, tripId, legId), {
    method: 'POST',
    body: JSON.stringify({ targetTripId }),
  });
}

export async function moveAccommodation(
  groupId: string,
  tripId: string,
  accomId: string,
  targetTripId: string,
): Promise<Accommodation> {
  return request<Accommodation>(API.groupTripAccommodationMove(groupId, tripId, accomId), {
    method: 'POST',
    body: JSON.stringify({ targetTripId }),
  });
}

// ── SSE ──────────────────────────────────────────────────────────────

export interface StreamHandle {
  close: () => void;
}

export interface StreamHandlers {
  onMessage?: (m: Message) => void;
  onMessagesDeleted?: (e: { groupId: string; ids: string[] }) => void;
  /** @deprecated ADR 0022 - server no longer streams tokens. */
  onBotToken?: (messageId: string, delta: string) => void;
  onBotDone?: (messageId: string) => void;
  onBotStart?: (e: BotStartEvent) => void;
  onBotReceipt?: (e: BotReceiptEvent) => void;
  onBotSaveOffer?: (o: BotSaveOffer) => void;
  onBotCard?: (p: BotCardPayload) => void;
  onBotTool?: (e: BotToolEvent) => void;
  onBotSources?: (e: BotSourcesEvent) => void;
  onMemoryCreated?: (m: Memory) => void;
  onMemoryProposed?: (m: Memory) => void;
  onMemoryResolved?: (e: { id: string; status: 'confirmed' | 'rejected' }) => void;
  onProposalCreated?: (p: Proposal) => void;
  onProposalResolved?: (e: ProposalResolvedEvent) => void;
  onConnectorBound?: (e: ConnectorBoundEvent) => void;
  onConnectorUnbound?: (e: ConnectorUnboundEvent) => void;
  onConnectorRenamed?: (e: ConnectorRenamedEvent) => void;
  onGroupRenamed?: (e: { groupId: string; name: string }) => void;
  /** A member (possibly this user on another device) marked the group read. */
  onGroupRead?: (e: GroupReadEvent) => void;
  onResourceChanged?: () => void;
  onIngestProgress?: (e: IngestProgressEvent) => void;
  onIngestDone?: (e: IngestDoneEvent) => void;
  onError?: (err: unknown) => void;
  onOpen?: () => void;
  /**
   * Fires when the server sent an explicit `stream.end` before closing -
   * i.e. a clean end-of-stream (graceful shutdown, auth loss, etc.).
   * The stream is already closed; `onError` will NOT also fire.
   */
  onEnd?: (reason: StreamEndReason) => void;
}

const RETRY_BASE_MS = 3000;
const RETRY_MAX_MS = 60_000;
/** A connection that lived this long was working; its drop is a normal blip. */
const STABLE_MS = 10_000;

interface BackoffTarget {
  interval: number;
  addEventListener: (t: string, f: (ev: unknown) => void) => void;
}

/**
 * Exponential backoff for react-native-sse's reconnect. The library re-polls on
 * a FIXED `pollingInterval` with no ceiling, so an outage becomes a 20-req/min
 * retry storm for as long as the screen lives. It reads `interval` fresh on
 * every re-poll, so widening it in place gives us backoff without replacing the
 * library's reconnect driver - which we must keep: a clean server-side close
 * re-polls silently without dispatching `error`, so a hand-rolled driver would
 * miss that case entirely and the stream would die unnoticed.
 */
function attachBackoff(es: BackoffTarget): void {
  let openedAt = 0;
  es.addEventListener('open', () => {
    openedAt = Date.now();
  });
  es.addEventListener('error', () => {
    const wasStable = openedAt > 0 && Date.now() - openedAt >= STABLE_MS;
    es.interval = wasStable ? RETRY_BASE_MS : Math.min(es.interval * 2, RETRY_MAX_MS);
    openedAt = 0;
    noteStreamError();
  });
}

const STREAM_CHECK_GAP_MS = 15_000;
let lastStreamCheckAt = 0;

/**
 * A dropped stream may be the network going (ADR 0311): one check, and if the
 * server is gone every stream parks instead of re-polling.
 */
function noteStreamError(): void {
  const now = Date.now();
  if (now - lastStreamCheckAt < STREAM_CHECK_GAP_MS) return;
  lastStreamCheckAt = now;
  void checkConnection();
}

type ManagedStream = StreamSupervisor<StreamHandle>;

/**
 * Live streams, tracked so they can be torn down while the app is backgrounded.
 *
 * iOS grants Chord no background execution (there are no `UIBackgroundModes` in
 * app.json, deliberately). A stream left open is therefore not a stream that
 * keeps working - it is an outstanding network task that forces the OS to
 * resume the process on every 25s server ping, all night, plus a reconnect
 * timer that retries forever when the backgrounded socket dies. Push
 * notifications are the background delivery path; SSE has no job to do when
 * nothing is on screen.
 */
const liveStreams = new Set<ManagedStream>();
let streamsForegrounded = true;
let appStateSub: { remove: () => void } | null = null;

/** In front and the server reachable: offline parks streams exactly like background (ADR 0311). */
function streamsAllowed(): boolean {
  return streamsForegrounded && isOnline();
}

function parkStreams(): void {
  for (const s of liveStreams) s.park();
}

let networkWatched = false;

function watchNetwork(): void {
  if (networkWatched) return;
  networkWatched = true;
  onNetworkChange((online) => {
    if (!online) parkStreams();
    else if (streamsForegrounded) for (const s of liveStreams) void resumeStream(s);
  });
}

function watchAppState(): void {
  if (appStateSub) return;
  streamsForegrounded = AppState.currentState !== 'background';
  appStateSub = AppState.addEventListener('change', (state) => {
    // 'inactive' is transient (app switcher, Control Centre, a call banner) -
    // tearing down there would churn every stream on a glance. Only a real
    // background transition closes.
    if (state === 'background') {
      streamsForegrounded = false;
      parkStreams();
    } else if (state === 'active' && !streamsForegrounded) {
      streamsForegrounded = true;
      if (isOnline()) for (const s of liveStreams) void resumeStream(s);
    }
  });
}

function resumeStream(s: ManagedStream): Promise<void> {
  return s.resume();
}

/**
 * Wrap a stream opener so the connection follows the app's foreground state
 * and the network (ADR 0311), and comes back when the server ends it for a
 * reason that is not a refusal (a deploy's `shutdown`, a browser EventSource
 * that gave up on a 502) - see kernel `StreamSupervisor`. The returned
 * handle's `close()` unregisters for good; backgrounding or going offline only
 * parks it. Reopening re-runs the opener, so callers reconnect with a fresh
 * token and re-fire their `onOpen` backfill.
 */
async function manageStream(
  reopen: (t: StreamTransportHooks) => Promise<StreamHandle>,
): Promise<StreamHandle> {
  watchNetwork();
  // Browsers throttle hidden tabs on their own; the foreground half exists for
  // the iOS process lifecycle. Offline applies everywhere: EventSource would
  // otherwise reconnect every few seconds for as long as the page is open.
  if (Platform.OS !== 'web') watchAppState();
  const s: ManagedStream = new StreamSupervisor<StreamHandle>({
    open: reopen,
    allowed: streamsAllowed,
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  });
  liveStreams.add(s);
  try {
    // A first-open failure reaches the caller (screens surface it). A stream
    // that never opened has no handle to close, so it leaves the set here.
    await s.start();
  } catch (e) {
    liveStreams.delete(s);
    throw e;
  }
  return {
    close: () => {
      liveStreams.delete(s);
      s.close();
    },
  };
}

/**
 * Opens an SSE stream for a group. Uses the browser EventSource on web (auth
 * via cookie) and react-native-sse on native (auth via token header). The
 * connection is parked while the app is backgrounded - see `manageStream`.
 */
export async function openGroupStream(
  groupId: string,
  h: StreamHandlers,
  currentUserId?: string,
): Promise<StreamHandle> {
  return manageStream((t) => openGroupStreamOnce(groupId, h, currentUserId, t));
}

async function openGroupStreamOnce(
  groupId: string,
  h: StreamHandlers,
  currentUserId?: string,
  t?: StreamTransportHooks,
): Promise<StreamHandle> {
  const url = `${API_BASE}${API.groupStream(groupId)}`;
  // Prime the device-sync gate: if this user has Google connected, the events
  // below already reach their device via the OS, so we must not write them too.
  void primeCalendarStatus().catch(() => {});
  const parse = <T>(data: unknown): T | null => {
    if (typeof data !== 'string') return null;
    try {
      return JSON.parse(data) as T;
    } catch (err) {
      h.onError?.(err);
      return null;
    }
  };
  const handleMessage = (ev: { data?: unknown }) => {
    const m = parse<Message>(ev.data);
    if (m) h.onMessage?.(m);
  };
  const handleMessagesDeleted = (ev: { data?: unknown }) => {
    const e = parse<{ groupId: string; ids: string[] }>(ev.data);
    if (e) h.onMessagesDeleted?.(e);
  };
  const handleBotToken = (ev: { data?: unknown }) => {
    const d = parse<{ messageId: string; delta: string }>(ev.data);
    if (d) h.onBotToken?.(d.messageId, d.delta);
  };
  const handleBotDone = (ev: { data?: unknown }) => {
    const d = parse<{ messageId: string }>(ev.data);
    if (d) h.onBotDone?.(d.messageId);
  };
  const handleBotReceipt = (ev: { data?: unknown }) => {
    const e = parse<BotReceiptEvent>(ev.data);
    if (e) h.onBotReceipt?.(e);
  };
  const handleBotStart = (ev: { data?: unknown }) => {
    const e = parse<BotStartEvent>(ev.data);
    if (e) h.onBotStart?.(e);
  };
  const handleMemoryCreated = (ev: { data?: unknown }) => {
    const m = parse<Memory>(ev.data);
    if (m) h.onMemoryCreated?.(m);
  };
  const handleMemoryProposed = (ev: { data?: unknown }) => {
    const m = parse<Memory>(ev.data);
    if (m) h.onMemoryProposed?.(m);
  };
  const handleMemoryResolved = (ev: { data?: unknown }) => {
    const e = parse<{ id: string; status: 'confirmed' | 'rejected' }>(ev.data);
    if (e) h.onMemoryResolved?.(e);
  };
  const handleProposalCreated = (ev: { data?: unknown }) => {
    const p = parse<Proposal>(ev.data);
    if (p) h.onProposalCreated?.(p);
  };
  const handleProposalResolved = (ev: { data?: unknown }) => {
    const e = parse<ProposalResolvedEvent>(ev.data);
    if (e) h.onProposalResolved?.(e);
  };
  const handleConnectorBound = (ev: { data?: unknown }) => {
    const e = parse<ConnectorBoundEvent>(ev.data);
    if (e) h.onConnectorBound?.(e);
  };
  const handleConnectorUnbound = (ev: { data?: unknown }) => {
    const e = parse<ConnectorUnboundEvent>(ev.data);
    if (e) h.onConnectorUnbound?.(e);
  };
  const handleConnectorRenamed = (ev: { data?: unknown }) => {
    const e = parse<ConnectorRenamedEvent>(ev.data);
    if (e) h.onConnectorRenamed?.(e);
  };
  const handleGroupRenamed = (ev: { data?: unknown }) => {
    const e = parse<{ groupId: string; name: string }>(ev.data);
    if (e) h.onGroupRenamed?.(e);
  };
  const handleGroupRead = (ev: { data?: unknown }) => {
    const e = parse<GroupReadEvent>(ev.data);
    if (e) h.onGroupRead?.(e);
  };
  const handleSaveOffer = (ev: { data?: unknown }) => {
    const o = parse<BotSaveOffer>(ev.data);
    if (o) h.onBotSaveOffer?.(o);
  };
  const handleBotCard = (ev: { data?: unknown }) => {
    const p = parse<BotCardPayload>(ev.data);
    if (p) h.onBotCard?.(p);
  };
  const handleBotTool = (ev: { data?: unknown }) => {
    const e = parse<BotToolEvent>(ev.data);
    if (e) h.onBotTool?.(e);
  };
  const handleBotSources = (ev: { data?: unknown }) => {
    const e = parse<BotSourcesEvent>(ev.data);
    if (e) h.onBotSources?.(e);
  };
  const handleResourceChanged = () => {
    h.onResourceChanged?.();
  };
  // ADR 0012: device-calendar sync (now a no-Google fallback - see ADR 0015/0040
  // and calendar.ts). Skipped internally when Google sync is active. Fires on
  // every SSE delivery; the calendar service dedupes by event/trip id. Errors
  // here (permissions, read-only iOS sources, locked DB) must never surface as
  // unhandled promise rejections - swallow them.
  // ADR 0040 - fan-out delivers one owner-tagged copy per member on the group
  // channel. Sync ONLY the recipient's own copy to their device calendar (else
  // every member would write every member's copy); the list itself refreshes
  // for everyone via onResourceChanged (the group endpoint is owner-scoped).
  // A copy with no ownerUserId (legacy / single-copy event) always syncs.
  const ownsCopy = (e: GroupEvent): boolean =>
    !e.ownerUserId || !currentUserId || e.ownerUserId === currentUserId;
  const handleEventCreated = (ev: { data?: unknown }) => {
    const e = parse<GroupEvent>(ev.data);
    if (e && ownsCopy(e)) {
      syncEventToCalendar(e).catch(() => {});
    }
    h.onResourceChanged?.();
  };
  const handleEventUpdated = (ev: { data?: unknown }) => {
    const e = parse<GroupEvent>(ev.data);
    if (e && ownsCopy(e)) {
      syncEventToCalendar(e).catch(() => {});
    }
    h.onResourceChanged?.();
  };
  // ADR 0057 - drop the device copy when our own event copy is deleted. Payload
  // is { id, ownerUserId } (events.ts); act only on this user's copy.
  const handleEventDeleted = (ev: { data?: unknown }) => {
    const e = parse<{ id?: string; ownerUserId?: string }>(ev.data);
    if (e?.id && (!e.ownerUserId || !currentUserId || e.ownerUserId === currentUserId)) {
      removeEventFromCalendar(e.id).catch(() => {});
    }
    h.onResourceChanged?.();
  };
  const handleTripUpdated = (ev: { data?: unknown }) => {
    const t = parse<Trip>(ev.data);
    if (t) {
      syncTripToCalendar(t).catch(() => {});
    }
    h.onResourceChanged?.();
  };
  const handleIngestProgress = (ev: { data?: unknown }) => {
    const e = parse<IngestProgressEvent>(ev.data);
    if (e) h.onIngestProgress?.(e);
  };
  // ADR 0212 - the personal chat's channel, or a shared chat's for an event
  // invitee (ADR 0157 addendum), where `forUserId` names whose phone answers.
  const handleContactLookup = (ev: { data?: unknown }) => {
    const e = parse<DeviceContactLookupRequest>(ev.data);
    if (e) handleDeviceContactLookup(e, currentUserId);
  };
  const handleIngestDone = (ev: { data?: unknown }) => {
    const e = parse<IngestDoneEvent>(ev.data);
    if (e) h.onIngestDone?.(e);
  };

  // Flipped to true when the server sends `stream.end`. Any subsequent
  // `error` event is the byproduct of our own `.close()` and must be
  // swallowed so callers don't treat a clean EOS as a broken connection.
  let ended = false;

  if (Platform.OS === 'web' && typeof EventSource !== 'undefined') {
    // EventSource can't set custom headers; the session cookie rides along (`withCredentials` for an API on
    // another origin). The token never goes in the URL.
    const es = new EventSource(url, { withCredentials: true });
    es.addEventListener('error', noteStreamError);
    es.addEventListener('open', () => {
      t?.opened();
      h.onOpen?.();
    });
    es.addEventListener('message', handleMessage);
    es.addEventListener('messages.deleted', handleMessagesDeleted as EventListener);
    es.addEventListener('bot.token', handleBotToken as EventListener);
    es.addEventListener('bot.start', handleBotStart as EventListener);
    es.addEventListener('bot.done', handleBotDone as EventListener);
    es.addEventListener('bot.receipt', handleBotReceipt as EventListener);
    es.addEventListener('bot.save-offer', handleSaveOffer as EventListener);
    es.addEventListener('bot.card', handleBotCard as EventListener);
    es.addEventListener('bot.tool', handleBotTool as EventListener);
    es.addEventListener('bot.sources', handleBotSources as EventListener);
    es.addEventListener('memory.created', handleMemoryCreated as EventListener);
    es.addEventListener('memory.proposed', handleMemoryProposed as EventListener);
    es.addEventListener('memory.resolved', handleMemoryResolved as EventListener);
    es.addEventListener('proposal.created', handleProposalCreated as EventListener);
    es.addEventListener('proposal.resolved', handleProposalResolved as EventListener);
    es.addEventListener('connector.bound', handleConnectorBound as EventListener);
    es.addEventListener('connector.unbound', handleConnectorUnbound as EventListener);
    es.addEventListener('connector.renamed', handleConnectorRenamed as EventListener);
    es.addEventListener('group.renamed', handleGroupRenamed as EventListener);
    es.addEventListener('group.read', handleGroupRead as EventListener);
    es.addEventListener('task.created', handleResourceChanged as EventListener);
    es.addEventListener('task.updated', handleResourceChanged as EventListener);
    es.addEventListener('list.updated', handleResourceChanged as EventListener);
    es.addEventListener('save.added', handleResourceChanged as EventListener);
    es.addEventListener('event.created', handleEventCreated as EventListener);
    es.addEventListener('event.updated', handleEventUpdated as EventListener);
    es.addEventListener('event.deleted', handleEventDeleted as EventListener);
    es.addEventListener('rsvp.updated', handleResourceChanged as EventListener);
    es.addEventListener('trip.updated', handleTripUpdated as EventListener);
    es.addEventListener('trip.deleted', handleResourceChanged as EventListener);
    es.addEventListener('travel_leg.created', handleResourceChanged as EventListener);
    es.addEventListener('accommodation.created', handleResourceChanged as EventListener);
    es.addEventListener('reservation.created', handleResourceChanged as EventListener);
    es.addEventListener('ingest.progress', handleIngestProgress as EventListener);
    es.addEventListener('ingest.done', handleIngestDone as EventListener);
    es.addEventListener('stream.end', ((ev: MessageEvent) => {
      const d = parse<StreamEndEvent>(ev.data);
      ended = true;
      es.close();
      const reason = d?.reason ?? 'shutdown';
      t?.ended(reason);
      h.onEnd?.(reason);
    }) as EventListener);
    es.addEventListener('error', (ev) => {
      if (ended) return;
      h.onError?.(ev);
      // A non-200 answer (a 502 while the server restarts) closes an
      // EventSource for good; it does not retry on its own.
      if (es.readyState === EventSource.CLOSED) {
        ended = true;
        t?.ended('closed');
      }
    });
    return {
      close: () => {
        ended = true;
        es.close();
      },
    };
  }

  const RNEventSource = (await import('react-native-sse')).default;
  const token = await getToken();
  const es = new RNEventSource(url, {
    headers: token ? { [SESSION_HEADER]: token } : undefined,
    // Retry interval after disconnect. Browsers reconnect automatically via
    // spec'd EventSource behavior; RN needs us to ask for it.
    pollingInterval: RETRY_BASE_MS,
  });
  attachBackoff(es as unknown as BackoffTarget);
  es.addEventListener('open', () => {
    t?.opened();
    h.onOpen?.();
  });
  es.addEventListener('message', handleMessage as (ev: unknown) => void);
  const rnAddEvent = (es as unknown as {
    addEventListener: (t: string, f: (ev: unknown) => void) => void;
  });
  rnAddEvent.addEventListener('messages.deleted', handleMessagesDeleted as (ev: unknown) => void);
  rnAddEvent.addEventListener('bot.token', handleBotToken as (ev: unknown) => void);
  rnAddEvent.addEventListener('bot.start', handleBotStart as (ev: unknown) => void);
  rnAddEvent.addEventListener('bot.done', handleBotDone as (ev: unknown) => void);
  rnAddEvent.addEventListener('bot.receipt', handleBotReceipt as (ev: unknown) => void);
  rnAddEvent.addEventListener('bot.save-offer', handleSaveOffer as (ev: unknown) => void);
  rnAddEvent.addEventListener('bot.card', handleBotCard as (ev: unknown) => void);
  rnAddEvent.addEventListener('bot.tool', handleBotTool as (ev: unknown) => void);
  rnAddEvent.addEventListener('bot.sources', handleBotSources as (ev: unknown) => void);
  rnAddEvent.addEventListener('memory.created', handleMemoryCreated as (ev: unknown) => void);
  rnAddEvent.addEventListener('memory.proposed', handleMemoryProposed as (ev: unknown) => void);
  rnAddEvent.addEventListener('memory.resolved', handleMemoryResolved as (ev: unknown) => void);
  rnAddEvent.addEventListener('proposal.created', handleProposalCreated as (ev: unknown) => void);
  rnAddEvent.addEventListener('proposal.resolved', handleProposalResolved as (ev: unknown) => void);
  rnAddEvent.addEventListener('connector.bound', handleConnectorBound as (ev: unknown) => void);
  rnAddEvent.addEventListener('connector.unbound', handleConnectorUnbound as (ev: unknown) => void);
  rnAddEvent.addEventListener('connector.renamed', handleConnectorRenamed as (ev: unknown) => void);
  rnAddEvent.addEventListener('group.renamed', handleGroupRenamed as (ev: unknown) => void);
  rnAddEvent.addEventListener('group.read', handleGroupRead as (ev: unknown) => void);
  rnAddEvent.addEventListener('task.created', handleResourceChanged as (ev: unknown) => void);
  rnAddEvent.addEventListener('task.updated', handleResourceChanged as (ev: unknown) => void);
  rnAddEvent.addEventListener('list.updated', handleResourceChanged as (ev: unknown) => void);
  rnAddEvent.addEventListener('save.added', handleResourceChanged as (ev: unknown) => void);
  rnAddEvent.addEventListener('event.created', handleEventCreated as (ev: unknown) => void);
  rnAddEvent.addEventListener('event.updated', handleEventUpdated as (ev: unknown) => void);
  rnAddEvent.addEventListener('event.deleted', handleEventDeleted as (ev: unknown) => void);
  rnAddEvent.addEventListener('rsvp.updated', handleResourceChanged as (ev: unknown) => void);
  rnAddEvent.addEventListener('trip.updated', handleTripUpdated as (ev: unknown) => void);
  rnAddEvent.addEventListener('trip.deleted', handleResourceChanged as (ev: unknown) => void);
  rnAddEvent.addEventListener('travel_leg.created', handleResourceChanged as (ev: unknown) => void);
  rnAddEvent.addEventListener('accommodation.created', handleResourceChanged as (ev: unknown) => void);
  rnAddEvent.addEventListener('reservation.created', handleResourceChanged as (ev: unknown) => void);
  rnAddEvent.addEventListener('ingest.progress', handleIngestProgress as (ev: unknown) => void);
  rnAddEvent.addEventListener('ingest.done', handleIngestDone as (ev: unknown) => void);
  rnAddEvent.addEventListener('contact.lookup', handleContactLookup as (ev: unknown) => void);
  rnAddEvent.addEventListener('stream.end', ((ev: { data?: unknown }) => {
    const d = parse<StreamEndEvent>(ev.data);
    ended = true;
    es.close();
    const reason = d?.reason ?? 'shutdown';
    t?.ended(reason);
    h.onEnd?.(reason);
  }) as (ev: unknown) => void);
  es.addEventListener('error', (ev: unknown) => {
    if (ended) return;
    h.onError?.(ev);
  });
  return {
    close: () => {
      ended = true;
      es.close();
    },
  };
}

export interface UserStreamHandlers {
  onEmailSynced?: (r: EmailSyncResult) => void;
  onEmailThreadUpdated?: (e: EmailThreadUpdatedEvent) => void;
  onEmailTilesUpdated?: (e: { userId: string }) => void;
  /** ADR 0105 - a To Do's entity changed in one of the user's groups. */
  onTodosChanged?: (e: { groupId: string }) => void;
  onError?: (err: unknown) => void;
  onOpen?: () => void;
  onEnd?: (reason: StreamEndReason) => void;
}

/**
 * Opens the user-scoped SSE stream (`GET /me/stream`) for email.* live updates.
 * Separate from group streams so email events never ride a chat channel. Parked
 * while the app is backgrounded - see `manageStream`.
 */
export async function openUserStream(h: UserStreamHandlers): Promise<StreamHandle> {
  userStreamSubs.add(h);
  if (userStreamConnected) {
    // Joining a live connection: this subscriber's open-time backfill runs as
    // if it had opened the socket itself.
    queueMicrotask(() => {
      if (userStreamSubs.has(h)) h.onOpen?.();
    });
  }
  if (!userStreamShared) {
    const shared = manageStream((t) => {
      userStreamConnected = false;
      return openUserStreamOnce(userStreamFanout, t);
    });
    userStreamShared = shared;
    shared.catch(() => {
      if (userStreamShared === shared) userStreamShared = null;
    });
  }
  try {
    await userStreamShared;
  } catch (e) {
    userStreamSubs.delete(h);
    throw e;
  }
  let released = false;
  return {
    close: () => {
      if (released) return;
      released = true;
      userStreamSubs.delete(h);
      if (userStreamSubs.size === 0) dropSharedUserStream();
    },
  };
}

/**
 * One `/me/stream` socket per app, shared by every screen that wants it (the
 * Email tab alone had two open at once). Each subscriber still gets every
 * event and its own `onOpen`; the socket closes when the last one leaves.
 */
const userStreamSubs = new Set<UserStreamHandlers>();
let userStreamShared: Promise<StreamHandle> | null = null;
let userStreamConnected = false;

function dropSharedUserStream(): void {
  const shared = userStreamShared;
  userStreamShared = null;
  userStreamConnected = false;
  void shared?.then((s) => s.close()).catch(() => {});
}

const userStreamFanout: UserStreamHandlers = {
  onEmailSynced: (r) => userStreamSubs.forEach((s) => s.onEmailSynced?.(r)),
  onEmailThreadUpdated: (e) => userStreamSubs.forEach((s) => s.onEmailThreadUpdated?.(e)),
  onEmailTilesUpdated: (e) => userStreamSubs.forEach((s) => s.onEmailTilesUpdated?.(e)),
  onTodosChanged: (e) => userStreamSubs.forEach((s) => s.onTodosChanged?.(e)),
  onError: (err) => {
    userStreamConnected = false;
    userStreamSubs.forEach((s) => s.onError?.(err));
  },
  onOpen: () => {
    userStreamConnected = true;
    userStreamSubs.forEach((s) => s.onOpen?.());
  },
  onEnd: (reason) => {
    const subs = [...userStreamSubs];
    // A deploy's `shutdown` is not the end: `manageStream` reopens the shared
    // socket and every subscriber's `onOpen` backfill runs again. A refusal
    // is final; the next subscriber opens anew.
    if (streamEndIsFinal(reason)) dropSharedUserStream();
    else userStreamConnected = false;
    subs.forEach((s) => s.onEnd?.(reason));
  },
};

async function openUserStreamOnce(
  h: UserStreamHandlers,
  t?: StreamTransportHooks,
): Promise<StreamHandle> {
  const url = `${API_BASE}${API.meStream}`;
  const parse = <T>(data: unknown): T | null => {
    if (typeof data !== 'string') return null;
    try {
      return JSON.parse(data) as T;
    } catch (err) {
      h.onError?.(err);
      return null;
    }
  };
  const handleSynced = (ev: { data?: unknown }) => {
    const r = parse<EmailSyncResult>(ev.data);
    if (r) h.onEmailSynced?.(r);
  };
  const handleThread = (ev: { data?: unknown }) => {
    const e = parse<EmailThreadUpdatedEvent>(ev.data);
    if (e) h.onEmailThreadUpdated?.(e);
  };
  const handleTiles = (ev: { data?: unknown }) => {
    const e = parse<{ userId: string }>(ev.data);
    if (e) h.onEmailTilesUpdated?.(e);
  };

  const handleTodos = (ev: { data?: unknown }) => {
    const e = parse<{ groupId: string }>(ev.data);
    if (e) h.onTodosChanged?.(e);
  };

  let ended = false;

  if (Platform.OS === 'web' && typeof EventSource !== 'undefined') {
    // The session cookie rides along (`withCredentials` for an API on
    // another origin). The token never goes in the URL.
    const es = new EventSource(url, { withCredentials: true });
    es.addEventListener('error', noteStreamError);
    es.addEventListener('open', () => {
      t?.opened();
      h.onOpen?.();
    });
    es.addEventListener('email.synced', handleSynced as EventListener);
    es.addEventListener('email.thread.updated', handleThread as EventListener);
    es.addEventListener('email.tiles.updated', handleTiles as EventListener);
    es.addEventListener('todos.changed', handleTodos as EventListener);
    es.addEventListener('stream.end', ((ev: MessageEvent) => {
      const d = parse<StreamEndEvent>(ev.data);
      ended = true;
      es.close();
      const reason = d?.reason ?? 'shutdown';
      t?.ended(reason);
      h.onEnd?.(reason);
    }) as EventListener);
    es.addEventListener('error', (ev) => {
      if (ended) return;
      h.onError?.(ev);
      // A non-200 answer (a 502 while the server restarts) closes an
      // EventSource for good; it does not retry on its own.
      if (es.readyState === EventSource.CLOSED) {
        ended = true;
        t?.ended('closed');
      }
    });
    return {
      close: () => {
        ended = true;
        es.close();
      },
    };
  }

  const RNEventSource = (await import('react-native-sse')).default;
  const token = await getToken();
  const es = new RNEventSource(url, {
    headers: token ? { [SESSION_HEADER]: token } : undefined,
    pollingInterval: RETRY_BASE_MS,
  });
  attachBackoff(es as unknown as BackoffTarget);
  es.addEventListener('open', () => {
    t?.opened();
    h.onOpen?.();
  });
  const rnAddEvent = es as unknown as {
    addEventListener: (t: string, f: (ev: unknown) => void) => void;
  };
  rnAddEvent.addEventListener('email.synced', handleSynced as (ev: unknown) => void);
  rnAddEvent.addEventListener('email.thread.updated', handleThread as (ev: unknown) => void);
  rnAddEvent.addEventListener('email.tiles.updated', handleTiles as (ev: unknown) => void);
  rnAddEvent.addEventListener('todos.changed', handleTodos as (ev: unknown) => void);
  rnAddEvent.addEventListener('stream.end', ((ev: { data?: unknown }) => {
    const d = parse<StreamEndEvent>(ev.data);
    ended = true;
    es.close();
    const reason = d?.reason ?? 'shutdown';
    t?.ended(reason);
    h.onEnd?.(reason);
  }) as (ev: unknown) => void);
  es.addEventListener('error', (ev: unknown) => {
    if (ended) return;
    h.onError?.(ev);
  });
  return {
    close: () => {
      ended = true;
      es.close();
    },
  };
}
