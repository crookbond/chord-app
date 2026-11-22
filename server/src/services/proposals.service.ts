/**
 * Proposals: staged bot tool calls awaiting user confirmation (ADR 0009).
 *
 * The bot writes a row here instead of executing directly for tools listed in
 * `PROPOSABLE_TOOLS` (see `bot/executor.ts`). A group member's confirm re-
 * validates the stored args against the zod registry and dispatches via
 * `applyToolCall` in commit mode; reject flips status without writing.
 *
 * Read tools (`list_tasks`, `search_saves`, etc.) never hit this table —
 * they have no side effects to gate.
 */
import type { Kysely } from 'kysely';

import type { Proposal, RouteSuggestion } from '@chord/kernel';

import { logger } from '../config/logging.js';
import { bindAfterCommit } from '../db/after-commit.js';
import { sealField } from '../db/crypto/index.js';
import type { DB, ProposalsTable } from '../db/schema.js';
import { newId } from '../utils/ids.js';
import { instantInZoneMs, tzToOffset } from '../utils/tz.js';
import { applyToolCall, type SseBroadcaster, type ToolExecutionResult } from './bot/executor.js';
import { isToolName, normalizeDatetimes, toolSchemas, type ToolCall } from './bot/tools.js';
import type { SseEventMap, SseEventName } from '@chord/kernel';
import { sseHub } from './sse.hub.js';
import { suggestRuleFromRouting } from './email/routing-rules.service.js';
import { attachCalendarChoices } from './email/source-mailbox.js';
import { replaceOffersFor } from './email/replace-offer.js';
import { calendarFitFor } from './events/calendar-fit.service.js';
import { sweepOrphanProvisionalPeople } from './people.service.js';
import { runInBackground } from '../utils/background.js';

// 72h so a proposal survives up to three daily briefings ("Waiting on your
// OK") before quietly expiring — 24h meant anything staged after the morning
// briefing got at most one shot at being seen.
const DEFAULT_TTL_MS = 72 * 60 * 60 * 1000;

/** ADR 0248 — tools an email change card carries (`email-changes.service.ts`). */
const EMAIL_CHANGE_TOOL_NAMES = new Set(['delete_event', 'update_event', 'complete_task', 'update_task']);

/** ADR 0248 — accept and dismiss rates per change, since rejected rows are pruned. */
function logEmailChangeResolved(
  row: { tool_name: string; provenance: string | null },
  status: 'confirmed' | 'rejected',
): void {
  if (!row.provenance?.startsWith('gmail:') || !EMAIL_CHANGE_TOOL_NAMES.has(row.tool_name)) return;
  logger.info('email change resolved', { tool: row.tool_name, status });
}

