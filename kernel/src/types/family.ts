/**
 * ADR 0231 — the family plan's roster. One payer ("owner") covers up to
 * FAMILY_SEATS people, themselves included, from one pooled token allowance.
 * Not related to `Persona` (the per-group profile roster) — a family member
 * here is a billing seat, optionally with a Chord account behind it.
 */
import { z } from 'zod';

/** People one family plan covers, the payer included. */
export const FAMILY_SEATS = 4;

/** Invite codes carry this prefix so `/join/<CODE>` can tell a family invite
 *  from a group invite with no new link route (universal links already
 *  verify `/join/*` — ADR 0048). */
export const FAMILY_INVITE_PREFIX = 'FAM';

/** True for a code minted for a family invite. Case-insensitive. A group
 *  invite code is six characters and could by chance begin `FAM`, so the
 *  prefix alone is not enough: a family code is the prefix plus twelve. */
export function isFamilyInviteCode(code: string): boolean {
  return new RegExp(`^${FAMILY_INVITE_PREFIX}[A-Z0-9]{12}$`).test(code.trim().toUpperCase());
}

/**
 * `profile`  — a person on the roster with no invite sent (a child, a
 *              grandparent). Uses no seat and no tokens.
 * `invited`  — an invite is out; the seat is held for them.
 * `active`   — has a Chord account and is covered by the plan.
 */
export type FamilyMemberStatus = 'profile' | 'invited' | 'active';

export interface FamilyMember {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  /** Free text the owner gave ("wife", "son") — display only. */
  relationship: string | null;
  status: FamilyMemberStatus;
  /** The owner lets this person assign tasks/events to them (ADR 0026). */
  chordinator: boolean;
  /** Present while `status === 'invited'`. */
  inviteLink: string | null;
  joinedAt: string | null;
}

export interface FamilyOverview {
  /** `none`: not on a family plan and no roster yet. */
  role: 'owner' | 'member' | 'none';
  seats: number;
  seatsUsed: number;
  members: FamilyMember[];
  /** For a member: the person paying. */
  ownerName?: string;
  /** The owner currently has an active family subscription, so seated
   *  members are actually covered. */
  planActive: boolean;
  /** ADR 0234 — the family's shared chat, once someone has been seated. */
  groupId?: string | null;
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? undefined : s))
    .optional();

export const AddFamilyMemberRequest = z.object({
  name: z.string().trim().min(1).max(100),
  email: optionalText(254),
  phone: optionalText(40),
  relationship: optionalText(60),
  chordinator: z.boolean().optional(),
  /** Send (reserve) an invite now. Needs an email or phone. */
  invite: z.boolean().optional(),
});
export type AddFamilyMemberRequest = z.infer<typeof AddFamilyMemberRequest>;

export const UpdateFamilyMemberRequest = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  email: z.string().trim().max(254).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  relationship: z.string().trim().max(60).nullable().optional(),
  chordinator: z.boolean().optional(),
});
export type UpdateFamilyMemberRequest = z.infer<typeof UpdateFamilyMemberRequest>;

export const AcceptFamilyInviteRequest = z.object({
  code: z.string().trim().min(4).max(40),
});
export type AcceptFamilyInviteRequest = z.infer<typeof AcceptFamilyInviteRequest>;

/** `POST /me/email/threads/:id/share` (ADR 0234). No `groupId` means the
 *  family chat. */
export const ShareEmailToGroupRequest = z.object({
  groupId: z.string().min(1).optional(),
  note: z.string().trim().max(1000).optional(),
});
export type ShareEmailToGroupRequest = z.infer<typeof ShareEmailToGroupRequest>;

export interface ShareEmailToGroupResult {
  groupId: string;
  groupName: string;
}

/** Result of `POST /me/family/:id/invite` and of adding with `invite: true`. */
export interface FamilyInviteResult {
  member: FamilyMember;
  inviteLink: string;
  /** Ready-to-send wording for a text or email. */
  message: string;
  /** ADR 0237 — the person already had a Chord account (matched on a sign-in
   *  email, a connected mailbox or a verified phone), so they are seated NOW:
   *  `member.status` is `active` and there is nothing for them to accept. */
  joined?: boolean;
  /** ADR 0237 — what Chord itself did to tell them. Email is sent from the
   *  owner's own mailbox; a text is not sent by Chord (it comes from the owner's
   *  phone), so there is no `sms` outcome. */
  delivery?: { email: 'queued' | 'no_email' | 'no_mailbox' | 'failed' };
}
