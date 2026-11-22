/**
 * ADR 0089 — WhatsApp's 24h session window and the briefing that has to
 * survive it.
 *
 * The template itself cannot be exercised end to end until Meta approves the
 * business and the template, so these tests drive the decision layer directly:
 * when a proactive send may be text, when it must ask, when it must stay quiet,
 * and what each answer does.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { bindChannel } from '@/services/connectors/channel-resolver.js';
import {
  askExpired,
  claimPendingBriefing,
  gateProactiveSend,
  markPrompted,
  optOutOfBriefing,
  recordInbound,
  resumeBriefing,
  windowOpen,
} from '@/services/connectors/whatsapp/session-window.js';
import { handleCallback } from '@/services/connectors/telegram/callback-handler.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { newId } from '@/utils/ids.js';

const CHANNEL = 'whatsapp:+13475550100';

let db: Kysely<DB>;
let groupId: string;
let userId: string;

async function ago(hours: number): Promise<string> {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

async function setPromptSentAt(at: string | null): Promise<void> {
  await db
    .updateTable('group_external_channels')
    .set({ nudge_prompt_sent_at: at })
    .where('external_channel_id', '=', CHANNEL)
    .execute();
}

async function setLastInbound(at: string | null): Promise<void> {
  await db
    .updateTable('group_external_channels')
    .set({ last_inbound_at: at })
    .where('external_channel_id', '=', CHANNEL)
    .execute();
}

/** A delivered briefing, as `fireOne` would have written it. */
async function seedBriefing(
  body: string,
  createdAt = new Date().toISOString(),
): Promise<string> {
  const id = newId('m');
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
      created_at: createdAt,
      source: null,
      external_message_id: null,
      chord_visible: 1,
      mentions_others: 0,
      auto_mirror: 1,
      bot_persona_id: null,
      is_proactive: 1,
      proactive_kind: 'daily_morning_scan',
    })
    .execute();
  return id;
}

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'sam');
  groupId = (await ensurePersonalGroup(db, userId)).id;
  await bindChannel(db, 'whatsapp', CHANNEL, groupId, 'whatsapp');
});

afterEach(async () => {
  await closeTestDb(db);
});

describe('windowOpen', () => {
  it('is closed with no inbound on record', () => {
    expect(windowOpen(null)).toBe(false);
  });

  it('is open just inside 24h and closed just outside', () => {
    const now = Date.now();
    expect(windowOpen(new Date(now - 23 * 3_600_000).toISOString(), now)).toBe(true);
    expect(windowOpen(new Date(now - 25 * 3_600_000).toISOString(), now)).toBe(false);
  });

  it('treats a send racing the 24h boundary as closed, not open', () => {
    const now = Date.now();
    // 23h59m — inside Meta's literal window but inside our safety margin too,
    // so we must not bet a free-form send on it.
    const edge = new Date(now - (24 * 3_600_000 - 60_000)).toISOString();
    expect(windowOpen(edge, now)).toBe(false);
  });

  it('is closed on an unparseable timestamp rather than assuming open', () => {
    expect(windowOpen('not-a-date')).toBe(false);
  });
});

