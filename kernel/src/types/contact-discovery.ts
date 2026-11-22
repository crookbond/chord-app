/**
 * Phone identity + deterministic contact discovery (ADR 0064 / 0065).
 *
 * Phone verification attaches a verified E.164 number to the Google-anchored
 * account. Contact discovery uploads client-hashed device numbers and gets back
 * the ones that are Chord users. Numbers are hashed on the client (same pepper
 * as the server); raw device numbers never leave the phone.
 */
import { z } from 'zod';

// ─── Phone verification (ADR 0064) ────────────────────────────────────

export interface PhoneStatus {
  /** Verified E.164 number, or null if none is set. */
  phone: string | null;
  verified: boolean;
  /** Shared pepper the client folds into contact hashes (ADR 0065). Served,
   *  not baked into the app build, so it can rotate without a release. */
  contactHashPepper: string;
}

// Loose length bounds — the server does the real E.164 normalization/validation
// and returns `invalid_phone` on anything it can't canonicalize.
export const StartPhoneVerificationRequest = z.object({
  phone: z.string().trim().min(3).max(32),
});
export type StartPhoneVerificationRequest = z.infer<typeof StartPhoneVerificationRequest>;

export interface StartPhoneVerificationResponse {
  /** The normalized E.164 the code was sent to. */
  phone: string;
}

export const VerifyPhoneRequest = z.object({
  phone: z.string().trim().min(3).max(32),
  code: z.string().trim().min(4).max(10),
});
export type VerifyPhoneRequest = z.infer<typeof VerifyPhoneRequest>;

// ─── Contact discovery (ADR 0065) ─────────────────────────────────────

/** A hex HMAC produced by the client with the shared contact-hash pepper. */
const PhoneHash = z.string().trim().regex(/^[0-9a-f]{16,128}$/i, 'expected a hex hash');

export const ResolveContactsRequest = z.object({
  contacts: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        phoneHashes: z.array(PhoneHash).min(1).max(20),
      }),
    )
    .max(5000),
});
export type ResolveContactsRequest = z.infer<typeof ResolveContactsRequest>;

export interface ResolvedContact {
  /** The owner's address-book name for this contact. */
  name: string;
  chordUserId: string;
  displayName: string;
}

export interface ResolveContactsResponse {
  resolved: ResolvedContact[];
}

// ─── On-demand device contact lookup (ADR 0212) ───────────────────────

/** `contact.lookup` payload: the bot asks the asker's own phone about ONE
 *  name. Rides the personal chat's channel, so only the asker's devices see it. */
export interface DeviceContactLookupRequest {
  requestId: string;
  query: string;
  /**
   * ADR 0275: the query is a role ("dentist"); match these words against an
   * entry's company, job title and name instead of the name alone. An app
   * that predates this ignores it and looks the query up as a name.
   */
  role?: string[];
  /**
   * The user whose phone should answer. A lookup for an event invitee can be
   * sent in a shared chat (ADR 0157 addendum), where every member's phone
   * hears it; only the asker's phone may search. An app that predates this
   * answers anyway and the server refuses the answer.
   */
  forUserId?: string;
}

export const DeviceContactMatch = z.object({
  name: z.string().trim().min(1).max(200),
  emails: z.array(z.string().trim().max(200)).max(10).default([]),
  phones: z.array(z.string().trim().max(40)).max(10).default([]),
  /** 'YYYY-MM-DD', year '0000' when the contact has none. */
  birthday: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** ADR 0275: the entry's company, for a role lookup. */
  company: z.string().trim().max(200).optional(),
});
export type DeviceContactMatch = z.infer<typeof DeviceContactMatch>;

/** What the phone answers. `no_permission` = Contacts access not granted. */
export const DeviceContactLookupResponse = z.object({
  status: z.enum(['found', 'not_found', 'no_permission']),
  matches: z.array(DeviceContactMatch).max(5).default([]),
});
export type DeviceContactLookupResponse = z.infer<typeof DeviceContactLookupResponse>;
