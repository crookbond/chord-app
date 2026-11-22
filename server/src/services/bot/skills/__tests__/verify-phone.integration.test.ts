/**
 * ADR 0299 — the Settings phone check, in chat. Pinned: the code arrives in a
 * later turn without the number and still verifies the number it was sent
 * to; a wrong code verifies nothing; the onboarding phone question is asked
 * until the number is verified and skipped after; personal chat only.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const sent: string[] = [];
vi.mock('@/services/phone/otp.js', () => ({
  getOtpProvider: () => ({
    name: 'fake',
    start: async (_db: unknown, phone: string) => {
      sent.push(phone);
      return { ok: true };
    },
    check: async (_db: unknown, _phone: string, code: string) =>
      code === '482913' ? { ok: true } : { ok: false, reason: 'invalid_code' },
  }),
}));

const { applyToolCall } = await import('@/services/bot/executor.js');
const { activeSkill, stepSkill } = await import('@/services/bot/skills/index.js');
const { createGroup, ensurePersonalGroup } = await import('@/services/groups.service.js');

describe('verify_phone (ADR 0299)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalId: string;

  beforeEach(async () => {
    sent.length = 0;
    db = await openTestDb();
    userId = await createUser(db, 'ro');
    personalId = (await ensurePersonalGroup(db, userId)).id;
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  const call = (name: string, args: Record<string, unknown>, groupId = personalId) =>
    applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      mode: 'commit',
      tz: 'America/New_York',
      call: { name, args } as never,
    });
  const dataOf = (r: Awaited<ReturnType<typeof call>>) => r.data as Record<string, any>;
  const verified = async () =>
    (await db.selectFrom('users').select(['phone_number', 'phone_verified']).where('id', '=', userId).executeTakeFirst())!;

  it('texts a code, then verifies with the code alone', async () => {
    const start = dataOf(await call('verify_phone', { phone: '(415) 555-0134' }));
    expect(start).toMatchObject({ ok: true, sent: true, phone: '+14155550134' });
    expect(sent).toEqual(['+14155550134']);
    expect((await verified()).phone_verified).toBe(0);

    const done = dataOf(await call('verify_phone', { code: '482913' }));
    expect(done).toMatchObject({ ok: true, verified: true, phone: '+14155550134' });
    expect(await verified()).toMatchObject({ phone_number: '+14155550134', phone_verified: 1 });
  });

  it('a wrong code verifies nothing', async () => {
    await call('verify_phone', { phone: '415 555 0134' });
    const r = dataOf(await call('verify_phone', { code: '111111' }));
    expect(r).toMatchObject({ ok: false, reason: 'invalid_code' });
    expect((await verified()).phone_verified).toBe(0);
  });

  it('a code with no number sent first is refused', async () => {
    const r = dataOf(await call('verify_phone', { code: '482913' }));
    expect(r.ok).toBe(false);
    expect((await verified()).phone_verified).toBe(0);
  });

  it('onboarding asks for the phone until it is verified', async () => {
    await call('start_skill', { skill: 'onboarding' });
    for (let i = 0; i < 4; i += 1) {
      await stepSkill(db, { userId, groupId: personalId, action: 'skip' });
    }
    expect((await activeSkill(db, userId, personalId))?.step?.id).toBe('phone');

    await call('verify_phone', { phone: '4155550134' });
    await call('verify_phone', { code: '482913' });
    await stepSkill(db, { userId, groupId: personalId, action: 'answered' });

    await call('start_skill', { skill: 'onboarding', restart: true });
    for (let i = 0; i < 4; i += 1) {
      await stepSkill(db, { userId, groupId: personalId, action: 'skip' });
    }
    // Verified now, so the question is not asked again.
    expect((await activeSkill(db, userId, personalId))?.step?.id).toBe('briefing');
  });

  it('works in the personal chat only', async () => {
    const shared = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: userId })).id;
    const r = dataOf(await call('verify_phone', { phone: '4155550134' }, shared));
    expect(r.reason).toBe('personal_only');
    expect(sent).toEqual([]);
  });
});
