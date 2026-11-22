/**
 * ADR 0076 — the one consent path for a person Chord learned about (from mail,
 * a chat fact, or a travel booking): an `add_person` proposal that lands on the
 * People screen's pending strip. Deduped against known people + pending
 * proposals.
 *
 * Extracted from `person-extraction.ts` (ADR 0158) so `trip-extraction.ts` can
 * propose a flight's non-owner passenger without importing that module — which
 * would close a `magics → trip-extraction → person-extraction → magics` cycle.
 */
import type { Kysely } from 'kysely';

import { toolSchemas } from '../bot/tools.js';
import type { DB } from '../../db/schema.js';
import { findPersonByEmail, findPersonByName } from '../people.service.js';
import { createProposal } from '../proposals.service.js';

export async function stagePersonProposal(
  db: Kysely<DB>,
  input: {
    userId: string;
    groupId: string;
    name: string;
    relationship?: string;
    email?: string;
    provenance: string;
  },
): Promise<boolean> {
  const known =
    (input.email ? await findPersonByEmail(db, input.userId, input.email) : null) ??
    (await findPersonByName(db, input.userId, input.name));
  if (known) return false;
  if (await hasPendingPersonProposal(db, input.userId, input.name)) return false;
  const args = {
    displayName: input.name,
    ...(input.relationship ? { notes: `${input.relationship} (from email)` } : {}),
    ...(input.email ? { email: input.email } : {}),
  };
  if (!toolSchemas.add_person.safeParse(args).success) return false;
  await createProposal(db, {
    groupId: input.groupId,
    proposedByUserId: input.userId,
    proposedByMessageId: null,
    toolName: 'add_person',
    args,
    provenance: input.provenance,
  });
  return true;
}

export async function hasPendingPersonProposal(
  db: Kysely<DB>,
  userId: string,
  name: string,
): Promise<boolean> {
  const rows = await db
    .selectFrom('proposals')
    .select('args_json')
    .where('proposed_by_user_id', '=', userId)
    .where('tool_name', '=', 'add_person')
    .where('status', '=', 'pending')
    .execute();
  const wanted = name.trim().toLowerCase();
  return rows.some((r) => {
    try {
      const args = JSON.parse(r.args_json) as { displayName?: string };
      return args.displayName?.trim().toLowerCase() === wanted;
    } catch {
      return false;
    }
  });
}
