/**
 * ADR 0091 — the whole out-of-window path, end to end.
 *
 * The unit tests cover the pieces (facts are single-line, the connector puts
 * five params on the wire). This one covers the wiring between them, which is
 * where the real risk lives: a proactive briefing broadcast into a group whose
 * WhatsApp window has closed must come out the other side as a TEMPLATE send
 * carrying that user's actual facts — not as text, and not as the old generic
 * "want your briefing?" prompt.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SSE } from '@chord/kernel';

import { logger } from '@/config/logging.js';
import type { DB, ProactiveMessageKind } from '@/db/schema.js';
import type { Connector, OutboundMessage } from '@/services/connectors/types.js';
import { bindChannel } from '@/services/connectors/channel-resolver.js';
import { startOutboundPublisher } from '@/services/connectors/outbound-publisher.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { sseHub } from '@/services/sse.hub.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

vi.mock('@/config/env.js', async (orig) => {
  const mod = (await orig()) as { env: Record<string, unknown> };
  return {
    env: {
      ...mod.env,
      WHATSAPP_PROVIDER: 'cloud',
      META_NUDGE_TEMPLATE_NAME: 'daily_briefing',
      WEATHER_PROVIDER: '',
      GEOIP_DB_PATH: '',
    },
  };
});

const CHANNEL = 'whatsapp:+13475550199';

class CapturingConnector {
  sent: OutboundMessage[] = [];
  send = async (msg: OutboundMessage) => {
    this.sent.push(msg);
    return { externalMessageId: 'wamid.test' };
  };
}

let db: Kysely<DB>;
let userId: string;
let groupId: string;
let conn: CapturingConnector;
let stop: () => void;

/**
 * A proactive message, exactly as `fireOne` writes it — including the kind
 * (ADR 0137), which is what decides whether it may spend the template ask.
 * Defaults to the briefing, since that is what most of this file is about.
 */
async function broadcastBriefing(
  body: string,
  proactiveKind: ProactiveMessageKind = 'daily_morning_scan',
): Promise<string> {
  const id = newId('m');
  const now = new Date().toISOString();
  await db
    .insertInto('messages')
    .values({
      id,
      group_id: groupId,
      sender_id: null,
      kind: 'bot',
      body,
      attachment_id: null,
      reply_to_id: null,
      mentions_bot: 0,
      created_at: now,
      source: null,
      external_message_id: null,
      chord_visible: 1,
      mentions_others: 0,
      auto_mirror: 1,
      bot_persona_id: null,
      is_proactive: 1,
      proactive_kind: proactiveKind,
    })
    .execute();
  sseHub.broadcast(groupId, SSE.message, {
    id,
    groupId,
    kind: 'bot',
    body,
    createdAt: now,
  } as never);
  // The publisher forwards in the background; wait for it to finish.
  await settleBackgroundWork();
  return id;
}

async function closeWindow(): Promise<void> {
  await db
    .updateTable('group_external_channels')
    .set({ last_inbound_at: new Date(Date.now() - 48 * 3_600_000).toISOString() })
    .where('external_channel_id', '=', CHANNEL)
    .execute();
}

async function addTask(title: string): Promise<void> {
  await db
    .insertInto('tasks')
    .values({
      id: newId('t'),
      group_id: groupId,
      title,
      status: 'open',
      due_at: new Date(Date.now() + 86_400_000).toISOString(),
      created_by: userId,
      created_at: new Date().toISOString(),
    })
    .execute();
}

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'sam');
  groupId = (await ensurePersonalGroup(db, userId)).id;
  await bindChannel(db, 'whatsapp', CHANNEL, groupId, 'whatsapp');
  conn = new CapturingConnector();
  stop = startOutboundPublisher(db, {
    getForBinding: () => conn as unknown as Connector,
  });
});

afterEach(async () => {
  stop();
  await closeTestDb(db);
});

