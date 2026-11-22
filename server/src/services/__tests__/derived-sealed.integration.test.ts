/**
 * Suggestions mined from mail, drafts, and meeting summaries sealed at rest
 * (ADR 0201, phase 4), and the backfill that seals what already exists. Each is
 * read back through the ordinary service functions, because that is what the
 * rest of the product calls.
 */
import { Kysely, sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { contentCrypto, isSealedText, sealedOwner, setContentEncryption } from '@/db/crypto/index.js';
import type { DB } from '@/db/schema.js';
import { saveDraft, getDraft, listDrafts } from '@/services/email/drafts.service.js';
import { createEvent } from '@/services/events.service.js';
import { buildAndStoreMeetingContext, type CorrespondenceSummarizer } from '@/services/events/meeting-context.js';
import { countPlaintextDerived, sealExistingDerived } from '@/services/encryption/backfill-derived.js';
import { createGroup, ensurePersonalGroup } from '@/services/groups.service.js';
import { createProposal, getProposal, listProposalsForUser } from '@/services/proposals.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { seedSyncedMail } from '@/__test-helpers__/email-seeds.js';

let db: Kysely<DB>;
let raw: Kysely<DB>;
let userId: string;
let groupId: string;

beforeEach(async () => {
  db = await openTestDb();
  raw = contentCrypto().raw;
  userId = await createUser(db, 'alice');
  groupId = (await ensurePersonalGroup(db, userId)).id;
  setContentEncryption(true);
});
afterEach(async () => {
  await closeTestDb(db);
});

const ARGS = { title: 'Sign the ZEBRAFORM permission slip', dueAt: '2026-10-01T00:00:00.000Z', details: 'Ms Quagmire needs it back' };

describe('suggestions mined from mail', () => {
  const propose = (provenance: string | null) =>
    createProposal(db, {
      groupId,
      proposedByUserId: userId,
      proposedByMessageId: null,
      toolName: 'create_task',
      args: ARGS,
      provenance,
    });

  it('the arguments are sealed under the person it was proposed to', async () => {
    const p = await propose('gmail:thread-1');
    const row = await raw.selectFrom('proposals').select('args_json').where('id', '=', p.id).executeTakeFirstOrThrow();
    expect(isSealedText(row.args_json)).toBe(true);
    expect(sealedOwner(row.args_json)).toBe(userId);
    expect(row.args_json).not.toContain('ZEBRAFORM');
  });

  it('every reader gets the arguments back exactly', async () => {
    const p = await propose('gmail:thread-1');
    expect(JSON.parse(p.argsJson)).toEqual(ARGS); // the value returned by create
    expect(JSON.parse((await getProposal(db, p.id))!.argsJson)).toEqual(ARGS);
    const listed = (await listProposalsForUser(db, userId)).find((x) => x.id === p.id);
    expect(JSON.parse(listed!.argsJson)).toEqual(ARGS);
  });

  it('a suggestion made in chat is not sealed (it is chat content, and chat is not sealed)', async () => {
    const p = await propose(null);
    const row = await raw.selectFrom('proposals').select('args_json').where('id', '=', p.id).executeTakeFirstOrThrow();
    expect(isSealedText(row.args_json)).toBe(false);
  });

  it('encryption off writes the arguments as before', async () => {
    setContentEncryption(false);
    const p = await propose('gmail:thread-2');
    const row = await raw.selectFrom('proposals').select('args_json').where('id', '=', p.id).executeTakeFirstOrThrow();
    expect(JSON.parse(row.args_json)).toEqual(ARGS);
  });

  it('provenance stays readable, so retracting a deleted email’s suggestions still works', async () => {
    const p = await propose('gmail:thread-9');
    const row = await raw.selectFrom('proposals').select('provenance').where('id', '=', p.id).executeTakeFirstOrThrow();
    expect(row.provenance).toBe('gmail:thread-9');
  });
});

describe('drafts', () => {
  it('subject and body are sealed, and read back exactly through every reader', async () => {
    const d = await saveDraft(db, userId, { kind: 'new', to: ['a@b.example'], subject: 'Quarterly ZEBRA review', body: 'The wombat plan is secret' });

    const row = await raw.selectFrom('email_drafts').select(['subject', 'body', 'to_emails']).where('id', '=', d.id).executeTakeFirstOrThrow();
    expect(isSealedText(row.subject) && isSealedText(row.body)).toBe(true);
    expect(`${row.subject}${row.body}`).not.toContain('wombat');
    expect(d.subject).toBe('Quarterly ZEBRA review'); // what save returns
    expect((await getDraft(db, userId, d.id))!.body).toBe('The wombat plan is secret');
    expect((await listDrafts(db, userId))[0]!.subject).toBe('Quarterly ZEBRA review');
  });

  it('an empty subject or body stays empty, so a blank draft is still blank', async () => {
    const d = await saveDraft(db, userId, { kind: 'new', to: ['a@b.example'], subject: '', body: 'only a body' });
    const row = await raw.selectFrom('email_drafts').select('subject').where('id', '=', d.id).executeTakeFirstOrThrow();
    expect(row.subject).toBe('');
  });

  it('saving again updates the same draft and reseals it', async () => {
    const d = await saveDraft(db, userId, { kind: 'new', to: [], subject: 'First', body: 'one' });
    await saveDraft(db, userId, { id: d.id, kind: 'new', to: [], subject: 'Second', body: 'two' });

    expect((await listDrafts(db, userId))).toHaveLength(1);
    expect((await getDraft(db, userId, d.id))!.subject).toBe('Second');
    const row = await raw.selectFrom('email_drafts').select('body').where('id', '=', d.id).executeTakeFirstOrThrow();
    expect(isSealedText(row.body)).toBe(true);
  });
});

describe('meeting summaries', () => {
  it('the summary is sealed under the user who built it, and reads back through the event', async () => {
    const summarizer: CorrespondenceSummarizer = async () => 'discussing the ZEBRA launch plan';
    await seedSyncedMail(db, userId, { subject: 'Launch', snippet: 'plan', fromEmail: 'kevin@corp.example' });
    await raw.updateTable('email_messages').set({ to_emails: JSON.stringify(['kevin@corp.example']) }).execute();
    const group = (await createGroup(db, { name: 'Fam', kind: 'group', createdBy: userId })).id;
    const ev = await createEvent(db, { groupId: group, title: 'Meeting with Kevin', startsAt: new Date(Date.now() + 86_400_000).toISOString(), createdBy: userId });

    await buildAndStoreMeetingContext(db, userId, ev.id, ['kevin@corp.example'], summarizer);

    const row = await raw.selectFrom('events').select('meeting_context').where('id', '=', ev.id).executeTakeFirstOrThrow();
    expect(isSealedText(row.meeting_context)).toBe(true);
    expect(row.meeting_context).not.toContain('ZEBRA');
    const read = await db.selectFrom('events').select('meeting_context').where('id', '=', ev.id).executeTakeFirstOrThrow();
    expect(read.meeting_context).toBe('discussing the ZEBRA launch plan');
  });
});

describe('sealing what already exists', () => {
  async function legacyRows() {
    setContentEncryption(false);
    const p = await createProposal(db, { groupId, proposedByUserId: userId, proposedByMessageId: null, toolName: 'create_task', args: ARGS, provenance: 'gmail:legacy-1' });
    const chat = await createProposal(db, { groupId, proposedByUserId: userId, proposedByMessageId: null, toolName: 'create_task', args: ARGS, provenance: null });
    const d = await saveDraft(db, userId, { kind: 'new', to: [], subject: 'Old subject', body: 'old body' });
    setContentEncryption(true);
    return { p, chat, d };
  }

  it('seals mail-derived proposals and drafts, leaves chat proposals, and everything still reads back', async () => {
    const { p, chat, d } = await legacyRows();
    expect((await countPlaintextDerived(db)).total).toBeGreaterThan(0);

    const r = await sealExistingDerived(db);

    expect(r).toMatchObject({ proposals: 1, drafts: 1, failed: 0 });
    expect((await countPlaintextDerived(db)).total).toBe(0);
    const rows = await raw.selectFrom('proposals').select(['id', 'args_json']).execute();
    const by = Object.fromEntries(rows.map((x) => [x.id, x.args_json]));
    expect(isSealedText(by[p.id])).toBe(true);
    expect(isSealedText(by[chat.id])).toBe(false);
    expect(JSON.parse((await getProposal(db, p.id))!.argsJson)).toEqual(ARGS);
    expect((await getDraft(db, userId, d.id))!.subject).toBe('Old subject');
  });

  it('is idempotent, and a dry run changes nothing', async () => {
    await legacyRows();
    const before = await raw.selectFrom('proposals').select('args_json').orderBy('id').execute();

    const dry = await sealExistingDerived(db, { dryRun: true });
    expect(dry.proposals).toBe(1);
    expect(await raw.selectFrom('proposals').select('args_json').orderBy('id').execute()).toEqual(before);

    await sealExistingDerived(db);
    const again = await sealExistingDerived(db);
    expect(again).toMatchObject({ attachments: 0, chunks: 0, proposals: 0, drafts: 0, meetings: 0, failed: 0 });
  });

  it('countPlaintextDerived reports zero on an empty database and names what it counts', async () => {
    const c = await countPlaintextDerived(db);
    expect(c.total).toBe(0);
    expect(Object.keys(c.counts)).toEqual(
      expect.arrayContaining(['attachments.extracted_text', 'attachment_chunks.content', 'proposals.args_json (mail)', 'email_drafts', 'events.meeting_context']),
    );
    void sql;
  });
});
