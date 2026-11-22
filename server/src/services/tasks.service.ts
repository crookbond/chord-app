import { sql, type Kysely } from 'kysely';

import type { CreateTaskRequest, Task } from '@chord/kernel';
import { normalizeText } from '@chord/kernel';

import type { DB, TaskArchivedReason, TasksTable } from '../db/schema.js';
import { instantMs } from '../db/text-instant.js';
import { newId } from '../utils/ids.js';
import { likeContains } from '../utils/like.js';
import { loadDisplayNames } from '../utils/display-names.js';
import { fanoutAssignment } from './catchup/folders.service.js';
import { logger } from '../config/logging.js';
import { isMember } from './groups.service.js';
import { TrustError, isTrusted, isTrustedForPersona } from './trust.service.js';

export function rowToTask(row: TasksTable): Task {
  return {
    id: row.id,
    groupId: row.group_id,
    title: row.title,
    details: row.details ?? undefined,
    assigneeId: row.assignee_id ?? undefined,
    assigneePersonaId: row.assignee_persona_id ?? undefined,
    status: row.status,
    dueAt: row.due_at ?? undefined,
    remindAt: row.remind_at ?? undefined,
    remindCue: row.remind_cue ?? undefined,
    liveUntil: row.live_until ?? undefined,
    archivedAt: row.archived_at ?? undefined,
    archivedReason: row.archived_reason ?? undefined,
    completedAt: row.completed_at ?? undefined,
    createdBy: row.created_by,
    createdAt: row.created_at,
    sourceRawContext: row.source_raw_context ?? undefined,
  };
}

async function enrichTasksWithCreatorNames(
  db: Kysely<DB>,
  rows: TasksTable[],
): Promise<Task[]> {
  if (rows.length === 0) return [];
  const names = await loadDisplayNames(db, rows.map((r) => r.created_by));
  const personaNames = await loadPersonaNames(
    db,
    rows.map((r) => r.assignee_persona_id ?? null),
  );
  return rows.map((r) => ({
    ...rowToTask(r),
    createdByName: r.created_by ? names.get(r.created_by) : undefined,
    assigneePersonaName: r.assignee_persona_id
      ? personaNames.get(r.assignee_persona_id)
      : undefined,
  }));
}

