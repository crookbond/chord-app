/**
 * An email can change something the user already has (ADR 0248).
 *
 * The suggestion pass shows the model a short labelled list of the user's
 * real items (`e3 calendar: Squash Singles 3 - 2026-10-16 17:30`, `t1 to-do:
 * Pay Con Ed bill`, `p2 suggested event: …`) and the model may answer
 * "change e3: remove / move / done / drop". The model names WHICH item and
 * WHAT happened; everything after that is code: the label maps back to the
 * row, the row is re-read, the action has to fit it, a new time has to be
 * real and ahead, and the result is a card the user taps, never a silent
 * write. A suggestion that was never accepted is simply taken back.
 */
import type { Kysely } from 'kysely';

import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { instantInZoneMs, isAllDayValue } from '../../utils/tz.js';
import { effectiveEndMs } from '../conflicts.service.js';
import { expireProposals } from '../event-convergence.service.js';
import { createProposal } from '../proposals.service.js';
import type { ChangeTarget } from './magics-context.js';
import { readOnlyCalendars, sourceCalendarOf } from './read-only-calendars.js';
import type { ChangeSuggestion } from './magics.service.js';

const MIN_CARD_TTL_MS = 60 * 60_000;
const MAX_CARD_TTL_MS = 72 * 60 * 60_000;

/** The tools a change card can carry. */
export const EMAIL_CHANGE_TOOLS = ['delete_event', 'update_event', 'complete_task', 'update_task'] as const;

export type ChangeSkipReason =
  | 'unknown_label'
  | 'wrong_action'
  | 'gone'
  | 'past'
  | 'bad_time'
  | 'card_exists'
  /** A move to the time the item already has. */
  | 'unchanged'
  /** A copy on a calendar the user can only read (a subscribed feed): an
   *  edit there is overwritten by the next pull, and the feed moves itself. */
  | 'read_only';

export interface EmailChangesOutcome {
  /** Cards staged for the user to confirm. */
  staged: number;
  /** Pending suggestions taken back (and re-suggested, for a move). */
  withdrawn: number;
  skipped: Array<{ target: string; reason: ChangeSkipReason }>;
}

/** "Fri, Oct 16 at 5:30 PM", in the user's zone; "Fri, Oct 16 (all day)". */
export function friendlyWhen(iso: string, tz: string | null | undefined): string {
  if (isAllDayValue(iso)) return `${friendlyDay(iso, tz)} (all day)`;
  const ms = instantInZoneMs(iso, tz);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  const zone = tz ?? 'UTC';
  try {
    const day = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' }).format(d);
    const time = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(d);
    return `${day} at ${time}`;
  } catch {
    return iso;
  }
}

function friendlyDay(iso: string, tz: string | null | undefined): string {
  const ms = instantInZoneMs(iso, tz);
  if (!Number.isFinite(ms)) return iso;
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz ?? 'UTC',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(new Date(ms));
  } catch {
    return iso;
  }
}

function fits(target: ChangeTarget, action: ChangeSuggestion['action']): boolean {
  if (target.kind === 'event') return action === 'remove' || action === 'move';
  if (target.kind === 'task') return action === 'done' || action === 'drop' || action === 'move';
  return action === 'remove' || action === 'move';
}

/** Same instant (or both unset), whatever the string shape. */
function sameMoment(a: string | null | undefined, b: string | null | undefined, tz: string | null): boolean {
  if (!a || !b) return !a && !b;
  return instantInZoneMs(a, tz) === instantInZoneMs(b, tz);
}

function ttlUntil(msList: number[], now: number): number {
  const soonest = Math.min(...msList.filter(Number.isFinite));
  const left = Number.isFinite(soonest) ? soonest - now : MAX_CARD_TTL_MS;
  return Math.min(MAX_CARD_TTL_MS, Math.max(MIN_CARD_TTL_MS, left));
}

/** Ids already carrying a change card: pending from anywhere, or any status
 *  from THIS email, so a card the user dismissed is not offered again. */
async function targetsWithCards(
  db: Kysely<DB>,
  userId: string,
  provenance: string,
): Promise<Set<string>> {
  const rows = await db
    .selectFrom('proposals')
    .select(['args_json', 'status', 'provenance'])
    .where('proposed_by_user_id', '=', userId)
    .where('tool_name', 'in', [...EMAIL_CHANGE_TOOLS])
    .where((eb) => eb.or([eb('status', '=', 'pending'), eb('provenance', '=', provenance)]))
    .execute();
  const out = new Set<string>();
  for (const r of rows) {
    try {
      const a = JSON.parse(r.args_json) as { eventId?: string; taskId?: string };
      if (a.eventId) out.add(a.eventId);
      if (a.taskId) out.add(a.taskId);
    } catch {
      /* unparseable — ignore */
    }
  }
  return out;
}

