import { z } from 'zod';

import type {
  GroupId,
  IsoDateTime,
  MessageId,
  UserId,
} from './ids';

export type ProposalId = string;

/**
 * Lifecycle of a bot-proposed tool call (ADR 0009).
 * - pending   — awaiting confirm/reject
 * - confirmed — a group member accepted; downstream entity has been written
 * - rejected  — a group member declined
 * - expired   — TTL elapsed (72h default) with no resolution
 */
export type ProposalStatus = 'pending' | 'confirmed' | 'rejected' | 'expired';

/**
 * A staged tool call. The LLM's intent, serialized into `toolName` +
 * `argsJson`, awaiting a group member's tap. On confirm, the original call is
 * re-validated and dispatched through the same executor path that auto-commits
 * today.
 */
export interface Proposal {
  id: ProposalId;
  groupId: GroupId;
  proposedByUserId: UserId | null;
  proposedByMessageId: MessageId | null;
  toolName: string;
  /** Tool arguments, JSON-serialized. Re-validated against the zod registry
   *  on commit — stored in serialized form so the schema can evolve without
   *  retroactively breaking older rows. */
  argsJson: string;
  provenance: string | null;
  /**
   * ADR 0063 — when set, confirming this proposal executes the tool in THIS
   * group instead of `groupId`. Used by the email magics: the suggestion stays
   * private in the owner's personal group (`groupId`), and only the owner's
   * confirm creates the entity in the target group — where it fans out to
   * members (ADR 0040). The raw email is never shared; only the confirmed,
   * distilled entity is. Null = execute in `groupId` as usual.
   */
  targetGroupId: GroupId | null;
  status: ProposalStatus;
  resolvedByUserId: UserId | null;
  resolvedByMessageId: MessageId | null;
  resolvedAt: IsoDateTime | null;
  /** Shared across a set of proposals that must confirm/reject together
   *  (e.g. trip + legs + accommodations from one flight PDF). */
  bundleId: string | null;
  expiresAt: IsoDateTime;
  createdAt: IsoDateTime;
  /**
   * In-app expo-router path to what generated this proposal (the source email
   * thread, the chat, the attachments tab) — ADR 0059 href conventions — so
   * the user can inspect the source before confirming. Computed per-viewer at
   * list time (email threads are per-user); absent when unresolvable.
   */
  sourceHref?: string | null;
  /**
   * Human name of that source — the email's subject — so several proposals
   * mined from one thread can be shown together under what they came from
   * (bug 12). Same per-viewer computation as `sourceHref`; absent when the
   * source is not an email or can no longer be resolved.
   */
  sourceLabel?: string | null;
  /**
   * ADR 0312 — where an email event will go: the calendar of the mailbox the
   * email came to (`auto`), or a question when that mailbox has none (`ask`,
   * with the calendars the user can write to). Confirm sends the picked
   * `calendarId`; without one an `ask` proposal is refused. Absent for
   * anything that is not an email event.
   */
  calendarChoice?: ProposalCalendarChoice;
  /**
   * ADR 0343 — this email event may replace one the user already has (same
   * sender, same subject, different time). The card asks Move it / Add as
   * new; confirm sends `replaceEventId` to move. Absent = a plain card.
   */
  replaces?: ProposalReplaceOffer;
  /**
   * ADR 0346 - how this email event sits on the user's calendar: free, a
   * conflict (shown to the user only), already there, or a question.
   * Absent for anything that is not a pending email event.
   */
  fit?: ProposalCalendarFit;
}

export interface FitEvent {
  eventId: string;
  title: string;
  /** As stored. */
  startsAt: string;
  endsAt: string | null;
}

export interface FitQuestion extends FitEvent {
  /** `same`: is this the same meeting? `movable`: can this block of yours move? */
  ask: 'same' | 'movable';
}

export interface ProposalCalendarFit {
  verdict: 'free' | 'conflict' | 'already' | 'ask';
  /** Different people at the same time. */
  conflicts: FitEvent[];
  /** A prep or debrief next to it: not a conflict. */
  related: FitEvent[];
  questions: FitQuestion[];
  /** The event this already is, for `already`. */
  already?: FitEvent;
  /** ADR 0346 phase 4 - slots held in Chord for another meeting (soft:
   *  still bookable). `eventId` is `hold:<meeting id>`. */
  held?: FitEvent[];
  /** "Saturday", "before 9:00 AM", "Thanksgiving Day": outside work hours. */
  outsideWorkHours?: string;
}

export type OverlapAnswer = 'same' | 'different' | 'movable' | 'fixed';

export interface ProposalReplaceOffer {
  eventId: string;
  title: string;
  /** The existing event's start, as stored. */
  startsAt: string;
}

export type ProposalCalendarChoice =
  | { kind: 'auto'; calendarId: string; label: string }
  | { kind: 'ask'; options: { calendarId: string; label: string }[] };

export interface ProposalResolvedEvent {
  id: ProposalId;
  status: 'confirmed' | 'rejected' | 'expired';
}

/**
 * Offered by the confirm response (ADR 0150) after a user routes an
 * email-derived proposal into a shared group by hand: a one-tap way to make it
 * a standing `sender_domain` rule (ADR 0077) so the next proposal from that
 * sender arrives pre-selected — still one confirm tap, never auto-routed.
 * `replaces` is set when a `sender_domain` rule for that domain already points
 * somewhere else, so the offer reads as "instead of <that group>".
 */
export interface RouteSuggestion {
  /** The sender's domain, lower-cased — the rule pattern to create. */
  pattern: string;
  targetGroupId: GroupId;
  targetGroupName: string;
  replaces?: { targetGroupName: string };
}

/**
 * ADR 0104 — how the user answered a calendar invitation. Named for the
 * iCalendar PARTSTAT values rather than yes/maybe/no, so the wire value is the
 * one both Google and an iTIP REPLY expect and nothing has to translate.
 */
export const RsvpProposalRequest = z.object({
  response: z.enum(['accepted', 'declined', 'tentative']),
});
export type RsvpProposalRequest = z.infer<typeof RsvpProposalRequest>;

/** ADR 0346 - the user's answer to a question on an email event card. */
export const OverlapAnswerRequest = z.object({
  eventId: z.string().min(1).max(200),
  answer: z.enum(['same', 'different', 'movable', 'fixed']),
});
export type OverlapAnswerRequest = z.infer<typeof OverlapAnswerRequest>;

/** Which route carried the answer, so the UI can be specific. */
export interface RsvpResultDto {
  rsvp: 'accepted' | 'declined' | 'tentative';
  /** 'calendar' — patched in place. 'email' — an iTIP reply was sent. */
  via: 'calendar' | 'email' | null;
  created: boolean;
}
