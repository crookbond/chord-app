/**
 * The per-group "About this family" payload (design doc
 * `docs/tasks/family-profile-design.md`, Phase 1).
 *
 * Assembles: the roster (`personas`) with each member's confirmed facts
 * grouped under them, the household's facts, and a pending strip of things
 * Chord has proposed and is waiting on a ✓/✕ for.
 *
 * Hybrid scope (ADR 0032 holds): everything here is group-scoped data, so
 * every group member is entitled to read it. The owner's PRIVATE roster stays
 * on the People screen and is not part of this.
 */
import type { Kysely } from 'kysely';

import type { FamilyProfile, Memory, PendingFact, PersonaWithFacts } from '@chord/kernel';

import type { DB } from '../db/schema.js';
import { listFamilyFacts } from './memory.service.js';
import { listPersonas } from './personas.service.js';

function factBelongsToPersona(
  fact: Memory,
  persona: { memberUserId: string | null; id: string },
): boolean {
  if (fact.subjectType === 'user') return fact.subjectId === persona.memberUserId;
  if (fact.subjectType === 'persona') return fact.subjectId === persona.id;
  return false;
}

export async function getGroupProfile(db: Kysely<DB>, groupId: string, viewerId: string): Promise<FamilyProfile> {
  const [personas, facts] = await Promise.all([
    listPersonas(db, groupId),
    // ADR 0333 — the chat's shared facts and the viewer's own private ones;
    // another member's private facts are not on this screen.
    listFamilyFacts(db, groupId, { viewerId }),
  ]);

  const confirmed = facts.filter((f) => f.status === 'confirmed');
  const proposedFacts = facts.filter((f) => f.status === 'proposed');

  const withFacts: PersonaWithFacts[] = personas.map((p) => ({
    ...p,
    facts: confirmed.filter((f) => factBelongsToPersona(f, p)),
  }));

  const household = confirmed.filter((f) => f.subjectType === 'household');

  // Pending strip: proposed facts in this group + any add_person /
  // add_important_date proposals staged directly here. (Email-derived person
  // proposals live in the owner's PERSONAL group — People screen — not here.)
  const personaNameById = new Map(personas.map((p) => [p.id, p.name] as const));
  const personaNameByUser = new Map(
    personas.filter((p) => p.memberUserId).map((p) => [p.memberUserId!, p.name] as const),
  );
  const subjectLabel = (f: Memory): string => {
    if (f.subjectType === 'user') return personaNameByUser.get(f.subjectId ?? '') ?? 'Someone';
    if (f.subjectType === 'persona') return personaNameById.get(f.subjectId ?? '') ?? 'Someone';
    return 'The household';
  };

  const proposalRows = await db
    .selectFrom('proposals')
    .select(['id', 'tool_name', 'args_json', 'provenance'])
    .where('group_id', '=', groupId)
    .where('tool_name', 'in', ['add_person', 'add_important_date'])
    .where('status', '=', 'pending')
    .orderBy('created_at', 'desc')
    .execute();

  const pending: PendingFact[] = [
    ...proposedFacts.map(
      (f): PendingFact => ({
        id: f.id,
        kind: 'fact',
        title: `${subjectLabel(f)} · ${f.key}`,
        detail: f.value,
        sourceHref: null,
      }),
    ),
    ...proposalRows.map((r): PendingFact => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(r.args_json) as Record<string, unknown>;
      } catch {
        /* keep {} */
      }
      const name = typeof args.displayName === 'string' ? args.displayName : (args.personName as string) ?? '?';
      return {
        id: r.id,
        kind: r.tool_name === 'add_person' ? 'person' : 'date',
        title:
          r.tool_name === 'add_person'
            ? `Add ${name} to the family?`
            : `${name}: ${(args.kind as string) ?? 'date'} ${(args.date as string) ?? ''}`.trim(),
        detail: typeof args.notes === 'string' ? args.notes : null,
        sourceHref: null,
      };
    }),
  ];

  return { personas: withFacts, household, pending };
}
