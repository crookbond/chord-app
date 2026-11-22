import { z } from 'zod';
import type { UserId, IsoDateTime } from './ids';
import { MAILBOX_NICKNAME_MAX } from '../mailbox-name';

export interface User {
  id: UserId;
  username: string;
  /** Full name (e.g. "John Doe"). Shown in rosters and event assignees. */
  displayName?: string;
  firstName?: string;
  lastName?: string;
  /** What the user wants to be called; takes precedence in direct address. */
  preferredName?: string;
  email?: string;
  createdAt: IsoDateTime;
}

/**
 * Name to greet / directly address the user by: preferred name, else first
 * name, else the first word of the full display name, else username.
 */
export function greetingName(
  user: Pick<User, 'username' | 'displayName' | 'firstName' | 'preferredName'>,
): string {
  const preferred = user.preferredName?.trim();
  if (preferred) return preferred;
  const first = user.firstName?.trim();
  if (first) return first;
  const fromDisplay = user.displayName?.trim().split(/\s+/)[0];
  if (fromDisplay) return fromDisplay;
  return user.username;
}

/**
 * The name to put on a person in a roster or a two-person chat: their full
 * name, not what you'd greet them by. `greetingName` answers "what do I call
 * you" (preferred name, first name); this answers "who is this".
 */
export function fullName(
  user: Pick<User, 'username' | 'displayName' | 'firstName' | 'lastName'>,
): string {
  const display = user.displayName?.trim();
  if (display) return display;
  const parts = [user.firstName?.trim(), user.lastName?.trim()].filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  return user.username;
}

export const GoogleAuthRequest = z.object({
  code: z.string().min(1),
  codeVerifier: z.string().min(1),
  redirectUri: z.string().min(1),
  /**
   * Optional UUID-style referrer token from a TG welcome-DM link. When
   * present and valid, the server soft-links this Telegram identity to
   * the newly-signed-in user, bypassing the pair-code paste step (ADR
   * 0031). Silently ignored if unknown / expired / already-consumed.
   */
  signupRef: z.string().trim().min(8).max(64).optional(),
});
export type GoogleAuthRequest = z.infer<typeof GoogleAuthRequest>;

/**
 * Sign in with Apple, native iOS (ADR 0156). Only the single-use
 * authorization code is trusted — the server exchanges it at Apple. Apple
 * hands the user's name to the device on the FIRST authorization only and
 * never puts it in a token, so the app forwards it here when it has it.
 */
export const AppleAuthRequest = z.object({
  authorizationCode: z.string().min(1).max(4096),
  givenName: z.string().trim().max(80).optional(),
  familyName: z.string().trim().max(80).optional(),
  signupRef: z.string().trim().min(8).max(64).optional(),
  /** Which Apple client issued the code. Omitted = the iOS app. A code is
   *  only redeemable by the client it was issued to. */
  client: z.enum(['ios', 'web']).optional(),
});
export type AppleAuthRequest = z.infer<typeof AppleAuthRequest>;

/**
 * Sign in with Microsoft (ADR 0293): the PKCE code from the same Microsoft
 * consent the Outlook mailbox connect uses, so one grant both signs the person
 * in and attaches their mailbox.
 */
export const MicrosoftAuthRequest = z.object({
  code: z.string().min(1).max(4096),
  codeVerifier: z.string().min(1).max(256),
  redirectUri: z.string().min(1).max(2048),
  signupRef: z.string().trim().min(8).max(64).optional(),
});
export type MicrosoftAuthRequest = z.infer<typeof MicrosoftAuthRequest>;

/** ADR 0345 - the app-review account's own sign-in (Play / App Review). */
export const ReviewAuthRequest = z.object({
  email: z.string().trim().min(3).max(320),
  password: z.string().min(1).max(256),
});
export type ReviewAuthRequest = z.infer<typeof ReviewAuthRequest>;

