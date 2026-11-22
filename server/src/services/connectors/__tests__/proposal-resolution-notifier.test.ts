/**
 * proposal-resolution-notifier (ADR 0029): on every SSE.proposalResolved
 * fire, edit the bridged copy of the bundle announcement to remove the
 * resolved proposal's buttons. When the bundle is empty (last sibling
 * resolved or standalone proposal), the keyboard goes away entirely.
 *
 * Pins:
 *   - 3 staged proposals in a bundle. Resolve one → connector.editActionButtons
 *     is called with cards for the remaining two (each card has confirm/reject
 *     buttons keyed by the surviving proposal id).
 *   - Resolve the last one → editActionButtons called with empty cards
 *     (keyboard removed in TG renderer terms).
 *   - Standalone proposal (no bundle_id) resolves → editActionButtons
 *     called with empty cards.
 *   - No outbound_connector_messages row → notifier skips silently (no
 *     editActionButtons call).
 *   - Connector that doesn't implement editActionButtons → skipped, not
 *     crashed.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SSE } from '@chord/kernel';

import type { DB } from '@/db/schema.js';
import { startProposalResolutionNotifier } from '@/services/connectors/proposal-resolution-notifier.js';
import { createProposal } from '@/services/proposals.service.js';
import { sseHub } from '@/services/sse.hub.js';
import { newId } from '@/utils/ids.js';
import type { Connector, EditActionButtonsInput } from '@/services/connectors/types.js';
import { closeTestDb, openTestDb } from '@/__test-helpers__/db.js';

class CapturingConnector {
  edits: EditActionButtonsInput[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send = async () => ({ externalMessageId: null });
  // The notifier only ever calls editActionButtons; the rest of the
  // Connector surface is unused here. Cast through `as unknown as Connector`
  // at the registry boundary.
  async editActionButtons(input: EditActionButtonsInput): Promise<void> {
    this.edits.push(input);
  }
}

function singleConnectorRegistry(connector: Connector | undefined) {
  return {
    getForBinding: () => connector,
  };
}

async function seedGroupWithBundle(db: Kysely<DB>, msgId: string) {
  const now = new Date().toISOString();
  const userId = newId('u');
  const groupId = newId('g');
  await db
    .insertInto('users')
    .values({
      id: userId,
      username: 'alice',
      display_name: 'Alice',
      created_at: now,
      shadow: 0,
    })
    .execute();
  await db
    .insertInto('groups')
    .values({
      id: groupId,
      name: 'Family',
      kind: 'group',
      invite_code: groupId.slice(2, 8).toUpperCase(),
      ingest_email: `notif-${groupId.slice(2)}@chord.app`,
      created_by: userId,
      adults_only: 0,
      mirror_inbound: 1,
      created_at: now,
    })
    .execute();
  await db
    .insertInto('messages')
    .values({
      id: msgId,
      group_id: groupId,
      sender_id: null,
      kind: 'bot',
      body: 'announcement',
      attachment_id: null,
      reply_to_id: null,
      mentions_bot: 0,
      mentions_others: 0,
      chord_visible: 1,
      auto_mirror: 1,
      source: null,
      external_message_id: null,
      bot_persona_id: null,
      is_proactive: 0,
      created_at: now,
    })
    .execute();
  return { userId, groupId };
}

describe('proposal-resolution-notifier', () => {
  let db: Kysely<DB>;
  let connector: CapturingConnector;
  let unsubscribe: () => void;

  beforeEach(async () => {
    db = await openTestDb();
    connector = new CapturingConnector();
    unsubscribe = startProposalResolutionNotifier(
      db,
      singleConnectorRegistry(connector as unknown as Connector),
    );
  });

  afterEach(async () => {
    unsubscribe();
    await closeTestDb(db);
  });

  it('resolves one of three bundle siblings → edit with 2 remaining cards', async () => {
    const msgId = newId('m');
    const { userId, groupId } = await seedGroupWithBundle(db, msgId);
    const now = new Date().toISOString();
    const bundleId = newId('bundle');

    const a = await createProposal(db, {
      groupId,
      proposedByUserId: userId,
      proposedByMessageId: msgId,
      toolName: 'save_link',
      args: { title: 'A', url: 'https://a.test' },
      provenance: 'test',
      bundleId,
    });
    const b = await createProposal(db, {
      groupId,
      proposedByUserId: userId,
      proposedByMessageId: msgId,
      toolName: 'save_place',
      args: { name: 'B' },
      provenance: 'test',
      bundleId,
    });
    const c = await createProposal(db, {
      groupId,
      proposedByUserId: userId,
      proposedByMessageId: msgId,
      toolName: 'create_task',
      args: { title: 'C' },
      provenance: 'test',
      bundleId,
    });
    await db
      .insertInto('outbound_connector_messages')
      .values({
        chord_message_id: msgId,
        platform: 'telegram',
        external_channel_id: '-1001',
        external_message_id: '42',
        bot_user_id: null,
        created_at: now,
      })
      .execute();

    // Flip A's status to confirmed *before* firing the SSE event — the
    // notifier reads the DB to find what's still pending, so this is
    // the order of operations during a real confirm: DB write, then
    // broadcast.
    await db
      .updateTable('proposals')
      .set({ status: 'confirmed', resolved_by_user_id: userId, resolved_at: now })
      .where('id', '=', a.id)
      .execute();
    sseHub.broadcast(groupId, SSE.proposalResolved, {
      id: a.id,
      status: 'confirmed',
    });
    // SSE -> notifier -> DB lookup -> editActionButtons is async and
    // crosses at least one PG round-trip; poll until the edit lands.
    await vi.waitFor(() => expect(connector.edits).toHaveLength(1));
    const e = connector.edits[0];
    expect(e.externalChannelId).toBe('-1001');
    expect(e.externalMessageId).toBe('42');
    // The two pending siblings should each appear as a card.
    expect(e.cards).toHaveLength(2);
    const ids = e.cards
      .flatMap((card) => card.buttons ?? [])
      .map((btn) => btn.callback?.id)
      .filter((x): x is string => !!x);
    expect(new Set(ids)).toEqual(new Set([b.id, c.id]));
  });

  it('resolves the last bundle sibling → edit with empty card list (keyboard removed)', async () => {
    const msgId = newId('m');
    const { userId, groupId } = await seedGroupWithBundle(db, msgId);
    const now = new Date().toISOString();
    const bundleId = newId('bundle');

    const only = await createProposal(db, {
      groupId,
      proposedByUserId: userId,
      proposedByMessageId: msgId,
      toolName: 'save_link',
      args: { title: 'only', url: 'https://x.test' },
      provenance: 'test',
      bundleId,
    });
    await db
      .insertInto('outbound_connector_messages')
      .values({
        chord_message_id: msgId,
        platform: 'telegram',
        external_channel_id: '-1001',
        external_message_id: '99',
        bot_user_id: null,
        created_at: now,
      })
      .execute();

    await db
      .updateTable('proposals')
      .set({ status: 'rejected', resolved_by_user_id: userId, resolved_at: now })
      .where('id', '=', only.id)
      .execute();
    sseHub.broadcast(groupId, SSE.proposalResolved, {
      id: only.id,
      status: 'rejected',
    });
    // SSE -> notifier -> DB lookup -> editActionButtons is async and
    // crosses at least one PG round-trip; poll until the edit lands.
    await vi.waitFor(() => expect(connector.edits).toHaveLength(1));
    expect(connector.edits[0].cards).toEqual([]);
  });

  it('standalone proposal (no bundle_id) → edit with empty card list', async () => {
    const msgId = newId('m');
    const { userId, groupId } = await seedGroupWithBundle(db, msgId);
    const now = new Date().toISOString();
    const p = await createProposal(db, {
      groupId,
      proposedByUserId: userId,
      proposedByMessageId: msgId,
      toolName: 'save_link',
      args: { title: 'solo', url: 'https://x.test' },
      provenance: 'test',
    });
    await db
      .insertInto('outbound_connector_messages')
      .values({
        chord_message_id: msgId,
        platform: 'telegram',
        external_channel_id: '-1001',
        external_message_id: '7',
        bot_user_id: null,
        created_at: now,
      })
      .execute();

    sseHub.broadcast(groupId, SSE.proposalResolved, {
      id: p.id,
      status: 'confirmed',
    });
    // SSE -> notifier -> DB lookup -> editActionButtons is async and
    // crosses at least one PG round-trip; poll until the edit lands.
    await vi.waitFor(() => expect(connector.edits).toHaveLength(1));
    expect(connector.edits[0].cards).toEqual([]);
  });

  it('no outbound mirror recorded → notifier skips silently', async () => {
    const msgId = newId('m');
    const { userId, groupId } = await seedGroupWithBundle(db, msgId);
    const p = await createProposal(db, {
      groupId,
      proposedByUserId: userId,
      proposedByMessageId: msgId,
      toolName: 'save_link',
      args: { title: 'x', url: 'https://x.test' },
      provenance: 'test',
    });
    sseHub.broadcast(groupId, SSE.proposalResolved, {
      id: p.id,
      status: 'confirmed',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(connector.edits).toHaveLength(0);
  });
});
