import { z } from 'zod';
import type {
  AccommodationId,
  AttachmentId,
  GroupId,
  IsoDate,
  IsoDateTime,
  TravelLegId,
  TripId,
  TripReservationId,
  UserId,
} from './ids';

export type TravelMode = 'flight' | 'train' | 'car' | 'ferry' | 'other';

/** The file a trip item was read from, resolved for the viewer so the Trips
 *  tab can show it in-app (an image in a lightbox) rather than hand it to the
 *  OS share sheet. `summary` is what indexing extracted — absent when the
 *  file was never ingested. */
export interface TripSourceDoc {
  id: AttachmentId;
  filename: string;
  mimeType: string;
  summary?: string;
  /** Local email thread the file arrived on (ADR 0071), when the viewer has it. */
  emailThreadId?: string;
}

/** Per-viewer links back to what produced a trip item (set by the list routes). */
export interface TripSourceLinks {
  /** Local `email_threads.id` for a `gmail:` provenance the viewer can open. */
  sourceEmailThreadId?: string;
  /** Mined from an email the viewer's mailbox no longer holds (deleted, or
   *  the mailbox was disconnected). Only set for the trip's creator — the one
   *  whose mail it was — so another member never reads their absence as a deletion. */
  sourceEmailGone?: boolean;
  sourceDoc?: TripSourceDoc;
}

export interface Trip extends TripSourceLinks {
  id: TripId;
  groupId: GroupId;
  name: string;
  destination: string;
  startDate: IsoDate;
  endDate: IsoDate;
  participants: UserId[];
  createdBy: UserId | null;
  createdAt: IsoDateTime;
  sourceRawContext?: string;
  /** ADR 0168 — set when every leg/accommodation is cancelled, or the trip
   *  itself was cancelled directly. */
  cancelledAt?: IsoDateTime;
  /** Soft-delete: set by the user's own delete, or derived once every
   *  leg/accommodation/reservation on the trip has been removed. The trip
   *  stays in the list (never hard-deleted) so it can be restored. */
  deletedAt?: IsoDateTime;
}

export interface TravelLeg extends TripSourceLinks {
  id: TravelLegId;
  tripId: TripId;
  personaId: UserId | null;
  /** Raw passenger name from the source document when not resolvable to a user. */
  passengerName?: string;
  /** Resolved passenger display names for a leg that represents several people
   *  on the same flight (set by getTripStatus when it collapses shared legs). */
  passengers?: string[];
  mode: TravelMode;
  origin: string;
  destination: string;
  departAt: IsoDateTime;
  arriveAt: IsoDateTime;
  carrier?: string;
  flightNo?: string;
  confirmation?: string;
  /** ADR 0158 — free-text booking detail (e.g. the itinerary/order number). */
  notes?: string;
  sourceDocId?: AttachmentId;
  createdAt: IsoDateTime;
  sourceRawContext?: string;
  /** ADR 0168 — set when a cancellation email matches this specific leg. */
  cancelledAt?: IsoDateTime;
}

export interface Accommodation extends TripSourceLinks {
  id: AccommodationId;
  tripId: TripId;
  propertyName: string;
  address?: string;
  checkinDate: IsoDate;
  checkoutDate: IsoDate;
  roomCount?: number;
  confirmation?: string;
  /** ADR 0158 — free-text booking detail (e.g. the itinerary/order number). */
  notes?: string;
  sourceDocId?: AttachmentId;
  createdAt: IsoDateTime;
  sourceRawContext?: string;
  /** ADR 0168 — set when a cancellation email matches this specific stay. */
  cancelledAt?: IsoDateTime;
}

export type ReservationKind = 'restaurant' | 'tour' | 'event' | 'activity' | 'other';

export interface TripReservation extends TripSourceLinks {
  id: TripReservationId;
  tripId: TripId;
  kind: ReservationKind;
  name: string;
  dateTime?: IsoDateTime;
  address?: string;
  confirmation?: string;
  notes?: string;
  createdAt: IsoDateTime;
  sourceRawContext?: string;
}

