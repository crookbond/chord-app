/**
 * Boot-time seed: pre-link Telegram identities to known emails so a dev's
 * Telegram account is already wired to a Chord user before they ever
 * sign in. On first Google login with the matching email, the auth
 * route claims the existing user record (sets google_sub) — the
 * external_identities row is already in place, so the dev skips the
 * pair-code dance.
 *
 * Source: `SEED_TG_EMAIL_PAIRS` env var (JSON array). Idempotent —
 * existing users are reused by email, existing identities are left
 * alone if already linked to a real user.
 */
import { nanoid } from 'nanoid';
import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import { logger } from '../../config/logging.js';
import type { DB } from '../../db/schema.js';
import { ensurePersonalGroup } from '../groups.service.js';

interface SeedPair {
  tg_id: string;
  email: string;
  display_name?: string;
  tg_display?: string;
}

function parsePairs(raw: string): SeedPair[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    logger.warn('SEED_TG_EMAIL_PAIRS: invalid JSON, skipping seed', {
      err: (err as Error).message,
    });
    return [];
  }
  if (!Array.isArray(parsed)) {
    logger.warn('SEED_TG_EMAIL_PAIRS: expected JSON array, skipping seed');
    return [];
  }
  const out: SeedPair[] = [];
  for (const entry of parsed) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as { tg_id?: unknown }).tg_id === 'string' &&
      typeof (entry as { email?: unknown }).email === 'string'
    ) {
      out.push(entry as SeedPair);
    } else {
      logger.warn('SEED_TG_EMAIL_PAIRS: dropping malformed entry', { entry });
    }
  }
  return out;
}

export async function seedTgEmailPairs(db: Kysely<DB>): Promise<void> {
  if (env.AUTH_MODE !== 'google') return;
  const pairs = parsePairs(env.SEED_TG_EMAIL_PAIRS);
  if (pairs.length === 0) return;

  for (const p of pairs) {
    const email = p.email.trim().toLowerCase();
    const tgId = p.tg_id.trim();
    if (!email || !tgId) continue;

    // 1. Find or create the user record (no google_sub yet — that
    //    lands on first Google login). Email is the join key.
    let userId: string | undefined;
    const existingByEmail = await db
      .selectFrom('users')
      .select(['id'])
      .where('email', '=', email)
      .executeTakeFirst();
    if (existingByEmail) {
      userId = existingByEmail.id;
    } else {
      const id = `u_${nanoid(12)}`;
      const now = new Date().toISOString();
      const displayName = p.display_name?.trim() || email.split('@')[0];
      const baseUsername = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_.-]+/g, '');
      let username = baseUsername || `user${nanoid(6)}`;
      const taken = await db
        .selectFrom('users')
        .select('id')
        .where('username', '=', username)
        .executeTakeFirst();
      if (taken) username = `${username}-${nanoid(4)}`;
      await db
        .insertInto('users')
        .values({
          id,
          username,
          display_name: displayName,
          created_at: now,
          shadow: 0,
          google_sub: null,
          email,
          email_verified: 0,
        })
        .execute();
      userId = id;
      await ensurePersonalGroup(db, id);
      logger.info('SEED_TG_EMAIL_PAIRS: created user', { id });
    }

    // 2. Find or create the telegram external_identities row.
    const existingIdent = await db
      .selectFrom('external_identities')
      .innerJoin('users', 'users.id', 'external_identities.user_id')
      .select([
        'external_identities.user_id as user_id',
        'users.shadow as shadow',
      ])
      .where('external_identities.platform', '=', 'telegram')
      .where('external_identities.external_id', '=', tgId)
      .executeTakeFirst();
    if (!existingIdent) {
      await db
        .insertInto('external_identities')
        .values({
          platform: 'telegram',
          external_id: tgId,
          external_display: p.tg_display ?? p.display_name ?? null,
          user_id: userId,
          created_at: new Date().toISOString(),
        })
        .execute();
      logger.info('SEED_TG_EMAIL_PAIRS: linked TG identity', {
        tgId,
        userId,
        email,
      });
    } else if (existingIdent.user_id !== userId) {
      // Already linked to a different Chord user. If that user is a
      // shadow, we can safely re-point. Otherwise log and leave it —
      // overwriting a real link would be data loss.
      if (existingIdent.shadow) {
        await db
          .updateTable('external_identities')
          .set({
            user_id: userId,
            external_display: p.tg_display ?? p.display_name ?? null,
          })
          .where('platform', '=', 'telegram')
          .where('external_id', '=', tgId)
          .execute();
        logger.info('SEED_TG_EMAIL_PAIRS: re-pointed TG identity from shadow', {
          tgId,
          userId,
          email,
        });
      } else {
        logger.warn(
          'SEED_TG_EMAIL_PAIRS: TG identity already linked to a different real user — leaving as-is',
          { tgId, existing: existingIdent.user_id, attempted: userId },
        );
      }
    }
  }
}