/**
 * Consume a welcome-DM referrer token for the *already signed-in* user
 * (ADR 0031 / 0053). The fresh-sign-in path carries `signupRef` on
 * `authGoogle`; a returning user who clicks the welcome link is already
 * authenticated and never re-runs OAuth, so this endpoint links their
 * external identity (Telegram ref / WhatsApp taster shadow) to the
 * current session instead. Best-effort: unknown/expired/consumed tokens
 * resolve with `linked: false`.
 */
export const LinkSignupRefRequest = z.object({
  signupRef: z.string().trim().min(8).max(64),
});
export type LinkSignupRefRequest = z.infer<typeof LinkSignupRefRequest>;

export const UsernameSchema = z
  .string()
  .trim()
  .min(2, 'Username must be at least 2 characters')
  .max(32, 'Username too long')
  .regex(/^[a-zA-Z0-9_.-]+$/, 'Only letters, numbers, _ . - allowed');

export const CreateSessionRequest = z.object({
  username: UsernameSchema,
  displayName: z.string().trim().max(64).optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequest>;

export interface SessionResponse {
  user: User;
  token: string;
}

/**
 * Incremental Google consent (calendar / Gmail). `user` is present only when
 * the consent re-pointed the session to the account that already held this
 * Google identity (ADR 0156) — the same token now answers as that user.
 */
export interface GoogleConsentResponse {
  ok: boolean;
  scopes: string;
  user?: User;
}

// ─── Settings (ADR 0018 + PR-D) ───────────────────────────────────────

export const ListeningMode = z.enum(['invocation', 'passive', 'active']);
export type ListeningMode = z.infer<typeof ListeningMode>;

export const ModelProvider = z.enum(['openai', 'gemini', 'anthropic']);
export type ModelProvider = z.infer<typeof ModelProvider>;

export interface MeSettings {
  listeningMode: ListeningMode;
  modelProvider: ModelProvider | null;
  modelName: string | null;
  /** Optional OpenAI-compatible base URL override. Null when unset. */
  modelBaseUrl: string | null;
  /** True if a key is stored — the key itself is never returned. */
  hasModelKey: boolean;
  /** ADR 0253 - the E.164 number Chord answers on WhatsApp; null = not offered. */
  whatsappNumber?: string | null;
  /**
   * Snapshot of the deploy-wide LLM config from server `.env`. Mobile
   * surfaces this so the user can tell whether system-config is
   * available before deciding whether they need to BYO. Null when no
   * provider is set on the server (LLM_PROVIDER='', no API keys).
   */
  systemLlm: {
    provider: 'openai' | 'gemini' | 'anthropic' | 'mock';
    model: string;
    /** Non-default base URL — present only when not the provider's standard endpoint. */
    baseUrl: string | null;
  } | null;
  /**
   * Daily morning-briefing ("nudge") schedule. The proactive scan fires at
   * `nudgeHour:nudgeMinute` in the user's local timezone. When
   * `nudgeEnabled` is false, no daily scan is seeded or rescheduled.
   * Defaults: 07:00, enabled.
   */
  nudgeHour: number;
  nudgeMinute: number;
  nudgeEnabled: boolean;
  /**
   * Push-notification preferences (account-level; apply to every device with a
   * registered token — ADR 0054). Per-category toggles plus a quiet-hours
   * window. Quiet hours suppresses `notifyMessages` + `notifyBot` only; the
   * daily briefing has its own schedule (`nudge*`) and is exempt.
   */
  notifyMessages: boolean;
  /** New mail (ADR 0117). Its own switch, because wanting chat on your
   *  phone and mail not is an ordinary preference. */
  notifyEmail: boolean;
  notifyBot: boolean;
  notifyBriefing: boolean;
  quietEnabled: boolean;
  quietStartHour: number;
  quietStartMinute: number;
  quietEndHour: number;
  quietEndMinute: number;
  /**
   * Email insights digest after the morning briefing (ADR 0063). Defaults on;
   * independent of `nudgeEnabled` / `notifyBriefing`.
   */
  emailDigestEnabled: boolean;
  /**
   * When true, Chord creates/applies `Chord/<category>` Gmail labels after
   * classification. Defaults off. Manual "Apply label" in the thread UI ignores this.
   */
  gmailSyncLabelsEnabled: boolean;
  /**
   * ADR 0142 — push user-chosen Chord labels to primary Gmail. Defaults off.
   * Distinct from `gmailSyncLabelsEnabled` (tile → Gmail label sync).
   */
  chordLabelPushEnabled: boolean;
  /**
   * Load remote images in email without asking (ADR 0136). Defaults on; they
   * are fetched by Chord rather than by the device either way. Off restores
   * ADR 0120's per-sender banner.
   */
  emailImagesAuto: boolean;
  /** ADR 0215 - what swiping an email row does. Defaults to archive. */
  emailSwipeAction: EmailSwipeAction;
  /** ADR 0218 - after archive/Trash in the reader. Defaults to the next email. */
  emailAfterRemove: EmailAfterRemove;
  /**
   * Plain-text signature appended to outbound email replies (after an
   * "-- " separator). Null = none. Edited in Settings.
   */
  emailSignature: string | null;
  /** ADR 0260 - the same signature as cleaned HTML, when it is a rich one. */
  emailSignatureHtml?: string | null;
  /**
   * ADR 0260 addendum - a mailbox's own signature, keyed 'primary' or an
   * account id. A mailbox not listed uses `emailSignature`.
   */
  mailboxSignatures?: Record<string, { text: string | null; html: string | null }>;
  /**
   * ADR 0091 — where the briefing's weather line is measured. `weatherPlace`
   * is the RESOLVED name, not the raw input, so a wrong automatic guess is
   * visible and correctable. Source: 'ip' and 'tz' are automatic, 'user' is an
   * explicit choice and is never overwritten. Null when weather is disabled or
   * nothing has resolved yet.
   */
  weatherPlace: string | null;
  weatherPlaceSource: 'device' | 'ip' | 'tz' | 'user' | null;
  /**
   * ADR 0091 — external channels this user's briefing is mirrored to, and
   * whether it is muted on each. ADR 0089's `n-` button sets `optedOut` with
   * no in-app way back; this is that affordance.
   */
  briefingChannels: BriefingChannel[];
}

export interface BriefingChannel {
  /** `group_external_channels.id`. */
  id: string;
  platform: string;
  groupName: string;
  optedOut: boolean;
}

export const SetWeatherLocationRequest = z.object({
  /** Free-text place name. Empty clears the override and lets the automatic
   *  tiers take over again. */
  place: z.string().max(200),
});
export type SetWeatherLocationRequest = z.infer<typeof SetWeatherLocationRequest>;

/** ADR 0258 - an approximate fix from the phone or browser, sent only after the user allowed it. */
export const SetDeviceLocationRequest = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  /** The device's own reverse-geocoded name, when it has one. */
  place: z.string().max(120).optional(),
});
export type SetDeviceLocationRequest = z.infer<typeof SetDeviceLocationRequest>;

