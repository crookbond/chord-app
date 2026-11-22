/**
 * The assembled morning message, through the real fire path. Before this,
 * code prepended the birthdays and weather ABOVE the model's greeting, so the
 * message opened "🎂 Birthdays…" with "Morning!" further down; and the
 * model's "nothing needs attention" sentence was printed above a birthday.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { createEvent } from '@/services/events.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { __testing, runDailyScanForUserNow } from '@/services/proactive.service.js';
import { createTask } from '@/services/tasks.service.js';
import { dayOf } from '@/utils/tz.js';

const modelReply = vi.hoisted(() => ({ text: '' }));

vi.mock('@/config/env.js', async (orig) => {
  const mod = (await orig()) as { env: Record<string, unknown> };
  return { env: { ...mod.env, WEATHER_PROVIDER: '', GEOIP_DB_PATH: '', GMAIL_ENABLED: false } };
});

vi.mock('@/services/llm/factory.js', () => {
  const llm = {
    providerName: 'pinned-mock',
    defaultModel: 'pinned-mock',
    supportsNativeTools: false,
    complete: async () => modelReply.text,
    // eslint-disable-next-line require-yield
    async *stream() { return; },
  };
  return {
    getLlm: () => llm,
    getLlmForUser: async () => llm,
    resolveTurnLlm: async () => ({ llm, tier: 'premium' as const }),
  };
});

const TZ = 'America/New_York';

describe('morning briefing assembly', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'ada');
    groupId = (await ensurePersonalGroup(db, userId)).id;
    await db.updateTable('users').set({ last_tz: TZ }).where('id', '=', userId).execute();
    const tomorrow = dayOf(new Date(Date.now() + 86_400_000).toISOString(), TZ);
    await createEvent(db, {
      groupId,
      title: "Ben's birthday",
      startsAt: `${tomorrow}T00:00:00`,
      createdBy: userId,
      allDay: true,
    });
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  async function briefing(): Promise<string> {
    expect(await runDailyScanForUserNow(db, userId)).toBe(true);
    const row = await db
      .selectFrom('messages')
      .select('body')
      .where('group_id', '=', groupId)
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow();
    return row.body ?? '';
  }

  it('opens with the greeting, once, above the birthdays', async () => {
    modelReply.text = "Morning! Here's what's on your radar:\n⏰ This week: dentist Tuesday";
    const body = await briefing();
    expect(body.split('\n')[0]).toBe("Morning! Here's what's on your radar:");
    expect(body.match(/morning!/gi)).toHaveLength(1);
    expect(body.indexOf("Ben's birthday")).toBeLessThan(body.indexOf('dentist Tuesday'));
  });

  it('names the to-do Chord took off the list that day, and why (ADR 0285)', async () => {
    modelReply.text = '⏰ This week: dentist Tuesday';
    await createTask(db, {
      groupId,
      createdBy: userId,
      title: 'Pay the CVS bill',
      dueAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    });
    await __testing.archiveStaleTasks(db);

    const body = await briefing();
    expect(body).toContain('Pay the CVS bill — more than a week past its date');
    expect(body.indexOf('dentist Tuesday')).toBeLessThan(body.indexOf('Pay the CVS bill'));
  });

  it('does not claim nothing needs attention above a birthday', async () => {
    modelReply.text = 'Morning! Nothing on the calendar needs attention today.';
    const body = await briefing();
    expect(body.split('\n')[0]).toBe("Morning! Here's what's on your radar:");
    expect(body).not.toMatch(/nothing/i);
    expect(body).toContain("Ben's birthday");
  });
});
