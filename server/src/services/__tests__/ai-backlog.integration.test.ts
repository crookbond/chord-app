/**
 * AI work held back for consent (ADR 0283) or allowance (ADR 0079/0325) is
 * run once both are met, never before. Before this, work that happens once -
 * a file's summary and filing at upload, the model pass over an imported
 * chat, a meeting's context after an email card is confirmed, the memory pass
 * over a message - was refused and then simply lost: agreeing to AI or buying
 * tokens later never brought it back.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import AdmZip from 'adm-zip';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { setAiConsent } from '@/services/ai-consent.service.js';
import { drainAiBacklog } from '@/services/ai-backlog.service.js';
import { AI_BACKLOG_RUNNERS } from '@/services/ai-backlog-runners.js';
import { saveFile } from '@/services/attachments.service.js';
import { awaitPendingBotReactions, passivelyExtractFromMessage } from '@/services/bot/bot.service.js';
import { buildAndStoreMeetingContext } from '@/services/events/meeting-context.js';
import { createGroup } from '@/services/groups.service.js';
import { importWhatsAppZip } from '@/services/ingest/whatsapp/pipeline.js';
import { __resetLlmCacheForTests, __setLlmForTests } from '@/services/llm/factory.js';
import type { LlmService } from '@/services/llm/types.js';
import { rowToMessage } from '@/services/messages.service.js';
import { settleBackgroundWork } from '@/utils/background.js';
import { newId } from '@/utils/ids.js';

let calls = 0;
const chordModel: LlmService = {
  providerName: 'openai',
  defaultModel: 'chord-model',
  supportsNativeTools: false,
  async complete(_m, o) {
    calls += 1;
    o?.onUsage?.({ promptTokens: 50, completionTokens: 10 });
    return '{"calls":[],"facts":[]}';
  },
  // eslint-disable-next-line require-yield
  async *stream() {
    throw new Error('not used');
  },
};

const e = env as { AI_CONSENT_REQUIRED: boolean; BILLING_ENABLED: boolean; FREE_TOKEN_ALLOWANCE: number };
let was: { consent: boolean; billing: boolean; free: number };
let tmpData: string;
let prevDataDir: string | undefined;
let prevFilesDir: string | undefined;
let db: Kysely<DB>;
let userId: string;
let groupId: string;

beforeEach(async () => {
  tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'chord-ai-backlog-'));
  prevDataDir = process.env.DATA_DIR;
  prevFilesDir = process.env.FILES_DIR;
  process.env.DATA_DIR = tmpData;
  process.env.FILES_DIR = path.join(tmpData, 'files');
  db = await openTestDb();
  userId = await createUser(db, 'backlog', 'John');
  groupId = (await createGroup(db, { name: 'Family', kind: 'group', createdBy: userId })).id;
  was = { consent: e.AI_CONSENT_REQUIRED, billing: e.BILLING_ENABLED, free: e.FREE_TOKEN_ALLOWANCE };
  e.AI_CONSENT_REQUIRED = true;
  calls = 0;
  __setLlmForTests(chordModel);
});
afterEach(async () => {
  await settleBackgroundWork();
  e.AI_CONSENT_REQUIRED = was.consent;
  e.BILLING_ENABLED = was.billing;
  e.FREE_TOKEN_ALLOWANCE = was.free;
  __resetLlmCacheForTests();
  await closeTestDb(db);
  if (prevDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = prevDataDir;
  if (prevFilesDir === undefined) delete process.env.FILES_DIR;
  else process.env.FILES_DIR = prevFilesDir;
  fs.rmSync(tmpData, { recursive: true, force: true });
});

const agree = () => setAiConsent(db, userId, { decision: 'granted', ageConfirmed: true, recipient: 'Test model' });
const backlog = () => db.selectFrom('ai_backlog').select(['kind', 'ref', 'payload']).where('user_id', '=', userId).execute();
const drain = () => drainAiBacklog(db, AI_BACKLOG_RUNNERS);

async function uploadNote(): Promise<string> {
  const att = await saveFile(db, {
    scope: { kind: 'group', groupId },
    uploadedBy: userId,
    filename: 'field-trip.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Field trip to the science museum on Friday. Permission slip due Wednesday.'),
    awaitExtraction: true,
  });
  return att.id;
}

describe('held-back AI work', () => {
  it('a file uploaded before consent is kept searchable, then summarized once the user agrees', async () => {
    const id = await uploadNote();
    expect(calls).toBe(0);
    const row = await db.selectFrom('attachments').select(['summary', 'extracted_text', 'indexed_at']).where('id', '=', id).executeTakeFirstOrThrow();
    expect(row.indexed_at).not.toBeNull();
    expect(row.summary).toBeNull();
    expect(await backlog()).toEqual([{ kind: 'attachment', ref: id, payload: null }]);

    // Still no consent: the catch-up pass reads nothing.
    await drain();
    expect(calls).toBe(0);
    expect(await backlog()).toHaveLength(1);

    await agree();
    await drain();
    expect(calls).toBeGreaterThan(0);
    expect(await backlog()).toHaveLength(0);
    const after = await db.selectFrom('attachments').select('summary').where('id', '=', id).executeTakeFirstOrThrow();
    expect(after.summary).not.toBeNull();
  });

  it('out of tokens: the work waits until the allowance is back', async () => {
    await agree();
    e.BILLING_ENABLED = true;
    e.FREE_TOKEN_ALLOWANCE = 0;
    const id = await uploadNote();
    expect(calls).toBe(0);
    expect((await backlog()).map((b) => b.ref)).toEqual([id]);

    await drain();
    expect(calls).toBe(0);
    expect(await backlog()).toHaveLength(1);

    e.FREE_TOKEN_ALLOWANCE = 10_000_000;
    await drain();
    expect(calls).toBeGreaterThan(0);
    expect(await backlog()).toHaveLength(0);
  });

  it('a message read for memory only once its sender agrees', async () => {
    const msg = {
      id: newId('m'),
      group_id: groupId,
      sender_id: userId,
      kind: 'text' as const,
      body: 'Ben is allergic to peanuts',
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
      is_proactive: 0,
    };
    await db.insertInto('messages').values(msg).execute();
    passivelyExtractFromMessage(db, rowToMessage(msg as never), { id: groupId, kind: 'group' });
    await awaitPendingBotReactions();
    expect(calls).toBe(0);
    expect(await backlog()).toEqual([{ kind: 'memory_message', ref: msg.id, payload: null }]);

    await agree();
    await drain();
    expect(calls).toBeGreaterThan(0);
    expect(await backlog()).toHaveLength(0);
  });

  it("a meeting's context is queued with its guests, not dropped", async () => {
    await buildAndStoreMeetingContext(db, userId, 'ev_1', ['tom@neuralads.example']);
    expect(calls).toBe(0);
    const rows = await backlog();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('meeting_context');
    expect(JSON.parse(rows[0]!.payload!)).toEqual({ attendeeEmails: ['tom@neuralads.example'] });
  });

  it('an imported chat is read from its stored messages once the uploader agrees', async () => {
    const zip = new AdmZip();
    zip.addFile(
      '_chat.txt',
      Buffer.from(
        ['[14/03/2024, 09:16:00] Alice: dinner at ours on Saturday at 7', '[14/03/2024, 09:17:00] Bob: great', ''].join('\n'),
        'utf-8',
      ),
    );
    const result = await importWhatsAppZip(db, { zipBuffer: zip.toBuffer(), uploaderId: userId, groupName: 'Crew' });
    expect(calls).toBe(0);
    expect(await backlog()).toEqual([{ kind: 'whatsapp_import', ref: result.groupId, payload: '{"fromWindow":0}' }]);

    await agree();
    await drain();
    expect(calls).toBeGreaterThan(0);
    expect(await backlog()).toHaveLength(0);
  });
});
