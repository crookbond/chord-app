/**
 * ADR 0299 / 0300 - the checks a skill question can use to tell that its
 * answer is already on record, so it is never asked. Code skills call them
 * directly; a skill stored as a row names one (`KNOWN_CHECKS`), since a row
 * cannot carry code.
 */
import { sql } from 'kysely';

import { env } from '../../../config/env.js';
import type { ExpressionBuilder } from 'kysely';

import type { DB } from '../../../db/schema.js';
import { factVisibleTo } from '../../memory.service.js';
import { getOtpProvider } from '../../phone/otp.js';
import type { SkillContext } from './types.js';

/**
 * ADR 0333 — a fact ABOUT this user: its subject is them, or (an old row
 * with no subject) they own it. Owning a private fact about someone else
 * (their spouse's airport) does not count.
 */
function aboutUser(userId: string) {
  return (eb: ExpressionBuilder<DB, 'memories'>) =>
    eb.or([
      eb.and([eb('memories.subject_type', '=', 'user'), eb('memories.subject_id', '=', userId)]),
      eb.and([eb('memories.subject_type', 'is', null), eb('memories.persona_id', '=', userId)]),
    ]);
}
export async function hasPeople({ db, userId }: SkillContext): Promise<boolean> {
  const row = await db
    .selectFrom('people')
    .select('id')
    .where('owner_user_id', '=', userId)
    .executeTakeFirst();
  return !!row;
}

export async function hasBirthday({ db, userId }: SkillContext): Promise<boolean> {
  const row = await db
    .selectFrom('important_dates as d')
    .innerJoin('people as p', 'p.id', 'd.person_id')
    .select('d.id')
    .where('p.owner_user_id', '=', userId)
    .where('d.kind', '=', 'birthday')
    .executeTakeFirst();
  return !!row;
}

export async function knowsSchool({ db, userId }: SkillContext): Promise<boolean> {
  const person = await db
    .selectFrom('people')
    .select('id')
    .where('owner_user_id', '=', userId)
    .where(sql<boolean>`lower(coalesce(notes, '')) LIKE '%school%'`)
    .executeTakeFirst();
  if (person) return true;
  // ADR 0333 — a school this user can see: their own facts and their chats'
  // shared ones, never another member's private fact.
  const fact = await db
    .selectFrom('memories')
    .innerJoin('group_members as gm', 'gm.group_id', 'memories.group_id')
    .select('memories.id')
    .where('gm.user_id', '=', userId)
    .where('memories.status', '=', 'confirmed')
    .where('memories.superseded_by', 'is', null)
    .where(factVisibleTo(userId))
    .where((eb) =>
      eb.or([eb('memories.category', '=', 'school'), eb(sql<string>`lower(memories.key)`, 'like', '%school%')]),
    )
    .executeTakeFirst();
  return !!fact;
}

export async function knowsHome({ db, userId }: SkillContext): Promise<boolean> {
  const user = await db
    .selectFrom('users')
    .select('weather_place_source')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (user?.weather_place_source !== 'user') return false;
  const airport = await db
    .selectFrom('memories')
    .select('id')
    .where('key', '=', 'home_airport')
    .where('status', '=', 'confirmed')
    .where('superseded_by', 'is', null)
    .where(aboutUser(userId))
    .executeTakeFirst();
  return !!airport;
}

/** Already verified, or this deployment cannot send a code. */
export async function phoneDoneOrUnavailable({ db, userId }: SkillContext): Promise<boolean> {
  if (!getOtpProvider()) return true;
  const user = await db
    .selectFrom('users')
    .select('phone_verified')
    .where('id', '=', userId)
    .executeTakeFirst();
  return Number(user?.phone_verified ?? 0) === 1;
}

/** Changed from the 07:00 default, or turned off: the user already chose. */
export async function choseBriefingTime({ db, userId }: SkillContext): Promise<boolean> {
  const user = await db
    .selectFrom('users')
    .select(['nudge_hour', 'nudge_minute', 'nudge_enabled'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user) return false;
  return user.nudge_enabled === 0 || user.nudge_hour !== 7 || user.nudge_minute !== 0;
}

export async function hasConnectedAccount({ db, userId }: SkillContext): Promise<boolean> {
  const user = await db
    .selectFrom('users')
    .select('google_connected_at')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (user?.google_connected_at) return true;
  const account = await db
    .selectFrom('email_accounts')
    .select('id')
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return !!account;
}

/** Already on WhatsApp, or this deployment publishes no number to message. */
export async function whatsappDoneOrUnavailable({ db, userId }: SkillContext): Promise<boolean> {
  if (!env.WHATSAPP_PUBLIC_NUMBER) return true;
  const identity = await db
    .selectFrom('external_identities')
    .select('user_id')
    .where('user_id', '=', userId)
    .where('platform', '=', 'whatsapp')
    .executeTakeFirst();
  return !!identity;
}

/** A confirmed, current fact about the user with this key (`home_airport`). */
export async function hasFact({ db, userId }: SkillContext, key: string): Promise<boolean> {
  const row = await db
    .selectFrom('memories')
    .select('id')
    .where('key', '=', key)
    .where('status', '=', 'confirmed')
    .where('superseded_by', 'is', null)
    .where(aboutUser(userId))
    .executeTakeFirst();
  return !!row;
}

type Check = (ctx: SkillContext) => Promise<boolean>;

/** The checks a stored skill may name in `known`. */
export const KNOWN_CHECKS: Readonly<Record<string, Check>> = {
  has_people: hasPeople,
  has_birthday: hasBirthday,
  knows_school: knowsSchool,
  knows_home: knowsHome,
  phone_verified_or_unavailable: phoneDoneOrUnavailable,
  briefing_time_chosen: choseBriefingTime,
  has_connected_account: hasConnectedAccount,
  on_whatsapp_or_unavailable: whatsappDoneOrUnavailable,
};

const FACT_KEY = /^has_fact:([a-z][a-z0-9_]{0,59})$/;

/** The check a stored skill names, or undefined when there is no such check. */
export function knownCheck(name: string): Check | undefined {
  const fact = FACT_KEY.exec(name);
  if (fact) {
    const key = fact[1]!;
    return (ctx) => hasFact(ctx, key);
  }
  return Object.hasOwn(KNOWN_CHECKS, name) ? KNOWN_CHECKS[name] : undefined;
}
