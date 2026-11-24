/**
 * ADR 0351 — re-engage nudges. Someone who has not opened the app for
 * `REENGAGE_IDLE_DAYS` gets ONE push naming a feature they have not tried
 * ("Long email? Tap tldr"), at a daytime hour in their own zone.
 *
 * Rules, each for a reason:
 *  - Activity is the newest app session's `last_seen_at` (refreshed at most
 *    every 5 min by `loadSession`). A WhatsApp-only user has no session and is
 *    never nudged to open an app they do not use.
 *  - One nudge per absence: nothing is sent if a nudge already went out after
 *    the user was last seen. Someone gone a month gets one push, not ten.
 *  - Never two nudges closer than `REENGAGE_MIN_GAP_DAYS`, and never the same
 *    feature twice. When every feature is used or sent, nothing goes out.
 *  - Gone longer than `REENGAGE_MAX_IDLE_DAYS` = stop trying.
 *  - The push is a `bot`-category push, so the user's bot-notification switch
 *    and quiet hours apply (`eligibleTokens`), and `reengage_tips_off` turns
 *    just these off (`set_feature_tips`, which every tip tells the user to
 *    reply in chat).
 *  - Recorded BEFORE it is sent (ADR 0115's rule): a crash mid-send costs one
 *    missing tip, never two copies.
 */
import { z } from 'zod';
import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { isLeader } from '../cluster/leadership.js';
import { sendPush } from '../push/expo.service.js';
import { eligibleTokens } from '../push/push-publisher.js';
import { localMinuteOfDay } from '../push/quiet-hours.js';
import { defineUserDefault } from '../user-defaults.service.js';
import { REENGAGE_FEATURES, pickFeature, type ReengageFeature } from './features.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every tip says how to stop them; `set_feature_tips` handles the reply. */
export const STOP_LINE = 'Reply "stop sending me tips" in chat to stop.';

const sentLog = defineUserDefault(
  'reengage_sent',
  z.array(z.object({ feature: z.string(), at: z.string() })).max(100),
);
export const tipsOff = defineUserDefault('reengage_tips_off', z.boolean());

export interface ReengageCandidate {
  userId: string;
  lastTz: string | null;
  lastSeenAt: string;
}

/** Users idle for at least REENGAGE_IDLE_DAYS and at most REENGAGE_MAX_IDLE_DAYS. */
export async function idleCandidates(db: Kysely<DB>, now: Date): Promise<ReengageCandidate[]> {
  const idleBefore = new Date(now.getTime() - env.REENGAGE_IDLE_DAYS * DAY_MS).toISOString();
  const giveUpBefore = new Date(now.getTime() - env.REENGAGE_MAX_IDLE_DAYS * DAY_MS).toISOString();
  // sessions.last_seen_at is only ever written by toISOString() (UTC `Z`), so
  // comparing it as text is comparing instants.
  const rows = await db
    .selectFrom('users as u')
    .innerJoin('sessions as s', 's.user_id', 'u.id')
    .select(['u.id as userId', 'u.last_tz as lastTz'])
    .select((eb) => eb.fn.max('s.last_seen_at').as('lastSeenAt'))
    .where('u.shadow', '=', 0)
    .groupBy(['u.id', 'u.last_tz'])
    .having((eb) => eb.fn.max('s.last_seen_at'), '<', idleBefore)
    .having((eb) => eb.fn.max('s.last_seen_at'), '>', giveUpBefore)
    .orderBy('lastSeenAt', 'desc')
    .limit(env.REENGAGE_BATCH)
    .execute();
  return rows.map((r) => ({ userId: r.userId, lastTz: r.lastTz, lastSeenAt: String(r.lastSeenAt) }));
}

export function withinSendHours(now: Date, tz: string | null): boolean {
  const minute = localMinuteOfDay(now, tz || env.BRIEFING_DEFAULT_TZ);
  return minute >= env.REENGAGE_START_HOUR * 60 && minute < env.REENGAGE_END_HOUR * 60;
}

/** Was a nudge sent this absence, or too recently? Pure. */
export function nudgeBlockedBy(
  sent: { at: string }[],
  lastSeenAt: string,
  now: Date,
): 'this_absence' | 'too_soon' | null {
  const seen = Date.parse(lastSeenAt);
  let newest = -Infinity;
  for (const s of sent) newest = Math.max(newest, Date.parse(s.at));
  if (!Number.isFinite(newest)) return null;
  if (newest > seen) return 'this_absence';
  if (now.getTime() - newest < env.REENGAGE_MIN_GAP_DAYS * DAY_MS) return 'too_soon';
  return null;
}

