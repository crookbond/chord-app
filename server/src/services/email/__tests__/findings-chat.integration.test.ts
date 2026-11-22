/**
 * ADR 0277 — the Findings tab's own chat. A tapped sample question was posted
 * into the personal chat and the app jumped there, so the answer was read
 * against everything else said in that chat and added to it. These pin the
 * replacement: the model sees only the Findings conversation, nothing is
 * written to the personal chat or broadcast, and only read-only mail tools run.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { findingsChat } from '@/services/email/findings-chat.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import type { LlmChunk, LlmMessage, LlmService, LlmStreamOptions } from '@/services/llm/types.js';
import { sseHub } from '@/services/sse.hub.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, insertMessage, openTestDb } from '@/__test-helpers__/db.js';

interface ScriptedTurn {
  text?: string;
  toolCalls?: Array<{ id: string; name: string; args: unknown }>;
}

function scriptedLlm(
  script: ScriptedTurn[],
  observed: LlmMessage[][],
  offered: string[][] = [],
): LlmService {
  return {
    providerName: 'openai',
    defaultModel: 'scripted',
    supportsNativeTools: true,
    complete: async () => '',
    async *stream(messages: LlmMessage[], opts?: LlmStreamOptions): AsyncIterable<LlmChunk> {
      observed.push(structuredClone(messages));
      offered.push((opts?.tools ?? []).map((t) => t.name));
      const turn = script.shift();
      if (turn?.text) yield { type: 'text', delta: turn.text };
      if (turn?.toolCalls) {
        for (const call of turn.toolCalls) yield { type: 'tool_call', call };
        yield { type: 'done', reason: 'tool_calls' };
        return;
      }
      yield { type: 'done', reason: 'stop' };
    },
  } as unknown as LlmService;
}

/** One message in the user's mailbox from `from`. */
async function mailFrom(db: Kysely<DB>, userId: string, from: string): Promise<void> {
  const now = new Date().toISOString();
  const threadId = newId('et');
  const gid = newId('gt');
  await db
    .insertInto('email_threads')
    .values({ id: threadId, user_id: userId, gmail_thread_id: gid, subject: 'Deals', from_email: from, last_message_at: now, created_at: now, updated_at: now })
    .execute();
  await db
    .insertInto('email_messages')
    .values({
      id: newId('em'),
      user_id: userId,
      thread_id: threadId,
      gmail_thread_id: gid,
      gmail_message_id: newId('gm'),
      from_email: from,
      to_emails: JSON.stringify(['me@example.org']),
      cc_emails: JSON.stringify([]),
      subject: 'Deals',
      snippet: '',
      internal_date: now,
      created_at: now,
    })
    .execute();
}

