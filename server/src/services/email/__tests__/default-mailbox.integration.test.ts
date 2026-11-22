/**
 * ADR 0255 — "send my emails from Outlook". New mail always left from the
 * primary Gmail when Chord could send from it; there was nowhere to say
 * otherwise. The choice is stored per user and set in chat only.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { PERSONAL_ONLY_TOOL_NAMES } from '@/services/bot/tools.js';
import { resolveSendMailbox, setDefaultMailbox } from '@/services/email/default-mailbox.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { listProposalsForGroup } from '@/services/proposals.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('default sending mailbox (ADR 0255)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let personalId: string;
  let priorProvider: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'john');
    await db.updateTable('users').set({ email: 'ownertest@gmail.com' }).where('id', '=', userId).execute();
    personalId = (await ensurePersonalGroup(db, userId)).id;
    // 'mock' = Chord may send from the primary Gmail, without a real token.
    priorProvider = env.GMAIL_PROVIDER;
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = 'mock';
  });
  afterEach(async () => {
    (env as { GMAIL_PROVIDER: string }).GMAIL_PROVIDER = priorProvider;
    await closeTestDb(db);
  });

  const addAccount = async (
    provider: 'gmail' | 'outlook' | 'imap',
    address: string,
    extra: { nickname?: string; status?: 'ok' | 'reconnect'; preset_key?: string } = {},
  ): Promise<string> => {
    const id = newId('ea');
    const now = new Date().toISOString();
    await db
      .insertInto('email_accounts')
      .values({
        id,
        user_id: userId,
        provider,
        email_address: address,
        created_at: now,
        updated_at: now,
        ...extra,
      } as never)
      .execute();
    return id;
  };

  const say = (mailbox?: string, groupId = personalId) =>
    applyToolCall(db, {
      groupId,
      actorUserId: userId,
      provenance: null,
      call: { name: 'set_default_mailbox', args: mailbox === undefined ? {} : { mailbox } },
    });

  it('new mail from chat leaves from the mailbox the user chose', async () => {
    const outlook = await addAccount('outlook', 'ownertest@outlook.com');
    expect((await resolveSendMailbox(db, userId))?.accountId).toBeNull();

    const res = await say('Outlook');
    expect(res.data).toMatchObject({ ok: true, address: 'ownertest@outlook.com' });

    await applyToolCall(db, {
      groupId: personalId,
      actorUserId: userId,
      provenance: null,
      mode: 'commit',
      call: {
        name: 'compose_email',
        args: { to: ['chen@school.org'], subject: 'Pickup', body: 'Running late.' },
      },
    });
    const draft = await db
      .selectFrom('email_drafts')
      .select('account_id')
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(draft.account_id).toBe(outlook);
  });

  it('resolves "my Outlook email", an address and a nickname', async () => {
    const yahoo = await addAccount('imap', 'family@yahoo.com', { nickname: 'Family', preset_key: 'yahoo' });
    await addAccount('outlook', 'ownertest@outlook.com');

    expect(await setDefaultMailbox(db, userId, 'Family')).toMatchObject({ ok: true, mailbox: { accountId: yahoo } });
    expect(await setDefaultMailbox(db, userId, 'my Outlook email')).toMatchObject({
      ok: true,
      mailbox: { address: 'ownertest@outlook.com' },
    });
    expect(await setDefaultMailbox(db, userId, 'family@yahoo.com')).toMatchObject({
      ok: true,
      mailbox: { accountId: yahoo },
    });
    expect(await setDefaultMailbox(db, userId, 'yahoo')).toMatchObject({ ok: true, mailbox: { accountId: yahoo } });
  });

  it('asks when the name fits two mailboxes, and stores nothing', async () => {
    const second = await addAccount('gmail', 'owner.work@gmail.com');
    await setDefaultMailbox(db, userId, 'owner.work@gmail.com');

    const res = await say('Gmail');

    expect(res.data).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect((res.data as { candidates: unknown[] }).candidates).toHaveLength(2);
    expect((await resolveSendMailbox(db, userId))?.accountId).toBe(second);
  });

  it('refuses a mailbox that needs reconnecting', async () => {
    await addAccount('outlook', 'ownertest@outlook.com', { status: 'reconnect' });

    const res = await say('Outlook');

    expect(res.data).toMatchObject({ ok: false, reason: 'needs_reconnect' });
    expect((await resolveSendMailbox(db, userId))?.accountId).toBeNull();
  });

  it('writes nothing for a name no mailbox has', async () => {
    expect((await say('Hotmail')).data).toEqual({ ok: false, reason: 'not_found' });
  });

  it('falls back to the built-in rule once the chosen mailbox is gone', async () => {
    const outlook = await addAccount('outlook', 'ownertest@outlook.com');
    await say('Outlook');
    await db.deleteFrom('email_accounts').where('id', '=', outlook).execute();

    expect((await resolveSendMailbox(db, userId))?.accountId).toBeNull();
  });

  it('an empty name clears the choice; no name reads it', async () => {
    await addAccount('outlook', 'ownertest@outlook.com');
    await say('Outlook');
    expect((await say()).data).toMatchObject({ ok: true, read: true, chosen: true, address: 'ownertest@outlook.com' });

    await say('');
    expect((await say()).data).toMatchObject({ ok: true, chosen: false, address: 'ownertest@gmail.com' });
  });

  it('is offered in the personal chat only', () => {
    expect(PERSONAL_ONLY_TOOL_NAMES.has('set_default_mailbox')).toBe(true);
  });

  describe('the compose card names its sender', () => {
    const late = { to: ['alice@example.com'], subject: 'Running late', body: "I'm running late." };
    const compose = (mode: 'propose' | 'commit', args: Record<string, unknown> = late) =>
      applyToolCall(db, {
        groupId: personalId,
        actorUserId: userId,
        provenance: null,
        mode,
        call: { name: 'compose_email', args } as never,
      });
    const stagedArgs = async (): Promise<Record<string, unknown>> => {
      const [p] = await listProposalsForGroup(db, personalId);
      return JSON.parse(p.argsJson) as Record<string, unknown>;
    };
    const draftAccount = async (): Promise<string | null> =>
      (
        await db
          .selectFrom('email_drafts')
          .select('account_id')
          .where('user_id', '=', userId)
          .executeTakeFirstOrThrow()
      ).account_id ?? null;

    it('shows the default mailbox on the card and sends from it', async () => {
      const outlook = await addAccount('outlook', 'ownertest@outlook.com');
      await say('Outlook');

      const res = await compose('propose');
      expect(res.card?.meta).toContain('from ownertest@outlook.com');

      await compose('commit', await stagedArgs());
      expect(await draftAccount()).toBe(outlook);
    });

    it('sends from the mailbox the card showed, even if the default changed after', async () => {
      const outlook = await addAccount('outlook', 'ownertest@outlook.com');
      await say('Outlook');
      await compose('propose');
      await say('');

      await compose('commit', await stagedArgs());
      expect(await draftAccount()).toBe(outlook);
    });

    it('refuses rather than switching sender when that mailbox stopped working', async () => {
      const outlook = await addAccount('outlook', 'ownertest@outlook.com');
      await say('Outlook');
      await compose('propose');
      await db.updateTable('email_accounts').set({ status: 'reconnect' }).where('id', '=', outlook).execute();

      const res = await compose('commit', await stagedArgs());
      expect(res.data).toMatchObject({ sent: false, reason: 'mailbox_unavailable' });
      expect(
        await db.selectFrom('email_drafts').select('id').where('user_id', '=', userId).execute(),
      ).toHaveLength(0);
    });
  });
});
