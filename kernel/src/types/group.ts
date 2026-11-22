import { z } from 'zod';
import type { GroupId, UserId, IsoDateTime } from './ids';

/** `group` = multi-person; `personal` = user ↔ bot only. */
export type GroupKind = 'group' | 'personal';
export type GroupRole = 'owner' | 'member';
export type IdentityTier = 'verified' | 'trusted' | 'guest';

export interface Group {
  id: GroupId;
  name: string;
  kind: GroupKind;
  /** Short code another user can use to join. */
  inviteCode: string;
  /** Ingestion email — forward docs here to index into the group. */
  ingestEmail: string;
  createdBy: UserId;
  createdAt: IsoDateTime;
  /** When true, members with tier='guest' are denied attachment access. */
  adultsOnly: boolean;
  /**
   * When false (default): external messages from bridges are dropped
   * unless they @-mention the bot. When true: every external message
   * is mirrored into the Chord group as a guest-shadow message.
   */
  mirrorInbound: boolean;
  /**
   * Timestamp of the most recent visible message in the group, or null
   * if the group has none. Set only by the listing endpoint; absent on
   * single-group fetches.
   */
  lastMessageAt?: IsoDateTime | null;
  /**
   * Body of the most recent visible message, trimmed to a short preview
   * for the chat list. Null when the group has none. Set only by the
   * listing endpoint; absent on single-group fetches.
   */
  lastMessagePreview?: string | null;
  /**
   * Number of visible messages newer than the requesting member's
   * `last_read_at`. Set only by the listing endpoint.
   */
  unreadCount?: number;
  /**
   * The requesting member's read cursor — the timestamp they last opened
   * the group, or null until first read. The client uses it to position a
   * freshly-opened chat at the first unread message (and to draw the
   * "Unread" divider). Set by both the listing endpoint and single-group
   * fetch. Server-authoritative, so it stays consistent across a user's
   * devices.
   */
  lastReadAt?: IsoDateTime | null;
  /**
   * Whether the requesting member has muted push notifications for this group
   * (ADR 0054). Set on single-group fetch; absent on the listing endpoint.
   */
  muted?: boolean;
  /**
   * The OTHER member's full name, for a two-person shared chat whose name
   * nobody chose. A two-person group is a group technically, but reading it
   * is easier when it is labelled by the person you are talking to. Present
   * only when the client should prefer it over `name`, so the rule for
   * deciding that lives on the server, next to the membership it needs:
   * absent for personal groups, for groups with any other member count, and
   * for any chat someone deliberately named.
   */
  counterpartName?: string | null;
}

export interface GroupMember {
  groupId: GroupId;
  userId: UserId;
  role: GroupRole;
  tier: IdentityTier;
  joinedAt: IsoDateTime;
  /** Enriched when the server returns a list alongside users. */
  username?: string;
  displayName?: string;
  /** True when the user was auto-created by a WhatsApp import and has no login. */
  shadow?: boolean;
}

export const CreateGroupRequest = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['group', 'personal']).default('personal'),
});
export type CreateGroupRequest = z.input<typeof CreateGroupRequest>;

export const JoinGroupRequest = z.object({
  inviteCode: z.string().trim().min(4).max(32),
});
export type JoinGroupRequest = z.infer<typeof JoinGroupRequest>;

/**
 * ADR 0318 - invite someone to chat by their email address. No `groupId` =
 * a direct chat with them; with one, add them to that chat. `message` is the
 * first thing they read (in the chat, and in the email when they are new).
 */
export const InviteByEmailRequest = z.object({
  email: z.string().trim().email().max(254),
  groupId: z.string().min(1).max(64).optional(),
  message: z.string().trim().max(2000).optional(),
});
export type InviteByEmailRequest = z.infer<typeof InviteByEmailRequest>;

/**
 * - `added`: they were already connected with you, so they are in the chat now.
 * - `asked`: they have Chord; they got an invite to accept or decline.
 * - `emailed`: they are not on Chord yet; a link went (or could not go) by email.
 */
export type InviteByEmailResponse =
  | { status: 'added'; groupId: string; name: string }
  | { status: 'asked'; groupId: string | null; name: string }
  | {
      status: 'emailed';
      groupId: string;
      /** What happened to the email: `queued` (sending from your mailbox, with
       *  the usual undo window), `no_mailbox` / `failed` (NOT sent - share the
       *  link yourself). */
      email: 'queued' | 'no_mailbox' | 'failed';
      link: string;
    };

/** An invite waiting for the signed-in user's answer. */
export interface ChatInvite {
  id: string;
  fromName: string;
  /** Null for a direct chat with the inviter. */
  groupName: string | null;
  message: string | null;
  createdAt: IsoDateTime;
}

export const UpdateGroupRequest = z.object({
  mirrorInbound: z.boolean().optional(),
});
export type UpdateGroupRequest = z.infer<typeof UpdateGroupRequest>;

// Per-(user,group) push mute toggle (ADR 0054).
export const SetGroupMutedRequest = z.object({
  muted: z.boolean(),
});
export type SetGroupMutedRequest = z.infer<typeof SetGroupMutedRequest>;
