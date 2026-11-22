/**
 * ADR 0067 — flagship cross-user messaging. Exercises `ensurePairGroup` and the
 * `message_user` tool through the real executor: resolve a contact → consent
 * check → deliver into a find-or-created pair group. Confirms the tool returns
 * the recipient NAME (no pair-group id) so ADR 0032's scrubber leaves it intact.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { blockUser } from '@/services/blocks.service.js';
import { createGroup, ensurePairGroup } from '@/services/groups.service.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

async function linkContact(
  db: Kysely<DB>,
  owner: string,
  name: string,
  chordUserId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .insertInto('contact_links')
    .values({
      id: newId('cl'),
      owner_user_id: owner,
      contact_name: name,
      phone_hash: `hash_${chordUserId}`,
      chord_user_id: chordUserId,
      created_at: now,
      updated_at: now,
    })
    .execute();
}

function callMessageUser(db: Kysely<DB>, groupId: string, sender: string, recipientName: string) {
  return applyToolCall(db, {
    groupId,
    actorUserId: sender,
    provenance: null,
    call: { name: 'message_user', args: { recipientName, body: 'Want to grab coffee at 11?' } },
  });
}

describe('ensurePairGroup (ADR 0067)', () => {
  let db: Kysely<DB>;
  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('find-or-creates one 2-member group regardless of who initiates', async () => {
    const a = await createUser(db, 'alice');
    const b = await createUser(db, 'bob');

    const g1 = await ensurePairGroup(db, a, b);
    const g2 = await ensurePairGroup(db, b, a); // reversed order → same group
    expect(g2.id).toBe(g1.id);

    const members = await db
      .selectFrom('group_members')
      .select('user_id')
      .where('group_id', '=', g1.id)
      .execute();
    expect(new Set(members.map((m) => m.user_id))).toEqual(new Set([a, b]));
  });
});

describe('message_user tool (ADR 0067)', () => {
  let db: Kysely<DB>;
  let sender: string;
  let recipient: string;
  let personal: string;
  beforeEach(async () => {
    db = await openTestDb();
    sender = await createUser(db, 'john', 'John');
    recipient = await createUser(db, 'adrian', 'Adrian');
    personal = (await createGroup(db, { name: 'John', kind: 'personal', createdBy: sender })).id;
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('delivers to a resolved contact via a pair group and returns the name (no groupId)', async () => {
    await linkContact(db, sender, 'Adrian', recipient);

    const res = await callMessageUser(db, personal, sender, 'Adrian');
    expect(res.data).toMatchObject({ ok: true, recipient: 'Adrian' });
    // Scrubber-safe: no group id leaked in the result.
    expect(JSON.stringify(res.data)).not.toContain('g_');

    // The message landed in the 2-member pair group.
    const msg = await db
      .selectFrom('messages')
      .selectAll()
      .where('sender_id', '=', sender)
      .where('body', 'like', '%coffee%')
      .executeTakeFirstOrThrow();
    const members = await db
      .selectFrom('group_members')
      .select('user_id')
      .where('group_id', '=', msg.group_id)
      .execute();
    expect(new Set(members.map((m) => m.user_id))).toEqual(new Set([sender, recipient]));
    expect(msg.group_id).not.toBe(personal); // not the sender's own 1:1
  });

  it('attaches a calendar invite that fans out to both people', async () => {
    await linkContact(db, sender, 'Adrian', recipient);

    const res = await applyToolCall(db, {
      groupId: personal,
      actorUserId: sender,
      provenance: null,
      call: {
        name: 'message_user',
        args: {
          recipientName: 'Adrian',
          body: 'Coffee at 11?',
          event: { title: 'Coffee', startsAt: '2026-07-01T11:00:00-04:00' },
        },
      },
    });
    expect(res.data).toMatchObject({ ok: true, recipient: 'Adrian', eventCreated: true });

    // The event exists as an owner copy for BOTH members of the pair group.
    const owners = await db
      .selectFrom('events')
      .select('owner_user_id')
      .where('title', '=', 'Coffee')
      .execute();
    expect(new Set(owners.map((o) => o.owner_user_id))).toEqual(new Set([sender, recipient]));
  });

  it('runs the invite as create_event: a past date sends nothing and asks, and the yes sends it once', async () => {
    // "text Adrian coffee Friday 11am" said on a Saturday: the model wrote
    // last Friday. `create_event` refuses that and asks (ADR 0100); this
    // path called createEvent itself and filed it with no question.
    await linkContact(db, sender, 'Adrian', recipient);
    const lastWeek = new Date(Date.now() - 8 * 86_400_000).toISOString().slice(0, 10);
    const send = (turnId: string, confirmPast?: boolean) =>
      applyToolCall(db, {
        groupId: personal,
        actorUserId: sender,
        provenance: null,
        turnId,
        tzOffset: '+00:00',
        call: {
          name: 'message_user',
          args: {
            recipientName: 'Adrian',
            body: 'Coffee at 11?',
            event: { title: 'Coffee', startsAt: `${lastWeek}T11:00:00+00:00`, ...(confirmPast ? { confirmPast } : {}) },
          },
        },
      });
    const coffees = () => db.selectFrom('events').select('owner_user_id').where('title', '=', 'Coffee').execute();
    const sent = () =>
      db.selectFrom('messages').select('id').where('sender_id', '=', sender).where('body', '=', 'Coffee at 11?').execute();

    const refused = await send('turn_1');
    expect(refused.data).toMatchObject({ ok: false, reason: 'past', recipient: 'Adrian' });
    expect(refused.summary).toContain('NOTHING was sent');
    expect(await coffees()).toHaveLength(0);
    expect(await sent()).toHaveLength(0);

    // The user said yes on the next turn.
    const confirmed = await send('turn_2', true);
    expect(confirmed.data).toMatchObject({ ok: true, eventCreated: true });
    expect(new Set((await coffees()).map((o) => o.owner_user_id))).toEqual(new Set([sender, recipient]));
    expect(await sent()).toHaveLength(1);
  });

  it('refuses an unknown contact', async () => {
    const res = await callMessageUser(db, personal, sender, 'Nobody');
    expect(res.data).toMatchObject({ ok: false, reason: 'not_found' });
    const count = await db.selectFrom('messages').select((e) => e.fn.countAll<number>().as('n')).executeTakeFirst();
    expect(Number(count?.n ?? 0)).toBe(0);
  });

  it('refuses when the recipient has blocked the sender', async () => {
    await linkContact(db, sender, 'Adrian', recipient);
    await blockUser(db, recipient, sender);
    const res = await callMessageUser(db, personal, sender, 'Adrian');
    expect(res.data).toMatchObject({ ok: false, reason: 'blocked' });
  });

  it('asks which one when the name is ambiguous', async () => {
    const other = await createUser(db, 'adrian2', 'Adrian');
    await linkContact(db, sender, 'Adrian', recipient);
    await linkContact(db, sender, 'Adrian', other);
    const res = await callMessageUser(db, personal, sender, 'Adrian');
    expect(res.data).toMatchObject({ ok: false, reason: 'ambiguous' });
  });
});
