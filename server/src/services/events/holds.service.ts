/**
 * ADR 0346 phase 4 - a hold keeps an agreed slot free in Chord while the
 * other side's invitation is on its way.
 *
 * A hold is not an event and is never written anywhere: it is read off the
 * meeting record (a time agreed, the invite not the user's to send, no
 * invitation linked yet, no event made from the thread). So it is gone the
 * moment the invite links or the event exists, and it can never reach Google,
 * Outlook, a work calendar, or another family member. It blocks Chord's own
 * free-time checks and shows in the user's briefing and calendar screen.
 */
import { sql, type Kysely } from 'kysely';

import type { MeetingHold } from '@chord/kernel';

import type { DB } from '../../db/schema.js';

/** A hold whose invite has not come in this long is not held any more. */
export const HOLD_DAYS = 7;

export async function activeHolds(
  db: Kysely<DB>,
  userId: string,
  window?: { fromMs?: number; toMs?: number },
  nowMs = Date.now(),
): Promise<MeetingHold[]> {
  const rows = await db
    .selectFrom('meetings')
    .select(['id', 'thread_key', 'core_people', 'agreed_start', 'agreed_end', 'facts_json', 'updated_at', 'invite_by'])
    .where('user_id', '=', userId)
    .where('state', '=', 'agreed')
    .where('invite_by', '!=', 'me')
    .where('hold_dropped_at', 'is', null)
    .where('agreed_start', 'is not', null)
    .where('updated_at', '>', new Date(nowMs - HOLD_DAYS * 86_400_000).toISOString())
    // An event made from the thread blocks the time itself.
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom('events')
            .select(sql`1`.as('one'))
            .where('events.owner_user_id', '=', userId)
            .where('events.deleted_at', 'is', null)
            .whereRef('events.source_raw_context', '=', 'meetings.thread_key'),
        ),
      ),
    )
    .execute();
  const out: MeetingHold[] = [];
  const firstPeople = [...new Set(rows.map((r) => r.core_people[0]).filter((p): p is string => !!p))];
  const names = new Map<string, string>();
  if (firstPeople.length > 0) {
    const named = await db
      .selectFrom('email_messages')
      .select(['from_email', 'from_name'])
      .where('user_id', '=', userId)
      .where(sql<boolean>`lower(from_email) in (${sql.join(firstPeople)})`)
      .where('from_name', 'is not', null)
      .limit(200)
      .execute();
    for (const n of named) if (n.from_email && n.from_name) names.set(n.from_email.toLowerCase(), n.from_name);
  }
  for (const r of rows) {
    const startMs = Date.parse(r.agreed_start!);
    const endMs = r.agreed_end ? Date.parse(r.agreed_end) : startMs + 3600_000;
    if (!Number.isFinite(startMs) || endMs <= nowMs) continue;
    if (window?.fromMs !== undefined && endMs <= window.fromMs) continue;
    if (window?.toMs !== undefined && startMs >= window.toMs) continue;
    const who = r.core_people[0];
    const local = who?.split('@')[0]!.split(/[._+-]/)[0] ?? '';
    const name = who
      ? (names.get(who)?.split(/\s+/)[0] ?? (local ? local[0]!.toUpperCase() + local.slice(1) : null))
      : null;
    out.push({
      meetingId: r.id,
      threadKey: r.thread_key,
      title: r.facts_json?.title ?? (name ? `Meeting with ${name}` : 'Meeting'),
      withName: name,
      people: r.core_people,
      startsAt: r.agreed_start!,
      endsAt: r.agreed_end ?? new Date(endMs).toISOString(),
    });
  }
  out.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  return out;
}

export type DropHoldResult = { ok: true; title: string } | { ok: false; reason: 'not_found' | 'ambiguous'; candidates?: string[] };

/** Stop holding a slot. The meeting itself is left as it is. */
export async function dropHold(
  db: Kysely<DB>,
  userId: string,
  pick: { meetingId?: string; name?: string },
): Promise<DropHoldResult> {
  const holds = await activeHolds(db, userId);
  const q = pick.name?.trim().toLowerCase();
  const hits = pick.meetingId
    ? holds.filter((h) => h.meetingId === pick.meetingId)
    : holds.filter(
        (h) =>
          !!q &&
          (h.title.toLowerCase().includes(q) ||
            (h.withName ?? '').toLowerCase().includes(q) ||
            h.people.some((p) => p.includes(q))),
      );
  if (hits.length === 0) return { ok: false, reason: 'not_found' };
  if (hits.length > 1) return { ok: false, reason: 'ambiguous', candidates: hits.map((h) => h.title) };
  await db
    .updateTable('meetings')
    .set({ hold_dropped_at: new Date().toISOString() })
    .where('id', '=', hits[0]!.meetingId)
    .where('user_id', '=', userId)
    .execute();
  return { ok: true, title: hits[0]!.title };
}

/** The briefing's "waiting on" lines, printed by code. `answers`: group
 *  meetings the user is arranging, and who has not answered yet. */
export function renderWaitingSection(
  holds: MeetingHold[],
  tz: string | null,
  answers: Array<{ title: string; waiting: string[] }> = [],
): string | null {
  if (holds.length === 0 && answers.length === 0) return null;
  const nameOf = (a: string) => {
    const l = a.split('@')[0]!.split(/[._+-]/)[0] ?? a;
    return l ? l[0]!.toUpperCase() + l.slice(1) : a;
  };
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString('en-US', {
      timeZone: tz ?? 'UTC',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  const lines = holds
    .slice(0, 6)
    .map((h) => `• ${h.withName ? `Waiting on ${h.withName}'s invite` : 'Waiting on the invite'} for ${fmt(h.startsAt)} (${h.title}) - held in Chord`);
  const asked = answers
    .slice(0, 6)
    .map((a) => `• Waiting on ${a.waiting.map(nameOf).join(', ')} to answer the times for ${a.title}`);
  return ['⏳ Waiting on', ...lines, ...asked].join('\n');
}
