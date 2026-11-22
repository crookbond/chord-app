import { z } from 'zod';
import { isValidTimeZone } from '../time-picker';
import type { VideoCallKind } from '../video-call';
import type {
  EventId,
  GroupId,
  IsoDateTime,
  RsvpId,
  UserId,
} from './ids';

/** Potluck-style event with RSVP + dish tracking (Flow 4/5). */
export interface GroupEvent {
  id: EventId;
  groupId: GroupId;
  title: string;
  location?: string;
  startsAt: IsoDateTime;
  /** Optional explicit end. When omitted, clients assume a 60-minute default. */
  endsAt?: IsoDateTime;
  createdBy: UserId | null;
  /** ADR 0040 — whose calendar copy this is. With group fan-out a logical event
   *  is one copy per member; SSE delivers each copy tagged with its owner so a
   *  client acts only on the recipient's own copy. */
  ownerUserId?: UserId;
  /** ADR 0151 — a managed family member as the subject; the event's owner
   *  (and gcal target) is that persona's managing adult. */
  assigneePersonaId?: string;
  /** Display name of the assigned persona. Populated by list endpoints. */
  assigneePersonaName?: string;
  createdAt: IsoDateTime;
  sourceRawContext?: string;
  /** ADR 0162 — a short, server-composed excerpt of what led to this event
   *  (the source email's subject+snippet+link, or the triggering chat
   *  message) when one is known. Never model-authored. */
  description?: string;
  /** ADR 0163 — a short "what this is about", mined once from prior
   *  correspondence with the event's invitee(s). Null/absent until computed,
   *  and stays absent when no correspondence was found. */
  meetingContext?: string;
  /** ADR 0013: stable id from the originating calendar (UID for .ics, etag/id for cloud). */
  externalUid?: string;
  /** ADR 0033: 'transparent' = informational ("show me as free"); 'opaque' = blocks time. */
  transparency?: 'opaque' | 'transparent';
  /** Display color (hex) of the event's calendar (ADR 0072/0278: the user's
   *  pick, else the provider's, else Chord's palette); null = Chord-native. */
  color?: string | null;
  /** ADR 0278 — the name of the calendar the event is on; null = Chord only. */
  calendarName?: string | null;
  /** ADR 0217 — set when this is one occurrence of a repeating Chord event. */
  seriesId?: string;
  /** ADR 0289 — the trip this entry is part of (its own ticket entry, or one
   *  Chord matched or the user named), and who is travelling on it. Such an
   *  entry is the travellers' time, not the calendar owner's. */
  tripId?: string;
  tripName?: string;
  tripTravelers?: string[];
  /** ADR 0297 — the IANA zone the event's times are in, when known. */
  timeZone?: string;
}

export type RsvpStatus = 'yes' | 'no' | 'maybe' | 'pending';

export interface Rsvp {
  id: RsvpId;
  eventId: EventId;
  /** Member user if known, else free-text name (spouse/plus-one). */
  userId?: UserId;
  displayName: string;
  status: RsvpStatus;
  /** Coming alone when partner is usually expected. */
  solo: boolean;
  /** What they're bringing — natural language ("dal makhani for 8"). */
  dish?: string;
  notes?: string;
  updatedAt: IsoDateTime;
}

export const CreateEventRequest = z.object({
  title: z.string().trim().min(1).max(200),
  location: z.string().max(200).optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().optional(),
});
export type CreateEventRequest = z.infer<typeof CreateEventRequest>;

/** ADR 0040 — partial edit of an existing event. All fields optional; only the
 *  provided ones change. Drives the two-way push (sequence bump + Google patch). */
export const UpdateEventRequest = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  location: z.string().max(200).nullable().optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  /** ADR 0297 — the IANA zone the times are in. */
  timeZone: z
    .string()
    .max(64)
    .refine((z) => isValidTimeZone(z), 'unknown time zone')
    .optional(),
});
export type UpdateEventRequest = z.infer<typeof UpdateEventRequest>;

/**
 * ADR 0157 addendum — add or remove guests from the event editor. Same rule as
 * the bot's `update_event { invitees, removeInvitees }` (ADR 0295): the guests
 * live on the calendar event, only its organizer may change them, and the
 * calendar mails the invitation. Addresses only — the app resolves names from
 * the phone's contacts before sending.
 */
export const ChangeEventGuestsRequest = z
  .object({
    add: z.array(z.string().trim().toLowerCase().email().max(200)).max(50).default([]),
    remove: z.array(z.string().trim().toLowerCase().email().max(200)).max(50).default([]),
  })
  .refine((r) => r.add.length + r.remove.length > 0, 'nothing to change');
export type ChangeEventGuestsRequest = z.input<typeof ChangeEventGuestsRequest>;

/**
 * `guests` = who the calendar lists now (null = could not be read).
 * `reason` explains a refused change, in the words of ADR 0295.
 */
/** ADR 0328 — a guest's answer, in the calendar's own words. */
export type GuestResponse = 'accepted' | 'tentative' | 'declined' | 'needsAction';

export interface GuestAnswer {
  email: string;
  /** The Chord member or saved person at that address, when known. */
  name: string | null;
  response: GuestResponse;
}

/** ADR 0328 — answering an invitation from inside Chord. */
export const EventAnswerRequest = z
  .object({ response: z.enum(['accepted', 'tentative', 'declined']) })
  .strict();
export type EventAnswerRequest = z.input<typeof EventAnswerRequest>;