/** Batch-resolve persona ids → display names (ADR 0151). */
export async function loadPersonaNames(
  db: Kysely<DB>,
  ids: (string | null)[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .selectFrom('personas')
    .select(['id', 'name'])
    .where('id', 'in', wanted)
    .execute();
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** 0 for open/active, 1 otherwise - sorts live work ahead of history. */
function liveFirst(column: 'status' | 'tasks.status') {
  return sql<number>`(CASE WHEN ${sql.ref(column)} IN ('open', 'active') THEN 0 ELSE 1 END)`;
}

export async function listTasks(
  db: Kysely<DB>,
  groupId: string,
  opts?: { withNames?: boolean; limit?: number },
): Promise<Task[]> {
  const rows = await db
    .selectFrom('tasks')
    .selectAll()
    .where('group_id', '=', groupId)
    // Live work first, then newest: done and archived tasks are kept forever,
    // and taken newest-first alone they pushed an older OPEN task out of the
    // 200 - so list_tasks, ordinals and the snapshot silently lost it.
    .orderBy(liveFirst('status'), 'asc')
    .orderBy('created_at', 'desc')
    // Unbounded over a group's lifetime otherwise. 200 is generous for any
    // normal family group's live+historical task count; a group that outgrows
    // it needs real pagination on the read side, not a bigger constant here.
    .limit(opts?.limit ?? 200)
    .execute();
  logger.debug('task.list', {
    scope: 'group',
    groupId,
    count: rows.length,
    statusBreakdown: countByStatus(rows),
  });
  // Callers that only read titles/counts (e.g. the bot's group snapshot) pass
  // withNames:false to skip the per-creator display-name lookup.
  if (opts?.withNames === false) return rows.map(rowToTask);
  return enrichTasksWithCreatorNames(db, rows);
}

export async function listTasksForUser(
  db: Kysely<DB>,
  userId: string,
  opts?: { limit?: number },
): Promise<Task[]> {
  const rows = await db
    .selectFrom('tasks')
    .innerJoin('group_members', 'group_members.group_id', 'tasks.group_id')
    .where('group_members.user_id', '=', userId)
    .selectAll('tasks')
    .orderBy(liveFirst('tasks.status'), 'asc')
    .orderBy('tasks.created_at', 'desc')
    .limit(opts?.limit ?? 200)
    .execute();
  logger.debug('task.list', {
    scope: 'user',
    userId,
    count: rows.length,
    statusBreakdown: countByStatus(rows),
  });
  return enrichTasksWithCreatorNames(db, rows);
}

/**
 * Resolve a task by id, scoped exactly like listTasks/listTasksForUser: in a
 * shared group, only a task belonging to THIS group; from the personal 1:1
 * (`crossGroupUserId`), any task in a group the user belongs to. Queries by
 * primary key directly rather than `listTasks(ForUser)(...).find(id)` —
 * `complete_task`/`update_task` used to resolve even a known `taskId` this
 * way, so an old task sitting behind 200+ newer ones (of any status, any
 * group member) silently failed to resolve. See `findEventsByTitle`'s doc
 * comment (events.service.ts) for the same root-cause class of bug.
 */
export async function getTaskInScope(
  db: Kysely<DB>,
  taskId: string,
  scope: { groupId: string } | { crossGroupUserId: string },
): Promise<Task | null> {
  const task = await getTask(db, taskId);
  if (!task) return null;
  if ('groupId' in scope) return task.groupId === scope.groupId ? task : null;
  return (await isMember(db, task.groupId, scope.crossGroupUserId)) ? task : null;
}

/**
 * Direct-SQL title match for `complete_task`/`update_task`'s `titleContains`
 * resolution — bounded by the actual title/status predicate in the `WHERE`
 * clause, not by scanning `listTasks(ForUser)`'s 200-row, `created_at DESC`
 * page. That old page is recency-biased (safer direction than events'
 * ascending-from-2020 bug) but still not a real bound: ADR 0092 deliberately
 * never auto-archives an undated open task ("renew passport" survives
 * forever), so a group with 200+ tasks created since it would silently drop
 * it from a title search too.
 */
export async function findTasksByTitle(
  db: Kysely<DB>,
  scope: { groupId: string } | { crossGroupUserId: string },
  titleContains: string,
  statuses: readonly TasksTable['status'][],
): Promise<Task[]> {
  const pat = likeContains(titleContains.toLowerCase());
  const rows =
    'groupId' in scope
      ? await db
          .selectFrom('tasks')
          .selectAll()
          .where('group_id', '=', scope.groupId)
          .where('status', 'in', statuses)
          .where((eb) => eb(eb.fn('lower', ['title']), 'like', pat))
          .orderBy('created_at', 'desc')
          .limit(50)
          .execute()
      : await db
          .selectFrom('tasks')
          .innerJoin('group_members', 'group_members.group_id', 'tasks.group_id')
          .where('group_members.user_id', '=', scope.crossGroupUserId)
          .where('tasks.status', 'in', statuses)
          .where((eb) => eb(eb.fn('lower', ['tasks.title']), 'like', pat))
          .selectAll('tasks')
          .orderBy('tasks.created_at', 'desc')
          .limit(50)
          .execute();
  return rows.map(rowToTask);
}

/**
 * Direct-SQL search for the `search` bot tool's tasks/reminders category —
 * matches `search_tsv` OR a literal substring across title/details/
 * remindCue (any status), scoped by group_id or cross-group membership, in
 * ONE query. Not `listTasks(ForUser)`'s 200-row `created_at DESC` page
 * intersected against an unscoped FTS id set — that old shape let the FTS
 * index correctly find a match and then throw it away because it wasn't
 * also on the recency page. See `findEventsByTitle`'s doc comment
 * (events.service.ts) for the root-cause class of bug this replaces.
 */
export async function searchTasksScoped(
  db: Kysely<DB>,
  scope: { groupId: string } | { crossGroupUserId: string },
  opts: { tsq: string | null; qLike: string; cap: number },
): Promise<Task[]> {
  const rows =
    'groupId' in scope
      ? await db
          .selectFrom('tasks')
          .selectAll()
          .where('group_id', '=', scope.groupId)
          .where((eb) =>
            eb.or([
              ...(opts.tsq
                ? [eb(sql<boolean>`search_tsv @@ to_tsquery('english', ${opts.tsq})`, '=', true)]
                : []),
              eb(sql<boolean>`lower(title) like ${opts.qLike} escape '\\'`, '=', true),
              eb(sql<boolean>`lower(coalesce(details,'')) like ${opts.qLike} escape '\\'`, '=', true),
              eb(sql<boolean>`lower(coalesce(remind_cue,'')) like ${opts.qLike} escape '\\'`, '=', true),
            ]),
          )
          .orderBy('created_at', 'desc')
          .limit(opts.cap)
          .execute()
      : await db
          .selectFrom('tasks')
          .innerJoin('group_members', 'group_members.group_id', 'tasks.group_id')
          .where('group_members.user_id', '=', scope.crossGroupUserId)
          .where((eb) =>
            eb.or([
              ...(opts.tsq
                ? [eb(sql<boolean>`tasks.search_tsv @@ to_tsquery('english', ${opts.tsq})`, '=', true)]
                : []),
              eb(sql<boolean>`lower(tasks.title) like ${opts.qLike} escape '\\'`, '=', true),
              eb(sql<boolean>`lower(coalesce(tasks.details,'')) like ${opts.qLike} escape '\\'`, '=', true),
              eb(sql<boolean>`lower(coalesce(tasks.remind_cue,'')) like ${opts.qLike} escape '\\'`, '=', true),
            ]),
          )
          .selectAll('tasks')
          .orderBy('tasks.created_at', 'desc')
          .limit(opts.cap)
          .execute();
  return rows.map(rowToTask);
}

function countByStatus(rows: { status: string }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
}

export interface CreateTaskInput extends CreateTaskRequest {
  groupId: string;
  createdBy: string | null;
  sourceRawContext?: string | null;
  /** ADR 0314 — doing it is replying to the email it came from. */
  closesOnReply?: boolean;
  /** ADR 0151 — a managed persona as the assignee. Server-side only: not on the
   *  REST request schema (assign-to-persona is bot-driven for now), mutually
   *  exclusive with `assigneeId`. */
  assigneePersonaId?: string | null;
}

export interface CreateTaskResult {
  task: Task;
  created: boolean;
  /** Fields an existing task gained from this call (empty when nothing changed). */
  updated: Array<'dueAt' | 'remindAt' | 'remindCue' | 'details'>;
}

/**
 * Create a task, or fold the call into the open task it duplicates.
 *
 * `create_task` had no dedup at all, which is why to-dos multiplied: every
 * restatement of the same intent — and the ADR 0051 follow-up window means the
 * bot hears plenty of restatement — minted another row, and the daily briefing
 * then read them all back, prompting more restatement.
 *
 * Match is deliberately narrow: same group, same assignee, same normalized
 * title, and **open** only. A task already done or archived is not a duplicate
 * — saying "book dentist" a month after finishing one means a new appointment.
 *
 * A duplicate is not simply ignored. There is no `update_task` tool, so
 * "actually make that Friday" reaches us as another `create_task`; dropping it
 * would silently lose the new date. Fields the caller supplies and the
 * existing task lacks are filled in, and a *different* due/remind time
 * replaces the old one — that is a reschedule, which is what the user meant.
 * Nothing the caller omits is ever cleared.
 */
/** The same moment whatever offset it is written with; text only when unreadable. */
function sameMoment(a: string, b: string | null): boolean {
  if (!b) return false;
  const am = instantMs(a);
  const bm = instantMs(b);
  return Number.isFinite(am) && Number.isFinite(bm) ? am === bm : a === b;
}

export async function createTaskWithDedup(
  db: Kysely<DB>,
  input: CreateTaskInput,
): Promise<CreateTaskResult> {
  const key = normalizeText(input.title);
  // Bounded, not a real index lookup: normalizeText has no SQL-side
  // equivalent (ADR 0094 rejected porting a JS normalizer into Postgres —
  // "the drift trap"), so this still matches in JS. Ordering newest-first and
  // capping at 500 keeps a years-old group's open-task pile from being loaded
  // whole on every create; 500 open/active tasks is far beyond any real family
  // group, so this doesn't change dedup behavior today. A from-scratch
  // SQL-side exact-match design (an ADR 0094-style canonical key for task
  // titles) would remove the cap entirely, but needs its own ADR + migration.
  const open = await db
    .selectFrom('tasks')
    .selectAll()
    .where('group_id', '=', input.groupId)
    .where('status', 'in', ['open', 'active'])
    .where('archived_at', 'is', null)
    .orderBy('created_at', 'desc')
    .limit(500)
    .execute();
  // A task to a user and a task to a managed persona with the same title are
  // not duplicates — collapse the assignee into one comparable key (ADR 0151).
  const akey = (a: string | null | undefined, p: string | null | undefined) =>
    a ?? (p ? `p:${p}` : null);
  const inputKey = akey(input.assigneeId, input.assigneePersonaId);
  const existing = open.find(
    (r) =>
      normalizeText(r.title) === key &&
      akey(r.assignee_id, r.assignee_persona_id) === inputKey,
  );

  if (!existing) {
    return { task: await createTask(db, input), created: true, updated: [] };
  }

  const patch: Partial<TasksTable> = {};
  const updated: CreateTaskResult['updated'] = [];
  if (input.dueAt && !sameMoment(input.dueAt, existing.due_at)) {
    patch.due_at = input.dueAt;
    updated.push('dueAt');
  }
  if (input.remindAt && !sameMoment(input.remindAt, existing.remind_at)) {
    patch.remind_at = input.remindAt;
    updated.push('remindAt');
  }
  if (input.remindCue && input.remindCue !== existing.remind_cue) {
    patch.remind_cue = input.remindCue;
    updated.push('remindCue');
  }
  if (input.details && !existing.details) {
    patch.details = input.details;
    updated.push('details');
  }

  if (updated.length === 0) {
    logger.info('task.duplicate', { taskId: existing.id, groupId: input.groupId });
    return { task: rowToTask(existing), created: false, updated };
  }

  await db.updateTable('tasks').set(patch).where('id', '=', existing.id).execute();
  logger.info('task.duplicate.updated', {
    taskId: existing.id,
    groupId: input.groupId,
    updated,
  });
  return { task: rowToTask({ ...existing, ...patch }), created: false, updated };
}

export async function createTask(db: Kysely<DB>, input: CreateTaskInput): Promise<Task> {
  if (input.assigneeId && input.assigneePersonaId) {
    throw new Error('assigneeId and assigneePersonaId are mutually exclusive');
  }
  if (
    input.assigneeId &&
    input.createdBy &&
    input.assigneeId !== input.createdBy &&
    !(await isTrusted(db, input.assigneeId, input.createdBy, 'task'))
  ) {
    throw new TrustError('task', input.createdBy, input.assigneeId);
  }
  if (input.assigneePersonaId) {
    const inGroup = await db
      .selectFrom('personas')
      .select('id')
      .where('id', '=', input.assigneePersonaId)
      .where('group_id', '=', input.groupId)
      .executeTakeFirst();
    if (!inGroup) throw new Error('assigneePersonaId is not a persona in this group');
    const { trusted, managedBy } = await isTrustedForPersona(
      db,
      input.assigneePersonaId,
      input.createdBy ?? '',
      'task',
    );
    if (input.createdBy && !trusted) {
      throw new TrustError('task', input.createdBy, managedBy ?? input.createdBy);
    }
  }
  const id = newId('t');
  const row: TasksTable = {
    id,
    group_id: input.groupId,
    title: input.title,
    details: input.details ?? null,
    assignee_id: input.assigneeId ?? null,
    assignee_persona_id: input.assigneePersonaId ?? null,
    status: 'open',
    due_at: input.dueAt ?? null,
    remind_at: input.remindAt ?? null,
    remind_cue: input.remindCue ?? null,
    live_until: input.liveUntil ?? null,
    archived_at: null,
    archived_reason: null,
    completed_at: null,
    created_by: input.createdBy,
    created_at: new Date().toISOString(),
    source_raw_context: input.sourceRawContext ?? null,
    closes_on_reply: input.closesOnReply ? 1 : 0,
  };
  await db.insertInto('tasks').values(row).execute();
  logger.info('task.create', {
    taskId: id,
    groupId: input.groupId,
    createdBy: input.createdBy,
    assigneeId: input.assigneeId ?? null,
    hasDueAt: !!input.dueAt,
    hasRemindAt: !!input.remindAt,
  });
  await fanoutAssignment(db, input.groupId, 'task', id, {
    type: 'task',
    primary: input.title,
    secondary: input.details ?? undefined,
  }).catch((err) => logger.warn('catchup fanout (task) failed', { err }));
  return rowToTask(row);
}

export interface UpdateTaskInput {
  title?: string;
  details?: string | null;
  assigneeId?: string | null;
  assigneePersonaId?: string | null;
  status?: Task['status'];
  dueAt?: string | null;
  remindAt?: string | null;
  remindCue?: string | null;
  liveUntil?: string | null;
  archivedAt?: string | null;
}

/**
 * A to-do whose due date is still ahead is still owed. Nothing automatic may
 * retire one on age or on its source email being trashed. An undated or
 * unparseable due date is not "ahead".
 */
export function isDueInFuture(dueAt: string | null | undefined, nowMs = Date.now()): boolean {
  if (!dueAt) return false;
  const ms = instantMs(dueAt);
  return Number.isFinite(ms) && ms > nowMs;
}

export async function updateTask(
  db: Kysely<DB>,
  id: string,
  patch: UpdateTaskInput,
): Promise<Task | null> {
  const before = await db
    .selectFrom('tasks')
    .select(['status', 'group_id', 'completed_at'])
    .where('id', '=', id)
    .executeTakeFirst();
  const values: Partial<TasksTable> = {};
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.details !== undefined) values.details = patch.details;
  // assigneeId and assigneePersonaId are mutually exclusive: setting one to a
  // value clears the other (ADR 0151).
  if (patch.assigneeId !== undefined) {
    values.assignee_id = patch.assigneeId;
    if (patch.assigneeId) values.assignee_persona_id = null;
  }
  if (patch.assigneePersonaId !== undefined) {
    values.assignee_persona_id = patch.assigneePersonaId;
    if (patch.assigneePersonaId) values.assignee_id = null;
  }
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.dueAt !== undefined) values.due_at = patch.dueAt;
  if (patch.remindAt !== undefined) values.remind_at = patch.remindAt;
  if (patch.remindCue !== undefined) values.remind_cue = patch.remindCue;
  if (patch.liveUntil !== undefined) values.live_until = patch.liveUntil;
  if (patch.archivedAt !== undefined) values.archived_at = patch.archivedAt;
  // A dropped to-do given a due date that is still ahead is owed again. Only
  // a DROPPED one (archived without ever being completed), and only when the
  // caller did not also choose a status. `archived_at` is cleared with it: it
  // marks that the overdue sweep already retired this task once (ADR 0092),
  // and a new date is a new shelf life the sweep may act on when it passes.
  if (
    patch.status === undefined &&
    before?.status === 'archived' &&
    !before.completed_at &&
    isDueInFuture(patch.dueAt)
  ) {
    values.status = 'open';
    values.archived_reason = null;
    if (patch.archivedAt === undefined) values.archived_at = null;
  }
  // Track when a task transitions in/out of 'done' so archiveStaleTasks
  // can key its 7-day window off real completion time, not due_at.
  if (patch.status !== undefined && before && before.status !== patch.status) {
    if (patch.status === 'done') {
      values.completed_at = new Date().toISOString();
    } else if (patch.status === 'open' || patch.status === 'active') {
      // Reopening — from 'done' OR from an auto-archived 'done' row (ADR 0092).
      // An open/active task must never carry a stale completion time: the
      // client reads `archived && completedAt` as "this was finished".
      values.completed_at = null;
    }
    // Stamp archived_at on the transition so a status-only patch records
    // when it happened. Deliberately NOT cleared on un-archive: a non-null
    // archived_at is what tells the overdue sweep it has already retired
    // this task once, so pulling an item back out keeps it out of reach
    // (ADR 0092).
    if (patch.status === 'archived' && patch.archivedAt === undefined) {
      values.archived_at = new Date().toISOString();
    }
    // ADR 0285 — archiving through an edit is a person's choice (Drop, or
    // the bot's complete_task drop), never news for their briefing. Leaving
    // the archive clears it; a done task filed later gets its own reason.
    values.archived_reason = patch.status === 'archived' ? 'dropped' : null;
  }
  if (Object.keys(values).length > 0) {
    await db.updateTable('tasks').set(values).where('id', '=', id).execute();
  }
  const row = await db.selectFrom('tasks').selectAll().where('id', '=', id).executeTakeFirst();
  if (row) {
    logger.info('task.update', {
      taskId: id,
      groupId: row.group_id,
      patchKeys: Object.keys(values),
      statusBefore: before?.status ?? null,
      statusAfter: row.status,
      statusChanged: before ? before.status !== row.status : false,
    });
  } else {
    logger.info('task.update', { taskId: id, missing: true, patchKeys: Object.keys(values) });
  }
  // Cancel any pending task_remind nudges when the task is no longer
  // open/active, or when the remind time has been cleared/changed —
  // the snapshot in the proactive_messages row would otherwise fire a
  // reminder for a task that's already been resolved or rescheduled.
  if (row) {
    const terminalStatus = row.status !== 'open' && row.status !== 'active';
    const remindCleared = patch.remindAt !== undefined;
    if (terminalStatus || remindCleared) {
      await cancelPendingTaskReminders(db, id);
    }
  }
  return row ? rowToTask(row) : null;
}

