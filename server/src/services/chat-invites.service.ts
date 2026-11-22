/**
 * ADR 0318 — inviting someone to a chat by their email address.
 *
 * Nobody types a code. The inviter gives an email (and optionally a first
 * message), and one of three things happens:
 *
 *   - the address belongs to someone already on Chord who has accepted an
 *     invite from (or sent one to) the inviter before: they are added now;
 *   - it belongs to someone on Chord with no such history: they get an invite
 *     to accept or decline, and nothing about them changes until they answer;
 *   - it belongs to nobody yet: an email goes from the inviter's own mailbox
 *     carrying the chat's join link (ADR 0047), so following it joins - the code
 *     is still how the join happens, it is just never typed.
 *
 * An account is matched only on proof it gave (sign-in email, a connected
 * mailbox), the ADR 0237 rule, never a name.
 */
import type { Kysely } from 'kysely';

import { fullName, SSE, type ChatInvite, type InviteByEmailResponse } from '@chord/kernel';

import { logger } from '../config/logging.js';
import type { DB } from '../db/schema.js';
import { newId } from '../utils/ids.js';
import { queueComposedEmail } from './bot/email-actions.js';
import { findAccountForContact, provenContactsOf } from './family-contact-match.js';
import { createGroup, ensurePairGroup, ensurePersonalGroup } from './groups.service.js';
import { postMessage } from './messages.service.js';
import { ensurePersonaForMember } from './personas.service.js';
import { sseHub } from './sse.hub.js';
import { webOrigin } from './stripe.service.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type InviteFailure = 'invalid_email' | 'self' | 'not_found' | 'personal' | 'not_member' | 'already_member';

export type InviteResult = ({ ok: true } & InviteByEmailResponse) | { ok: false; reason: InviteFailure };

