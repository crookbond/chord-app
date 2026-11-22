/**
 * Trusted-sender list and permission-request workflow.
 *
 * Closed by default: a user can only assign a task / event to another
 * user if the recipient has explicitly granted them. Group membership
 * is not sufficient. Self-assignment is always allowed and never
 * stored — `isTrusted(x, x, _) === true` without a DB lookup.
 *
 * Scopes are a comma-separated subset of `task` and `event`. We do
 * not gate `save` or `list_item` writes — those are shared-group
 * artifacts where membership is the right gate.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../db/schema.js';
import { newId } from '../utils/ids.js';

export type TrustScope = 'task' | 'event';

/**
 * Thrown by service write paths when a sender tries to assign to a
 * recipient who hasn't trusted them. Carries enough context for the
 * caller (HTTP route, bot tool executor) to open a permission_request
 * and surface a useful message.
 */
export class TrustError extends Error {
  readonly code = 'TRUST_DENIED';
  constructor(
    readonly scope: TrustScope,
    readonly senderUserId: string,
    readonly recipientUserId: string,
  ) {
    super(`user ${senderUserId} not trusted to ${scope} for ${recipientUserId}`);
  }
}

const ALL_SCOPES: ReadonlySet<TrustScope> = new Set(['task', 'event']);

function parseScopes(s: string): Set<TrustScope> {
  const out = new Set<TrustScope>();
  for (const part of s.split(',')) {
    const t = part.trim();
    if (t === 'task' || t === 'event') out.add(t);
  }
  return out;
}

function stringifyScopes(scopes: ReadonlySet<TrustScope>): string {
  return [...scopes].sort().join(',');
}

export async function isTrusted(
  db: Kysely<DB>,
  recipientUserId: string,
  senderUserId: string,
  scope: TrustScope,
): Promise<boolean> {
  if (recipientUserId === senderUserId) return true;
  const row = await db
    .selectFrom('trusted_senders')
    .select('scopes')
    .where('recipient_user_id', '=', recipientUserId)
    .where('sender_user_id', '=', senderUserId)
    .executeTakeFirst();
  if (!row) return false;
  return parseScopes(row.scopes).has(scope);
}

/**
 * ADR 0151 — trust to give work to a *managed persona* (a kid, a grandparent)
 * is indirected through the adult who manages them: a persona cannot consent,
 * so the consent authority is `personas.managed_by`. The assigner passes when
 * they ARE the manager, or when the manager has trusted them for this scope.
 *
 * Returns `managedBy` too, so a refusing caller can build the `TrustError` /
 * permission request against the adult rather than the persona.
 */
export async function isTrustedForPersona(
  db: Kysely<DB>,
  personaId: string,
  senderUserId: string,
  scope: TrustScope,
): Promise<{ trusted: boolean; managedBy: string | null }> {
  const row = await db
    .selectFrom('personas')
    .select('managed_by')
    .where('id', '=', personaId)
    .executeTakeFirst();
  const managedBy = row?.managed_by ?? null;
  // A managed persona with no manager has no consent authority — nobody can be
  // trusted on its behalf.
  if (!managedBy) return { trusted: false, managedBy: null };
  if (senderUserId === managedBy) return { trusted: true, managedBy };
  return { trusted: await isTrusted(db, managedBy, senderUserId, scope), managedBy };
}

export interface TrustGrant {
  id: string;
  recipientUserId: string;
  senderUserId: string;
  scopes: TrustScope[];
  grantedAt: string;
}

export async function listGrantsByRecipient(
  db: Kysely<DB>,
  recipientUserId: string,
): Promise<TrustGrant[]> {
  const rows = await db
    .selectFrom('trusted_senders')
    .selectAll()
    .where('recipient_user_id', '=', recipientUserId)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    recipientUserId: r.recipient_user_id,
    senderUserId: r.sender_user_id,
    scopes: [...parseScopes(r.scopes)],
    grantedAt: r.granted_at,
  }));
}

/**
 * Upsert grant. Passing an empty scope set revokes (deletes the row).
 * Returns the resulting grant or null if it was revoked.
 */
