/**
 * ADR 0346 phase 5 - "Send Rob an invite, or wait for his?" answered with
 * wait: the card is dismissed, the meeting records that their side sends,
 * and the slot is held (phase 4) until their invitation arrives. Shared by
 * the card's button and the `wait_for_invite` chat tool.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema.js';
import { rejectProposal } from '../proposals.service.js';

export type WaitForInviteResult =
  | { ok: true; title: string }
  | { ok: false; reason: 'not_found' | 'not_asking' | 'ambiguous'; candidates?: string[] };

interface Asking {
  id: string;
  title: string;
  provenance: string;
  invitees: string[];
}

/** The user's pending meeting cards that ask who sends the invite. */
export async function cardsAskingWhoSends(db: Kysely<DB>, userId: string): Promise<Asking[]> {
  const rows = await db
    .selectFrom('proposals')
    .select(['id', 'args_json', 'provenance'])
    .where('proposed_by_user_id', '=', userId)
    .where('status', '=', 'pending')
    .where('tool_name', '=', 'create_event')
    .where('expires_at', '>', new Date().toISOString())
    .where('provenance', 'like', 'gmail:%')
    .execute();
  const out: Asking[] = [];
  for (const r of rows) {
    let a: Record<string, unknown>;
    try {
      a = JSON.parse(r.args_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (a.whoSends !== 'ask') continue;
    out.push({
      id: r.id,
      title: typeof a.title === 'string' ? a.title : 'Meeting',
      provenance: r.provenance!,
      invitees: Array.isArray(a.invitees) ? a.invitees.filter((e): e is string => typeof e === 'string') : [],
    });
  }
  return out;
}

export async function waitForTheirInvite(
  db: Kysely<DB>,
  userId: string,
  pick: { proposalId?: string; name?: string },
): Promise<WaitForInviteResult> {
  const asking = await cardsAskingWhoSends(db, userId);
  const q = pick.name?.trim().toLowerCase();
  const hits = pick.proposalId
    ? asking.filter((a) => a.id === pick.proposalId)
    : asking.filter((a) => !!q && (a.title.toLowerCase().includes(q) || a.invitees.some((e) => e.includes(q))));
  if (hits.length === 0) {
    if (pick.proposalId) {
      const any = await db
        .selectFrom('proposals')
        .select('id')
        .where('id', '=', pick.proposalId)
        .where('proposed_by_user_id', '=', userId)
        .executeTakeFirst();
      return { ok: false, reason: any ? 'not_asking' : 'not_found' };
    }
    return { ok: false, reason: 'not_found' };
  }
  if (hits.length > 1) return { ok: false, reason: 'ambiguous', candidates: hits.map((h) => h.title) };
  const card = hits[0]!;
  await rejectProposal(db, { id: card.id, resolvedByUserId: userId });
  await db
    .updateTable('meetings')
    .set({ invite_by: 'them', hold_dropped_at: null, updated_at: new Date().toISOString() })
    .where('user_id', '=', userId)
    .where('thread_key', '=', card.provenance)
    .execute();
  return { ok: true, title: card.title };
}