export async function displayName(db: Kysely<DB>, userId: string): Promise<string> {
  const u = await db
    .selectFrom('users')
    .select(['username', 'display_name', 'first_name', 'last_name'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!u) return 'Someone';
  return fullName({
    username: u.username,
    displayName: u.display_name ?? undefined,
    firstName: u.first_name ?? undefined,
    lastName: u.last_name ?? undefined,
  });
}

export function joinLinkFor(code: string): string {
  return `${webOrigin()}/join/${code}`;
}

/** Two people are connected once either has accepted an invite from the other.
 *  After that an invite between them needs no answer. */
export async function areConnected(db: Kysely<DB>, a: string, b: string): Promise<boolean> {
  const row = await db
    .selectFrom('chat_invites')
    .select('id')
    .where('status', '=', 'accepted')
    .where((eb) =>
      eb.or([
        eb.and([eb('inviter_id', '=', a), eb('invitee_user_id', '=', b)]),
        eb.and([eb('inviter_id', '=', b), eb('invitee_user_id', '=', a)]),
      ]),
    )
    .executeTakeFirst();
  return !!row;
}

async function addMember(db: Kysely<DB>, groupId: string, userId: string): Promise<void> {
  await db
    .insertInto('group_members')
    .values({ group_id: groupId, user_id: userId, role: 'member', tier: 'trusted', joined_at: new Date().toISOString() })
    .onConflict((oc) => oc.columns(['group_id', 'user_id']).doNothing())
    .execute();
  await ensurePersonaForMember(db, groupId, userId);
}

async function post(db: Kysely<DB>, groupId: string, senderId: string | null, body: string): Promise<void> {
  const message = await postMessage(db, { groupId, senderId, body, mentionsBot: false });
  sseHub.broadcast(groupId, SSE.message, message);
}

async function tellInvitee(db: Kysely<DB>, userId: string, body: string): Promise<void> {
  try {
    const personal = await ensurePersonalGroup(db, userId);
    await post(db, personal.id, null, body);
  } catch (err) {
    logger.warn('chat invite notice failed', { userId, err: (err as Error).message });
  }
}

/** A two-person chat made for an invite becomes THE pair chat for the two of
 *  them, unless they already have one. */
async function claimPairKey(db: Kysely<DB>, groupId: string, a: string, b: string): Promise<void> {
  const [lo, hi] = [a, b].sort();
  const pairKey = `${lo}|${hi}`;
  const taken = await db.selectFrom('groups').select('id').where('pair_key', '=', pairKey).executeTakeFirst();
  if (taken) return;
  await db.updateTable('groups').set({ pair_key: pairKey }).where('id', '=', groupId).where('pair_key', 'is', null).execute();
}

export async function inviteByEmail(
  db: Kysely<DB>,
  inviterId: string,
  input: { email: string; groupId?: string; message?: string },
): Promise<InviteResult> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, reason: 'invalid_email' };
  const message = input.message?.trim() || null;

  const mine = await provenContactsOf(db, inviterId);
  if (mine.emails.includes(email)) return { ok: false, reason: 'self' };

  let group: { id: string; name: string; invite_code: string } | null = null;
  if (input.groupId) {
    const row = await db
      .selectFrom('groups')
      .select(['id', 'name', 'kind', 'invite_code'])
      .where('id', '=', input.groupId)
      .executeTakeFirst();
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.kind === 'personal') return { ok: false, reason: 'personal' };
    const member = await db
      .selectFrom('group_members')
      .select('user_id')
      .where('group_id', '=', row.id)
      .where('user_id', '=', inviterId)
      .executeTakeFirst();
    if (!member) return { ok: false, reason: 'not_member' };
    group = row;
  }

  const inviter = await displayName(db, inviterId);
  const accountId = await findAccountForContact(db, { email }, { excludeUserIds: [inviterId] });

  if (accountId) {
    const name = await displayName(db, accountId);
    // Someone who blocked the inviter (ADR 0298) hears nothing, and the
    // inviter is not told they were blocked: it reads as a sent invite.
    const blocked = await db
      .selectFrom('blocks')
      .select('blocker_user_id')
      .where('blocker_user_id', '=', accountId)
      .where('blocked_user_id', '=', inviterId)
      .executeTakeFirst();
    if (blocked) return { ok: true, status: 'asked', groupId: group?.id ?? null, name };
    if (group) {
      const already = await db
        .selectFrom('group_members')
        .select('user_id')
        .where('group_id', '=', group.id)
        .where('user_id', '=', accountId)
        .executeTakeFirst();
      if (already) return { ok: false, reason: 'already_member' };
    }

    if (await areConnected(db, inviterId, accountId)) {
      const target = group ? group.id : (await ensurePairGroup(db, inviterId, accountId)).id;
      if (group) {
        await addMember(db, group.id, accountId);
        await post(db, group.id, null, `${inviter} added ${name}.`);
        await tellInvitee(db, accountId, `${inviter} added you to ${group.name}.`);
      }
      if (message) await post(db, target, inviterId, message);
      return { ok: true, status: 'added', groupId: target, name };
    }

    // Someone on Chord who has not agreed to hear from the inviter yet: ask.
    // A repeat while one is pending refreshes its message rather than asking twice.
    const pending = await db
      .selectFrom('chat_invites')
      .select('id')
      .where('inviter_id', '=', inviterId)
      .where('invitee_user_id', '=', accountId)
      .where('status', '=', 'pending')
      .where((eb) => (group ? eb('group_id', '=', group.id) : eb('group_id', 'is', null)))
      .executeTakeFirst();
    if (pending) {
      if (message) await db.updateTable('chat_invites').set({ message }).where('id', '=', pending.id).execute();
    } else {
      await db
        .insertInto('chat_invites')
        .values({
          id: newId('ci'),
          inviter_id: inviterId,
          email,
          invitee_user_id: accountId,
          group_id: group?.id ?? null,
          direct: group ? 0 : 1,
          message,
          message_posted: 0,
          status: 'pending',
          created_at: new Date().toISOString(),
        })
        .execute();
      await tellInvitee(
        db,
        accountId,
        `${inviter} wants to ${group ? `add you to ${group.name}` : 'chat with you'}. Open Messages to accept or decline.`,
      );
    }
    return { ok: true, status: 'asked', groupId: group?.id ?? null, name };
  }

  // Not on Chord yet. A direct invite needs a chat now so it has a join link;
  // it is named for the address until the other person is in it (ADR 0101
  // then shows their name).
  let pending = await db
    .selectFrom('chat_invites')
    .select(['id', 'group_id'])
    .where('inviter_id', '=', inviterId)
    .where('email', '=', email)
    .where('invitee_user_id', 'is', null)
    .where('status', '=', 'pending')
    .where((eb) => (group ? eb('group_id', '=', group.id) : eb('direct', '=', 1)))
    .executeTakeFirst();
  if (!group && pending?.group_id) {
    group =
      (await db
        .selectFrom('groups')
        .select(['id', 'name', 'invite_code'])
        .where('id', '=', pending.group_id)
        .executeTakeFirst()) ?? null;
  }
  if (!group) {
    group = await createGroup(db, { name: `Chat with ${email}`, kind: 'group', createdBy: inviterId });
    pending = undefined;
  }
  if (!pending) {
    await db
      .insertInto('chat_invites')
      .values({
        id: newId('ci'),
        inviter_id: inviterId,
        email,
        invitee_user_id: null,
        group_id: group.id,
        direct: input.groupId ? 0 : 1,
        message,
        message_posted: message ? 1 : 0,
        status: 'pending',
        created_at: new Date().toISOString(),
      })
      .execute();
  } else if (message) {
    await db.updateTable('chat_invites').set({ message, message_posted: 1 }).where('id', '=', pending.id).execute();
  }
  // The message is in the chat already, so it is there when they arrive.
  if (message) await post(db, group.id, inviterId, message);

  const link = joinLinkFor(group.invite_code);
  const lead = input.groupId
    ? `${inviter} invited you to the "${group.name}" chat on Chord.`
    : `${inviter} wants to chat with you on Chord.`;
  const body = [message ? `${message}\n` : null, lead, `Open it here: ${link}`].filter(Boolean).join('\n');
  let sent: 'queued' | 'no_mailbox' | 'failed';
  try {
    const out = await queueComposedEmail(db, inviterId, {
      to: [email],
      subject: input.groupId ? `${inviter} invited you to ${group.name}` : `${inviter} sent you a message on Chord`,
      body,
    });
    sent = out.ok ? 'queued' : 'no_mailbox';
  } catch (err) {
    logger.warn('chat invite email failed', { inviterId, err: (err as Error).message });
    sent = 'failed';
  }
  return { ok: true, status: 'emailed', groupId: group.id, email: sent, link };
}