export async function setGrant(
  db: Kysely<DB>,
  recipientUserId: string,
  senderUserId: string,
  scopes: TrustScope[],
): Promise<TrustGrant | null> {
  if (recipientUserId === senderUserId) {
    throw new Error('cannot grant trust to yourself');
  }
  const sanitized = new Set<TrustScope>();
  for (const s of scopes) if (ALL_SCOPES.has(s)) sanitized.add(s);

  if (sanitized.size === 0) {
    await db
      .deleteFrom('trusted_senders')
      .where('recipient_user_id', '=', recipientUserId)
      .where('sender_user_id', '=', senderUserId)
      .execute();
    return null;
  }

  const existing = await db
    .selectFrom('trusted_senders')
    .selectAll()
    .where('recipient_user_id', '=', recipientUserId)
    .where('sender_user_id', '=', senderUserId)
    .executeTakeFirst();
  const scopeStr = stringifyScopes(sanitized);
  if (existing) {
    await db
      .updateTable('trusted_senders')
      .set({ scopes: scopeStr })
      .where('id', '=', existing.id)
      .execute();
    return {
      id: existing.id,
      recipientUserId,
      senderUserId,
      scopes: [...sanitized],
      grantedAt: existing.granted_at,
    };
  }
  const id = newId('trust');
  const grantedAt = new Date().toISOString();
  await db
    .insertInto('trusted_senders')
    .values({
      id,
      recipient_user_id: recipientUserId,
      sender_user_id: senderUserId,
      scopes: scopeStr,
      granted_at: grantedAt,
    })
    .execute();
  return { id, recipientUserId, senderUserId, scopes: [...sanitized], grantedAt };
}

export interface PermissionRequest {
  id: string;
  recipientUserId: string;
  senderUserId: string;
  groupId: string | null;
  scopes: TrustScope[];
  reason: string | null;
  status: 'pending' | 'approved' | 'denied';
  requestedAt: string;
  resolvedAt: string | null;
}

/**
 * Open a permission request. If a pending request already exists for
 * the same (recipient, sender) pair, the existing one is returned —
 * scopes are unioned so a follow-up ask doesn't shadow earlier scopes.
 */
export async function requestPermission(
  db: Kysely<DB>,
  opts: {
    recipientUserId: string;
    senderUserId: string;
    groupId?: string | null;
    scopes: TrustScope[];
    reason?: string | null;
  },
): Promise<PermissionRequest> {
  if (opts.recipientUserId === opts.senderUserId) {
    throw new Error('cannot request permission from yourself');
  }
  const sanitized = new Set<TrustScope>();
  for (const s of opts.scopes) if (ALL_SCOPES.has(s)) sanitized.add(s);
  if (sanitized.size === 0) sanitized.add('task');

  const existing = await db
    .selectFrom('permission_requests')
    .selectAll()
    .where('recipient_user_id', '=', opts.recipientUserId)
    .where('sender_user_id', '=', opts.senderUserId)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  if (existing) {
    const merged = new Set([...parseScopes(existing.scopes), ...sanitized]);
    await db
      .updateTable('permission_requests')
      .set({ scopes: stringifyScopes(merged) })
      .where('id', '=', existing.id)
      .execute();
    return {
      id: existing.id,
      recipientUserId: existing.recipient_user_id,
      senderUserId: existing.sender_user_id,
      groupId: existing.group_id,
      scopes: [...merged],
      reason: existing.reason,
      status: 'pending',
      requestedAt: existing.requested_at,
      resolvedAt: existing.resolved_at,
    };
  }
  const id = newId('preq');
  const requestedAt = new Date().toISOString();
  await db
    .insertInto('permission_requests')
    .values({
      id,
      recipient_user_id: opts.recipientUserId,
      sender_user_id: opts.senderUserId,
      group_id: opts.groupId ?? null,
      scopes: stringifyScopes(sanitized),
      reason: opts.reason ?? null,
      status: 'pending',
      requested_at: requestedAt,
      resolved_at: null,
    })
    .execute();
  return {
    id,
    recipientUserId: opts.recipientUserId,
    senderUserId: opts.senderUserId,
    groupId: opts.groupId ?? null,
    scopes: [...sanitized],
    reason: opts.reason ?? null,
    status: 'pending',
    requestedAt,
    resolvedAt: null,
  };
}

