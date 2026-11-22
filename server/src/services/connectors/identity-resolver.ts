/**
 * Maps an external IM platform user (Slack U…, Discord snowflake, Telegram
 * numeric id) to a Chord users.id. First sighting creates a shadow user
 * (`users.shadow = 1`, `group_members.tier = 'guest'`) — same pattern as
 * the WhatsApp ingest pipeline (ADR 0008). Linking a shadow to a real
 * Chord account is a user-config concern handled elsewhere.
 */
import type { Kysely } from 'kysely';
import { nanoid } from 'nanoid';

import type { DB } from '../../db/schema';
import { newId } from '../../utils/ids';
import { ensurePersonalGroup } from '../groups.service';
import type { ConnectorPlatform } from './types';

/**
 * Read-only identity lookup. Returns the existing Chord user_id for the
 * given external identity, or null if none. Never creates a shadow row.
 *
 * Used by the DM-onboarding gate and the inbound auto-bind path, where
 * we want to know "is this TG user already paired?" without polluting
 * the DB with half-onboarded shadow accounts.
 */
export async function lookupIdentity(
  db: Kysely<DB>,
  platform: ConnectorPlatform,
  externalId: string,
): Promise<{ userId: string; shadow: boolean } | null> {
  const row = await db
    .selectFrom('external_identities')
    .innerJoin('users', 'users.id', 'external_identities.user_id')
    .select(['external_identities.user_id as user_id', 'users.shadow as shadow'])
    .where('external_identities.platform', '=', platform)
    .where('external_identities.external_id', '=', externalId)
    .executeTakeFirst();
  if (!row) return null;
  return { userId: row.user_id, shadow: row.shadow === 1 };
}

export interface ResolvedIdentity {
  userId: string;
  listeningMode: 'invocation' | 'passive' | 'active';
  lastTz: string | null;
}

/**
 * Like `resolveIdentity` but also returns the sender's per-user settings
 * the inbound pipeline needs (`listening_mode`, `last_tz`), read from the
 * same joined `users` row — saving the pipeline a second lookup per
 * inbound message.
 */
export async function resolveIdentityWithMeta(
  db: Kysely<DB>,
  platform: ConnectorPlatform,
  externalId: string,
  externalDisplay: string | null,
): Promise<ResolvedIdentity> {
  const existing = await db
    .selectFrom('external_identities')
    .innerJoin('users', 'users.id', 'external_identities.user_id')
    .select(['user_id', 'external_display'])
    .select([
      'users.shadow as shadow',
      'users.display_name as display_name',
      'users.listening_mode as listening_mode',
      'users.last_tz as last_tz',
    ])
    .where('platform', '=', platform)
    .where('external_id', '=', externalId)
    .executeTakeFirst();

  if (existing) {
    if (
      externalDisplay &&
      externalDisplay !== existing.external_display
    ) {
      await db
        .updateTable('external_identities')
        .set({ external_display: externalDisplay })
        .where('platform', '=', platform)
        .where('external_id', '=', externalId)
        .execute();
      if (
        existing.shadow === 1 &&
        externalDisplay !== existing.display_name
      ) {
        await db
          .updateTable('users')
          .set({ display_name: externalDisplay })
          .where('id', '=', existing.user_id)
          .execute();
      }
    }
    return {
      userId: existing.user_id,
      listeningMode: existing.listening_mode,
      lastTz: existing.last_tz ?? null,
    };
  }

  const userId = newId('u');
  const now = new Date().toISOString();
  const displayName =
    externalDisplay && externalDisplay.trim().length > 0
      ? externalDisplay.trim()
      : `${platform}:${externalId}`;
  const username = `${platform}_${externalId}`.toLowerCase().slice(0, 64);

  await db.transaction().execute(async (tx) => {
    await tx
      .insertInto('users')
      .values({
        id: userId,
        username,
        display_name: displayName,
        created_at: now,
        shadow: 1,
      })
      .execute();
    await tx
      .insertInto('external_identities')
      .values({
        platform,
        external_id: externalId,
        external_display: externalDisplay,
        user_id: userId,
        created_at: now,
      })
      .execute();
  });

  return { userId, listeningMode: 'invocation', lastTz: null };
}

export async function resolveIdentity(
  db: Kysely<DB>,
  platform: ConnectorPlatform,
  externalId: string,
  externalDisplay: string | null,
): Promise<string> {
  return (await resolveIdentityWithMeta(db, platform, externalId, externalDisplay))
    .userId;
}

/**
 * Demo-mode escape hatch: when AUTH_MODE=demo there's no Google OAuth
 * available, so an unpaired Telegram user can't sign up to pair from.
 * Instead, auto-provision a *real* (non-shadow) Chord user keyed off
 * their external identity and seed a personal group, so the connector
 * pipeline can treat them as already-paired.
 *
 * Caller is responsible for gating on `env.AUTH_MODE === 'demo'`. Never
 * call this under AUTH_MODE=google — it'd bypass the app-first identity
 * gate that policy depends on.
 */
export async function autoProvisionDemoUser(
  db: Kysely<DB>,
  platform: ConnectorPlatform,
  externalId: string,
  externalDisplay: string | null,
): Promise<string> {
  const existing = await lookupIdentity(db, platform, externalId);
  if (existing) return existing.userId;

  const userId = newId('u');
  const now = new Date().toISOString();
  const displayName =
    externalDisplay && externalDisplay.trim().length > 0
      ? externalDisplay.trim()
      : `${platform}:${externalId}`;
  const username =
    `${platform}_${externalId}_${nanoid(4)}`.toLowerCase().slice(0, 64);

  await db.transaction().execute(async (tx) => {
    await tx
      .insertInto('users')
      .values({
        id: userId,
        username,
        display_name: displayName,
        created_at: now,
        shadow: 0,
      })
      .execute();
    await tx
      .insertInto('external_identities')
      .values({
        platform,
        external_id: externalId,
        external_display: externalDisplay,
        user_id: userId,
        created_at: now,
      })
      .execute();
  });
  await ensurePersonalGroup(db, userId);
  return userId;
}