/** Invites waiting for this user, newest first. */
export async function listPendingInvites(db: Kysely<DB>, userId: string): Promise<ChatInvite[]> {
  const rows = await db
    .selectFrom('chat_invites')
    .leftJoin('groups', 'groups.id', 'chat_invites.group_id')
    .select([
      'chat_invites.id as id',
      'chat_invites.inviter_id as inviter_id',
      'chat_invites.direct as direct',
      'chat_invites.message as message',
      'chat_invites.created_at as created_at',
      'groups.name as group_name',
    ])
    .where('chat_invites.invitee_user_id', '=', userId)
    .where('chat_invites.status', '=', 'pending')
    .orderBy('chat_invites.created_at', 'desc')
    .execute();
  const out: ChatInvite[] = [];
  for (const r of rows) {
    out.push({
      id: r.id,
      fromName: await displayName(db, r.inviter_id),
      groupName: r.direct === 1 ? null : (r.group_name ?? null),
      message: r.message,
      createdAt: r.created_at,
    });
  }
  return out;
}

export type RespondResult = { ok: true; groupId: string | null } | { ok: false; reason: 'not_found' | 'gone' };

export async function respondToInvite(
  db: Kysely<DB>,
  userId: string,
  inviteId: string,
  accept: boolean,
): Promise<RespondResult> {
  const row = await db
    .selectFrom('chat_invites')
    .selectAll()
    .where('id', '=', inviteId)
    .where('invitee_user_id', '=', userId)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  if (!row) return { ok: false, reason: 'not_found' };
  const now = new Date().toISOString();
  if (!accept) {
    await db.updateTable('chat_invites').set({ status: 'declined', responded_at: now }).where('id', '=', row.id).execute();
    return { ok: true, groupId: null };
  }

  let groupId: string;
  if (row.group_id) {
    const g = await db.selectFrom('groups').select(['id']).where('id', '=', row.group_id).executeTakeFirst();
    if (!g) return { ok: false, reason: 'gone' };
    groupId = g.id;
    await addMember(db, groupId, userId);
    if (row.direct === 1) await claimPairKey(db, groupId, row.inviter_id, userId);
  } else {
    groupId = (await ensurePairGroup(db, row.inviter_id, userId)).id;
  }
  await db.updateTable('chat_invites').set({ status: 'accepted', responded_at: now }).where('id', '=', row.id).execute();

  const name = await displayName(db, userId);
  if (row.message && row.message_posted !== 1) await post(db, groupId, row.inviter_id, row.message);
  if (row.direct !== 1) await post(db, groupId, null, `${name} joined.`);
  return { ok: true, groupId };
}

