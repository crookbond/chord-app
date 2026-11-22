import { Router } from 'express';

import {
  API,
  CreateGroupRequest,
  InviteByEmailRequest,
  type InviteByEmailResponse,
  JoinGroupRequest,
  SearchRequest,
  SetGroupMutedRequest,
  SSE,
  UpdateGroupRequest,
  type Group,
} from '@chord/kernel';

import { loadSession, requireSession } from '../middleware/auth';
import { requireMember } from '../middleware/require-member';
import { searchHits, parseSearchTypes } from '../services/search.service';
import {
  type InviteFailure,
  inviteByEmail,
  listPendingInvites,
  noteJoinedViaLink,
  respondToInvite,
} from '../services/chat-invites.service';
import {
  counterpartNames,
  createGroup,
  deleteGroupAs,
  getMemberRole,
  type GroupListRow,
  type GroupRow,
  isMember,
  joinGroupByCode,
  leaveGroupAs,
  listGroupsForUser,
  markGroupRead,
  regenerateInviteCode,
  setGroupMuted,
} from '../services/groups.service';
import { sseHub } from '../services/sse.hub';

export const groupsRouter = Router();

groupsRouter.use(loadSession);

function toGroup(
  row: GroupRow,
  lastReadAt?: string | null,
  muted?: boolean,
  counterpartName?: string,
): Group {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    inviteCode: row.invite_code,
    ingestEmail: row.ingest_email,
    createdBy: row.created_by,
    createdAt: row.created_at,
    adultsOnly: row.adults_only === 1,
    mirrorInbound: row.mirror_inbound === 1,
    ...(lastReadAt !== undefined ? { lastReadAt } : {}),
    ...(muted !== undefined ? { muted } : {}),
    ...(counterpartName ? { counterpartName } : {}),
  };
}

/** Collapse whitespace and clamp to a single short line for the chat list. */
function toPreview(body: string | null): string | null {
  if (!body) return null;
  const flat = body.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > 120 ? `${flat.slice(0, 117)}…` : flat;
}

function toGroupListItem(row: GroupListRow, counterpartName?: string): Group {
  return {
    ...toGroup(row, row.last_read_at, undefined, counterpartName),
    lastMessageAt: row.last_message_at,
    lastMessagePreview: toPreview(row.last_message_preview),
    unreadCount: Number(row.unread_count) || 0,
  };
}

groupsRouter.get(API.groups, requireSession, async (req, res, next) => {
  try {
    const rows = await listGroupsForUser(req.db, req.userId!);
    const counterparts = await counterpartNames(req.db, req.userId!, rows);
    res.json(rows.map((r) => toGroupListItem(r, counterparts.get(r.id))));
  } catch (err) {
    next(err);
  }
});

// ADR 0062 — search within a single group (membership-gated).
groupsRouter.get(
  API.groupSearch(':id'),
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      const parsed = SearchRequest.safeParse({
        q: req.query.q,
        types: parseSearchTypes(req.query.types),
        limit: req.query.limit,
      });
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid_query', detail: parsed.error.flatten() });
        return;
      }
      const out = await searchHits(req.db, {
        userId: req.userId!,
        groupId: req.params.id,
        crossGroup: false,
        query: parsed.data.q,
        types: parsed.data.types,
        limit: parsed.data.limit,
      });
      res.json(out);
    } catch (err) {
      next(err);
    }
  },
);

groupsRouter.post('/api/v1/groups/:id/read', requireSession, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!(await isMember(req.db, id, req.userId!))) {
      res.status(403).json({ error: 'not a member' });
      return;
    }
    const lastReadAt = await markGroupRead(req.db, id, req.userId!);
    // Server-authoritative read cursor: tell the member's other devices so
    // their unread badge clears in real time (they filter by userId).
    sseHub.broadcast(id, SSE.groupRead, { groupId: id, userId: req.userId!, lastReadAt });
    res.json({ ok: true, lastReadAt });
  } catch (err) {
    next(err);
  }
});