/**
 * Retire the open to-dos a now-deleted source produced (ADR 0143).
 *
 * `archived`, not `done`. ADR 0092 made dropping first-class precisely because
 * forcing abandonment through `done` corrupts the completion signal — and
 * nobody did this task, the reason to do it went away. The user-visible
 * outcome is the same either way; what differs is what the row then means.
 *
 * Deliberately narrow. Only `open` rows with a null `archived_at` are touched:
 * `active` means a person picked it up, `done` is history, and a non-null
 * `archived_at` is ADR 0092's marker that the overdue sweep already retired
 * this task once — re-stamping it would restart a clock that exists to fire
 * exactly once.
 *
 * Scoped by `created_by` as well as provenance. Thread ids are opaque per
 * mailbox, so a collision across two users is vanishingly unlikely rather than
 * impossible, and this writes into groups other people can see.
 *
 * `dueOnOrBefore` narrows the set to to-dos that were FOR the removed thing: an
 * undated one, or one due no later than the cutoff. A follow-up due after it
 * ("send the receipt next week") survives an event that got deleted. An
 * unparseable due date is left alone — we cannot prove it belongs.
 *
 * With NO cutoff (the source email was trashed or deleted) a to-do whose own
 * due date is still ahead is left alone: the date is the user's statement that
 * it is owed until then, and trashing mail after reading it is not a
 * retraction. With a cutoff the caller is an event being removed, and a to-do
 * due by that event was FOR it (ADR 0192) - that one still goes with it, even
 * when the event was next week.
 */
