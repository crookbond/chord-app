/**
 * ADR 0231 — the family plan's roster: who the owner has added, who has been
 * invited, who is seated. Billing coverage itself is NOT decided here — it is
 * read from the owner's subscription by `getFamilyCoverage` every time, so a
 * lapsed owner stops covering the family without anything on this table
 * changing.
 *
 * Every function returns a result union rather than throwing, because the
 * callers are a REST route and a bot tool that both need to say WHY in words
 * (the ADR 0094/0102 posture: a refusal the model can relay, never an error
 * it will paraphrase into a claim about the user's data).
 */
import type { Kysely, Selectable } from 'kysely';

import {
  FAMILY_INVITE_PREFIX,
  FAMILY_SEATS,
  fullName,
  isFamilyInviteCode,
  type FamilyInviteResult,
  type FamilyMember,
  type FamilyOverview,
} from '@chord/kernel';

import type { DB, FamilyMembersTable } from '../db/schema.js';
import { newId, newInviteCode } from '../utils/ids.js';
import { emailFamilyInvite, tellMemberTheyAreCovered, type InviteEmailOutcome } from './family-invite-delivery.js';
import { findAccountForContact, phoneCandidates, provenContactsOf } from './family-contact-match.js';
import {
  familyGroupIdFor,
  placeRosterProfilesInFamilyGroup,
  removeRosterProfileFromFamilyGroup,
  seatInFamilyGroup,
  unseatFromFamilyGroup,
} from './family-group.service.js';
import { createPerson, findPersonByName, updatePerson } from './people.service.js';
import { setGrant } from './trust.service.js';
import { webOrigin } from './stripe.service.js';

type Row = Selectable<FamilyMembersTable>;

export type FamilyFailure =
  | 'not_found'
  | 'invalid_email'
  | 'need_contact'
  | 'no_seats'
  | 'already_active'
  | 'own_invite'
  | 'already_in_family'
  | 'owns_family'
  | 'invalid_code';

export type FamilyResult<T> = ({ ok: true } & T) | { ok: false; reason: FamilyFailure };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function inviteLinkFor(code: string): string {
  return `${webOrigin()}/join/${code}`;
}

function toMember(r: Row): FamilyMember {
  return {
    id: r.id,
    name: r.name,
    email: r.email ?? null,
    phone: r.phone ?? null,
    relationship: r.relationship ?? null,
    status: r.status,
    chordinator: r.chordinator === 1,
    inviteLink: r.status === 'invited' && r.invite_code ? inviteLinkFor(r.invite_code) : null,
    joinedAt: r.joined_at ?? null,
  };
}

function newFamilyCode(): string {
  return `${FAMILY_INVITE_PREFIX}${newInviteCode()}${newInviteCode()}`;
}

async function seatsHeld(db: Kysely<DB>, ownerId: string, exceptMemberId?: string): Promise<number> {
  let q = db
    .selectFrom('family_members')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('owner_user_id', '=', ownerId)
    .where('status', 'in', ['invited', 'active']);
  if (exceptMemberId) q = q.where('id', '!=', exceptMemberId);
  const row = await q.executeTakeFirst();
  // The owner holds the first seat.
  return 1 + Number(row?.n ?? 0);
}