export async function listIncomingRequests(
  db: Kysely<DB>,
  recipientUserId: string,
  status: 'pending' | 'approved' | 'denied' | 'all' = 'pending',
): Promise<PermissionRequest[]> {
  let q = db
    .selectFrom('permission_requests')
    .selectAll()
    .where('recipient_user_id', '=', recipientUserId);
  if (status !== 'all') q = q.where('status', '=', status);
  const rows = await q.orderBy('requested_at', 'desc').limit(100).execute();
  return rows.map(rowToRequest);
}

export async function listOutgoingRequests(
  db: Kysely<DB>,
  senderUserId: string,
): Promise<PermissionRequest[]> {
  const rows = await db
    .selectFrom('permission_requests')
    .selectAll()
    .where('sender_user_id', '=', senderUserId)
    .orderBy('requested_at', 'desc')
    .limit(100)
    .execute();
  return rows.map(rowToRequest);
}

/**
 * Recipient approves or denies a pending request. Approval upserts
 * the trust grant with the requested scopes; denial just resolves
 * the row.
 */
export async function respondToRequest(
  db: Kysely<DB>,
  opts: {
    requestId: string;
    recipientUserId: string;
    decision: 'approve' | 'deny';
  },
): Promise<PermissionRequest> {
  const row = await db
    .selectFrom('permission_requests')
    .selectAll()
    .where('id', '=', opts.requestId)
    .executeTakeFirst();
  if (!row) throw new Error('request not found');
  if (row.recipient_user_id !== opts.recipientUserId) {
    throw new Error('not the recipient of this request');
  }
  if (row.status !== 'pending') {
    throw new Error('request already resolved');
  }
  const resolvedAt = new Date().toISOString();
  await db
    .updateTable('permission_requests')
    .set({
      status: opts.decision === 'approve' ? 'approved' : 'denied',
      resolved_at: resolvedAt,
    })
    .where('id', '=', opts.requestId)
    .execute();
  if (opts.decision === 'approve') {
    await setGrant(db, opts.recipientUserId, row.sender_user_id, [
      ...parseScopes(row.scopes),
    ]);
  }
  return {
    id: row.id,
    recipientUserId: row.recipient_user_id,
    senderUserId: row.sender_user_id,
    groupId: row.group_id,
    scopes: [...parseScopes(row.scopes)],
    reason: row.reason,
    status: opts.decision === 'approve' ? 'approved' : 'denied',
    requestedAt: row.requested_at,
    resolvedAt,
  };
}

export interface TrustCandidate {
  userId: string;
  displayName: string;
  email: string | null;
  sharedGroups: string[];
}

/**
 * Users who share at least one group with the given user (excluding
 * self and the @chord bot user). Used by the Settings UI to populate
 * the "add trusted sender" picker.
 */
export async function listTrustCandidates(
  db: Kysely<DB>,
  userId: string,
): Promise<TrustCandidate[]> {
  const rows = await db
    .selectFrom('group_members as gm')
    .innerJoin('group_members as me', 'me.group_id', 'gm.group_id')
    .innerJoin('users', 'users.id', 'gm.user_id')
    .innerJoin('groups', 'groups.id', 'gm.group_id')
    .select([
      'gm.user_id as userId',
      'users.display_name as displayName',
      'users.email as email',
      'groups.name as groupName',
    ])
    .where('me.user_id', '=', userId)
    .where('gm.user_id', '!=', userId)
    .execute();

  const byUser = new Map<string, TrustCandidate>();
  for (const r of rows) {
    const existing = byUser.get(r.userId);
    if (existing) {
      if (!existing.sharedGroups.includes(r.groupName)) {
        existing.sharedGroups.push(r.groupName);
      }
      continue;
    }
    byUser.set(r.userId, {
      userId: r.userId,
      displayName: r.displayName ?? r.userId,
      email: r.email ?? null,
      sharedGroups: [r.groupName],
    });
  }
  return [...byUser.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }),
  );
}

function rowToRequest(row: {
  id: string;
  recipient_user_id: string;
  sender_user_id: string;
  group_id: string | null;
  scopes: string;
  reason: string | null;
  status: 'pending' | 'approved' | 'denied';
  requested_at: string;
  resolved_at: string | null;
}): PermissionRequest {
  return {
    id: row.id,
    recipientUserId: row.recipient_user_id,
    senderUserId: row.sender_user_id,
    groupId: row.group_id,
    scopes: [...parseScopes(row.scopes)],
    reason: row.reason,
    status: row.status,
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at,
  };
}