export async function retireTasksByProvenance(
  db: Kysely<DB>,
  userId: string,
  provenanceKeys: string[],
  opts?: { dueOnOrBefore?: string; spam?: boolean },
): Promise<Task[]> {
  if (provenanceKeys.length === 0) return [];
  const cutoffMs = opts?.dueOnOrBefore ? Date.parse(opts.dueOnOrBefore) : null;
  const spam = opts?.spam === true;
  const candidates = await db
    .selectFrom('tasks')
    .selectAll()
    .where('created_by', '=', userId)
    .where('source_raw_context', 'in', provenanceKeys)
    .where('status', '=', 'open')
    .where('archived_at', 'is', null)
    .execute();
  const nowMs = Date.now();
  const rows = candidates.filter((r) => {
    // A to-do from mail the provider calls spam was never owed, however far
    // ahead its date (a phish's "call support by Friday").
    if (spam) return true;
    if (cutoffMs === null) return !isDueInFuture(r.due_at, nowMs);
    if (!r.due_at) return true;
    const due = Date.parse(r.due_at);
    return Number.isFinite(due) && due <= cutoffMs;
  });
  if (rows.length === 0) return [];
  const nowIso = new Date().toISOString();
  // ADR 0285 — a cutoff means an event is being removed (see above).
  const archivedReason: TaskArchivedReason = spam ? 'email_spam' : cutoffMs === null ? 'email_gone' : 'event_gone';
  await db
    .updateTable('tasks')
    .set({ status: 'archived', archived_at: nowIso, archived_reason: archivedReason })
    .where(
      'id',
      'in',
      rows.map((r) => r.id),
    )
    .execute();
  for (const r of rows) {
    logger.info('task.retired-with-source', {
      taskId: r.id,
      groupId: r.group_id,
      provenance: r.source_raw_context,
    });
  }
  return rows.map((r) =>
    rowToTask({ ...r, status: 'archived', archived_at: nowIso, archived_reason: archivedReason }),
  );
}

export async function deleteTask(db: Kysely<DB>, id: string): Promise<void> {
  const before = await db
    .selectFrom('tasks')
    .select(['group_id', 'status'])
    .where('id', '=', id)
    .executeTakeFirst();
  await cancelPendingTaskReminders(db, id);
  const result = await db.deleteFrom('tasks').where('id', '=', id).execute();
  const deletedCount = Number(result[0]?.numDeletedRows ?? 0);
  logger.info('task.delete', {
    taskId: id,
    groupId: before?.group_id ?? null,
    statusBefore: before?.status ?? null,
    deletedCount,
    found: !!before,
  });
}

async function cancelPendingTaskReminders(
  db: Kysely<DB>,
  taskId: string,
): Promise<void> {
  await db
    .deleteFrom('proactive_messages')
    .where('kind', '=', 'task_remind')
    .where('fired_at', 'is', null)
    .where('payload', 'like', `%"taskId":"${taskId}"%`)
    .execute();
}

export async function getTask(db: Kysely<DB>, id: string): Promise<Task | null> {
  const row = await db.selectFrom('tasks').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? rowToTask(row) : null;
}