// Per-(user,group) push mute (ADR 0054). The current mute state is returned on
// the single-group GET as `Group.muted`; this only sets it.
groupsRouter.put('/api/v1/groups/:id/notifications', requireSession, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!(await isMember(req.db, id, req.userId!))) {
      res.status(403).json({ error: 'not a member' });
      return;
    }
    const parsed = SetGroupMutedRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    await setGroupMuted(req.db, id, req.userId!, parsed.data.muted);
    res.json({ ok: true, muted: parsed.data.muted });
  } catch (err) {
    next(err);
  }
});

groupsRouter.post(API.groups, requireSession, async (req, res, next) => {
  try {
    const parsed = CreateGroupRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    const row = await createGroup(req.db, {
      name: parsed.data.name,
      kind: parsed.data.kind,
      createdBy: req.userId!,
      // Typed into the create form by a person, so it is their name for it.
      nameIsCustom: true,
    });
    res.status(201).json(toGroup(row));
  } catch (err) {
    next(err);
  }
});

groupsRouter.post(API.groupJoin, requireSession, async (req, res, next) => {
  try {
    const parsed = JoinGroupRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    const row = await joinGroupByCode(req.db, req.userId!, parsed.data.inviteCode);
    if (!row) {
      res.status(404).json({ error: 'invite not found' });
      return;
    }
    // ADR 0318 - following an emailed invite's link answers it.
    await noteJoinedViaLink(req.db, req.userId!, row.id);
    res.json(toGroup(row));
  } catch (err) {
    next(err);
  }
});

const INVITE_REFUSALS: Record<InviteFailure, { status: number; error: string }> = {
  invalid_email: { status: 400, error: 'That does not look like an email address.' },
  self: { status: 400, error: 'That is your own address.' },
  not_found: { status: 404, error: 'chat not found' },
  personal: { status: 400, error: 'Your personal chat cannot have other people in it.' },
  not_member: { status: 403, error: 'not a member' },
  already_member: { status: 409, error: 'They are already in this chat.' },
};

groupsRouter.post(API.chatInviteByEmail, requireSession, async (req, res, next) => {
  try {
    const parsed = InviteByEmailRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    const out = await inviteByEmail(req.db, req.userId!, parsed.data);
    if (!out.ok) {
      const r = INVITE_REFUSALS[out.reason];
      res.status(r.status).json({ error: r.error, reason: out.reason });
      return;
    }
    const { ok: _ok, ...body } = out;
    res.json(body satisfies InviteByEmailResponse);
  } catch (err) {
    next(err);
  }
});

groupsRouter.get(API.meChatInvites, requireSession, async (req, res, next) => {
  try {
    res.json(await listPendingInvites(req.db, req.userId!));
  } catch (err) {
    next(err);
  }
});

for (const accept of [true, false]) {
  const path = accept ? API.meChatInviteAccept(':id') : API.meChatInviteDecline(':id');
  groupsRouter.post(path, requireSession, async (req, res, next) => {
    try {
      const out = await respondToInvite(req.db, req.userId!, String(req.params.id), accept);
      if (!out.ok) {
        res.status(out.reason === 'gone' ? 410 : 404).json({ error: out.reason === 'gone' ? 'That chat no longer exists.' : 'invite not found' });
        return;
      }
      res.json({ ok: true, groupId: out.groupId });
    } catch (err) {
      next(err);
    }
  });
}

groupsRouter.get('/api/v1/groups/:id', requireSession, async (req, res, next) => {
  try {
    const { id } = req.params;
    // Inlined rather than calling the shared `isMember` helper + a second
    // `group_members` lookup: one query gets both the membership gate and
    // the last_read_at/muted this handler also needs.
    const membership = await req.db
      .selectFrom('group_members')
      .select(['user_id', 'last_read_at', 'muted'])
      .where('group_id', '=', id)
      .where('user_id', '=', req.userId!)
      .executeTakeFirst();
    if (!membership) {
      res.status(403).json({ error: 'not a member' });
      return;
    }
    const row = await req.db
      .selectFrom('groups')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: 'group not found' });
      return;
    }
    const counterparts = await counterpartNames(req.db, req.userId!, [row]);
    res.json(
      toGroup(
        row,
        membership.last_read_at ?? null,
        Number(membership.muted ?? 0) === 1,
        counterparts.get(row.id),
      ),
    );
  } catch (err) {
    next(err);
  }
});

