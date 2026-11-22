/**
 * Family personas — the universal "family member" abstraction for the
 * per-group family-profile surface (design doc
 * `docs/tasks/family-profile-design.md`).
 *
 * Every member of a shared (`kind='group'`) group is a persona. The ones with
 * a Chord account carry `memberUserId`; managed non-users (kids, grandparents,
 * a caregiver) carry `isManaged` + `managedBy`. `group_members` stays the
 * auth/permission truth; personas is the roster truth.
 *
 * Not related to `BotPersona` (ADR 0027 — the configurable bot voice).
 */
import { z } from 'zod';

import type { GroupId, IsoDateTime, UserId } from './ids';
import type { Memory } from './memory';

export type PersonaId = string;

export type HouseholdRole = 'parent' | 'child' | 'grandparent' | 'caregiver' | 'other';
export const HOUSEHOLD_ROLES: readonly HouseholdRole[] = [
  'parent',
  'child',
  'grandparent',
  'caregiver',
  'other',
] as const;

export interface Persona {
  id: PersonaId;
  groupId: GroupId;
  /** Set iff this member has a Chord account. */
  memberUserId: UserId | null;
  name: string;
  householdRole: HouseholdRole;
  isManaged: boolean;
  /** Who may edit a managed persona. Null for account-linked personas. */
  managedBy: UserId | null;
  /** 'YYYY-MM-DD'; null when unknown. */
  birthdate: string | null;
  /** Optional bridge to an owner's private `people` row. */
  linkedPersonId: string | null;
  createdAt: IsoDateTime;
}

const roleSchema = z.enum(['parent', 'child', 'grandparent', 'caregiver', 'other']);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CreatePersonaRequest = z.object({
  name: z.string().trim().min(1).max(100),
  householdRole: roleSchema,
  birthdate: dateSchema.optional(),
});
export type CreatePersonaRequest = z.infer<typeof CreatePersonaRequest>;

export const UpdatePersonaRequest = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  householdRole: roleSchema.optional(),
  birthdate: dateSchema.nullable().optional(),
});
export type UpdatePersonaRequest = z.infer<typeof UpdatePersonaRequest>;

/**
 * Promote a person from the caller's PRIVATE People roster into a shared
 * group — creates a managed persona there and copies the person's dates /
 * note / email as facts (provenance `promoted:person:<id>`). One-directional.
 */
export const PromotePersonRequest = z.object({
  fromPersonId: z.string().min(1),
});
export type PromotePersonRequest = z.infer<typeof PromotePersonRequest>;

export interface PromotePersonResult {
  persona: Persona;
  /** How many facts were copied across. */
  facts: number;
  /** True when an existing managed persona of the same name was reused. */
  reused: boolean;
}

/** A persona plus the facts about them, for the "About this family" view. */
export interface PersonaWithFacts extends Persona {
  facts: Memory[];
}

/**
 * A staged fact awaiting the user's ✓/✕ on the profile surface — an
 * `add_person` / `add_important_date` proposal, or a `proposed` memory.
 * Resolved through the standard proposal / memory confirm routes.
 */
export interface PendingFact {
  /** proposal id, or memory id when `kind: 'fact'`. */
  id: string;
  kind: 'person' | 'date' | 'fact';
  title: string;
  detail: string | null;
  /** In-app route to what generated it (the source email), when resolvable. */
  sourceHref: string | null;
}

/** The per-group family-profile payload — `GET /groups/:id/profile`. */
export interface FamilyProfile {
  personas: PersonaWithFacts[];
  /** Facts about the household, not one member. */
  household: Memory[];
  pending: PendingFact[];
}