export interface TripStatus {
  trip: Trip;
  legs: TravelLeg[];
  accommodations: Accommodation[];
  reservations: TripReservation[];
  /** Display names of trip participants (same order as trip.participants). */
  participantNames: string[];
  /** Human-readable summary for the bot / card. */
  narrative: string;
  /**
   * Night-spans within [trip.startDate, trip.endDate) not covered by any
   * accommodation. Each entry is a half-open [start, end) IsoDate interval.
   * Empty array means every night is covered.
   */
  gaps: { start: IsoDate; end: IsoDate }[];
  /**
   * Breaks in a passenger's leg sequence — leg N's arrival airport and leg
   * N+1's departure airport don't belong to the same metro/airport system
   * (matched via airport-metro.ts, not exact string equality, so a NYC
   * itinerary that departs LGA and returns to JFK is never flagged). Only
   * populated when both endpoints resolve to a KNOWN place — an
   * unrecognized airport/city never produces a false gap, it's just
   * skipped. Empty array means every connection checked out (or nothing
   * was checkable).
   */
  legGaps: { afterLegId: TravelLegId; passengerName?: string; arrivedAt: string; departingFrom: string }[];
}

export const CreateTripRequest = z.object({
  name: z.string().trim().min(1).max(120),
  destination: z.string().trim().min(1).max(120),
  startDate: z.string().min(10).max(10),
  endDate: z.string().min(10).max(10),
  participantIds: z.array(z.string()).max(20).default([]),
});
export type CreateTripRequest = z.infer<typeof CreateTripRequest>;

/** Bot tool `update_trip` — corrects a trip's own name/destination/dates
 *  after it was created wrong (e.g. a year typo from a source with no year
 *  printed on it). Every field optional; only the ones supplied change. */
export const UpdateTripRequest = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  destination: z.string().trim().min(1).max(120).optional(),
  startDate: z.string().min(10).max(10).optional(),
  endDate: z.string().min(10).max(10).optional(),
});
export type UpdateTripRequest = z.infer<typeof UpdateTripRequest>;

export const AddTravelLegRequest = z.object({
  tripId: z.string().optional(),
  personaId: z.string().optional(),
  passengerName: z.string().max(120).optional(),
  mode: z.enum(['flight', 'train', 'car', 'ferry', 'other']).default('flight'),
  origin: z.string().trim().min(1).max(80),
  destination: z.string().trim().min(1).max(80),
  departAt: z.string().datetime(),
  arriveAt: z.string().datetime(),
  carrier: z.string().max(80).optional(),
  flightNo: z.string().max(40).optional(),
  confirmation: z.string().max(80).optional(),
  /** ADR 0158 — free-text booking detail (itinerary/order number, etc.). */
  notes: z.string().max(500).optional(),
  sourceDocId: z.string().optional(),
});
export type AddTravelLegRequest = z.infer<typeof AddTravelLegRequest>;

export const AddAccommodationRequest = z.object({
  tripId: z.string().optional(),
  propertyName: z.string().trim().min(1).max(120),
  address: z.string().max(200).optional(),
  /** ADR 0190 — just the city (e.g. "Vail"), not the full address. Used to
   *  match this stay against an existing trip by place, since an
   *  accommodation carries no traveler to chain against the way a leg does. */
  city: z.string().max(80).optional(),
  checkinDate: z.string().min(10).max(10),
  checkoutDate: z.string().min(10).max(10),
  roomCount: z.number().int().positive().max(20).optional(),
  confirmation: z.string().max(80).optional(),
  /** ADR 0158 — free-text booking detail. */
  notes: z.string().max(500).optional(),
  sourceDocId: z.string().optional(),
});
export type AddAccommodationRequest = z.infer<typeof AddAccommodationRequest>;

/** Bot tool `unmerge` follow-up — reverses one specific `mergeTrips` call
 *  from the mobile drag-to-combine "Undo" toast. The caller already holds
 *  the exact row ids and the keeper's pre-merge date range from the
 *  `TripStatus` it had in memory right before merging, so nothing extra
 *  needs to be persisted server-side just to make a mis-drop reversible. */
export const UndoMergeTripsRequest = z.object({
  mergeTripId: z.string().min(1),
  legIds: z.array(z.string()).max(200).default([]),
  accommodationIds: z.array(z.string()).max(200).default([]),
  reservationIds: z.array(z.string()).max(200).default([]),
  keepStartDate: z.string().min(10).max(10),
  keepEndDate: z.string().min(10).max(10),
});
export type UndoMergeTripsRequest = z.infer<typeof UndoMergeTripsRequest>;

export const AddReservationRequest = z.object({
  tripId: z.string().optional(),
  kind: z.enum(['restaurant', 'tour', 'event', 'activity', 'other']).default('other'),
  name: z.string().trim().min(1).max(120),
  dateTime: z.string().datetime({ offset: true }).optional(),
  address: z.string().max(200).optional(),
  confirmation: z.string().max(80).optional(),
  notes: z.string().max(500).optional(),
});
export type AddReservationRequest = z.infer<typeof AddReservationRequest>;