export async function applyEmailChanges(
  db: Kysely<DB>,
  args: {
    userId: string;
    personalGroupId: string;
    userTz: string | null;
    /** The changing email's own thread. */
    provenance: string;
    changes: ChangeSuggestion[];
    targets: Map<string, ChangeTarget>;
    nowMs?: number;
  },
): Promise<EmailChangesOutcome> {
  const { userId, userTz } = args;
  const zoned = (iso: string) => instantInZoneMs(iso, userTz);
  const now = args.nowMs ?? Date.now();
  const outcome: EmailChangesOutcome = { staged: 0, withdrawn: 0, skipped: [] };
  const carded = await targetsWithCards(db, userId, args.provenance);
  const readOnly = await readOnlyCalendars(db, userId);
  const skip = (target: string, reason: ChangeSkipReason) => outcome.skipped.push({ target, reason });

  for (const c of args.changes) {
    const target = args.targets.get(c.target);
    if (!target) {
      skip(c.target, 'unknown_label');
      continue;
    }
    if (!fits(target, c.action)) {
      skip(c.target, 'wrong_action');
      continue;
    }
    const why = c.why ? { why: c.why } : {};

    if (target.kind === 'event') {
      const row = await db
        .selectFrom('events')
        .select(['id', 'title', 'starts_at', 'ends_at', 'series_id', 'google_calendar_id', 'external_uid'])
        .where('id', '=', target.id)
        .where('owner_user_id', '=', userId)
        .where('deleted_at', 'is', null)
        .where('status', '!=', 'cancelled')
        .executeTakeFirst();
      if (!row) {
        skip(c.target, 'gone');
        continue;
      }
      // Past once it has ENDED: an event under way, or an all-day event today,
      // can still be cancelled or moved.
      const oldMs = instantInZoneMs(row.starts_at, userTz);
      if (!Number.isFinite(oldMs) || effectiveEndMs(row.starts_at, row.ends_at, userTz) <= now) {
        skip(c.target, 'past');
        continue;
      }
      const cal = sourceCalendarOf(row);
      if (cal && readOnly.has(cal)) {
        skip(c.target, 'read_only');
        continue;
      }
      if (carded.has(row.id)) {
        skip(c.target, 'card_exists');
        continue;
      }
      const scope = row.series_id ? { scope: 'this' as const } : {};
      const display = { eventTitle: row.title, eventStartsAt: row.starts_at };
      if (c.action === 'remove') {
        await createProposal(db, {
          groupId: args.personalGroupId,
          proposedByUserId: userId,
          proposedByMessageId: null,
          toolName: 'delete_event',
          args: { eventId: row.id, ...scope, ...display, ...why },
          provenance: args.provenance,
          ttlMs: ttlUntil([oldMs], now),
        });
      } else {
        const newMs = c.startsAt ? zoned(c.startsAt) : NaN;
        if (!Number.isFinite(newMs)) {
          skip(c.target, 'bad_time');
          continue;
        }
        if (newMs < now) {
          skip(c.target, 'past');
          continue;
        }
        if (newMs === oldMs && (!c.endsAt || sameMoment(c.endsAt, row.ends_at, userTz))) {
          skip(c.target, 'unchanged');
          continue;
        }
        // A move that gives no end keeps the booking's own length.
        const oldEnd = row.ends_at ? instantInZoneMs(row.ends_at, userTz) : NaN;
        const endsAt =
          c.endsAt && Number.isFinite(zoned(c.endsAt)) && zoned(c.endsAt) > newMs
            ? c.endsAt
            : Number.isFinite(oldEnd) && oldEnd > oldMs
              ? new Date(newMs + (oldEnd - oldMs)).toISOString()
              : undefined;
        await createProposal(db, {
          groupId: args.personalGroupId,
          proposedByUserId: userId,
          proposedByMessageId: null,
          toolName: 'update_event',
          args: {
            eventId: row.id,
            startsAt: c.startsAt,
            ...(endsAt ? { endsAt } : {}),
            ...scope,
            ...display,
            ...why,
          },
          provenance: args.provenance,
          ttlMs: ttlUntil([oldMs, newMs], now),
        });
      }
      carded.add(row.id);
      outcome.staged += 1;
      logger.info('email change staged', { userId, action: c.action, targetKind: 'event' });
      continue;
    }

    if (target.kind === 'task') {
      const row = await db
        .selectFrom('tasks')
        .innerJoin('group_members', 'group_members.group_id', 'tasks.group_id')
        .select(['tasks.id as id', 'tasks.title as title', 'tasks.due_at as due_at'])
        .where('tasks.id', '=', target.id)
        .where('group_members.user_id', '=', userId)
        .where('tasks.status', 'in', ['open', 'active'])
        .where('tasks.archived_at', 'is', null)
        .executeTakeFirst();
      if (!row) {
        skip(c.target, 'gone');
        continue;
      }
      if (carded.has(row.id)) {
        skip(c.target, 'card_exists');
        continue;
      }
      if (c.action === 'move') {
        const dueMs = c.dueAt ? zoned(c.dueAt) : NaN;
        if (!Number.isFinite(dueMs)) {
          skip(c.target, 'bad_time');
          continue;
        }
        if (dueMs < now) {
          skip(c.target, 'past');
          continue;
        }
        if (sameMoment(c.dueAt, row.due_at, userTz)) {
          skip(c.target, 'unchanged');
          continue;
        }
        await createProposal(db, {
          groupId: args.personalGroupId,
          proposedByUserId: userId,
          proposedByMessageId: null,
          toolName: 'update_task',
          args: { taskId: row.id, dueAt: c.dueAt, taskTitle: row.title, ...why },
          provenance: args.provenance,
          ttlMs: MAX_CARD_TTL_MS,
        });
      } else {
        await createProposal(db, {
          groupId: args.personalGroupId,
          proposedByUserId: userId,
          proposedByMessageId: null,
          toolName: 'complete_task',
          args: { taskId: row.id, ...(c.action === 'drop' ? { drop: true } : {}), taskTitle: row.title, ...why },
          provenance: args.provenance,
          ttlMs: MAX_CARD_TTL_MS,
        });
      }
      carded.add(row.id);
      outcome.staged += 1;
      logger.info('email change staged', { userId, action: c.action, targetKind: 'task' });
      continue;
    }

    // A suggestion nobody accepted yet: take it back, and for a move offer it
    // again at the new time, still under the email it came from.
    const row = await db
      .selectFrom('proposals')
      .select(['id', 'group_id', 'tool_name', 'args_json', 'provenance', 'target_group_id'])
      .where('id', '=', target.id)
      .where('proposed_by_user_id', '=', userId)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (!row) {
      skip(c.target, 'gone');
      continue;
    }
    let held: Record<string, unknown>;
    try {
      held = JSON.parse(row.args_json) as Record<string, unknown>;
    } catch {
      skip(c.target, 'gone');
      continue;
    }
    if (c.action === 'move') {
      const isEvent = row.tool_name === 'create_event';
      const when = isEvent ? c.startsAt : (c.dueAt ?? c.startsAt);
      const ms = when ? zoned(when) : NaN;
      if (!Number.isFinite(ms)) {
        skip(c.target, 'bad_time');
        continue;
      }
      if (ms < now) {
        skip(c.target, 'past');
        continue;
      }
      const heldWhen = isEvent ? held.startsAt : (held.dueAt ?? held.startsAt);
      if (typeof heldWhen === 'string' && sameMoment(when, heldWhen, userTz)) {
        skip(c.target, 'unchanged');
        continue;
      }
      let moved: Record<string, unknown>;
      if (isEvent) {
        const oldStart = typeof held.startsAt === 'string' ? zoned(held.startsAt) : NaN;
        const oldEnd = typeof held.endsAt === 'string' ? zoned(held.endsAt) : NaN;
        const { endsAt: _old, ...rest } = held;
        const endsAt =
          c.endsAt && zoned(c.endsAt) > ms
            ? c.endsAt
            : Number.isFinite(oldStart) && Number.isFinite(oldEnd) && oldEnd > oldStart
              ? new Date(ms + (oldEnd - oldStart)).toISOString()
              : undefined;
        moved = { ...rest, startsAt: when, ...(endsAt ? { endsAt } : {}) };
      } else {
        moved = { ...held, dueAt: when };
      }
      await expireProposals(db, [row.id]);
      await createProposal(db, {
        groupId: row.group_id,
        proposedByUserId: userId,
        proposedByMessageId: null,
        toolName: row.tool_name,
        args: moved,
        provenance: row.provenance,
        targetGroupId: row.target_group_id,
        ttlMs: ttlUntil([ms], now),
      });
    } else {
      await expireProposals(db, [row.id]);
    }
    outcome.withdrawn += 1;
    logger.info('email change staged', { userId, action: c.action, targetKind: 'pending' });
  }

  if (outcome.skipped.length > 0) {
    logger.info('email change skipped', { userId, skipped: outcome.skipped });
  }
  return outcome;
}