async function personalGroupId(db: Kysely<DB>, userId: string): Promise<string | null> {
  const row = await db
    .selectFrom('groups')
    .select('id')
    .where('kind', '=', 'personal')
    .where('created_by', '=', userId)
    .orderBy('created_at', 'asc')
    .executeTakeFirst();
  return row?.id ?? null;
}

export type ReengageOutcome =
  | { sent: ReengageFeature['id'] }
  | { skipped: 'tips_off' | 'hours' | 'this_absence' | 'too_soon' | 'no_device' | 'nothing_left' };

/** Decide and (maybe) send one user's nudge. */
export async function reengageUser(
  db: Kysely<DB>,
  c: ReengageCandidate,
  now: Date = new Date(),
  features: ReengageFeature[] = REENGAGE_FEATURES,
): Promise<ReengageOutcome> {
  if (await tipsOff.get(db, c.userId)) return { skipped: 'tips_off' };
  if (!withinSendHours(now, c.lastTz)) return { skipped: 'hours' };
  const sent = (await sentLog.get(db, c.userId)) ?? [];
  const blocked = nudgeBlockedBy(sent, c.lastSeenAt, now);
  if (blocked) return { skipped: blocked };
  const tokens = await eligibleTokens(db, [c.userId], 'bot', now);
  // Not recorded: a user who turns pushes on later can still get this tip.
  if (tokens.length === 0) return { skipped: 'no_device' };

  const ctx = { db, userId: c.userId, personalGroupId: await personalGroupId(db, c.userId) };
  const used = new Set<string>();
  for (const f of features) if (await f.used(ctx)) used.add(f.id);
  const feature = pickFeature(features, used, new Set(sent.map((s) => s.feature)));
  if (!feature) return { skipped: 'nothing_left' };

  const claimed = await sentLog.update(db, c.userId, (current) => {
    const log = current ?? [];
    if (nudgeBlockedBy(log, c.lastSeenAt, now)) return { value: undefined, result: false };
    return { value: [...log, { feature: feature.id, at: now.toISOString() }].slice(-100), result: true };
  });
  if (!claimed) return { skipped: 'this_absence' };

  try {
    await sendPush(db, tokens, {
      title: feature.title,
      body: `${feature.body} ${STOP_LINE}`,
      data: { kind: 'reengage', feature: feature.id, url: feature.url(ctx) },
    });
  } catch (err) {
    logger.warn('reengage push failed', { userId: c.userId, feature: feature.id, err: (err as Error).message });
  }
  logger.info('reengage nudge sent', { userId: c.userId, feature: feature.id });
  return { sent: feature.id };
}

export async function sweepReengage(db: Kysely<DB>, now: Date = new Date()): Promise<number> {
  let n = 0;
  for (const c of await idleCandidates(db, now)) {
    try {
      const out = await reengageUser(db, c, now);
      if ('sent' in out) n++;
    } catch (err) {
      logger.warn('reengage user failed', { userId: c.userId, err: (err as Error).message });
    }
  }
  return n;
}

let lastRunAt: number | null = null;

/** At most every REENGAGE_SWEEP_MINUTES, from the proactive tick, leader only. */
export async function maybeSweepReengage(db: Kysely<DB>, now: Date = new Date()): Promise<number> {
  if (!env.REENGAGE_ENABLED || !env.PUSH_ENABLED) return 0;
  if (!isLeader('worker')) return 0;
  if (lastRunAt !== null && now.getTime() - lastRunAt < env.REENGAGE_SWEEP_MINUTES * 60 * 1000) return 0;
  lastRunAt = now.getTime();
  return sweepReengage(db, now);
}

export function __resetReengageForTests(): void {
  lastRunAt = null;
}

/** `set_feature_tips` — null reads. */
export async function setFeatureTips(db: Kysely<DB>, userId: string, enabled: boolean | null): Promise<boolean> {
  if (enabled !== null) await tipsOff.set(db, userId, enabled ? null : true);
  return !(await tipsOff.get(db, userId));
}