async function ownerDisplayName(db: Kysely<DB>, userId: string): Promise<string> {
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

/**
 * Why this account cannot take a seat on `ownerId`'s plan, or null when it can.
 * One person sits on one family plan, and someone who PAYS for a family plan
 * can't also sit on another's (their own would cover nobody in the pool they
 * think it does). Shared by accepting a link and by being matched without one.
 */
async function seatBlocker(
  db: Kysely<DB>,
  ownerId: string,
  userId: string,
): Promise<'own_invite' | 'already_in_family' | 'owns_family' | null> {
  if (ownerId === userId) return 'own_invite';
  const already = await db
    .selectFrom('family_members')
    .select('id')
    .where('user_id', '=', userId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (already) return 'already_in_family';
  const me = await db
    .selectFrom('users')
    .select(['subscription_plan', 'subscription_current_period_end'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (
    me?.subscription_plan === 'family' &&
    me.subscription_current_period_end &&
    Date.now() < Date.parse(me.subscription_current_period_end)
  ) {
    return 'owns_family';
  }
  return null;
}

/** Turn an invited row into a seat for `userId`: the roster row, the grant the
 *  owner chose, and the family chat (ADR 0234). Returns the chat's id. */
async function seatInvitee(db: Kysely<DB>, row: Row, userId: string): Promise<string> {
  await db
    .updateTable('family_members')
    .set({ user_id: userId, status: 'active', invite_code: null, joined_at: new Date().toISOString() })
    .where('id', '=', row.id)
    .execute();
  if (row.chordinator === 1) await setGrant(db, row.owner_user_id, userId, ['task', 'event']);
  // ADR 0234 — a seat comes with a chat: they land in the family's group at once.
  return seatInFamilyGroup(db, row.owner_user_id, userId, row.person_id);
}

export async function getFamilyOverview(db: Kysely<DB>, userId: string): Promise<FamilyOverview> {
  const own = await db
    .selectFrom('family_members')
    .selectAll()
    .where('owner_user_id', '=', userId)
    .orderBy('created_at', 'asc')
    .execute();
  const me = await db
    .selectFrom('users')
    .select(['subscription_plan', 'subscription_current_period_end'])
    .where('id', '=', userId)
    .executeTakeFirst();
  const ownsPlan =
    me?.subscription_plan === 'family' &&
    !!me.subscription_current_period_end &&
    Date.now() < Date.parse(me.subscription_current_period_end);
  if (own.length > 0 || ownsPlan) {
    return {
      role: 'owner',
      seats: FAMILY_SEATS,
      seatsUsed: await seatsHeld(db, userId),
      members: own.map(toMember),
      planActive: ownsPlan,
      groupId: await familyGroupIdFor(db, userId),
    };
  }
  const seat = await db
    .selectFrom('family_members')
    .select('owner_user_id')
    .where('user_id', '=', userId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (seat) {
    const owner = await db
      .selectFrom('users')
      .select(['subscription_plan', 'subscription_current_period_end'])
      .where('id', '=', seat.owner_user_id)
      .executeTakeFirst();
    return {
      role: 'member',
      seats: FAMILY_SEATS,
      seatsUsed: await seatsHeld(db, seat.owner_user_id),
      members: [],
      ownerName: await ownerDisplayName(db, seat.owner_user_id),
      planActive:
        owner?.subscription_plan === 'family' &&
        !!owner.subscription_current_period_end &&
        Date.now() < Date.parse(owner.subscription_current_period_end),
      groupId: await familyGroupIdFor(db, userId),
    };
  }
  return { role: 'none', seats: FAMILY_SEATS, seatsUsed: 1, members: [], planActive: false, groupId: null };
}

export async function findFamilyMemberByName(
  db: Kysely<DB>,
  ownerId: string,
  name: string,
): Promise<FamilyMember[]> {
  const wanted = name.trim().toLowerCase();
  const rows = await db.selectFrom('family_members').selectAll().where('owner_user_id', '=', ownerId).execute();
  const exact = rows.filter((r) => r.name.trim().toLowerCase() === wanted);
  if (exact.length > 0) return exact.map(toMember);
  // No exact hit: a unique first-name match is still unambiguous ("Priya"
  // for "Priya Doe"); more than one is the caller's cue to ask.
  const first = rows.filter((r) => r.name.trim().toLowerCase().split(/\s+/)[0] === wanted);
  return first.map(toMember);
}

export interface AddFamilyMemberArgs {
  name: string;
  email?: string | null;
  phone?: string | null;
  relationship?: string | null;
  chordinator?: boolean;
  invite?: boolean;
}

/**
 * Add a person to the roster — or fill in an existing entry of the same name,
 * so "add Priya's email" after "add my wife Priya" updates her rather than
 * minting a second Priya. Mirrors the person into the owner's private People
 * list (ADR 0078): the roster is a billing fact, People is where the product
 * remembers who someone is, and the owner just told us about this person.
 */
export async function addFamilyMember(
  db: Kysely<DB>,
  ownerId: string,
  args: AddFamilyMemberArgs,
): Promise<FamilyResult<{ member: FamilyMember; invite?: FamilyInviteResult }>> {
  const email = args.email?.trim().toLowerCase() || null;
  if (email && !EMAIL_RE.test(email)) return { ok: false, reason: 'invalid_email' };
  const phone = args.phone?.trim() || null;
  const name = args.name.trim();

  const existing = (await findFamilyMemberByName(db, ownerId, name)).find(
    (m) => m.name.trim().toLowerCase() === name.toLowerCase(),
  );
  const now = new Date().toISOString();
  let memberId: string;
  if (existing) {
    memberId = existing.id;
    await db
      .updateTable('family_members')
      .set({
        ...(email ? { email } : {}),
        ...(phone ? { phone } : {}),
        ...(args.relationship?.trim() ? { relationship: args.relationship.trim() } : {}),
        ...(args.chordinator !== undefined ? { chordinator: args.chordinator ? 1 : 0 } : {}),
      })
      .where('id', '=', memberId)
      .execute();
  } else {
    let person = await findPersonByName(db, ownerId, name);
    if (!person) person = await createPerson(db, { ownerUserId: ownerId, displayName: name, email });
    const patch: { email?: string; phone?: string } = {};
    if (email && !person.email) patch.email = email;
    if (phone && !person.phone) patch.phone = phone;
    if (Object.keys(patch).length > 0) await updatePerson(db, ownerId, person.id, patch);
    memberId = newId('fam');
    await db
      .insertInto('family_members')
      .values({
        id: memberId,
        owner_user_id: ownerId,
        user_id: null,
        name,
        email,
        phone,
        relationship: args.relationship?.trim() || null,
        status: 'profile',
        chordinator: args.chordinator ? 1 : 0,
        invite_code: null,
        person_id: person.id,
        created_at: now,
      })
      .execute();
  }
  // ADR 0299 addendum — no account yet: in the family chat as a managed persona.
  await placeRosterProfilesInFamilyGroup(db, ownerId);
  if (args.invite) {
    const invited = await inviteFamilyMember(db, ownerId, memberId);
    if (!invited.ok) return invited;
    return { ok: true, member: invited.member, invite: invited };
  }
  const row = await db.selectFrom('family_members').selectAll().where('id', '=', memberId).executeTakeFirstOrThrow();
  return { ok: true, member: toMember(row) };
}

/**
 * Reserve a seat and mint the link. Re-inviting an already-invited member
 * returns the SAME link (a lost message is resent, not replaced); an active
 * member has nothing to invite.
 */
export async function inviteFamilyMember(
  db: Kysely<DB>,
  ownerId: string,
  memberId: string,
): Promise<FamilyResult<FamilyInviteResult>> {
  const row = await db
    .selectFrom('family_members')
    .selectAll()
    .where('id', '=', memberId)
    .where('owner_user_id', '=', ownerId)
    .executeTakeFirst();
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status === 'active') return { ok: false, reason: 'already_active' };
  if (!row.email && !row.phone) return { ok: false, reason: 'need_contact' };
  let code = row.invite_code;
  if (row.status !== 'invited') {
    if ((await seatsHeld(db, ownerId, memberId)) >= FAMILY_SEATS) return { ok: false, reason: 'no_seats' };
    code = newFamilyCode();
    await db
      .updateTable('family_members')
      .set({ status: 'invited', invite_code: code, invited_at: new Date().toISOString() })
      .where('id', '=', memberId)
      .execute();
  }
  let fresh = await db.selectFrom('family_members').selectAll().where('id', '=', memberId).executeTakeFirstOrThrow();
  const link = inviteLinkFor(code as string);
  const owner = await ownerDisplayName(db, ownerId);

  // ADR 0237 — already on Chord? Then there is nothing to accept: the plan
  // covers them now, and the invite below only tells them so. Matched on proof
  // the account gave us (sign-in email, a connected mailbox, a verified phone),
  // never on a name; two different accounts for one person means no match.
  let joined = false;
  const accountId = await findAccountForContact(
    db,
    { email: fresh.email, phone: fresh.phone },
    { excludeUserIds: [ownerId] },
  );
  if (accountId && !(await seatBlocker(db, ownerId, accountId))) {
    await seatInvitee(db, fresh, accountId);
    fresh = await db.selectFrom('family_members').selectAll().where('id', '=', memberId).executeTakeFirstOrThrow();
    joined = true;
    await tellMemberTheyAreCovered(db, accountId, owner);
  }

  const firstName = fresh.name.trim().split(/\s+/)[0] ?? fresh.name;
  const appUrl = webOrigin();
  const message = joined
    ? `Hi ${firstName} - I added you to my family plan on Chord, so you're covered and in our family chat. Open Chord: ${appUrl}`
    : `${owner} invited you to Chord, the family assistant, and is sharing their family plan with you. Join here: ${link}`;

  // Email goes from the owner's own mailbox. A text is the owner's to send from
  // their phone (the share sheet / sms: card) - Chord has no SMS sender.
  let email: InviteEmailOutcome | 'no_email' = 'no_email';
  if (fresh.email) {
    email = await emailFamilyInvite(db, ownerId, fresh.email, {
      subject: joined ? `${owner} added you to their Chord family plan` : `${owner} invited you to Chord`,
      body: `${message}\n\n(Sent from Chord on ${owner}'s behalf.)`,
    });
  }
  return {
    ok: true,
    member: toMember(fresh),
    inviteLink: joined ? appUrl : link,
    message,
    joined,
    delivery: { email },
  };
}

/**
 * ADR 0237 — someone invited BEFORE they had an account (or before they had
 * proved the address/number the invite used) becomes covered the moment they
 * prove it: at sign-in, and when they verify a phone. Called best-effort from
 * those two places; returns how many invites were seated (at most one family).
 */
export async function claimFamilyInvitesFor(db: Kysely<DB>, userId: string): Promise<number> {
  const proven = await provenContactsOf(db, userId);
  if (proven.emails.length === 0 && !proven.phone) return 0;
  const pending = await db
    .selectFrom('family_members')
    .selectAll()
    .where('status', '=', 'invited')
    .where('user_id', 'is', null)
    .execute();
  const mine = pending.filter(
    (r) =>
      (r.email && proven.emails.includes(r.email.trim().toLowerCase())) ||
      (proven.phone && phoneCandidates(r.phone).includes(proven.phone)),
  );
  for (const row of mine) {
    if (await seatBlocker(db, row.owner_user_id, userId)) continue;
    await seatInvitee(db, row, userId);
    await tellMemberTheyAreCovered(db, userId, await ownerDisplayName(db, row.owner_user_id));
    return 1;
  }
  return 0;
}

export async function updateFamilyMember(
  db: Kysely<DB>,
  ownerId: string,
  memberId: string,
  patch: {
    name?: string;
    email?: string | null;
    phone?: string | null;
    relationship?: string | null;
    chordinator?: boolean;
  },
): Promise<FamilyResult<{ member: FamilyMember }>> {
  const row = await db
    .selectFrom('family_members')
    .selectAll()
    .where('id', '=', memberId)
    .where('owner_user_id', '=', ownerId)
    .executeTakeFirst();
  if (!row) return { ok: false, reason: 'not_found' };
  const set: Partial<Selectable<FamilyMembersTable>> = {};
  if (patch.name !== undefined && patch.name.trim()) set.name = patch.name.trim();
  if (patch.email !== undefined) {
    const e = patch.email?.trim().toLowerCase() || null;
    if (e && !EMAIL_RE.test(e)) return { ok: false, reason: 'invalid_email' };
    set.email = e;
  }
  if (patch.phone !== undefined) set.phone = patch.phone?.trim() || null;
  if (patch.relationship !== undefined) set.relationship = patch.relationship?.trim() || null;
  if (patch.chordinator !== undefined) set.chordinator = patch.chordinator ? 1 : 0;
  if (Object.keys(set).length > 0) {
    await db.updateTable('family_members').set(set).where('id', '=', memberId).execute();
  }
  // Changing the flag on someone already seated takes effect now, not at the
  // next sign-in: it is a grant the owner can give or take back.
  if (patch.chordinator !== undefined && row.status === 'active' && row.user_id) {
    await setGrant(db, ownerId, row.user_id, patch.chordinator ? ['task', 'event'] : []);
  }
  const fresh = await db.selectFrom('family_members').selectAll().where('id', '=', memberId).executeTakeFirstOrThrow();
  return { ok: true, member: toMember(fresh) };
}

/** Take someone off the roster. A seated member stops being covered at once;
 *  the Chordinator grant the owner gave them goes with them. Their private
 *  People entry stays — removing a seat doesn't forget a relative. */
export async function removeFamilyMember(
  db: Kysely<DB>,
  ownerId: string,
  memberId: string,
): Promise<FamilyResult<{ removed: FamilyMember }>> {
  const row = await db
    .selectFrom('family_members')
    .selectAll()
    .where('id', '=', memberId)
    .where('owner_user_id', '=', ownerId)
    .executeTakeFirst();
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status === 'active' && row.user_id) {
    if (row.chordinator === 1) await setGrant(db, ownerId, row.user_id, []);
    await unseatFromFamilyGroup(db, ownerId, row.user_id);
  } else {
    await removeRosterProfileFromFamilyGroup(db, ownerId, row.person_id);
  }
  await db.deleteFrom('family_members').where('id', '=', memberId).execute();
  return { ok: true, removed: toMember(row) };
}

/**
 * The invitee taps the link, signs in, and lands here. Seats were reserved at
 * invite time so there is no capacity check — the code IS the seat. A person
 * can be seated on one family plan only, and one who PAYS for a family plan
 * can't also sit on another's (their own would cover nobody in the pool they
 * think it does).
 */
export async function acceptFamilyInvite(
  db: Kysely<DB>,
  userId: string,
  rawCode: string,
): Promise<FamilyResult<{ ownerName: string; member: FamilyMember; groupId: string }>> {
  const code = rawCode.trim().toUpperCase();
  if (!isFamilyInviteCode(code)) return { ok: false, reason: 'invalid_code' };
  const row = await db
    .selectFrom('family_members')
    .selectAll()
    .where('invite_code', '=', code)
    .where('status', '=', 'invited')
    .executeTakeFirst();
  if (!row) return { ok: false, reason: 'not_found' };
  const blocked = await seatBlocker(db, row.owner_user_id, userId);
  if (blocked) return { ok: false, reason: blocked };
  const groupId = await seatInvitee(db, row, userId);
  const fresh = await db.selectFrom('family_members').selectAll().where('id', '=', row.id).executeTakeFirstOrThrow();
  return {
    ok: true,
    ownerName: await ownerDisplayName(db, row.owner_user_id),
    member: toMember(fresh),
    groupId,
  };
}

/** A seated member leaves the plan. Their seat is freed (the row goes) and the
 *  grant the owner gave them is revoked with it. */
export async function leaveFamily(db: Kysely<DB>, userId: string): Promise<FamilyResult<Record<never, never>>> {
  const row = await db
    .selectFrom('family_members')
    .selectAll()
    .where('user_id', '=', userId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.chordinator === 1) await setGrant(db, row.owner_user_id, userId, []);
  await unseatFromFamilyGroup(db, row.owner_user_id, userId);
  await db.deleteFrom('family_members').where('id', '=', row.id).execute();
  return { ok: true };
}