export const SetBriefingChannelRequest = z.object({ optedOut: z.boolean() });
export type SetBriefingChannelRequest = z.infer<typeof SetBriefingChannelRequest>;

export const SetListeningModeRequest = z.object({ mode: ListeningMode });
export type SetListeningModeRequest = z.infer<typeof SetListeningModeRequest>;

// Empty string clears the field (back to null); omitted leaves it unchanged.
const nameField = z.string().trim().max(80).optional();
export const SetMyNameRequest = z
  .object({
    firstName: nameField,
    lastName: nameField,
    preferredName: nameField,
  })
  .refine((v) => Object.keys(v).length > 0, 'provide at least one field');
export type SetMyNameRequest = z.infer<typeof SetMyNameRequest>;

export const SetModelKeyRequest = z.object({
  provider: ModelProvider,
  apiKey: z.string().trim().min(1).max(512),
  model: z.string().trim().min(1).max(120),
  /** Optional OpenAI-compatible base URL (Ollama, vLLM, OpenRouter, …). */
  baseUrl: z.string().trim().url().max(2048).optional(),
});
export type SetModelKeyRequest = z.infer<typeof SetModelKeyRequest>;

/** ADR 0235 - `POST /me/model-key/openrouter/start`. `platform` decides where
 *  the browser lands afterwards; `model` is only set when the user edited it,
 *  otherwise the server picks the model the app itself runs on. */