groupsRouter.patch('/api/v1/groups/:id', requireSession, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!(await isMember(req.db, id, req.userId!))) {
      res.status(403).json({ error: 'not a member' });
      return;
    }
    const parsed = UpdateGroupRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    const updates: { mirror_inbound?: number } = {};
    if (parsed.data.mirrorInbound !== undefined) {
      updates.mirror_inbound = parsed.data.mirrorInbound ? 1 : 0;
    }
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: 'no changes' });
      return;
    }
    const row = await req.db
      .updateTable('groups')
      .set(updates)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    res.json(toGroup(row));
  } catch (err) {
    next(err);
  }
});

groupsRouter.delete('/api/v1/groups/:id', requireSession, async (req, res, next) => {
  try {
    const { id } = req.params;
    const out = await deleteGroupAs(req.db, id, req.userId!);
    if (!out.ok) {
      const refused = {
        not_member: [403, 'not a member'],
        not_owner: [403, 'only the owner can delete this group'],
        not_found: [404, 'group not found'],
        personal: [400, 'cannot delete your personal chat'],
      } as const;
      const [status, error] = refused[out.reason];
      res.status(status).json({ error });
      return;
    }
    // Tell connected members their stream ended on purpose so clients drop the
    // group instead of trying to reconnect to a now-deleted channel.
    sseHub.closeChannel(id, 'group_deleted');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

groupsRouter.post('/api/v1/groups/:id/leave', requireSession, async (req, res, next) => {
  try {
    const { id } = req.params;
    const out = await leaveGroupAs(req.db, id, req.userId!);
    if (!out.ok) {
      const refused = {
        not_member: [403, 'not a member'],
        not_owner: [403, 'not a member'],
        not_found: [404, 'group not found'],
        personal: [400, 'cannot leave your personal chat'],
      } as const;
      const [status, error] = refused[out.reason];
      res.status(status).json({ error });
      return;
    }
    const { ok: _ok, ...result } = out;
    // Leaving as the sole member deletes the group; close any open streams.
    if (result.deleted) sseHub.closeChannel(id, 'group_deleted');
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

groupsRouter.post(
  '/api/v1/groups/:id/invite/regenerate',
  requireSession,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      // Independent lookups — run together rather than one after the other.
      const [role, group] = await Promise.all([
        getMemberRole(req.db, id, req.userId!),
        req.db.selectFrom('groups').select('kind').where('id', '=', id).executeTakeFirst(),
      ]);
      if (!role) {
        res.status(403).json({ error: 'not a member' });
        return;
      }
      if (role !== 'owner') {
        res.status(403).json({ error: 'only the owner can regenerate the invite code' });
        return;
      }
      if (!group) {
        res.status(404).json({ error: 'group not found' });
        return;
      }
      if (group.kind === 'personal') {
        res.status(400).json({ error: 'personal chats have no invite code' });
        return;
      }
      const inviteCode = await regenerateInviteCode(req.db, id);
      res.json({ inviteCode });
    } catch (err) {
      next(err);
    }
  },
);

groupsRouter.get('/api/v1/groups/:id/members', requireSession, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!(await isMember(req.db, id, req.userId!))) {
      res.status(403).json({ error: 'not a member' });
      return;
    }
    const members = await req.db
      .selectFrom('group_members')
      .innerJoin('users', 'users.id', 'group_members.user_id')
      .where('group_members.group_id', '=', id)
      .select([
        'users.id as userId',
        'users.username as username',
        'users.display_name as displayName',
        'users.shadow as shadow',
        'group_members.role as role',
        'group_members.tier as tier',
        'group_members.joined_at as joinedAt',
      ])
      .execute();
    res.json(
      members.map((m) => ({
        ...m,
        shadow: m.shadow === 1,
        groupId: id,
      })),
    );
  } catch (err) {
    next(err);
  }
});
