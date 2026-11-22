/**
 * ADR 0016 — family graph (first slice); relationships completed in
 * migration 082 / docs/notes/0189 (`PersonRelationship` below).
 *
 * Addresses and contact methods are still deliberately deferred until a
 * consumer needs them.
 */
import type { IsoDate, IsoDateTime, UserId } from './ids';

export type PersonId = string & { readonly __personIdBrand: unique symbol };
export type ImportantDateId = string & { readonly __importantDateIdBrand: unique symbol };

export type ImportantDateKind = 'birthday' | 'anniversary' | 'death' | 'other';

export interface Person {
  id: PersonId;
  ownerUserId: UserId;
  displayName: string;
  notes?: string;
  /** ADR 0076 — sender anchor. Kept off the bare `Person` for a while after
   *  0076 shipped; present here now that `PersonRelationship`/profile reads
   *  need every `Person` consumer to see it, not just `PersonWithDates`. */
  email?: string | null;
  /** ADR 0212 — phone number as the user gave it. */
  phone?: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ImportantDate {
  id: ImportantDateId;
  personId: PersonId;
  kind: ImportantDateKind;
  /** 'YYYY-MM-DD'. Year may be '0000' when unknown — use with `recurs`. */
  date: IsoDate;
  recurs: boolean;
}

/** Wire shape for the calendar's Important Days feed. */
export interface ImportantDay {
  id: ImportantDateId;
  personId: PersonId;
  personName: string;
  kind: ImportantDateKind;
  /** Raw stored date — year may be '0000'. */
  date: IsoDate;
  recurs: boolean;
}

/** ADR 0076/0078 — a confirmed fact Chord has learned about this person
 *  (from chat/email extraction the owner accepted in the Memory tab). */
export interface PersonFact {
  key: string;
  value: string;
}

/** Wire shape for the People list (manual UI). */
export interface PersonWithDates {
  id: PersonId;
  ownerUserId: UserId;
  displayName: string;
  notes: string | null;
  /** ADR 0076 — known email address (sender anchor), when learned. */
  email?: string | null;
  /** ADR 0212 — phone number as the user gave it. */
  phone?: string | null;
  /** Confirmed memories that mention this person. Absent = none. */
  facts?: PersonFact[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  importantDates: ImportantDate[];
}

/** A staged add_person / add_important_date proposal awaiting ✓/✕ —
 *  surfaced at the top of the People screen. Resolves via the standard
 *  proposal confirm/reject routes. */
export interface PendingPersonSuggestion {
  proposalId: string;
  kind: 'person' | 'date';
  title: string;
  detail: string | null;
  /** In-app route to what generated the suggestion (the source email thread),
   *  so the user can check before accepting. Absent when unresolvable. */
  sourceHref?: string | null;
}

import { z } from 'zod';

export const CreatePersonRequest = z.object({
  displayName: z.string().trim().min(1).max(100),
  notes: z.string().trim().max(500).optional(),
});
export type CreatePersonRequest = z.infer<typeof CreatePersonRequest>;

/** ADR 0212 — omitted leaves a field alone; `null` or '' clears it. */
export const UpdatePersonRequest = z.object({
  displayName: z.string().trim().min(1).max(100).optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  email: z.union([z.string().trim().email().max(200), z.literal(''), z.null()]).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
});
export type UpdatePersonRequest = z.infer<typeof UpdatePersonRequest>;

export const ImportantDateKindSchema = z.enum(['birthday', 'anniversary', 'death', 'other']);

export const AddImportantDateRequest = z.object({
  kind: ImportantDateKindSchema,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  recurs: z.boolean().optional(),
});
export type AddImportantDateRequest = z.infer<typeof AddImportantDateRequest>;

/**
 * Migration 082 — canonical relationship vocabulary, mirroring the enum
 * `person-extraction.ts`'s own extraction prompt already asks the model for
 * (`spouse|partner|kid|parent|sibling|friend|teacher|coach|doctor|other`),
 * plus `travel_companion` (ADR 0158's non-owner-passenger proposal). See
 * `people.service.ts`'s `normalizeRelation` for the free-text → this mapping.
 */
export const RELATION_KINDS = [
  'spouse',
  'partner',
  'kid',
  'parent',
  'sibling',
  'friend',
  'teacher',
  'coach',
  'doctor',
  'travel_companion',
  'other',
] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

export type RelationSubjectType = 'user' | 'persona' | 'person';

/**
 * A structural edge: `relatedId` IS `relation` OF `subjectId` — e.g.
 * subject=the asker, relation='kid', related=Ben reads "Ben is the
 * asker's kid" (matches `person-extraction.ts`'s own prompt framing,
 * "the relationship is TO THE USER"). Deliberately no supersede chain: two
 * people can hold several relation kinds to each other at once. Always fully
 * proposal-gated (never the `memories` lighter bar) — see docs/notes/0189.
 */
export interface PersonRelationship {
  id: string;
  ownerUserId: UserId;
  subjectType: RelationSubjectType;
  subjectId: string;
  relatedType: RelationSubjectType;
  relatedId: string;
  relation: RelationKind;
  confidence: number;
  status: 'proposed' | 'confirmed';
  source: 'passive' | 'extracted' | 'explicit';
  provenance?: string | null;
  createdAt: IsoDateTime;
}

/**
 * A relationship edge with both ends' display names resolved — the full
 * sentence ("`subjectName` is `relation` of `relatedName`"), not just "the
 * other end", so a consumer (the `get_person_profile` bot tool) never has to
 * invert the relation word's grammar to phrase it correctly either direction.
 */
export interface ResolvedRelationship {
  relation: RelationKind;
  subjectName: string;
  subjectType: RelationSubjectType;
  relatedName: string;
  relatedType: RelationSubjectType;
  status: 'proposed' | 'confirmed';
}

/** A recent-activity mention on a person profile — always derived live from
 *  trips/tasks/events, never stored as its own fact (ADR 0135/0138's
 *  render-don't-restate rule applied to people). */
export interface PersonActivityMention {
  kind: 'trip' | 'task' | 'event';
  id: string;
  title: string;
  /** ISO date/time this activity anchors to (departAt/dueAt/startsAt); null when undated. */
  at: string | null;
}

/** "Tell me about X" — assembled read (`get_person_profile` bot tool /
 *  `people.service.ts`'s `getPersonProfile`). Never itself persisted. */
export interface PersonProfile {
  person: PersonWithDates;
  relationships: ResolvedRelationship[];
  facts: PersonFact[];
  recentActivity: PersonActivityMention[];
}