function rowToProposal(row: ProposalsTable): Proposal {
  return {
    id: row.id,
    groupId: row.group_id,
    proposedByUserId: row.proposed_by_user_id,
    proposedByMessageId: row.proposed_by_message_id,
    toolName: row.tool_name,
    argsJson: row.args_json,
    provenance: row.provenance,
    targetGroupId: row.target_group_id ?? null,
    status: row.status,
    resolvedByUserId: row.resolved_by_user_id,
    resolvedByMessageId: row.resolved_by_message_id,
    resolvedAt: row.resolved_at,
    bundleId: row.bundle_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export interface CreateProposalInput {
  groupId: string;
  proposedByUserId: string | null;
  proposedByMessageId: string | null;
  toolName: string;
  args: unknown;
  provenance: string | null;
  /** ADR 0063 — execute in this group on confirm instead of `groupId`. */
  targetGroupId?: string | null;
  bundleId?: string | null;
  ttlMs?: number;
}

export async function createProposal(
  db: Kysely<DB>,
  input: CreateProposalInput,
): Promise<Proposal> {
  const id = newId('prop');
  const now = Date.now();
  const row: ProposalsTable = {
    id,
    group_id: input.groupId,
    proposed_by_user_id: input.proposedByUserId,
    proposed_by_message_id: input.proposedByMessageId,
    tool_name: input.toolName,
    args_json: JSON.stringify(input.args),
    provenance: input.provenance,
    target_group_id: input.targetGroupId ?? null,
    status: 'pending',
    resolved_by_user_id: null,
    resolved_by_message_id: null,
    resolved_at: null,
    bundle_id: input.bundleId ?? null,
    expires_at: new Date(now + (input.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
    created_at: new Date(now).toISOString(),
  };
  // ADR 0201 - a suggestion mined from someone's mail carries what the mail
  // said (titles, dates, names). Those are sealed under the person it was
  // proposed to; one a person made in chat is already chat content and is not.
  // ADR 0335 - one an AI app proposed is usually built from the user's mail too.
  const emailDerived =
    (input.provenance?.startsWith('gmail:') || input.provenance?.startsWith('connector:')) && input.proposedByUserId;
  const stored = emailDerived
    ? { ...row, args_json: await sealField(input.proposedByUserId!, 'proposals:args_json', row.args_json) }
    : row;
  await db.insertInto('proposals').values(stored).execute();
  return rowToProposal(row);
}

export async function getProposal(
  db: Kysely<DB>,
  id: string,
): Promise<Proposal | null> {
  const row = await db
    .selectFrom('proposals')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  return row ? rowToProposal(row) : null;
}

export async function listProposalsForGroup(
  db: Kysely<DB>,
  groupId: string,
  opts?: { status?: Proposal['status']; limit?: number },
): Promise<Proposal[]> {
  const base = () =>
    db.selectFrom('proposals').selectAll().where('group_id', '=', groupId).orderBy('created_at', 'desc');
  const limit = opts?.limit ?? 200;
  if (opts?.status) {
    const rows = await base().where('status', '=', opts.status).limit(limit).execute();
    return rows.map(rowToProposal);
  }
  // Same rule as listProposalsForUser: pending is never crowded out.
  const [pending, decided] = await Promise.all([
    base().where('status', '=', 'pending').limit(PENDING_LIST_CAP).execute(),
    base().where('status', '!=', 'pending').limit(limit).execute(),
  ]);
  return [...pending, ...decided]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .map(rowToProposal);
}

/**
 * Every pending proposal across the user's groups, plus the most recent
 * decided ones (the Action Items audit trail). Pending rows are read on their
 * own: under one shared cap, a user with a few hundred decided cards had their
 * oldest still-pending ones pushed off the end and never shown. Pending is
 * bounded already — proposals expire (72h TTL, swept on read).
 */
export async function listProposalsForUser(
  db: Kysely<DB>,
  userId: string,
  opts?: { status?: Proposal['status']; limit?: number },
): Promise<Proposal[]> {
  const base = () =>
    db
      .selectFrom('proposals')
      .innerJoin('group_members', 'group_members.group_id', 'proposals.group_id')
      .where('group_members.user_id', '=', userId)
      .selectAll('proposals')
      .orderBy('proposals.created_at', 'desc');
  const limit = opts?.limit ?? 200;
  if (opts?.status) {
    const rows = await base().where('proposals.status', '=', opts.status).limit(limit).execute();
    return rows.map(rowToProposal);
  }
  const [pending, decided] = await Promise.all([
    base().where('proposals.status', '=', 'pending').limit(PENDING_LIST_CAP).execute(),
    base().where('proposals.status', '!=', 'pending').limit(limit).execute(),
  ]);
  return [...pending, ...decided]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .map(rowToProposal);
}

/** A safety ceiling only; real pending sets are far smaller (they expire). */
const PENDING_LIST_CAP = 2000;

/**
 * Attach the ADR 0059-style in-app `sourceHref` pointing at what generated
 * each proposal, so the row can open the source before confirm/reject:
 * `gmail:<threadId>` provenance → the viewer's local email thread;
 * `attachment:<id>` provenance → the Attachments tab; a chat-born proposal
 * (proposedByMessageId set) → its group chat. Per-viewer because email
 * thread rows are per-user; unresolvable sources stay href-less.
 */
export async function attachSourceHrefs(
  db: Kysely<DB>,
  userId: string,
  proposals: Proposal[],
): Promise<Proposal[]> {
  const gmailIds = [
    ...new Set(
      proposals
        .filter((p) => p.provenance?.startsWith('gmail:'))
        .map((p) => p.provenance!.slice('gmail:'.length)),
    ),
  ];
  const rowByGmailId = new Map<string, { id: string; subject: string }>();
  if (gmailIds.length > 0) {
    const rows = await db
      .selectFrom('email_threads')
      .select(['id', 'gmail_thread_id', 'subject'])
      .where('user_id', '=', userId)
      .where('gmail_thread_id', 'in', gmailIds)
      .execute();
    for (const r of rows) rowByGmailId.set(r.gmail_thread_id, { id: r.id, subject: r.subject });
  }
  // ADR 0335 - a suggestion an AI app made names the app as its source.
  const grantIds = [
    ...new Set(
      proposals
        .filter((p) => p.provenance?.startsWith('connector:'))
        .map((p) => p.provenance!.slice('connector:'.length)),
    ),
  ];
  const appByGrant = new Map<string, string>();
  if (grantIds.length > 0) {
    const rows = await db
      .selectFrom('oauth_grants')
      .innerJoin('oauth_clients', 'oauth_clients.id', 'oauth_grants.client_id')
      .select(['oauth_grants.id', 'oauth_clients.name'])
      .where('oauth_grants.id', 'in', grantIds)
      .where('oauth_grants.user_id', '=', userId)
      .execute();
    for (const r of rows) appByGrant.set(r.id, r.name);
  }
  const withCalendars = await attachCalendarChoices(db, userId, proposals);
  // ADR 0343 — an email event that may replace one the user already has.
  const candidates = withCalendars.map((p) => ({
    id: p.id,
    tool_name: p.toolName,
    args_json: p.argsJson,
    provenance: p.provenance,
    status: p.status,
  }));
  const [replaces, fits] = await Promise.all([
    replaceOffersFor(db, userId, candidates),
    // ADR 0346 - conflict, already there, or a question, shown to this user only.
    calendarFitFor(db, userId, candidates),
  ]);
  return withCalendars.map((p0) => {
    const offer = replaces.get(p0.id);
    const fit = fits.get(p0.id);
    const p = { ...p0, ...(offer ? { replaces: offer } : {}), ...(fit ? { fit } : {}) };
    let sourceHref: string | null = null;
    let sourceLabel: string | null = null;
    if (p.provenance?.startsWith('gmail:')) {
      const thread = rowByGmailId.get(p.provenance.slice('gmail:'.length));
      sourceHref = thread ? `/email/${thread.id}` : null;
      sourceLabel = thread?.subject?.trim() || null;
    } else if (p.provenance?.startsWith('connector:')) {
      sourceLabel = `Suggested by ${appByGrant.get(p.provenance.slice('connector:'.length)) ?? 'a connected app'}`;
    } else if (p.provenance?.startsWith('attachment:')) {
      sourceHref = '/catchup/files';
    } else if (p.proposedByMessageId) {
      sourceHref = `/groups/${p.groupId}`;
    }
    if (!sourceHref && !sourceLabel) return p;
    return { ...p, ...(sourceHref ? { sourceHref } : {}), ...(sourceLabel ? { sourceLabel } : {}) };
  });
}

/** Compact one-line label for a proposal in the briefing. Defensive parse —
 *  stored args are re-validated only on commit. */
function briefLabel(p: Proposal): string {
  let a: Record<string, unknown> = {};
  try {
    a = JSON.parse(p.argsJson) as Record<string, unknown>;
  } catch {
    return p.toolName.replace(/_/g, ' ');
  }
  const s = (k: string): string | undefined =>
    typeof a[k] === 'string' ? (a[k] as string) : undefined;
  const arr = (k: string): string[] | undefined =>
    Array.isArray(a[k]) ? (a[k] as string[]) : undefined;
  switch (p.toolName) {
    case 'create_event':
      return `Event: ${s('title') ?? '(untitled)'}${s('startsAt') ? ` — ${fmtBriefWhen(s('startsAt')!)}` : ''}`;
    case 'create_task':
      return `Task: ${s('title') ?? '(untitled)'}`;
    case 'add_list_item': {
      const items = arr('items') ?? [];
      return `${s('listName') ?? 'List'}: ${items.join(', ')}`;
    }
    case 'create_trip':
      return `Trip: ${s('name') ?? s('destination') ?? '(trip)'}`;
    case 'record_rsvp':
      return `RSVP: ${s('displayName') ?? ''} → ${s('status') ?? ''}`.trim();
    case 'save_link':
      return `Save: ${s('title') ?? s('url') ?? '(link)'}`;
    case 'save_place':
      return `Save: ${s('name') ?? '(place)'}`;
    case 'save_contact':
      return `Contact: ${s('name') ?? '(contact)'}`;
    default:
      return p.toolName.replace(/_/g, ' ');
  }
}

function fmtBriefWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const BRIEFING_PROPOSALS_MAX = 5;

/**
 * "Waiting on your OK" section of the daily briefing: every still-pending,
 * unexpired proposal across the user's groups, deterministic (no LLM).
 * Bundles (trip + legs from one PDF) collapse to their lead row. Pass
 * `excludeGmail` when the email digest section already rendered — it lists
 * the gmail-provenance suggestions itself (ADR 0072). Null when empty.
 */
export async function buildPendingProposalsSection(
  db: Kysely<DB>,
  userId: string,
  opts?: { excludeGmail?: boolean },
): Promise<string | null> {
  const now = Date.now();
  const pending = (await listProposalsForUser(db, userId, { status: 'pending' }))
    .filter((p) => Date.parse(p.expiresAt) > now)
    .filter((p) => !(opts?.excludeGmail && p.provenance?.startsWith('gmail:')));
  if (pending.length === 0) return null;

  // Collapse bundles to one line, led by the trip row when present.
  const seenBundles = new Set<string>();
  const rows: Array<{ p: Proposal; extra: number }> = [];
  for (const p of pending) {
    if (!p.bundleId) {
      rows.push({ p, extra: 0 });
      continue;
    }
    if (seenBundles.has(p.bundleId)) continue;
    seenBundles.add(p.bundleId);
    const siblings = pending.filter((q) => q.bundleId === p.bundleId);
    const lead = siblings.find((q) => q.toolName === 'create_trip') ?? siblings[0];
    rows.push({ p: lead, extra: siblings.length - 1 });
  }

  const groupIds = [...new Set(rows.map((r) => r.p.groupId))];
  const groups = await db
    .selectFrom('groups')
    .select(['id', 'name', 'kind'])
    .where('id', 'in', groupIds)
    .execute();
  const sharedName = new Map(
    groups.filter((g) => g.kind !== 'personal').map((g) => [g.id, g.name]),
  );

  const total = rows.length;
  const lines = [`⏳ Waiting on your OK — ${total} suggestion${total === 1 ? '' : 's'}:`];
  for (const { p, extra } of rows.slice(0, BRIEFING_PROPOSALS_MAX)) {
    const where = sharedName.has(p.groupId) ? ` (in ${sharedName.get(p.groupId)})` : '';
    const linked = extra > 0 ? ` (+${extra} linked)` : '';
    lines.push(`  • ${briefLabel(p)}${linked}${where}`);
  }
  if (total > BRIEFING_PROPOSALS_MAX) {
    lines.push(`  …and ${total - BRIEFING_PROPOSALS_MAX} more in To Do's.`);
  }
  lines.push(`Confirm or dismiss them in To Do's → Action Items.`);
  return lines.join('\n');
}

export interface ConfirmProposalInput {
  id: string;
  resolvedByUserId: string;
  resolvedByMessageId?: string | null;
  /**
   * The organizer of an invitation has already been answered (the RSVP route
   * does that with the user's real choice). Without it, confirming an
   * invitation sends an "accepted" reply first.
   */
  inviteAnswered?: boolean;
  /**
   * ADR 0097 — where the confirmer wants this to land, overriding whatever the
   * proposal was staged with. Since the model no longer picks a group, this is
   * the only way an email-derived item reaches a shared one without a standing
   * routing rule. Membership is enforced below; an unknown or foreign group is
   * refused rather than silently ignored.
   */
  targetGroupId?: string | null;
  /**
   * ADR 0247 — several destinations picked at once. The item is created once
   * per group, each copy fanning out to that group's members. Wins over
   * `targetGroupId` when non-empty.
   */
  targetGroupIds?: string[];
  /**
   * ADR 0312 — the calendar picked on the card. Needed when the email came to
   * a mailbox with no calendar Chord can write to; otherwise optional.
   */
  calendarId?: string | null;
  /**
   * ADR 0343 — "Move it": instead of adding the email's event, move this
   * existing one to its time. Only the event the card offered is accepted.
   */
  replaceEventId?: string | null;
  /**
   * ADR 0348 — an email meeting card invites its guests only when the user
   * ticked "Also send invitations" on it. Without it, confirming adds the
   * meeting to their calendar and emails nobody.
   */
  sendInvites?: boolean;
}

/** The executor refused to place an email event (ADR 0312). */
class CalendarChoiceError extends Error {
  constructor(readonly reason: 'calendar_required' | 'calendar_not_writable') {
    super(reason);
    this.name = 'CalendarChoiceError';
  }
}

/** Thrown inside a confirm transaction when another confirm/reject resolved
 *  the proposal first; the transaction rolls back and nothing runs. */
class AlreadyResolvedError extends Error {
  constructor() {
    super('already_resolved');
    this.name = 'AlreadyResolvedError';
  }
}

/**
 * Claim pending proposals for this confirm, inside its transaction, before any
 * tool runs. The status check outside the transaction is only a fast path: two
 * confirms at once (a double tap, the app and WhatsApp) both pass it. Here the
 * second one's UPDATE waits on the first's row lock, re-reads the row after it
 * commits, finds it no longer pending and claims nothing.
 */
async function claimPending(
  trx: Kysely<DB>,
  ids: string[],
  resolvedByUserId: string,
  resolvedByMessageId: string | null,
): Promise<void> {
  if (ids.length === 0) return;
  const claimed = await trx
    .updateTable('proposals')
    .set({
      status: 'confirmed',
      resolved_by_user_id: resolvedByUserId,
      resolved_by_message_id: resolvedByMessageId,
      resolved_at: new Date().toISOString(),
    })
    .where('id', 'in', ids)
    .where('status', '=', 'pending')
    .returning('id')
    .execute();
  if (claimed.length !== ids.length) throw new AlreadyResolvedError();
}

/** How many groups one confirm may send an item to. */
export const MAX_CONFIRM_GROUPS = 12;

export type ConfirmProposalResult =
  | {
      ok: true;
      proposal: Proposal;
      summary: string;
      affected: string[];
      /** ADR 0150 — present only on a standalone confirm the user routed into
       *  a shared group by hand, when no matching `sender_domain` rule exists
       *  yet. A one-tap offer to make it standing; never auto-applied. */
      routeSuggestion?: RouteSuggestion;
    }
  | {
      ok: false;
      reason:
        | 'not_found'
        | 'already_resolved'
        | 'expired'
        | 'invalid_args'
        | 'exec_failed'
        | 'calendar_required'
        | 'calendar_not_writable'
        | 'replace_unavailable';
      message?: string;
    };

const TRIP_CHILD_TOOLS: ReadonlySet<string> = new Set([
  'add_travel_leg',
  'add_accommodation',
  'add_reservation',
]);

function validateCall(
  toolName: string,
  argsJson: string,
  tzOffset: string,
  tz: string | null,
): { ok: true; call: ToolCall } | { ok: false; message: string } {
  if (!isToolName(toolName)) return { ok: false, message: `unknown tool ${toolName}` };
  let parsedArgs: unknown;
  try {
    parsedArgs = JSON.parse(argsJson);
  } catch (err) {
    return { ok: false, message: `malformed args_json: ${(err as Error).message}` };
  }
  // Re-normalize at confirm so proposals stored before the creation-time fix
  // (or by any path that skipped it) still validate. A bare datetime gets the
  // CONFIRMING user's zone — their tap is the moment "5pm" becomes an
  // instant — but the offset that applies is the target DATE's own (a
  // still-bare "1pm Dec 5" confirmed today must not get today's DST side
  // stamped onto a December instant; see `offsetForLocalDatetime`).
  parsedArgs = normalizeDatetimes(parsedArgs, tzOffset, tz);
  const validated = toolSchemas[toolName].safeParse(parsedArgs);
  if (!validated.success) {
    return { ok: false, message: validated.error.issues[0]?.message ?? 'invalid args' };
  }
  return { ok: true, call: { name: toolName, args: validated.data } };
}

/** The confirming user's current UTC offset (`±HH:MM`) and raw IANA zone,
 *  from `users.last_tz`; UTC/null only when they have never reported a
 *  timezone. */
async function offsetForUser(
  db: Kysely<DB>,
  userId: string,
): Promise<{ tzOffset: string; tz: string | null }> {
  const row = await db
    .selectFrom('users')
    .select('last_tz')
    .where('id', '=', userId)
    .executeTakeFirst();
  return {
    tzOffset: row?.last_tz ? tzToOffset(row.last_tz) : '+00:00',
    tz: row?.last_tz ?? null,
  };
}

/**
 * Commit a single pending proposal row + flip its status. Shared by the
 * standalone and bundle paths. Returns the full executor result (summary +
 * optional data like a new trip id) or throws on failure — callers rely on
 * the throw to trigger transaction rollback.
 *
 * `emit` is routed through to the executor so broadcasts can be buffered
 * and only fired after the surrounding transaction commits. This prevents
 * phantom `task.created` / `trip.updated` events for entities that end up
 * rolled back by a later sibling failure in a bundle.
 */
async function commitRow(
  db: Kysely<DB>,
  row: ProposalsTable,
  resolvedByUserId: string,
  resolvedByMessageId: string | null,
  sink: CommitBuffer,
  tzOffset: string,
  tz: string | null,
  argsOverride?: unknown,
  overrideGroupId?: string | null,
  additionalGroupShare = false,
  calendarId: string | null = null,
): Promise<ToolExecutionResult> {
  const validated = validateCall(
    row.tool_name,
    argsOverride === undefined ? row.args_json : JSON.stringify(argsOverride),
    tzOffset,
    tz,
  );
  if (!validated.ok) throw new Error(validated.message);

  // ADR 0063 — a group-routed proposal (email magic) executes in its target
  // group so the confirmed entity fans out there; the suggestion itself lived
  // privately in the owner's personal group.
  const execGroupId = overrideGroupId ?? row.target_group_id ?? row.group_id;
  const result = await applyToolCall(db, {
    groupId: execGroupId,
    call: validated.call,
    actorUserId: resolvedByUserId,
    provenance: row.provenance,
    mode: 'commit',
    emit: sink.emit,
    afterCommit: sink.afterCommit,
    tzOffset,
    tz,
    ...(additionalGroupShare ? { additionalGroupShare: true } : {}),
    ...(calendarId ? { calendarId } : {}),
  });
  // A refusal is not a write: leave the proposal pending so the card can ask.
  const refused = (result.data as { reason?: string } | undefined)?.reason;
  if (refused === 'calendar_required' || refused === 'calendar_not_writable') {
    throw new CalendarChoiceError(refused);
  }

  await db
    .updateTable('proposals')
    .set({
      status: 'confirmed',
      resolved_by_user_id: resolvedByUserId,
      resolved_by_message_id: resolvedByMessageId,
      resolved_at: new Date().toISOString(),
    })
    .where('id', '=', row.id)
    .execute();

  return result;
}

interface CommitBuffer {
  emit: SseBroadcaster;
  afterCommit: (job: (db: Kysely<DB>) => Promise<void>) => void;
  /** Send the broadcasts and start the background work, on `db` (not the
   *  transaction). Only after the transaction committed. */
  flush: (db: Kysely<DB>) => void;
}

/**
 * Collect SSE emissions and background work (calendar sync, meeting summary)
 * in memory. The caller flushes them only after the surrounding transaction
 * commits. If it rolls back, the buffer is discarded — no events and no work
 * for writes that no longer exist.
 */
function createCommitBuffer(): CommitBuffer {
  const buf: Array<{ ch: string; ev: SseEventName; data: SseEventMap[SseEventName] }> = [];
  const jobs: Array<(db: Kysely<DB>) => Promise<void>> = [];
  return {
    emit: (ch, ev, data) => {
      buf.push({ ch, ev, data });
    },
    afterCommit: (job) => {
      jobs.push(job);
    },
    flush: (db) => {
      for (const { ch, ev, data } of buf) {
        sseHub.broadcast(ch, ev as SseEventName, data as never);
      }
      for (const job of jobs) runInBackground(job(db));
    },
  };
}

/**
 * Accept a pending proposal: re-validate args, dispatch via applyToolCall
 * (commit mode), flip status + record resolver.
 *
 * Bundle semantics (ADR 0009): if the proposal has a `bundle_id`, confirm
 * all pending siblings atomically. `create_trip` commits first so its new
 * trip id can be stamped into the child proposals' args before they commit.
 */
/**
 * Acting on an email-born suggestion — confirm OR reject — implies its source
 * mail was read; clear UNREAD on the way out. Scoped to `proposed_by_user_id`
 * because the mirror row lives in the mailbox owner's mirror, and they are the
 * only one whose mailbox the thread exists in — a group member confirming on
 * their behalf must not be looked up instead.
 *
 * Dynamically imported: `gmail.service` imports this module for
 * `retractByProvenance`, so a static edge back would close a cycle.
 */
async function markEmailSourcesRead(
  db: Kysely<DB>,
  rows: Array<{ proposed_by_user_id: string | null; provenance: string | null }>,
): Promise<void> {
  const byUser = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.proposed_by_user_id || !r.provenance?.startsWith('gmail:')) continue;
    const keys = byUser.get(r.proposed_by_user_id) ?? [];
    keys.push(r.provenance);
    byUser.set(r.proposed_by_user_id, keys);
  }
  if (byUser.size === 0) return;
  try {
    const { markSourceThreadsRead } = await import('./email/thread-read.js');
    for (const [userId, keys] of byUser) {
      await markSourceThreadsRead(db, userId, keys);
    }
  } catch (err) {
    logger.warn('marking email sources read failed', { err });
  }
}

/**
 * ADR 0315 addendum — an email meeting card that carried guests: tell the
 * confirmer in their personal chat who the calendar actually invited, with a
 * link to edit the event. Best effort; the confirm already succeeded.
 */
async function noticeEmailMeetingInvites(
  db: Kysely<DB>,
  row: ProposalsTable,
  userId: string,
  tz: string | null,
  result: ToolExecutionResult | null,
  /** ADR 0348 — the user added the meeting without sending invitations. */
  notInvited = false,
): Promise<void> {
  if (row.tool_name !== 'create_event' || !row.provenance?.startsWith('gmail:') || !result) return;
  try {
    const args = JSON.parse(row.args_json) as { title?: string; startsAt?: string; invitees?: unknown };
    const asked = Array.isArray(args.invitees) ? args.invitees.filter((e): e is string => typeof e === 'string') : [];
    if (asked.length === 0 || !args.title || !args.startsAt) return;
    const { postMeetingInviteNotice } = await import('./email/meeting-invite-notice.js');
    await postMeetingInviteNotice(db, {
      userId,
      title: args.title,
      startsAt: args.startsAt,
      tz,
      asked,
      outcome: {
        ...((result.data ?? {}) as Record<string, never>),
        ...(notInvited ? { notInvited: true, eventId: await eventMadeFrom(db, userId, row.provenance) } : {}),
      },
    });
  } catch (err) {
    logger.warn('meeting invite notice failed', { err, proposalId: row.id });
  }
}

/** The event a confirm just made from this email (no guests, so the tool did not name it). */
async function eventMadeFrom(db: Kysely<DB>, userId: string, provenance: string): Promise<string | undefined> {
  const ev = await db
    .selectFrom('events')
    .select('id')
    .where('owner_user_id', '=', userId)
    .where('source_raw_context', '=', provenance)
    .where('deleted_at', 'is', null)
    .orderBy('created_at', 'desc')
    .executeTakeFirst();
  return ev?.id;
}

/**
 * ADR 0348 — the args of an email card that would add a meeting with other
 * people (not an invitation's own card, which answers that invitation).
 */
function emailMeetingCardArgs(row: ProposalsTable): Record<string, unknown> | null {
  if (row.tool_name !== 'create_event' || !row.provenance?.startsWith('gmail:')) return null;
  try {
    const a = JSON.parse(row.args_json || '{}') as Record<string, unknown>;
    if (a.alreadyInGoogle === true || a.externalUid) return null;
    return Array.isArray(a.invitees) && a.invitees.length > 0 ? a : null;
  } catch {
    return null;
  }
}

/** The card's event with nobody invited: the guests stay a suggestion. */
function withoutInvites(args: Record<string, unknown>): Record<string, unknown> {
  const { invitees: _i, whoSends: _w, lapsedNote: _l, ...rest } = args;
  return rest;
}

/**
 * ADR 0348 — the meeting is already on the calendar (someone on the thread
 * sent the invitation): confirming adds nothing and sends nothing, and says so.
 */
async function confirmAlreadyOnCalendar(
  db: Kysely<DB>,
  row: ProposalsTable,
  input: ConfirmProposalInput,
  resolvedByMessageId: string | null,
  tz: string | null,
  existingTitle: string,
): Promise<ConfirmProposalResult> {
  const claimed = await db
    .updateTable('proposals')
    .set({
      status: 'confirmed',
      resolved_by_user_id: input.resolvedByUserId,
      resolved_by_message_id: resolvedByMessageId,
      resolved_at: new Date().toISOString(),
    })
    .where('id', '=', row.id)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  if (Number(claimed.numUpdatedRows) === 0) return { ok: false, reason: 'already_resolved' };
  await markEmailSourcesRead(db, [row]);
  await noticeEmailMeetingInvites(db, row, input.resolvedByUserId, tz, {
    summary: '',
    data: { merged: 'covered', existingTitle },
  });
  const updated = await db.selectFrom('proposals').selectAll().where('id', '=', row.id).executeTakeFirstOrThrow();
  return {
    ok: true,
    proposal: rowToProposal(updated),
    summary: `"${existingTitle}" is already on the calendar; nothing was added and no invitations went out`,
    affected: [row.id],
  };
}

/** The invitation a `create_event` proposal carries, or null for anything else. */
export function inviteArgsOf(row: {
  tool_name: string;
  args_json: string;
}): { externalUid: string; organizerEmail: string | null; title: string | null } | null {
  if (row.tool_name !== 'create_event') return null;
  try {
    const a = JSON.parse(row.args_json || '{}') as {
      alreadyInGoogle?: boolean;
      externalUid?: string;
      organizerEmail?: string;
      title?: string;
    };
    if (a.alreadyInGoogle !== true || !a.externalUid) return null;
    return {
      externalUid: a.externalUid,
      organizerEmail: a.organizerEmail ?? null,
      title: a.title ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * ADR 0343 — "Move it": the email's event is the user's existing one at a new
 * time. The offer is worked out again here, so only the event the card
 * offered can be moved; the move is an ordinary `update_event` in that
 * event's group, keeping its length when the email gives no end.
 */
async function confirmAsMove(
  db: Kysely<DB>,
  row: ProposalsTable,
  input: ConfirmProposalInput,
  resolvedByMessageId: string | null,
): Promise<ConfirmProposalResult> {
  const offers = await replaceOffersFor(db, input.resolvedByUserId, [row]);
  const offer = offers.get(row.id);
  if (!offer || offer.eventId !== input.replaceEventId) {
    return { ok: false, reason: 'replace_unavailable' };
  }
  const event = await db
    .selectFrom('events')
    .innerJoin('group_members', (j) =>
      j.onRef('group_members.group_id', '=', 'events.group_id').on('group_members.user_id', '=', input.resolvedByUserId),
    )
    .select(['events.id as id', 'events.group_id as group_id', 'events.starts_at as starts_at', 'events.ends_at as ends_at'])
    .where('events.id', '=', offer.eventId)
    .executeTakeFirst();
  if (!event) return { ok: false, reason: 'replace_unavailable' };

  const { tzOffset, tz } = await offsetForUser(db, input.resolvedByUserId);
  const args = JSON.parse(row.args_json) as { startsAt: string; endsAt?: string };
  const newStart = instantInZoneMs(args.startsAt, tz);
  const givenEnd = args.endsAt ? instantInZoneMs(args.endsAt, tz) : NaN;
  const oldStart = instantInZoneMs(event.starts_at, tz);
  const oldEnd = event.ends_at ? instantInZoneMs(event.ends_at, tz) : NaN;
  const endsAt =
    Number.isFinite(givenEnd) && givenEnd > newStart
      ? args.endsAt
      : Number.isFinite(oldEnd) && oldEnd > oldStart
        ? new Date(newStart + (oldEnd - oldStart)).toISOString()
        : undefined;
  const moveArgs = { eventId: event.id, startsAt: args.startsAt, ...(endsAt ? { endsAt } : {}) };
  const asMove: ProposalsTable = { ...row, tool_name: 'update_event' };

  const preflight = validateCall('update_event', JSON.stringify(moveArgs), tzOffset, tz);
  if (!preflight.ok) return { ok: false, reason: 'invalid_args', message: preflight.message };
  const sink = createCommitBuffer();
  let summary: string;
  try {
    summary = await db.transaction().execute(async (trx) => {
      bindAfterCommit(trx, sink.afterCommit);
      await claimPending(trx, [row.id], input.resolvedByUserId, resolvedByMessageId);
      const r = await commitRow(
        trx,
        asMove,
        input.resolvedByUserId,
        resolvedByMessageId,
        sink,
        tzOffset,
        tz,
        moveArgs,
        event.group_id,
      );
      if ((r.data as { updated?: boolean } | undefined)?.updated === false) {
        throw new Error(r.summary || 'event not moved');
      }
      return r.summary;
    });
  } catch (err) {
    if (err instanceof AlreadyResolvedError) return { ok: false, reason: 'already_resolved' };
    logger.error('proposal move failed', { err, proposalId: row.id });
    return { ok: false, reason: 'exec_failed', message: (err as Error).message };
  }
  sink.flush(db);
  logger.info('email event confirmed as a move', { proposalId: row.id, eventId: event.id });
  await markEmailSourcesRead(db, [row]);
  const updated = await db.selectFrom('proposals').selectAll().where('id', '=', row.id).executeTakeFirst();
  return { ok: true, proposal: rowToProposal(updated!), summary, affected: [row.id] };
}

export async function confirmProposal(
  db: Kysely<DB>,
  input: ConfirmProposalInput,
): Promise<ConfirmProposalResult> {
  const row = await db
    .selectFrom('proposals')
    .selectAll()
    .where('id', '=', input.id)
    .executeTakeFirst();
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status !== 'pending') {
    if (row.status === 'expired') return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'already_resolved' };
  }
  if (Date.parse(row.expires_at) < Date.now()) {
    await db
      .updateTable('proposals')
      .set({ status: 'expired' })
      .where('id', '=', row.id)
      .where('status', '=', 'pending')
      .execute();
    return { ok: false, reason: 'expired' };
  }

  const resolvedByMessageId = input.resolvedByMessageId ?? null;

  // An invitation is answered, not filed (ADR 0104): confirming one means
  // "yes", and the organizer hears it. Done here so the docked email card, the
  // feeds, a chat "yes" and a Telegram tap all behave the same; the RSVP route
  // has already answered (with the user's actual choice) and says so.
  if (!input.inviteAnswered) {
    const invite = inviteArgsOf(row);
    if (invite) {
      const { respondToInvite } = await import('./google/rsvp.service.js');
      const rsvp = await respondToInvite(db, input.resolvedByUserId, {
        icalUid: invite.externalUid,
        response: 'accepted',
        organizerEmail: invite.organizerEmail,
        title: invite.title,
        provenance: row.provenance,
      });
      if (!rsvp.ok) {
        return { ok: false, reason: 'exec_failed', message: rsvp.reason ?? 'rsvp_failed' };
      }
    }
  }

  if (input.replaceEventId) return confirmAsMove(db, row, input, resolvedByMessageId);

  // ADR 0063 — a group-routed proposal executes in target_group_id; the
  // confirmer must belong to that group. Under ADR 0097 that value now comes
  // either from a standing routing rule or from this confirm call, so the
  // membership check is doing real work rather than backstopping a value we
  // generated ourselves.
  //
  // ADR 0247 — `targetGroupIds` names several destinations at once; each one
  // gets its own copy, run as if confirmed into that group alone.
  const pickedGroups = [
    ...new Set((input.targetGroupIds ?? []).filter((g) => typeof g === 'string' && g.length > 0)),
  ];
  if (pickedGroups.length > MAX_CONFIRM_GROUPS) {
    return { ok: false, reason: 'invalid_args', message: `at most ${MAX_CONFIRM_GROUPS} groups` };
  }
  const targetGroupId =
    input.targetGroupId !== undefined ? input.targetGroupId : row.target_group_id;
  const destinations: Array<string | null> =
    pickedGroups.length > 0 ? pickedGroups : [targetGroupId ?? null];
  for (const dest of destinations) {
    if (!dest) continue;
    const member = await db
      .selectFrom('group_members')
      .select('user_id')
      .where('group_id', '=', dest)
      .where('user_id', '=', input.resolvedByUserId)
      .executeTakeFirst();
    if (!member) {
      return { ok: false, reason: 'exec_failed', message: 'not a member of the target group' };
    }
  }
  // The one group the user named by hand on this confirm, if exactly one.
  const explicitGroups =
    pickedGroups.length > 0
      ? pickedGroups
      : typeof input.targetGroupId === 'string' && input.targetGroupId.length > 0
        ? [input.targetGroupId]
        : [];

  // Standalone proposal — wrap in a transaction anyway so the entity write
  // + proposal status flip are atomic, and route SSE through a buffered
  // emitter that only flushes after commit (prevents phantom `task.created`
  // events if the status flip fails post-insert).
  const { tzOffset, tz } = await offsetForUser(db, input.resolvedByUserId);

  if (!row.bundle_id) {
    const preflight = validateCall(row.tool_name, row.args_json, tzOffset, tz);
    if (!preflight.ok) return { ok: false, reason: 'invalid_args', message: preflight.message };
    // ADR 0348 — an email meeting card adds the meeting; inviting its guests
    // is a separate choice the user makes on the card.
    const meeting = emailMeetingCardArgs(row);
    if (meeting) {
      const { meetingAlreadyOnCalendar } = await import('./events/calendar-fit.service.js');
      const already = await meetingAlreadyOnCalendar(db, input.resolvedByUserId, {
        args: meeting,
        provenance: row.provenance,
      });
      if (already) return confirmAlreadyOnCalendar(db, row, input, resolvedByMessageId, tz, already.title);
    }
    const argsOverride = meeting && !input.sendInvites ? withoutInvites(meeting) : undefined;
    const sink = createCommitBuffer();
    let summary: string;
    let firstResult: ToolExecutionResult | null = null;
    try {
      summary = await db.transaction().execute(async (trx) => {
        bindAfterCommit(trx, sink.afterCommit);
        await claimPending(trx, [row.id], input.resolvedByUserId, resolvedByMessageId);
        const out: string[] = [];
        for (const [i, dest] of destinations.entries()) {
          const r = await commitRow(
            trx,
            row,
            input.resolvedByUserId,
            resolvedByMessageId,
            sink,
            tzOffset,
            tz,
            argsOverride,
            // ADR 0097 — an explicit destination from this confirm wins over
            // the one the proposal was staged with. Only the standalone path
            // takes it: a screenshot bundle (ADR 0029) is several entities
            // resolved in one tap, and "put THAT one in the family group" is
            // not expressible there.
            dest,
            i > 0,
            input.calendarId ?? null,
          );
          if (i === 0) firstResult = r;
          out.push(r.summary);
        }
        return out.join(' · ');
      });
    } catch (err) {
      if (err instanceof CalendarChoiceError) return { ok: false, reason: err.reason };
      if (err instanceof AlreadyResolvedError) return { ok: false, reason: 'already_resolved' };
      logger.error('proposal commit failed', { err, proposalId: row.id });
      return { ok: false, reason: 'exec_failed', message: (err as Error).message };
    }
    sink.flush(db);
    logEmailChangeResolved(row, 'confirmed');
    await markEmailSourcesRead(db, [row]);
    await noticeEmailMeetingInvites(db, row, input.resolvedByUserId, tz, firstResult, !!argsOverride);
    const updated = await db
      .selectFrom('proposals')
      .selectAll()
      .where('id', '=', row.id)
      .executeTakeFirst();

    // ADR 0150 — only when the user named a destination on THIS confirm (the
    // explicit override, not the staged fallback) is there a correction to
    // learn from. The suggestion is deterministic and only ever pre-selects a
    // future proposal; it never routes anything on its own.
    // A rule routes to ONE group, so several picks teach nothing standing.
    let routeSuggestion: RouteSuggestion | null = null;
    if (explicitGroups.length === 1) {
      routeSuggestion = await suggestRuleFromRouting(db, {
        userId: input.resolvedByUserId,
        provenance: row.provenance,
        targetGroupId: explicitGroups[0]!,
      }).catch((err) => {
        logger.warn('routeSuggestion failed', { err, proposalId: row.id });
        return null;
      });
    }

    return {
      ok: true,
      proposal: rowToProposal(updated!),
      summary,
      affected: [row.id],
      ...(routeSuggestion ? { routeSuggestion } : {}),
    };
  }

  // Bundle commit. Order: create_trip first (so children get its id), then
  // trip children, then anything else. Run the whole chain inside a
  // transaction so a mid-bundle failure rolls back every write — no
  // partially-committed trip + first leg left behind (ADR 0009 atomicity
  // guarantee).
  const siblings = await db
    .selectFrom('proposals')
    .selectAll()
    .where('bundle_id', '=', row.bundle_id)
    .where('status', '=', 'pending')
    .execute();

  const tripProposal = siblings.find((s) => s.tool_name === 'create_trip') ?? null;
  const children = siblings.filter((s) => TRIP_CHILD_TOOLS.has(s.tool_name));
  const others = siblings.filter(
    (s) => s.tool_name !== 'create_trip' && !TRIP_CHILD_TOOLS.has(s.tool_name),
  );

  // Preflight every row — if any is malformed, refuse to commit any.
  for (const s of siblings) {
    const pre = validateCall(s.tool_name, s.args_json, tzOffset, tz);
    if (!pre.ok) {
      return { ok: false, reason: 'invalid_args', message: `proposal ${s.id}: ${pre.message}` };
    }
  }

  // ADR 0233 — a TRIP bundle can be sent to a shared group on this confirm, the
  // way a standalone proposal can (ADR 0097). Every member then runs in that
  // group, because a leg or stay checks that its trip lives in the group it is
  // added from — the trip is created there and the children follow it. Only a
  // trip bundle: a screenshot bundle (ADR 0029) is several unrelated entities
  // resolved in one tap, where "put THAT one in the family group" still has no
  // meaning. The membership check above has already vetted the group.
  // ADR 0247 — several groups picked: the whole trip (trip + legs + stays) is
  // created once per group, each its own trip in its own group.
  const bundleGroupIds: Array<string | undefined> =
    tripProposal && explicitGroups.length > 0 ? explicitGroups : [undefined];

  const sink = createCommitBuffer();
  let summaries: string[];
  try {
    summaries = await db.transaction().execute(async (trx) => {
      bindAfterCommit(trx, sink.afterCommit);
      // The card being confirmed is always claimed too: if another confirm
      // committed the bundle after this one read it, `siblings` is empty, and
      // claiming nothing used to "succeed" — reporting ok with nothing done.
      await claimPending(
        trx,
        [...new Set([row.id, ...siblings.map((s) => s.id)])],
        input.resolvedByUserId,
        resolvedByMessageId,
      );
      const out: string[] = [];
      for (const [gi, bundleGroupId] of bundleGroupIds.entries()) {
        const extra = gi > 0;
        let newTripId: string | null = null;

        if (tripProposal) {
          const r = await commitRow(
            trx,
            tripProposal,
            input.resolvedByUserId,
            resolvedByMessageId,
            sink,
            tzOffset,
            tz,
            undefined,
            bundleGroupId,
            extra,
          );
          out.push(r.summary);
          const data = r.data as { tripId?: string } | undefined;
          newTripId = data?.tripId ?? null;
        }

        for (const c of children) {
          const parsed = JSON.parse(c.args_json) as Record<string, unknown>;
          if (newTripId && !parsed.tripId) parsed.tripId = newTripId;
          const r = await commitRow(
            trx,
            c,
            input.resolvedByUserId,
            resolvedByMessageId,
            sink,
            tzOffset,
            tz,
            parsed,
            bundleGroupId,
            extra,
          );
          out.push(r.summary);
        }

        for (const o of others) {
          const r = await commitRow(
            trx,
            o,
            input.resolvedByUserId,
            resolvedByMessageId,
            sink,
            tzOffset,
            tz,
            undefined,
            bundleGroupId,
            extra,
          );
          out.push(r.summary);
        }
      }

      return out;
    });
  } catch (err) {
    if (err instanceof AlreadyResolvedError) return { ok: false, reason: 'already_resolved' };
    logger.error('bundle commit rolled back', { err, bundleId: row.bundle_id });
    return { ok: false, reason: 'exec_failed', message: (err as Error).message };
  }
  // Transaction committed successfully — only now do buffered broadcasts
  // land on the SSE hub. If we'd thrown, `flush()` is never called and the
  // buffer is discarded along with the rolled-back rows.
  sink.flush(db);
  await markEmailSourcesRead(db, siblings);

  const updated = await db
    .selectFrom('proposals')
    .selectAll()
    .where('id', '=', row.id)
    .executeTakeFirst();
  return {
    ok: true,
    proposal: rowToProposal(updated!),
    summary: summaries.join(' · '),
    affected: siblings.map((s) => s.id),
  };
}

export async function rejectProposal(
  db: Kysely<DB>,
  input: { id: string; resolvedByUserId: string; resolvedByMessageId?: string | null },
): Promise<{ proposal: Proposal; affected: string[] } | null> {
  const row = await db
    .selectFrom('proposals')
    .selectAll()
    .where('id', '=', input.id)
    .executeTakeFirst();
  if (!row) return null;
  if (row.status !== 'pending') {
    return { proposal: rowToProposal(row), affected: [row.id] };
  }

  // Bundle rejects: reject every pending sibling together. Members
  // already resolved are left alone — this should not normally happen.
  const siblings = row.bundle_id
    ? await db
        .selectFrom('proposals')
        .select(['id', 'proposed_by_user_id', 'provenance'])
        .where('bundle_id', '=', row.bundle_id)
        .where('status', '=', 'pending')
        .execute()
    : [row];
  const ids = siblings.map((r) => r.id);

  await db
    .updateTable('proposals')
    .set({
      status: 'rejected',
      resolved_by_user_id: input.resolvedByUserId,
      resolved_by_message_id: input.resolvedByMessageId ?? null,
      resolved_at: new Date().toISOString(),
    })
    .where('id', 'in', ids)
    // A confirm that won the race has already run the tool: never relabel it.
    .where('status', '=', 'pending')
    .execute();

  logEmailChangeResolved(row, 'rejected');
  // docs/notes/0191 — a rejected add_person takes its provisional person with it.
  await sweepOrphanProvisionalPeople(db);
  await markEmailSourcesRead(db, siblings);

  const updated = await db
    .selectFrom('proposals')
    .selectAll()
    .where('id', '=', row.id)
    .executeTakeFirst();
  return updated ? { proposal: rowToProposal(updated), affected: ids } : null;
}

/**
 * Lazy expiry sweep. Called on list-reads to avoid a cron for now. Flips
 * pending rows whose `expires_at` is in the past to 'expired' and returns
 * `{id, groupId}` per affected row so the caller can broadcast
 * `proposal.resolved` to the right group channels — live-removal of stale
 * pills without reloading the client.
 */
export async function expireStale(
  db: Kysely<DB>,
): Promise<Array<{ id: string; groupId: string }>> {
  const nowIso = new Date().toISOString();
  const stale = await db
    .selectFrom('proposals')
    .select(['id', 'group_id'])
    .where('status', '=', 'pending')
    .where('expires_at', '<', nowIso)
    .execute();
  if (stale.length === 0) return [];
  await db
    .updateTable('proposals')
    .set({ status: 'expired', resolved_at: nowIso })
    .where(
      'id',
      'in',
      stale.map((r) => r.id),
    )
    .where('status', '=', 'pending')
    .execute();
  await sweepOrphanProvisionalPeople(db);
  return stale.map((r) => ({ id: r.id, groupId: r.group_id }));
}

/**
 * Retract pending proposals whose source artifact no longer exists — e.g. a
 * Gmail thread deleted before the owner decided: the email→proposal flow dies
 * with the email. Confirmed/rejected rows are history and never touched; an
 * entity created from an earlier confirm survives its source's deletion.
 * Returns `{id, groupId}` per retracted row (same contract as `expireStale`).
 */
export async function retractByProvenance(
  db: Kysely<DB>,
  proposedByUserId: string,
  provenanceKeys: string[],
): Promise<Array<{ id: string; groupId: string }>> {
  if (provenanceKeys.length === 0) return [];
  const nowIso = new Date().toISOString();
  const rows = await db
    .selectFrom('proposals')
    .select(['id', 'group_id'])
    .where('proposed_by_user_id', '=', proposedByUserId)
    .where('status', '=', 'pending')
    .where('provenance', 'in', provenanceKeys)
    .execute();
  if (rows.length === 0) return [];
  await db
    .updateTable('proposals')
    .set({ status: 'expired', resolved_at: nowIso })
    .where(
      'id',
      'in',
      rows.map((r) => r.id),
    )
    .execute();
  await sweepOrphanProvisionalPeople(db);
  return rows.map((r) => ({ id: r.id, groupId: r.group_id }));
}