export interface EventAnswerResponse {
  ok: boolean;
  response?: GuestResponse;
  /** How the answer reached the organizer. */
  via?: 'calendar' | 'email';
  /** A "no" takes the event off the member's calendar in Chord. */
  removed?: boolean;
  /**
   * - `not_invited`: this copy is not an invitation (the organizer's own, or
   *   a member's copy with no invitation behind it).
   * - `no_route`: neither the member's calendar nor a mailbox of theirs can
   *   carry the answer (nothing connected that has the invitation).
   * - `send_failed`: the calendar or the mail refused it.
   */
  reason?: 'not_found' | 'not_invited' | 'no_route' | 'send_failed';
}

export interface EventGuestsResponse {
  guests: string[] | null;
  /** ADR 0328 — who has answered and how, as last reported by the
   *  organizer's calendar or a mailed reply. Present for members as well as
   *  the organizer; absent when nothing has been recorded. */
  answers?: GuestAnswer[];
  /** ADR 0328 — set when the viewer was INVITED to this event (a family
   *  member's group event): their own answer, which they can change here. */
  myInvite?: { response: GuestResponse };
  /** Who organizes it, when that is someone else (read only on GET). */
  organizer?: string | null;
  added?: string[];
  removed?: string[];
  reason?: 'not_found' | 'not_organizer' | 'not_on_calendar' | 'provider_error';
  /** ADR 0319/0323 — the video call this event's calendar can be given, or
   *  null for none (a phone-mirrored calendar, or no calendar at all). The
   *  editor's button is named from it, and drawn only when it is one. */
  videoCall?: VideoCallKind | null;
  /** ADR 0331 — the join link the calendar holds (Google Meet, Teams), read
   *  on GET only; null when it has none or cannot be read. */
  videoCallLink?: string | null;
}

/**
 * ADR 0317/0323 — adding a video call. `kind` says which was added, so the
 * caller names what it really did. `link` null with no `reason` = asked for
 * and accepted, the provider has not returned the link yet (Google Meet
 * only: Graph returns a Teams join URL with the write, so a missing one
 * there is a refusal, not a wait).
 */
export interface EventVideoCallResponse {
  link: string | null;
  kind?: VideoCallKind;
  reason?:
    | 'not_found'
    | 'not_organizer'
    | 'not_on_calendar'
    /** This calendar's provider has none Chord can create (a phone mirror). */
    | 'no_video_call'
    /** An Outlook calendar that does not offer Teams: a personal account, or
     *  a tenant without the licence. */
    | 'teams_unavailable'
    | 'provider_error';
}

/** ADR 0057 — one selected device calendar in a device-calendar sync batch. */
export const DeviceCalendarInput = z.object({
  deviceCalendarId: z.string().min(1).max(256),
  title: z.string().max(256).optional(),
  /** Device-writable → counts as busy by default (ADR 0033 policy). */
  allowsModifications: z.boolean().optional(),
  /** EventKit calendar color (hex), surfaced in settings. */
  color: z.string().max(32).nullable().optional(),
});
export type DeviceCalendarInput = z.infer<typeof DeviceCalendarInput>;

/** ADR 0057 — one device event in a sync batch. `externalId` is EventKit's
 *  `calendarItemExternalIdentifier` (Layer-0 dedup key), when the native module
 *  could read it. */
export const DeviceEventInput = z.object({
  deviceCalendarId: z.string().min(1).max(256),
  deviceEventId: z.string().min(1).max(256),
  externalId: z.string().max(512).nullable().optional(),
  title: z.string().max(500),
  startsAt: z.string().min(1),
  endsAt: z.string().nullable().optional(),
  allDay: z.boolean().optional(),
  location: z.string().max(500).nullable().optional(),
  description: z.string().max(8000).nullable().optional(),
  status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
  /** EventKit per-event availability — 'free' maps to transparent (never a
   *  conflict), mirroring Google's per-event transparency. */
  availability: z.enum(['busy', 'free', 'tentative', 'unavailable', 'notSupported']).optional(),
  /** Device `lastModifiedDate`, ISO — drives last-writer-wins. */
  updatedAt: z.string().nullable().optional(),
});
export type DeviceEventInput = z.infer<typeof DeviceEventInput>;

/** ADR 0057 — the device → Chord read-up batch for the −30/+60 window. */
export const DeviceCalendarSyncRequest = z.object({
  calendars: z.array(DeviceCalendarInput).max(100),
  events: z.array(DeviceEventInput).max(5000),
  /** ISO bounds of the synced window; reverse-delete is scoped to it. */
  windowStart: z.string().min(1),
  windowEnd: z.string().min(1),
  /** The phone's IANA zone: decides which day an all-day event's midnight is
   *  on. Older apps omit it and the user's `last_tz` stands in. */
  timeZone: z.string().max(64).optional(),
});
export type DeviceCalendarSyncRequest = z.infer<typeof DeviceCalendarSyncRequest>;

export interface DeviceCalendarSyncResult {
  inserted: number;
  updated: number;
  deduped: number;
  deleted: number;
}

/**
 * Which of these event ids still exist for the caller. The device-calendar
 * delete reconcile asks this instead of diffing against `/me/events`, which
 * is a date window: an event outside it is not deleted, just not listed.
 */
export const LiveEventIdsRequest = z.object({
  ids: z.array(z.string().min(1).max(64)).max(2000),
});
export type LiveEventIdsRequest = z.infer<typeof LiveEventIdsRequest>;
export interface LiveEventIdsResponse {
  live: string[];
}

export const UpsertRsvpRequest = z.object({
  userId: z.string().optional(),
  displayName: z.string().trim().min(1).max(80),
  status: z.enum(['yes', 'no', 'maybe', 'pending']),
  solo: z.boolean().optional(),
  dish: z.string().max(200).optional(),
  notes: z.string().max(500).optional(),
});
export type UpsertRsvpRequest = z.infer<typeof UpsertRsvpRequest>;
