/**
 * Gating coverage for the push fan-out (ADR 0054): selectRecipientTokens must
 * honour author-exclusion, per-group mute, per-category toggles, and quiet
 * hours (with the daily briefing exempt).
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Message } from '@chord/kernel';
import type { DB, ProactiveMessageKind } from '@/db/schema.js';
import { createGroup, joinGroupByCode, setGroupMuted } from '@/services/groups.service.js';
import { selectRecipientTokens } from '@/services/push/push-publisher.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { newId } from '@/utils/ids.js';

async function addToken(db: Kysely<DB>, userId: string): Promise<string> {
  const token = `ExponentPushToken[${userId}]`;
  const now = new Date().toISOString();
  await db
    .insertInto('push_tokens')
    .values({ token, user_id: userId, platform: 'ios', created_at: now, last_seen_at: now })
    .execute();
  return token;
}

async function setPrefs(
  db: Kysely<DB>,
  userId: string,
  patch: Partial<{
    notify_messages: number;
    notify_bot: number;
    notify_briefing: number;
    quiet_enabled: number;
    quiet_start_hour: number;
    quiet_end_hour: number;
    last_tz: string;
  }>,
): Promise<void> {
  await db.updateTable('users').set(patch).where('id', '=', userId).execute();
}

/** Insert a message row (so classify() can read the proactive columns) and
 *  return a matching kernel Message. */
async function insertMessage(
  db: Kysely<DB>,
  opts: {
    groupId: string;
    senderId: string | null;
    kind: 'text' | 'bot';
    isProactive?: 0 | 1;
    proactiveKind?: ProactiveMessageKind;
  },
): Promise<Message> {
  const id = newId('m');
  await db
    .insertInto('messages')
    .values({
      id,
      group_id: opts.groupId,
      sender_id: opts.senderId,
      kind: opts.kind,
      body: 'hello',
      attachment_id: null,
      reply_to_id: null,
      mentions_bot: 0,
      created_at: new Date().toISOString(),
      source: null,
      external_message_id: null,
      chord_visible: 1,
      mentions_others: 0,
      auto_mirror: 1,
      bot_persona_id: null,
      is_proactive: opts.isProactive ?? 0,
      proactive_kind: opts.proactiveKind ?? null,
    })
    .execute();
  return {
    id,
    groupId: opts.groupId,
    senderId: opts.senderId,
    kind: opts.kind,
    body: 'hello',
    mentionsBot: false,
    createdAt: new Date().toISOString(),
  } as Message;
}