describe('out-of-window briefing goes out as a filled template', () => {
  it('sends a template with five body params carrying the user real facts', async () => {
    await addTask('Book dentist');
    await closeWindow();
    await broadcastBriefing('Morning! Here is your full briefing.');

    expect(conn.sent).toHaveLength(1);
    const sent = conn.sent[0];
    expect(sent.contentSid).toBe('daily_briefing');
    expect(sent.templateParams).toHaveLength(5);
    // Slot 4 is open tasks — proof the facts builder actually ran for this
    // user rather than a static prompt going out.
    expect(sent.templateParams?.[3]).toContain('Book dentist');
  });

  it('never sends an empty slot, even for an account with nothing in it', async () => {
    await closeWindow();
    await broadcastBriefing('Morning!');

    for (const p of conn.sent[0].templateParams ?? []) {
      expect(p.length).toBeGreaterThan(0);
      expect(p).not.toMatch(/[\r\n\t]/);
    }
  });

  it('offers Full briefing and Stop these, carrying the ADR 0029 payloads', async () => {
    await closeWindow();
    await broadcastBriefing('Morning!');

    const buttons = conn.sent[0].cards[0].buttons ?? [];
    expect(buttons.map((b) => b.label)).toEqual(['Full briefing', 'Stop these']);
    expect(buttons.map((b) => b.callback?.verb)).toEqual(['n+', 'n-']);
  });

  it('parks the briefing so the Full briefing button has something to deliver', async () => {
    await closeWindow();
    const messageId = await broadcastBriefing('the real briefing');

    const row = await db
      .selectFrom('group_external_channels')
      .select(['pending_briefing_message_id', 'nudge_prompt_sent_at'])
      .where('external_channel_id', '=', CHANNEL)
      .executeTakeFirstOrThrow();
    expect(row.pending_briefing_message_id).toBe(messageId);
    expect(row.nudge_prompt_sent_at).not.toBeNull();
  });

  it('sends the briefing as plain text when the window is open', async () => {
    await db
      .updateTable('group_external_channels')
      .set({ last_inbound_at: new Date().toISOString() })
      .where('external_channel_id', '=', CHANNEL)
      .execute();
    await broadcastBriefing('Morning! Here is your full briefing.');

    expect(conn.sent).toHaveLength(1);
    expect(conn.sent[0].contentSid).toBeUndefined();
    expect(conn.sent[0].templateParams).toBeUndefined();
    expect(conn.sent[0].body).toContain('full briefing');
  });

  it('stays silent on the second closed-window morning — ask-once (ADR 0089 §6)', async () => {
    await closeWindow();
    await broadcastBriefing('day one');
    expect(conn.sent).toHaveLength(1);

    await closeWindow();
    await broadcastBriefing('day two');
    expect(conn.sent).toHaveLength(1);
  });

  /**
   * The prod bug, at the level it happened (ADR 0137). At 21:02 an
   * `event_created_nudge` fired, found the window shut, and — because the gate
   * keyed on `is_proactive`, which SIX different messages set — sent the
   * BRIEFING's template: "Good morning! Want your daily briefing?" plus the
   * day's facts, at nine at night. The conflict warning it was supposed to
   * deliver ended up parked behind a `Full briefing` button.
   */
  it('a non-briefing nudge sends nothing rather than a 9pm good-morning template', async () => {
    await closeWindow();
    await broadcastBriefing(
      '🚨 Conflict: "Amtrak Train" overlaps another event',
      'event_created_nudge',
    );
    expect(conn.sent).toHaveLength(0);
  });

  it('leaves the briefing ask unspent, and unparked', async () => {
    await closeWindow();
    await broadcastBriefing('🚨 Conflict: two events overlap', 'event_created_nudge');

    // `nudge_prompt_sent_at` means "asked and unanswered", which ADR 0089 §6
    // reads as permission to stay quiet for a week. We never asked.
    const row = await db
      .selectFrom('group_external_channels')
      .select(['nudge_prompt_sent_at', 'pending_briefing_message_id'])
      .where('group_id', '=', groupId)
      .executeTakeFirstOrThrow();
    expect(row.nudge_prompt_sent_at).toBeNull();
    // Nor may an unrelated message sit behind the Full briefing button.
    expect(row.pending_briefing_message_id).toBeNull();

    // And the morning's real briefing still gets the ask.
    await broadcastBriefing('Morning! Here is your day');
    expect(conn.sent).toHaveLength(1);
    expect(conn.sent[0].contentSid).toBeTruthy();
  });

  it('still delivers a non-briefing nudge while the window is open', async () => {
    await db
      .updateTable('group_external_channels')
      .set({ last_inbound_at: new Date().toISOString() })
      .where('external_channel_id', '=', CHANNEL)
      .execute();
    await broadcastBriefing('🚨 Conflict: two events overlap', 'event_created_nudge');
    expect(conn.sent).toHaveLength(1);
    expect(conn.sent[0].contentSid).toBeUndefined();
    expect(conn.sent[0].body).toContain('Conflict');
  });
});

/**
 * ADR 0099 — production ran two days with `META_NUDGE_TEMPLATE_LANG=en_US`
 * against a template approved as `en`. Meta answered 132001, the throw landed
 * in the publisher's generic catch as a warn, and the briefing vanished: not
 * delivered, not parked, no prompt. The ask must survive so the next morning
 * retries once the config is fixed.
 */
describe('a template Meta rejects does not silently cost the ask', () => {
  /** What the cloud API raises on 132001. */
  class RejectingConnector {
    attempts = 0;
    send = async () => {
      this.attempts += 1;
      throw new Error(
        'whatsapp cloud send failed: 404 (#132001) Template name does not exist in the translation',
      );
    };
  }

  let rejecting: RejectingConnector;

  beforeEach(() => {
    stop();
    rejecting = new RejectingConnector();
    stop = startOutboundPublisher(db, {
      getForBinding: () => rejecting as unknown as Connector,
    });
  });

  async function channelRow() {
    return db
      .selectFrom('group_external_channels')
      .select(['pending_briefing_message_id', 'nudge_prompt_sent_at'])
      .where('external_channel_id', '=', CHANNEL)
      .executeTakeFirstOrThrow();
  }

  it('leaves the ask unspent, so tomorrow tries again', async () => {
    await closeWindow();
    await broadcastBriefing('the briefing that could not go out');

    expect(rejecting.attempts).toBe(1);
    expect((await channelRow()).nudge_prompt_sent_at).toBeNull();
  });

  it('parks nothing — there is no prompt to tap, so a parked copy is unreachable', async () => {
    await closeWindow();
    await broadcastBriefing('the briefing that could not go out');

    expect((await channelRow()).pending_briefing_message_id).toBeNull();
  });

  it('actually retries the next morning rather than reading as already-asked', async () => {
    await closeWindow();
    await broadcastBriefing('day one');
    await closeWindow();
    await broadcastBriefing('day two');

    // Contrast with the ask-once case above, where the second morning is silent.
    expect(rejecting.attempts).toBe(2);
  });

  it('logs at error naming the template and language to change', async () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    await closeWindow();
    await broadcastBriefing('the briefing that could not go out');

    // winston types `error` as a 1-tuple, so index the metadata arg loosely.
    const calls = spy.mock.calls as unknown as unknown[][];
    const call = calls.find((c) => String(c[0]).includes('template rejected'));
    expect(call).toBeDefined();
    const meta = call?.[1] as { template?: string; language?: string };
    expect(meta.template).toBe('daily_briefing');
    expect(meta.language).toBeDefined();
    spy.mockRestore();
  });
});
