import { z } from 'zod';
import type { IsoDateTime } from './ids';
import { MAILBOX_NICKNAME_MAX } from '../mailbox-name';

/**
 * ADR 0080 — additional mailboxes beyond the primary Gmail connection.
 * `gmail` is a SECONDARY Google mailbox (the login-anchor Gmail lives on
 * `users`, not here); `outlook` covers both Outlook.com and Microsoft 365
 * (one Graph app); `imap` is the generic app-password provider (Yahoo,
 * AOL, iCloud, custom).
 */
export type EmailAccountProvider = 'gmail' | 'outlook' | 'imap';

/** Host presets for the generic IMAP provider. `custom` requires explicit hosts. */
export const IMAP_PRESETS = {
  yahoo: {
    label: 'Yahoo Mail',
    host: 'imap.mail.yahoo.com',
    port: 993,
    smtpHost: 'smtp.mail.yahoo.com',
    smtpPort: 465,
    appPasswordHint: 'Yahoo → Account Security → Generate app password',
  },
  aol: {
    label: 'AOL Mail',
    host: 'imap.aol.com',
    port: 993,
    smtpHost: 'smtp.aol.com',
    smtpPort: 465,
    appPasswordHint: 'AOL → Account Security → Generate app password',
  },
  icloud: {
    label: 'iCloud Mail',
    host: 'imap.mail.me.com',
    port: 993,
    smtpHost: 'smtp.mail.me.com',
    smtpPort: 587,
    appPasswordHint: 'appleid.apple.com → Sign-In and Security → App-Specific Passwords',
  },
  custom: {
    label: 'Other (IMAP)',
    host: '',
    port: 993,
    smtpHost: '',
    smtpPort: 465,
    appPasswordHint: 'Use your provider’s IMAP app password',
  },
} as const;

export type ImapPresetKey = keyof typeof IMAP_PRESETS;

/** One attached mailbox row in Settings + status payloads. */
export interface EmailAccountSummary {
  id: string;
  provider: EmailAccountProvider;
  emailAddress: string;
  displayName: string | null;
  /** ADR 0145 — user-chosen name for this mailbox; null falls back to the
   *  local part. Distinct from `displayName`, which the provider owns. */
  nickname: string | null;
  /** `reconnect` = stored credentials died; the user must re-attach. */
  status: 'ok' | 'reconnect';
  backfillDone: boolean;
  lastSyncedAt: IsoDateTime | null;
  /** IMAP accounts only — which preset the account was created from. */
  presetKey?: ImapPresetKey | null;
  /** ADR 0142 — mailbox can receive Chord label push. */
  labelPushSupported: boolean;
  /** ADR 0142 — user opted in to push Chord labels into this mailbox. */
  labelPushEnabled: boolean;
  /** ADR 0228 — this mailbox's grant also covers its calendar. */
  calendarEnabled?: boolean;
  /**
   * ADR 0320 — a connect that landed on a mailbox already attached: its
   * credentials were replaced and no new mailbox appeared. Set only by the
   * connect responses, never present in a listing, so the "add a mailbox"
   * door can say so instead of reporting a silent success.
   */
  reattached?: boolean;
}

/**
 * Result of retrying a flagged mailbox with the credential already on file.
 * A provider hiccup can strand an account in `reconnect` while its stored
 * app password is still perfectly good, so re-entry is the fallback, not the
 * first move — `needsReconnect` is the server saying the credential is
 * genuinely dead and the user really does have to supply a new one.
 */
export interface EmailAccountRetryResult {
  ok: boolean;
  needsReconnect: boolean;
  account: EmailAccountSummary;
}

/** POST body to attach an Outlook / Microsoft 365 mailbox (PKCE code exchange). */
export const ConnectOutlookRequest = z.object({
  code: z.string().min(1).max(4096),
  codeVerifier: z.string().min(1).max(256),
  redirectUri: z.string().min(1).max(2048),
});
export type ConnectOutlookRequest = z.infer<typeof ConnectOutlookRequest>;

/** POST body to attach a SECONDARY Gmail mailbox (same Google OAuth client;
 *  the exchanged refresh token lands on the account row, never on `users`). */
export const ConnectGmailAccountRequest = z.object({
  code: z.string().min(1).max(4096),
  codeVerifier: z.string().min(1).max(256),
  redirectUri: z.string().min(1).max(2048),
});
export type ConnectGmailAccountRequest = z.infer<typeof ConnectGmailAccountRequest>;

/** POST body to attach a generic IMAP mailbox (app password). */
export const ConnectImapRequest = z
  .object({
    emailAddress: z.string().trim().email().max(320),
    password: z.string().min(1).max(256),
    preset: z.enum(['yahoo', 'aol', 'icloud', 'custom']),
    /** Login user when it differs from the address (rare); defaults to the address. */
    username: z.string().trim().min(1).max(320).optional(),
    host: z.string().trim().min(1).max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    smtpHost: z.string().trim().min(1).max(255).optional(),
    smtpPort: z.number().int().min(1).max(65535).optional(),
  })
  .refine((v) => v.preset !== 'custom' || (v.host && v.smtpHost), {
    message: 'custom preset requires host and smtpHost',
  });
export type ConnectImapRequest = z.infer<typeof ConnectImapRequest>;

/** ADR 0142 — per-attached-mailbox Chord label push opt-in. */
export const SetEmailAccountPrefsRequest = z
  .object({
    labelPushEnabled: z.boolean().optional(),
    /** ADR 0145 — empty string clears it, back to the local-part default. */
    nickname: z.string().max(MAILBOX_NICKNAME_MAX).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'provide at least one field');
export type SetEmailAccountPrefsRequest = z.infer<typeof SetEmailAccountPrefsRequest>;