describe('selectRecipientTokens — push gating', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('sends a new message to other members but not the author', async () => {
    const john = await createUser(db, 'john', 'John');
    const maya = await createUser(db, 'maya', 'Maya');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: john });
    await joinGroupByCode(db, maya, group.invite_code);
    await addToken(db, john);
    const mayaToken = await addToken(db, maya);

    const msg = await insertMessage(db, { groupId: group.id, senderId: john, kind: 'text' });
    const tokens = await selectRecipientTokens(db, group.id, msg);
    expect(tokens).toEqual([mayaToken]); // author excluded
  });

  it('excludes a member who muted the group', async () => {
    const john = await createUser(db, 'john', 'John');
    const maya = await createUser(db, 'maya', 'Maya');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: john });
    await joinGroupByCode(db, maya, group.invite_code);
    await addToken(db, maya);
    await setGroupMuted(db, group.id, maya, true);

    const msg = await insertMessage(db, { groupId: group.id, senderId: john, kind: 'text' });
    expect(await selectRecipientTokens(db, group.id, msg)).toEqual([]);
  });

  it('respects the per-category toggle', async () => {
    const john = await createUser(db, 'john', 'John');
    const maya = await createUser(db, 'maya', 'Maya');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: john });
    await joinGroupByCode(db, maya, group.invite_code);
    await addToken(db, maya);
    await setPrefs(db, maya, { notify_messages: 0 });

    const msg = await insertMessage(db, { groupId: group.id, senderId: john, kind: 'text' });
    expect(await selectRecipientTokens(db, group.id, msg)).toEqual([]);

    // Bot reply still goes through (notify_bot left on).
    const bot = await insertMessage(db, { groupId: group.id, senderId: null, kind: 'bot' });
    expect(await selectRecipientTokens(db, group.id, bot)).toHaveLength(1);
  });

  it('quiet hours suppresses messages but not the daily briefing', async () => {
    const john = await createUser(db, 'john', 'John');
    const maya = await createUser(db, 'maya', 'Maya');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: john });
    await joinGroupByCode(db, maya, group.invite_code);
    await addToken(db, maya);
    // Quiet all day in UTC so "now" is always inside the window.
    await setPrefs(db, maya, {
      quiet_enabled: 1,
      quiet_start_hour: 0,
      quiet_end_hour: 23,
      last_tz: 'UTC',
    });
    const now = new Date('2026-06-17T12:00:00Z'); // 12:00 UTC, inside 00–23

    const text = await insertMessage(db, { groupId: group.id, senderId: john, kind: 'text' });
    expect(await selectRecipientTokens(db, group.id, text, now)).toEqual([]);

    const briefing = await insertMessage(db, {
      groupId: group.id,
      senderId: null,
      kind: 'bot',
      isProactive: 1,
      proactiveKind: 'daily_morning_scan',
    });
    expect(await selectRecipientTokens(db, group.id, briefing, now)).toHaveLength(1);
  });

  // ADR 0137 — the exemption is for messages arriving at a moment the USER
  // chose. `is_proactive` alone put every nudge in that category, so an event
  // echo woke people through their quiet hours on a technicality.
  it('quiet hours does suppress a proactive nudge that is not the briefing', async () => {
    const john = await createUser(db, 'john', 'John');
    const maya = await createUser(db, 'maya', 'Maya');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: john });
    await joinGroupByCode(db, maya, group.invite_code);
    await addToken(db, maya);
    await setPrefs(db, maya, {
      quiet_enabled: 1,
      quiet_start_hour: 0,
      quiet_end_hour: 23,
      last_tz: 'UTC',
    });
    const now = new Date('2026-06-17T12:00:00Z');

    for (const kind of ['event_created_nudge', 'calendar_reconnect'] as const) {
      const nudge = await insertMessage(db, {
        groupId: group.id,
        senderId: null,
        kind: 'bot',
        isProactive: 1,
        proactiveKind: kind,
      });
      expect(await selectRecipientTokens(db, group.id, nudge, now)).toEqual([]);
    }

    // A reminder the user themselves scheduled still pierces quiet hours —
    // they named that moment.
    const remind = await insertMessage(db, {
      groupId: group.id,
      senderId: null,
      kind: 'bot',
      isProactive: 1,
      proactiveKind: 'task_remind',
    });
    expect(await selectRecipientTokens(db, group.id, remind, now)).toHaveLength(1);
  });

  // A proactive row written before the column existed. Treating an unknown
  // kind as the briefing is what the whole change is undoing, so it must
  // resolve the other way.
  it('treats a proactive message with no recorded kind as not-the-briefing', async () => {
    const john = await createUser(db, 'john', 'John');
    const maya = await createUser(db, 'maya', 'Maya');
    const group = await createGroup(db, { name: 'Fam', kind: 'group', createdBy: john });
    await joinGroupByCode(db, maya, group.invite_code);
    await addToken(db, maya);
    await setPrefs(db, maya, { notify_bot: 0, notify_briefing: 1 });

    const legacy = await insertMessage(db, {
      groupId: group.id,
      senderId: null,
      kind: 'bot',
      isProactive: 1,
    });
    expect(await selectRecipientTokens(db, group.id, legacy)).toEqual([]);
  });
});
