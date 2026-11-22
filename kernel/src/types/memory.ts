import { z } from 'zod';

import type {
  GroupId,
  IsoDateTime,
  MemoryId,
  UserId,
} from './ids';
import { FACT_CATEGORIES, type FactCategory, type FactSubjectType } from '../family-facts';

export type MemoryScope = 'persona' | 'group' | 'event';
export type MemorySource = 'passive' | 'extracted' | 'explicit';
export type MemoryStatus = 'proposed' | 'confirmed';

export interface Memory {
  id: MemoryId;
  groupId: GroupId;
  /** Owner of a persona-scoped (private) memory: the only person who may
   *  see it. Not necessarily who it is ABOUT — that is `subjectType`/`subjectId`. */
  personaId: UserId | null;
  /** ADR 0333 — who the fact is about, as a person reads it ("Ben",
   *  "Family"). Filled by the fact list routes; absent elsewhere. */
  about?: string;
  scope: MemoryScope;
  key: string;
  value: string;
  source: MemorySource;
  confidence: number;
  /**
   * Family-profile surface (design doc family-profile-design.md). Denormalised
   * identity of what this fact is ABOUT — `'user'` + a users.id, `'persona'` +
   * a personas.id, or `'household'`. Derived from `scope`/`personaId` for
   * legacy rows and kept in lockstep on write. Null only for `scope: 'event'`.
   */
  subjectType?: FactSubjectType | null;
  subjectId?: string | null;
  /** Grouping bucket on the profile surface; `categoryForKey(key)` by default. */
  category?: FactCategory | null;
  /** Where this fact came from: `gmail:<threadId>`, `chat:<msgId>`,
   *  `manual`, `promoted:<origin>`. */
  provenance?: string | null;
  /** For milestones and any fact tied to a day; 'YYYY-MM-DD'. */
  datedAt?: string | null;
  /**
   * Lifecycle gate for bot-proposed facts (ADR 0009). `proposed` rows are
   * pending user review; `confirmed` rows are live and are the only ones
   * injected into future turn context.
   */
  status: MemoryStatus;
  supersededBy: MemoryId | null;
  createdAt: IsoDateTime;
  /**
   * Migration 082 — set only on a `proposed` attribute fact about an
   * already-confirmed subject; `decayMemories` auto-confirms it at this time
   * unless a human acts first. Null means manual confirm only (the default).
   */
  autoConfirmAt?: string | null;
}

/** Add a family-profile fact about a member, a managed persona, or the household. */
export const CreateFactRequest = z.object({
  subjectType: z.enum(['user', 'persona', 'household']),
  /** users.id or personas.id; omitted for `household`. */
  subjectId: z.string().min(1).optional(),
  /** Short label — `allergy`, `shoe_size`, `note`, … */
  key: z.string().trim().min(1).max(80),
  value: z.string().trim().min(1).max(2000),
  category: z.enum(FACT_CATEGORIES).optional(),
  datedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type CreateFactRequest = z.infer<typeof CreateFactRequest>;

/** Edit a family-profile fact (its value / category / date). */
export const UpdateFactRequest = z
  .object({
    value: z.string().trim().min(1).max(2000).optional(),
    category: z.enum(FACT_CATEGORIES).optional(),
    datedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });
export type UpdateFactRequest = z.infer<typeof UpdateFactRequest>;
