/**
 * ADR 0278 — every mailbox has its own color in the Email tab, like every
 * calendar: the user's pick, else the next free color of Chord's palette.
 * Settings and the `set_mailbox_color` chat tool share one writer.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CHORD_CALENDAR_PALETTE } from '@chord/kernel';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { PERSONAL_ONLY_TOOL_NAMES } from '@/services/bot/tools.js';
import { mailboxColors, setMailboxColor } from '@/services/email/mailbox-colors.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('mailbox colors (ADR 0278)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalId: string;
  let priorProvider: string;
  let hotmail: string;
  let yahoo: string;

  const addAccount = async (provider: 'outlook' | 'imap', address: string, createdAt: string): Promise<string> => {
    const id = newId('ea');
    await db
      .insertInto('email_accounts')
      .values({
        id,
        user_id: userId,
        provider,
        email_address: address,
        created_at: createdAt,
        updated_at: createdAt,
      } as never)
      .execute();
    return id;
  };

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'john');
    await db.updateTable('users').set({ email: 'ownertest@gmail.com' }).where('id', '=', userId).execute();
    personalId = (await ensurePersonalGroup(db, userId)).id;
    priorProvider = env.GMAIL_PROVIDER;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
    hotmail = await addAccount('outlook', 'owner.two@hotmail.com', '2026-01-01T00:00:00Z');
    yahoo = await addAccount('imap', 'owner.three@yahoo.com', '2026-02-01T00:00:00Z');
  });
  afterEach(async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = priorProvider;
    await closeTestDb(db);
  });

  it('gives each mailbox its own palette color, the primary Gmail first', async () => {
    const { colors } = await mailboxColors(db, userId);
    expect(colors.primary).toBe(CHORD_CALENDAR_PALETTE[0]);
    expect(colors[hotmail]).toBe(CHORD_CALENDAR_PALETTE[1]);
    expect(colors[yahoo]).toBe(CHORD_CALENDAR_PALETTE[2]);
  });

  it('a pick wins, and the other mailboxes skip the color it took', async () => {
    const r = await setMailboxColor(db, userId, { mailbox: hotmail }, CHORD_CALENDAR_PALETTE[0]);
    expect(r.ok).toBe(true);
    const { colors, picked } = await mailboxColors(db, userId);
    expect(colors[hotmail]).toBe(CHORD_CALENDAR_PALETTE[0]);
    expect(colors.primary).toBe(CHORD_CALENDAR_PALETTE[1]);
    expect(picked).toEqual({ [hotmail]: CHORD_CALENDAR_PALETTE[0] });
  });

  it('an empty color clears the pick', async () => {
    await setMailboxColor(db, userId, { mailbox: yahoo }, 'pink');
    await setMailboxColor(db, userId, { mailbox: yahoo }, '');
    const { colors, picked } = await mailboxColors(db, userId);
    expect(colors[yahoo]).toBe(CHORD_CALENDAR_PALETTE[2]);
    expect(picked).toEqual({});
  });

  it('refuses an unknown mailbox and an unknown color', async () => {
    expect(await setMailboxColor(db, userId, { mailbox: 'nope' }, 'red')).toEqual({ ok: false, reason: 'not_found' });
    expect(await setMailboxColor(db, userId, { mailbox: yahoo }, 'sparkly')).toEqual({ ok: false, reason: 'bad_color' });
  });

  describe('set_mailbox_color tool', () => {
    const say = (args: { mailbox?: string; color?: string }) =>
      applyToolCall(db, {
        groupId: personalId,
        actorUserId: userId,
        provenance: null,
        call: { name: 'set_mailbox_color', args },
      });

    it('is personal-chat only', () => {
      expect(PERSONAL_ONLY_TOOL_NAMES.has('set_mailbox_color')).toBe(true);
    });

    it('"make my Hotmail purple" saves it', async () => {
      const r = await say({ mailbox: 'Hotmail', color: 'purple' });
      expect(r.data).toMatchObject({ ok: true, color: '#7F76DE', colorName: 'purple' });
      expect((await mailboxColors(db, userId)).colors[hotmail]).toBe('#7F76DE');
    });

    it('reads every mailbox when none is named', async () => {
      const r = await say({});
      const data = r.data as { ok: boolean; mailboxes: { address: string }[] };
      expect(data.mailboxes.map((m) => m.address)).toEqual([
        'ownertest@gmail.com',
        'owner.two@hotmail.com',
        'owner.three@yahoo.com',
      ]);
    });
  });
});