describe('gateProactiveSend', () => {
  // ADR 0137. In prod a 9:02pm event-created nudge found the window shut and
  // sent the "Good morning! Want your daily briefing?" template carrying the
  // day's facts — a briefing at 9pm — then parked the conflict warning behind
  // its `Full briefing` button. The ask belongs to the briefing.
  it('does not spend the briefing ask on another kind of proactive message', async () => {
    await setLastInbound(await ago(40));
    const gate = await gateProactiveSend(db, {
      externalChannelId: CHANNEL,
      groupId,
      hasTemplate: true,
      isBriefing: false,
    });
    expect(gate).toEqual({ action: 'skip', reason: 'window_closed' });
  });

  it('leaves the ask unspent, so the briefing can still use it', async () => {
    await setLastInbound(await ago(40));
    await gateProactiveSend(db, {
      externalChannelId: CHANNEL,
      groupId,
      hasTemplate: true,
      isBriefing: false,
    });
    // The skip must not look like an ask: `nudge_prompt_sent_at` staying null
    // is what lets the morning's briefing prompt rather than reading as
    // "already asked" (ADR 0089 §6) for a week.
    expect(
      await gateProactiveSend(db, {
        externalChannelId: CHANNEL,
        groupId,
        hasTemplate: true,
        isBriefing: true,
      }),
    ).toEqual({ action: 'prompt' });
  });

  it('still sends a non-briefing nudge while the window is open', async () => {
    await setLastInbound(await ago(2));
    const gate = await gateProactiveSend(db, {
      externalChannelId: CHANNEL,
      groupId,
      hasTemplate: true,
      isBriefing: false,
    });
    expect(gate.action).toBe('send');
  });

  it('sends as text when the user wrote recently', async () => {
    await setLastInbound(await ago(2));
    const gate = await gateProactiveSend(db, {
      externalChannelId: CHANNEL,
      groupId,
      hasTemplate: true,
      isBriefing: true,
    });
    expect(gate.action).toBe('send');
  });

  it('prompts when the window is closed and we have a template', async () => {
    await setLastInbound(await ago(40));
    const gate = await gateProactiveSend(db, {
      externalChannelId: CHANNEL,
      groupId,
      hasTemplate: true,
      isBriefing: true,
    });
    expect(gate.action).toBe('prompt');
  });

  it('skips rather than failing when no template is configured', async () => {
    await setLastInbound(await ago(40));
    const gate = await gateProactiveSend(db, {
      externalChannelId: CHANNEL,
      groupId,
      hasTemplate: false,
      isBriefing: true,
    });
    expect(gate).toEqual({ action: 'skip', reason: 'no_template' });
  });

  it('asks again once the ask has aged out, without the user doing anything', async () => {
    await setLastInbound(await ago(40));
    await markPrompted(db, {
      externalChannelId: CHANNEL,
      groupId,
      messageId: await seedBriefing('last week'),
    });
    // Silent all week: no tap, no reply, window still shut.
    await setPromptSentAt(await ago(24 * 8));

    expect(
      await gateProactiveSend(db, { externalChannelId: CHANNEL, groupId, hasTemplate: true, isBriefing: true }),
    ).toEqual({ action: 'prompt' });
  });

  it('stays quiet inside the re-ask interval', async () => {
    await setLastInbound(await ago(40));
    await markPrompted(db, {
      externalChannelId: CHANNEL,
      groupId,
      messageId: await seedBriefing('two days ago'),
    });
    await setPromptSentAt(await ago(24 * 6));

    expect(
      await gateProactiveSend(db, { externalChannelId: CHANNEL, groupId, hasTemplate: true, isBriefing: true }),
    ).toEqual({ action: 'skip', reason: 'already_asked' });
  });

  it('a re-ask parks the fresh briefing over the stale one', async () => {
    await setLastInbound(await ago(40));
    await markPrompted(db, {
      externalChannelId: CHANNEL,
      groupId,
      messageId: await seedBriefing('last week'),
    });
    await setPromptSentAt(await ago(24 * 8));

    await markPrompted(db, {
      externalChannelId: CHANNEL,
      groupId,
      messageId: await seedBriefing('today'),
    });
    // The tap must not hand back a week-old morning.
    expect((await claimPendingBriefing(db, CHANNEL))?.body).toBe('today');
  });

  it('asks only once — silence stops the asking', async () => {
    await setLastInbound(await ago(40));
    const first = await gateProactiveSend(db, {
      externalChannelId: CHANNEL,
      groupId,
      hasTemplate: true,
      isBriefing: true,
    });
    expect(first.action).toBe('prompt');

    await markPrompted(db, {
      externalChannelId: CHANNEL,
      groupId,
      messageId: await seedBriefing('day one'),
    });

    const second = await gateProactiveSend(db, {
      externalChannelId: CHANNEL,
      groupId,
      hasTemplate: true,
      isBriefing: true,
    });
    expect(second).toEqual({ action: 'skip', reason: 'already_asked' });
  });

  it('asks again once the user re-engages of their own accord', async () => {
    await setLastInbound(await ago(40));
    await markPrompted(db, {
      externalChannelId: CHANNEL,
      groupId,
      messageId: await seedBriefing('day one'),
    });

    // The user writes. That reopens the window AND clears the ask marker.
    await recordInbound(db, CHANNEL);
    expect(
      (await gateProactiveSend(db, { externalChannelId: CHANNEL, groupId, hasTemplate: true, isBriefing: true }))
        .action,
    ).toBe('send');

    // ...and once that window lapses again, we're allowed to ask afresh.
    await setLastInbound(await ago(40));
    expect(
      (await gateProactiveSend(db, { externalChannelId: CHANNEL, groupId, hasTemplate: true, isBriefing: true }))
        .action,
    ).toBe('prompt');
  });

  it('stays silent forever once opted out, even inside an open window', async () => {
    await optOutOfBriefing(db, CHANNEL);
    await setLastInbound(await ago(1));
    const gate = await gateProactiveSend(db, {
      externalChannelId: CHANNEL,
      groupId,
      hasTemplate: true,
      isBriefing: true,
    });
    expect(gate).toEqual({ action: 'skip', reason: 'opted_out' });
  });

  it('does not swallow the message when the channel has no binding row', async () => {
    const gate = await gateProactiveSend(db, {
      externalChannelId: 'whatsapp:+19995550000',
      groupId,
      hasTemplate: true,
      isBriefing: true,
    });
    expect(gate.action).toBe('send');
  });
});