/**
 * Someone joined a chat through its link (ADR 0047). Any invite emailed for
 * that chat is now answered - they followed it - so the inviter and they are
 * connected; a chat made for a direct invite becomes their pair chat.
 */
export async function noteJoinedViaLink(db: Kysely<DB>, userId: string, groupId: string): Promise<void> {
  const rows = await db
    .selectFrom('chat_invites')
    .selectAll()
    .where('group_id', '=', groupId)
    .where('status', '=', 'pending')
    .where('inviter_id', '!=', userId)
    .execute();
  if (rows.length === 0) return;
  const proven = await provenContactsOf(db, userId);
  const now = new Date().toISOString();
  for (const r of rows) {
    // A direct chat's link went to one person, so whoever follows it is them
    // (they may sign in with another address); a group's link names the address.
    if (r.direct !== 1 && !proven.emails.includes(r.email.toLowerCase())) continue;
    await db
      .updateTable('chat_invites')
      .set({ status: 'accepted', invitee_user_id: userId, responded_at: now })
      .where('id', '=', r.id)
      .execute();
    if (r.direct === 1) await claimPairKey(db, groupId, r.inviter_id, userId);
  }
}

/**
 * At sign-in: invites emailed before this person had an account become invites
 * waiting for them in the app (they still choose; signing up is not accepting).
 */
export async function claimChatInvitesFor(db: Kysely<DB>, userId: string): Promise<number> {
  const proven = await provenContactsOf(db, userId);
  if (proven.emails.length === 0) return 0;
  const rows = await db
    .selectFrom('chat_invites')
    .select(['id', 'inviter_id'])
    .where('status', '=', 'pending')
    .where('invitee_user_id', 'is', null)
    .where('email', 'in', proven.emails)
    .where('inviter_id', '!=', userId)
    .execute();
  for (const r of rows) {
    await db.updateTable('chat_invites').set({ invitee_user_id: userId }).where('id', '=', r.id).execute();
  }
  if (rows.length > 0) {
    const who = await displayName(db, rows[0]!.inviter_id);
    const more = rows.length > 1 ? ` and ${rows.length - 1} more` : '';
    await tellInvitee(db, userId, `${who}${more} invited you to chat. Open Messages to accept or decline.`);
  }
  return rows.length;
}