describe('findingsChat (ADR 0277)', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeTestDb(db);
  });

  it('answers in place, from its own conversation, with read-only tools only', async () => {
    const uid = await createUser(db, 'alice');
    const personal = await ensurePersonalGroup(db, uid);
    await insertMessage(db, {
      groupId: personal.id,
      senderId: uid,
      body: 'remind me to call the plumber about the leak',
    });
    const before = await db
      .selectFrom('messages')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('group_id', '=', personal.id)
      .executeTakeFirstOrThrow();
    const broadcast = vi.spyOn(sseHub, 'broadcast');

    const observed: LlmMessage[][] = [];
    const llm = scriptedLlm(
      [
        {
          toolCalls: [
            { id: 'c1', name: 'create_task', args: { title: 'review Netflix' } },
            { id: 'c2', name: 'query_receipts', args: { recurring: true } },
          ],
        },
        { text: 'No repeating charges in the receipts Chord has.' },
      ],
      observed,
    );

    const out = await findingsChat(
      db,
      uid,
      {
        messages: [
          { role: 'user', text: 'Who emails me most?' },
          { role: 'assistant', text: 'Mostly the school.' },
          { role: 'user', text: 'What am I paying for every month?' },
        ],
        tz: 'America/New_York',
      },
      { llm },
    );

    expect(out.reply).toBe('No repeating charges in the receipts Chord has.');

    // The personal chat's history never reaches the model; this one does.
    const firstPrompt = JSON.stringify(observed[0]);
    expect(firstPrompt).not.toContain('plumber');
    expect(firstPrompt).toContain('Mostly the school.');
    expect(observed[0].at(-1)).toMatchObject({ role: 'user', content: 'What am I paying for every month?' });

    // A write the model reaches for is refused, a read runs.
    const toolResults = observed[1].filter((m) => m.role === 'tool');
    expect(JSON.stringify(toolResults.find((m) => m.toolName === 'create_task'))).toContain('not available');
    expect(JSON.stringify(toolResults.find((m) => m.toolName === 'query_receipts'))).not.toContain('error');
    const tasks = await db.selectFrom('tasks').select('id').execute();
    const proposals = await db.selectFrom('proposals').select('id').execute();
    expect(tasks).toHaveLength(0);
    expect(proposals).toHaveLength(0);

    // Nothing posted to, or streamed into, the personal chat.
    const after = await db
      .selectFrom('messages')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('group_id', '=', personal.id)
      .executeTakeFirstOrThrow();
    expect(Number(after.n)).toBe(Number(before.n));
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('hands a change to the personal chat, naming exactly what it is about', async () => {
    const uid = await createUser(db, 'bob');
    const personal = await ensurePersonalGroup(db, uid);
    await mailFrom(db, uid, 'target@e.target.com');
    const observed: LlmMessage[][] = [];
    const offered: string[][] = [];
    const request = 'Unsubscribe me from the Target mailing list, target@e.target.com';
    const llm = scriptedLlm(
      [
        { toolCalls: [{ id: 'h1', name: 'hand_off_to_chat', args: { request } }] },
        { text: 'Taking you to your chat to unsubscribe from Target.' },
      ],
      observed,
      offered,
    );

    const out = await findingsChat(
      db,
      uid,
      {
        messages: [
          { role: 'user', text: 'What mailing lists am I on?' },
          { role: 'assistant', text: 'Target (target@e.target.com) and Medium.' },
          { role: 'user', text: 'Unsubscribe me from Target' },
        ],
      },
      { llm },
    );

    expect(out.handoff).toEqual({ message: request });
    expect(out.reply).toBe('Taking you to your chat to unsubscribe from Target.');
    // The hand-off is offered; the write it stands in for is not.
    expect(offered[0]).toContain('hand_off_to_chat');
    expect(offered[0]).not.toContain('unsubscribe_from_sender');
    expect(JSON.stringify(observed[1].filter((m) => m.role === 'tool'))).toContain('handedOff');
    // The server posts nothing itself: the app sends the message as the user.
    const posted = await db.selectFrom('messages').select('id').where('group_id', '=', personal.id).execute();
    expect(posted).toHaveLength(0);
  });

  // Prod 2026-10-30 15:35Z: the hand-off posted twelve lists with addresses
  // nobody had seen ("Unsubscribe me from the Macy's mailing list,
  // macys@example.com; ..."), and the chat could match none of them.
  it('refuses a hand-off naming addresses that are not in the user mail, then takes the corrected one', async () => {
    const uid = await createUser(db, 'alice');
    const personal = await ensurePersonalGroup(db, uid);
    await mailFrom(db, uid, 'no-reply@em.macys.com');
    const invented =
      "Unsubscribe me from the Macy's mailing list, macys@example.com; Unsubscribe me from the Amtrak mailing list, amtrak@example.com";
    const fixed = "Unsubscribe me from the Macy's mailing list, no-reply@em.macys.com; Unsubscribe me from the Amtrak mailing list";
    const observed: LlmMessage[][] = [];
    const llm = scriptedLlm(
      [
        { toolCalls: [{ id: 'h1', name: 'hand_off_to_chat', args: { request: invented } }] },
        { toolCalls: [{ id: 'h2', name: 'hand_off_to_chat', args: { request: fixed } }] },
        { text: 'Taking you to your chat to do that.' },
      ],
      observed,
    );

    const out = await findingsChat(
      db,
      uid,
      { messages: [{ role: 'user', text: 'Unsubscribe me from all the ones I never open' }] },
      { llm },
    );

    const first = observed[1].filter((m) => m.role === 'tool').at(-1);
    expect(first?.content).toContain('"handedOff":false');
    expect(first?.content).toContain('macys@example.com');
    expect(first?.content).toContain('amtrak@example.com');
    expect(out.handoff).toEqual({ message: fixed });
    const posted = await db.selectFrom('messages').select('id').where('group_id', '=', personal.id).execute();
    expect(posted).toHaveLength(0);
  });

  it('accepts an address the user typed themselves, even with no mail from it', async () => {
    const uid = await createUser(db, 'erin');
    const request = 'Forward the school photo email to grandma@family.example';
    const llm = scriptedLlm(
      [{ toolCalls: [{ id: 'h1', name: 'hand_off_to_chat', args: { request } }] }, { text: 'Taking you to your chat.' }],
      [],
    );
    const out = await findingsChat(
      db,
      uid,
      { messages: [{ role: 'user', text: 'Send the school photo email to grandma@family.example' }] },
      { llm },
    );
    expect(out.handoff).toEqual({ message: request });
  });

  it('hands off from a provider without native tools too', async () => {
    const uid = await createUser(db, 'dan');
    const request = 'Add a to-do on Nov 2 to review my Netflix subscription, $15.49 a month';
    const fence = '```chord-tool\n' + JSON.stringify({ name: 'hand_off_to_chat', args: { request } }) + '\n```';
    const llm = {
      ...scriptedLlm([{ text: `Taking you to your chat.\n${fence}` }], []),
      supportsNativeTools: false,
    } as LlmService;
    const out = await findingsChat(db, uid, { messages: [{ role: 'user', text: 'Remind me to cancel Netflix' }] }, { llm });
    expect(out.handoff).toEqual({ message: request });
    expect(out.reply).toBe('Taking you to your chat.');
  });

  // Audit 2026-11-01: the app posted the hand-off as the user with no tap and
  // the model was told it was "taking them" to do it, so an instruction inside
  // an email the model read could run as the user's own request. The hand-off
  // is now a draft the user sends, and the model is told nothing went yet.
  it('tells the model the hand-off is a draft the user still has to send', async () => {
    const uid = await createUser(db, 'frank');
    await mailFrom(db, uid, 'target@e.target.com');
    const observed: LlmMessage[][] = [];
    const offered: string[][] = [];
    const request = 'Unsubscribe me from the Target mailing list, target@e.target.com';
    // Native provider: what it is told about the tool, and the tool's answer.
    const llm = scriptedLlm([{ toolCalls: [{ id: 'h1', name: 'hand_off_to_chat', args: { request } }] }, {}], observed, offered);
    const out = await findingsChat(db, uid, { messages: [{ role: 'user', text: 'Unsubscribe me from Target' }] }, { llm });

    const result = observed[1].filter((m) => m.role === 'tool').at(-1)?.content ?? '';
    expect(result).toContain('"sent":false');
    expect(result).toContain('NOTHING has been sent');
    expect(result).not.toMatch(/taking (you|them)/i);
    // No reply text from the model: the fallback says it waits for a tap.
    expect(out.reply).toMatch(/Send to chat/);
    expect(out.reply).not.toMatch(/taking you/i);
    expect(out.handoff).toEqual({ message: request });
  });

  it('answers without a hand-off when nothing was asked to change', async () => {
    const uid = await createUser(db, 'carol');
    const llm = scriptedLlm([{ text: 'Mostly the school.' }], []);
    const out = await findingsChat(db, uid, { messages: [{ role: 'user', text: 'Who emails me most?' }] }, { llm });
    expect(out.handoff).toBeUndefined();
  });
});