describe('askExpired', () => {
  const now = Date.parse('2026-08-25T11:00:00.000Z');

  it('holds inside the interval and lapses on it', () => {
    expect(askExpired('2026-08-19T11:00:00.000Z', now, 7)).toBe(false);
    expect(askExpired('2026-08-18T11:00:00.000Z', now, 7)).toBe(true);
  });

  it('never expires when the interval is off', () => {
    expect(askExpired('2020-01-01T00:00:00.000Z', now, 0)).toBe(false);
    expect(askExpired('2020-01-01T00:00:00.000Z', now, -1)).toBe(false);
  });

  it('expires an unparseable stamp so the channel self-heals', () => {
    // The opposite reading would mute the binding permanently on a value
    // nothing can interpret, and nothing would ever rewrite it.
    expect(askExpired('not-a-date', now, 7)).toBe(true);
  });

  it('defaults to the configured interval', () => {
    const saved = env.WHATSAPP_NUDGE_REASK_DAYS;
    (env as { WHATSAPP_NUDGE_REASK_DAYS: number }).WHATSAPP_NUDGE_REASK_DAYS = 1;
    try {
      expect(askExpired(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe(true);
    } finally {
      (env as { WHATSAPP_NUDGE_REASK_DAYS: number }).WHATSAPP_NUDGE_REASK_DAYS = saved;
    }
  });
});

describe('answering the prompt', () => {
  it('yes hands back the parked briefing, once', async () => {
    const messageId = await seedBriefing('Here is your Tuesday.');
    await markPrompted(db, { externalChannelId: CHANNEL, groupId, messageId });

    const claimed = await claimPendingBriefing(db, CHANNEL);
    expect(claimed?.body).toBe('Here is your Tuesday.');
    expect(claimed?.groupId).toBe(groupId);

    // A second tap on the same prompt has nothing left to deliver.
    expect(await claimPendingBriefing(db, CHANNEL)).toBeNull();
  });

  /**
   * The reported bug: the prompt goes out at most weekly, so after a few days
   * of silence the tap handed back the briefing parked on the day the prompt
   * was sent. "Full briefing" means today's.
   */
  it('yes after days of silence hands back today’s briefing, not the parked one', async () => {
    const messageId = await seedBriefing('Here is your Tuesday.', await ago(72));
    await markPrompted(db, { externalChannelId: CHANNEL, groupId, messageId });
    await seedBriefing('Here is your Friday.');

    const claimed = await claimPendingBriefing(db, CHANNEL);
    expect(claimed?.body).toBe('Here is your Friday.');
    expect(claimed?.refreshForUserId).toBeUndefined();
  });

  it('yes after days of silence with nothing posted today asks for a fresh one', async () => {
    const messageId = await seedBriefing('Here is your Tuesday.', await ago(72));
    await markPrompted(db, { externalChannelId: CHANNEL, groupId, messageId });

    const claimed = await claimPendingBriefing(db, CHANNEL);
    expect(claimed?.refreshForUserId).toBe(userId);
  });

  it('the tap on an old prompt runs today’s briefing instead of sending the old one', async () => {
    const messageId = await seedBriefing('Here is your Tuesday.', await ago(72));
    await markPrompted(db, { externalChannelId: CHANNEL, groupId, messageId });

    const result = await handleCallback(db, {
      platform: 'whatsapp',
      externalUserId: CHANNEL,
      receivedByBotUserId: null,
      data: 'n+:brief',
    });
    await settleBackgroundWork();

    expect(result.toast).not.toContain('Tuesday');
    const fresh = await db
      .selectFrom('messages')
      .select('id')
      .where('group_id', '=', groupId)
      .where('proactive_kind', '=', 'daily_morning_scan')
      .where('id', '!=', messageId)
      .execute();
    expect(fresh).toHaveLength(1);
  });

  it('yes with nothing parked returns null instead of inventing a briefing', async () => {
    expect(await claimPendingBriefing(db, CHANNEL)).toBeNull();
  });

  it('no mutes the channel but leaves nudge_enabled alone', async () => {
    const userId = await createUser(db, 'kim');
    const kimGroup = (await ensurePersonalGroup(db, userId)).id;
    const kimChannel = 'whatsapp:+13475550111';
    await bindChannel(db, 'whatsapp', kimChannel, kimGroup, 'whatsapp');

    await optOutOfBriefing(db, kimChannel);

    const channel = await db
      .selectFrom('group_external_channels')
      .select('briefing_opted_out')
      .where('external_channel_id', '=', kimChannel)
      .executeTakeFirst();
    expect(Number(channel?.briefing_opted_out)).toBe(1);

    // ADR 0089 §5 — the in-app / push briefing keeps working.
    const user = await db
      .selectFrom('users')
      .select('nudge_enabled')
      .where('id', '=', userId)
      .executeTakeFirst();
    expect(Number(user?.nudge_enabled ?? 1)).toBe(1);
  });

  it('no drops the parked briefing so a later tap cannot resurrect it', async () => {
    const messageId = await seedBriefing('unwanted');
    await markPrompted(db, { externalChannelId: CHANNEL, groupId, messageId });
    await optOutOfBriefing(db, CHANNEL);
    expect(await claimPendingBriefing(db, CHANNEL)).toBeNull();
  });

  it('an opt-out survives the user writing back', async () => {
    await optOutOfBriefing(db, CHANNEL);
    await recordInbound(db, CHANNEL);
    const gate = await gateProactiveSend(db, {
      externalChannelId: CHANNEL,
      groupId,
      hasTemplate: true,
      isBriefing: true,
    });
    expect(gate).toEqual({ action: 'skip', reason: 'opted_out' });
  });
});

/**
 * ADR 0091 — the Settings toggle's way back. ADR 0089 shipped `n-` with no
 * in-app undo, so a mis-tap muted the channel permanently.
 */
describe('resuming a muted channel', () => {
  it('un-mutes, and the next closed-window morning may send again', async () => {
    await optOutOfBriefing(db, CHANNEL);
    await resumeBriefing(db, { externalChannelId: CHANNEL, groupId });
    await setLastInbound(await ago(48));
    const gate = await gateProactiveSend(db, {
      externalChannelId: CHANNEL,
      groupId,
      hasTemplate: true,
      isBriefing: true,
    });
    // Not `already_asked`: resuming clears the prompt stamp too, otherwise a
    // channel muted after being asked would come back permanently silent.
    expect(gate).toEqual({ action: 'prompt' });
  });

  it('un-muting clears a prompt stamp left over from before the mute', async () => {
    const messageId = await seedBriefing('yesterday');
    await markPrompted(db, { externalChannelId: CHANNEL, groupId, messageId });
    await optOutOfBriefing(db, CHANNEL);
    await resumeBriefing(db, { externalChannelId: CHANNEL, groupId });
    const row = await db
      .selectFrom('group_external_channels')
      .select(['briefing_opted_out', 'nudge_prompt_sent_at'])
      .where('external_channel_id', '=', CHANNEL)
      .executeTakeFirstOrThrow();
    expect(Number(row.briefing_opted_out)).toBe(0);
    expect(row.nudge_prompt_sent_at).toBeNull();
  });

  it('ask-once still holds — one content template, then silence', async () => {
    const messageId = await seedBriefing('the briefing');
    await setLastInbound(await ago(48));
    expect(
      await gateProactiveSend(db, { externalChannelId: CHANNEL, groupId, hasTemplate: true, isBriefing: true }),
    ).toEqual({ action: 'prompt' });
    await markPrompted(db, { externalChannelId: CHANNEL, groupId, messageId });
    expect(
      await gateProactiveSend(db, { externalChannelId: CHANNEL, groupId, hasTemplate: true, isBriefing: true }),
    ).toEqual({ action: 'skip', reason: 'already_asked' });
  });
});
