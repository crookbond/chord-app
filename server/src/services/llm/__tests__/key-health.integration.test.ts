/**
 * ADR 0252 - a user's own AI key running out of credit is recorded where every
 * surface can read it, and nudged once per outage.
 *
 * Built from the prod shape: an OpenRouter key (an `openai`-provider key with a
 * base URL) whose provider answers 402 once the account is empty.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';

import type { DB } from '@/db/schema.js';
import { getBillingStatus } from '@/services/billing-status.service.js';
import { maybeNudgeByokKeyIssue, sweepByokKeyNudges } from '@/services/proactive.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import {
  clearByokKeyIssue,
  getByokKeyIssue,
  markByokKeyNudged,
  noteByokKeyFailure,
  withKeyHealth,
} from '@/services/llm/key-health.js';
import type { LlmService } from '@/services/llm/types.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { settleBackgroundWork } from '@/utils/background.js';

const empty = () => Object.assign(new Error('402 Insufficient credits'), { status: 402 });
const rejected = () => Object.assign(new Error('401 No auth credentials found'), { status: 401 });
const throttled = () => Object.assign(new Error('429 slow down'), { status: 429 });

function stub(behaviour: 'ok' | (() => Error)): LlmService {
  return {
    providerName: 'openai',
    defaultModel: 'm',
    supportsNativeTools: false,
    complete: async () => {
      if (behaviour !== 'ok') throw behaviour();
      return 'fine';
    },
    async *stream() {
      if (behaviour !== 'ok') throw behaviour();
      yield { type: 'text', text: 'fine' } as never;
    },
  };
}

describe('own-key health (ADR 0252)', () => {
  let db: Kysely<DB>;
  let userId: string;

  const row = () =>
    db
      .selectFrom('users')
      .select(['byok_key_issue', 'byok_key_issue_at', 'byok_key_nudged_at'])
      .where('id', '=', userId)
      .executeTakeFirstOrThrow();
  const settle = settleBackgroundWork;
  const nudges = () =>
    db
      .selectFrom('messages')
      .select(['body', 'proactive_kind', 'group_id'])
      .where('proactive_kind', '=', 'byok_key_issue')
      .execute();
  const ageIssue = (ms: number) =>
    db
      .updateTable('users')
      .set({ byok_key_issue_at: new Date(Date.now() - ms).toISOString() })
      .where('id', '=', userId)
      .execute();

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'keyholder');
    await ensurePersonalGroup(db, userId);
    await db
      .updateTable('users')
      .set({
        model_provider: 'openai',
        model_name: 'openai/gpt-5',
        model_base_url: 'https://openrouter.ai/api/v1',
        model_key_ciphertext: Buffer.from('c'),
        model_key_iv: Buffer.from('i'),
        model_key_tag: Buffer.from('t'),
      })
      .where('id', '=', userId)
      .execute();
  });
  afterEach(async () => closeTestDb(db));

  it('records a key that is out of credit or rejected, and rethrows the error untouched', async () => {
    const llm = withKeyHealth(stub(empty), db, userId, false);
    await expect(llm.complete([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({ status: 402 });
    await settle();
    expect((await row()).byok_key_issue).toBe('credit');

    const bad = withKeyHealth(stub(rejected), db, userId, true);
    await expect(bad.complete([{ role: 'user', content: 'hi' }])).rejects.toMatchObject({ status: 401 });
    await settle();
    // A different outage: it restarts, so the user is told again.
    expect(await row()).toMatchObject({ byok_key_issue: 'auth', byok_key_nudged_at: null });
  });

  it('streams fail the same way, and a rate limit is not the key\'s fault', async () => {
    const llm = withKeyHealth(stub(empty), db, userId, false);
    await expect(
      (async () => {
        for await (const _ of llm.stream([{ role: 'user', content: 'hi' }])) void _;
      })(),
    ).rejects.toMatchObject({ status: 402 });
    await settle();
    expect((await row()).byok_key_issue).toBe('credit');

    await clearByokKeyIssue(db, userId);
    await expect(
      withKeyHealth(stub(throttled), db, userId, false).complete([{ role: 'user', content: 'hi' }]),
    ).rejects.toMatchObject({ status: 429 });
    await settle();
    expect((await row()).byok_key_issue).toBeNull();
  });

  it('a call that works clears the outage', async () => {
    await noteByokKeyFailure(db, userId, empty());
    const llm = withKeyHealth(stub('ok'), db, userId, true);
    expect(await llm.complete([{ role: 'user', content: 'hi' }])).toBe('fine');
    await settle();
    expect(await row()).toMatchObject({ byok_key_issue: null, byok_key_issue_at: null, byok_key_nudged_at: null });
  });

  it('a user with no key of their own is never flagged', async () => {
    const other = await createUser(db, 'systemkey');
    await noteByokKeyFailure(db, other, empty());
    const r = await db.selectFrom('users').select('byok_key_issue').where('id', '=', other).executeTakeFirstOrThrow();
    expect(r.byok_key_issue).toBeNull();
  });

  it('tells the user once, in their own chat, with a way to fix it', async () => {
    await noteByokKeyFailure(db, userId, empty());

    // Too soon: the chat reply to a failed turn gets first claim.
    expect(await sweepByokKeyNudges(db)).toBe(0);
    await ageIssue(60_000);
    expect(await sweepByokKeyNudges(db)).toBe(1);

    const posted = await nudges();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toMatch(/OpenRouter API key is out of credits/);
    expect(posted[0]!.body).toMatch(/openrouter\.ai\/credits/);
    expect(posted[0]!.body).toMatch(/can't answer your messages, sort your email.*morning briefing/);
    const personal = await ensurePersonalGroup(db, userId);
    expect(posted[0]!.group_id).toBe(personal.id);
    const card = await db.selectFrom('message_cards').select('cards_json').executeTakeFirstOrThrow();
    const cards = JSON.parse(card.cards_json) as Array<{ title: string; appUrl: string }>;
    // Said in the provider's terms - it is their key, not a charge from Chord.
    expect(cards[0]).toMatchObject({ title: 'Add credits to your key', appUrl: 'chord://settings?open=model' });
    // Billing is off, so there is no plan; Chord's own AI is the other way out.
    expect(cards.map((c) => c.title)).toEqual(['Add credits to your key', "Use Chord's AI instead"]);

    // Another failure of the same kind, another sweep: nothing more.
    await noteByokKeyFailure(db, userId, empty());
    await ageIssue(120_000);
    expect(await sweepByokKeyNudges(db)).toBe(0);
    expect(await maybeNudgeByokKeyIssue(db, userId)).toBe(false);
    expect(await nudges()).toHaveLength(1);
  });

  it('where Chord plans exist, the nudge also offers one', async () => {
    (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = true;
    try {
      await noteByokKeyFailure(db, userId, empty());
      await ageIssue(60_000);
      expect(await sweepByokKeyNudges(db)).toBe(1);
      const card = await db.selectFrom('message_cards').select('cards_json').executeTakeFirstOrThrow();
      const cards = JSON.parse(card.cards_json) as Array<{ title: string; appUrl: string }>;
      expect(cards.map((c) => c.title)).toEqual(['Add credits to your key', 'Use a Chord plan instead']);
      expect(cards[1]!.appUrl).toBe('chord://settings?open=plan');
      expect((await getByokKeyIssue(db, userId))?.fallback).toBe('plan');
    } finally {
      (env as { BILLING_ENABLED: boolean }).BILLING_ENABLED = false;
    }
  });

  it('a chat reply that already told them claims the outage, so the nudge does not repeat it', async () => {
    await noteByokKeyFailure(db, userId, empty());
    await markByokKeyNudged(db, userId);
    await ageIssue(60_000);
    expect(await sweepByokKeyNudges(db)).toBe(0);
    expect(await nudges()).toHaveLength(0);
  });

  it('after the key is fixed and fails again, they are told again', async () => {
    await noteByokKeyFailure(db, userId, empty());
    await ageIssue(60_000);
    await sweepByokKeyNudges(db);
    await clearByokKeyIssue(db, userId);
    await noteByokKeyFailure(db, userId, empty());
    await ageIssue(60_000);
    expect(await sweepByokKeyNudges(db)).toBe(1);
    expect(await nudges()).toHaveLength(2);
  });

  it('shows up where the app looks: billing status and nothing when healthy', async () => {
    expect((await getBillingStatus(db, userId)).byokKeyIssue).toBeUndefined();
    await noteByokKeyFailure(db, userId, empty());
    const status = await getBillingStatus(db, userId);
    expect(status.byokKeyIssue).toMatchObject({
      kind: 'credit',
      topUpUrl: 'https://openrouter.ai/credits',
    });
    expect(status.byokKeyIssue!.message).toMatch(/OpenRouter/);
  });
});
