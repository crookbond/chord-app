/**
 * Bind/lookup external channels to Chord groups. Bindings are explicit —
 * inbound from an unbound channel is dropped silently (no auto-create).
 * v1 binds via the `connectors-bind` CLI script; an admin route lands
 * with the `client/` UI later.
 */
import type { Kysely } from 'kysely';

import type { DB } from '../../db/schema';
import type { ConnectorPlatform } from './types';

export interface ChannelBinding {
  platform: ConnectorPlatform;
  externalChannelId: string;
  groupId: string;
  configJson: string | null;
  alias: string;
  /** ADR 0025 — null = deploy-wide bot; non-null = BYO bot identity. */
  botUserId: string | null;
}

function rowToBinding(r: {
  platform: ConnectorPlatform;
  external_channel_id: string;
  group_id: string;
  config_json: string | null;
  alias: string;
  bot_user_id: string | null;
}): ChannelBinding {
  return {
    platform: r.platform,
    externalChannelId: r.external_channel_id,
    groupId: r.group_id,
    configJson: r.config_json,
    alias: r.alias,
    botUserId: r.bot_user_id,
  };
}

export async function lookupGroupForChannel(
  db: Kysely<DB>,
  platform: ConnectorPlatform,
  externalChannelId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('group_external_channels')
    .select('group_id')
    .where('platform', '=', platform)
    .where('external_channel_id', '=', externalChannelId)
    .executeTakeFirst();
  return row?.group_id ?? null;
}

export async function listBindingsForGroup(
  db: Kysely<DB>,
  groupId: string,
): Promise<ChannelBinding[]> {
  const rows = await db
    .selectFrom('group_external_channels')
    .selectAll()
    .where('group_id', '=', groupId)
    .execute();
  return rows.map(rowToBinding);
}

export async function bindChannel(
  db: Kysely<DB>,
  platform: ConnectorPlatform,
  externalChannelId: string,
  groupId: string,
  alias: string,
  configJson: string | null = null,
): Promise<void> {
  const group = await db
    .selectFrom('groups')
    .select('id')
    .where('id', '=', groupId)
    .executeTakeFirst();
  if (!group) throw new Error(`group ${groupId} not found`);

  const now = new Date().toISOString();
  await db
    .insertInto('group_external_channels')
    .values({
      platform,
      external_channel_id: externalChannelId,
      group_id: groupId,
      config_json: configJson,
      alias,
      created_at: now,
    })
    .onConflict((oc) =>
      oc.columns(['platform', 'external_channel_id']).doUpdateSet({
        group_id: groupId,
        config_json: configJson,
        alias,
      }),
    )
    .execute();
}

/**
 * Rename a binding's alias. Returns:
 *   - 'ok' if the rename succeeded.
 *   - 'not_found' if no binding matches.
 *   - 'conflict' if another binding in the same group already uses this alias.
 */
export async function renameBindingAlias(
  db: Kysely<DB>,
  groupId: string,
  platform: ConnectorPlatform,
  externalChannelId: string,
  alias: string,
): Promise<'ok' | 'not_found' | 'conflict'> {
  const row = await db
    .selectFrom('group_external_channels')
    .select('alias')
    .where('group_id', '=', groupId)
    .where('platform', '=', platform)
    .where('external_channel_id', '=', externalChannelId)
    .executeTakeFirst();
  if (!row) return 'not_found';
  if (row.alias === alias) return 'ok';

  const conflict = await db
    .selectFrom('group_external_channels')
    .select('external_channel_id')
    .where('group_id', '=', groupId)
    .where('alias', '=', alias)
    .executeTakeFirst();
  if (conflict) return 'conflict';

  await db
    .updateTable('group_external_channels')
    .set({ alias })
    .where('platform', '=', platform)
    .where('external_channel_id', '=', externalChannelId)
    .execute();
  return 'ok';
}

export async function unbindChannel(
  db: Kysely<DB>,
  platform: ConnectorPlatform,
  externalChannelId: string,
): Promise<boolean> {
  const result = await db
    .deleteFrom('group_external_channels')
    .where('platform', '=', platform)
    .where('external_channel_id', '=', externalChannelId)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0) > 0;
}