export const StartOpenRouterConnectRequest = z.object({
  platform: z.enum(['web', 'native']).default('web'),
  model: z.string().trim().min(1).max(120).optional(),
});
export type StartOpenRouterConnectRequest = z.infer<typeof StartOpenRouterConnectRequest>;

export interface StartOpenRouterConnectResult {
  /** Open this in a browser. */
  url: string;
  /** The model the key will be set up on. */
  model: string;
}

/** Query parameter the return redirect carries: `ok` | `needs_credit` | `error`. */
export const BYOK_RETURN_PARAM = 'byok';

// Daily morning-briefing schedule. All fields optional so callers can patch
// just the time, just the enabled flag, or both; refine requires at least one.
export const SetNudgeRequest = z
  .object({
    hour: z.number().int().min(0).max(23).optional(),
    minute: z.number().int().min(0).max(59).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'provide at least one field');
export type SetNudgeRequest = z.infer<typeof SetNudgeRequest>;

// The device's current IANA zone. Reported on launch and on every foreground
// so a traveller's briefing follows them — posting a chat message is no longer
// the only way the server learns where the user is.
export const SetTimezoneRequest = z.object({
  tz: z.string().trim().min(1).max(64),
});
export type SetTimezoneRequest = z.infer<typeof SetTimezoneRequest>;

// Device push-notification registration (Expo push tokens). Presence of a
// token is the per-device enable signal — there is no separate flag. The
// Settings toggle registers on enable and unregisters on disable / logout.
export const RegisterPushTokenRequest = z.object({
  token: z.string().trim().min(1).max(256),
  platform: z.enum(['ios', 'android', 'web']).optional(),
});
export type RegisterPushTokenRequest = z.infer<typeof RegisterPushTokenRequest>;

// token given → drop just that device; omitted → drop all this user's tokens.
export const UnregisterPushTokenRequest = z.object({
  token: z.string().trim().min(1).max(256).optional(),
});
export type UnregisterPushTokenRequest = z.infer<typeof UnregisterPushTokenRequest>;

// Push preferences. All optional so the UI can patch a single toggle or just
// the quiet-hours window; refine requires at least one field.
export const SetNotificationPrefsRequest = z
  .object({
    notifyMessages: z.boolean().optional(),
    notifyEmail: z.boolean().optional(),
    notifyBot: z.boolean().optional(),
    notifyBriefing: z.boolean().optional(),
    quietEnabled: z.boolean().optional(),
    quietStartHour: z.number().int().min(0).max(23).optional(),
    quietStartMinute: z.number().int().min(0).max(59).optional(),
    quietEndHour: z.number().int().min(0).max(23).optional(),
    quietEndMinute: z.number().int().min(0).max(59).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'provide at least one field');
export type SetNotificationPrefsRequest = z.infer<typeof SetNotificationPrefsRequest>;

export const EMAIL_SWIPE_ACTIONS = ['archive', 'trash'] as const;
export type EmailSwipeAction = (typeof EMAIL_SWIPE_ACTIONS)[number];

/** ADR 0218 — after archiving/trashing from the reader: open the next email, or go back to the list. */
export const EMAIL_AFTER_REMOVE = ['next', 'list'] as const;
export type EmailAfterRemove = (typeof EMAIL_AFTER_REMOVE)[number];

/** Email reader prefs. Partial patch; refine requires at least one field. */
export const SetEmailPrefsRequest = z
  .object({
    emailDigestEnabled: z.boolean().optional(),
    gmailSyncLabelsEnabled: z.boolean().optional(),
    /** ADR 0142 — push user-chosen Chord labels to primary Gmail. */
    chordLabelPushEnabled: z.boolean().optional(),
    /** Reply signature; empty string clears (back to null). */
    emailSignature: z.string().max(2000).optional(),
    /** ADR 0260 - a rich signature, cleaned on the server. Null or empty clears it. */
    emailSignatureHtml: z.string().max(20000).nullable().optional(),
    /** ADR 0136 — load remote images (always through Chord's proxy) without
     *  asking. False restores ADR 0120's per-sender banner. */
    emailImagesAuto: z.boolean().optional(),
    /** ADR 0215 - swipe an email row to archive it or to move it to Trash. */
    emailSwipeAction: z.enum(EMAIL_SWIPE_ACTIONS).optional(),
    /** ADR 0218 - after archive/Trash in the reader: next email or the list. */
    emailAfterRemove: z.enum(EMAIL_AFTER_REMOVE).optional(),
    /** ADR 0145 — nickname for the PRIMARY Gmail, which has no account row.
     *  Empty string clears it, back to "Gmail". */
    gmailNickname: z.string().max(MAILBOX_NICKNAME_MAX).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'provide at least one field');
export type SetEmailPrefsRequest = z.infer<typeof SetEmailPrefsRequest>;

/**
 * ADR 0260 addendum - one mailbox's own signature. `text` / `html` as in
 * `SetEmailPrefsRequest`; `useShared: true` removes the mailbox's own, so it
 * goes back to the signature every mailbox shares.
 */
export const SetMailboxSignatureRequest = z
  .object({
    mailbox: z.string().min(1).max(64),
    text: z.string().max(2000).optional(),
    html: z.string().max(20000).nullable().optional(),
    useShared: z.boolean().optional(),
  })
  .refine((v) => v.useShared || v.text !== undefined || v.html !== undefined, 'provide text, html or useShared');
export type SetMailboxSignatureRequest = z.infer<typeof SetMailboxSignatureRequest>;

/** ADR 0326 - a picture for a signature, base64 (a `data:` URL is accepted). */
export const UploadSignatureImageRequest = z.object({
  data: z.string().min(1).max(1_950_000),
});
export type UploadSignatureImageRequest = z.infer<typeof UploadSignatureImageRequest>;
export interface UploadSignatureImageResponse {
  url: string;
}

/**
 * Parse a loose time-of-day string into 24h {hour, minute}, or null when
 * unparseable. Accepts "7", "7a", "7am", "7:30 am", "7 PM", "19:00", "0730".
 * Used by the Settings UI; the chat path lets the LLM emit hour/minute.
 */
export function parseTimeOfDay(input: string): { hour: number; minute: number } | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})(?::?(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|a|p)?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const ap = m[3]?.[0]; // 'a' | 'p' | undefined
  if (minute > 59) return null;
  if (ap) {
    if (hour < 1 || hour > 12) return null;
    if (ap === 'a') hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  } else if (hour > 23) {
    return null;
  }
  return { hour, minute };
}

/** Render 24h {hour, minute} as a 12h clock string, e.g. "7:00 AM", "7:30 PM". */
export function formatTimeOfDay(hour: number, minute: number): string {
  const ap = hour < 12 ? 'AM' : 'PM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${ap}`;
}

/**
 * ADR 0283 — the user's answer to "may Chord send your data to an AI
 * provider". No AI runs on a user's data without `granted`.
 */
export interface AiConsent {
  decision: 'granted' | 'declined';
  at: IsoDateTime;
  /** The sentence naming who receives the data, as it was shown. */
  recipient: string;
  /** "I'm 18 or older, or my parent or guardian agreed." */
  ageConfirmed: boolean;
}

export interface AiConsentStatus {
  consent: AiConsent | null;
  /** Who would receive the data today: Chord's provider or the user's own key. */
  recipient: string;
  /** False when the deploy has the gate switched off (AI_CONSENT_REQUIRED). */
  required: boolean;
}

export const SetAiConsentRequest = z.object({
  decision: z.enum(['granted', 'declined']),
  /** Needed with the first answer; a later change reuses the stored one. */
  ageConfirmed: z.boolean().optional(),
});
export type SetAiConsentRequest = z.infer<typeof SetAiConsentRequest>;
