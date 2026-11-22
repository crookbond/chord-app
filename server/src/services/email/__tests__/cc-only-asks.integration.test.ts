/**
 * An ask aimed at someone else on the email is not the user's to-do.
 *
 * Reported 2026-11-16: the user is on Cc while the sender asks the To person
 * for their time ("Tom, when are you free next week?"), and Action Items
 * offered "Reply to Sarah with times that work" - Tom's job. The suggestion
 * pass saw the To/Cc addresses but was never told which one was the user, and
 * every rule said "the recipient", so the model filed every ask as theirs.
 *
 * Fixed in two places: the prompt names the user's address and where it sits
 * (`You: ... (on Cc only)`), and each item carries `"askedOf"`, the name the
 * email asks; code drops an item whose name is another person on the email.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { ingestClassification } from '@/services/email/classification.service.js';
import { runLlmClassifier } from '@/services/email/llm-classifier.js';
import { askedSomeoneElse } from '@/services/email/asked-of.js';
import { parseSuggestions, runEmailMagics } from '@/services/email/magics.service.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { __resetLlmCacheForTests, __setLlmForTests } from '@/services/llm/factory.js';
import type { LlmService } from '@/services/llm/types.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const ME = 'john@example.com';
let prompts: string[] = [];
let reply = '{"items":[]}';

const model: LlmService = {
  providerName: 'openai',
  defaultModel: 'test-model',
  supportsNativeTools: false,
  async complete(messages) {
    prompts.push(messages.map((m) => m.content).join('\n'));
    return reply;
  },
  // eslint-disable-next-line require-yield
  async *stream() {
    throw new Error('not used');
  },
};

let db: Kysely<DB>;
let userId: string;

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'cc-only');
  await db
    .updateTable('users')
    .set({ email: ME, display_name: 'John Doe', first_name: 'John' })
    .where('id', '=', userId)
    .execute();
  await ensurePersonalGroup(db, userId);
  prompts = [];
  __setLlmForTests(model);
});
afterEach(async () => {
  __resetLlmCacheForTests();
  await closeTestDb(db);
});

async function seedEmail(opts: {
  to: string[];
  cc: string[];
  body: string;
  classified?: boolean;
}): Promise<string> {
  const at = new Date(Date.now() - 60_000).toISOString();
  const gid = `t-cc-${newId('x')}`;
  const threadId = newId('emt');
  await db
    .insertInto('email_threads')
    .values({
      id: threadId,
      user_id: userId,
      account_id: null,
      gmail_thread_id: gid,
      subject: 'Coffee next week?',
      snippet: opts.body.slice(0, 80),
      from_email: 'sarah@example.org',
      from_name: 'Sarah Lee',
      last_message_at: at,
      is_unread: 1,
      is_archived: 0,
      created_at: at,
      updated_at: at,
    })
    .execute();
  await db
    .insertInto('email_messages')
    .values({
      id: newId('emm'),
      user_id: userId,
      account_id: null,
      thread_id: threadId,
      gmail_message_id: `m-${gid}`,
      gmail_thread_id: gid,
      from_name: 'Sarah Lee',
      from_email: 'sarah@example.org',
      to_emails: JSON.stringify(opts.to),
      cc_emails: JSON.stringify(opts.cc),
      subject: 'Coffee next week?',
      snippet: opts.body.slice(0, 80),
      body_text: opts.body,
      body_html: null,
      ics_text: '',
      internal_date: at,
      is_unread: 1,
      gmail_label_ids: JSON.stringify(['INBOX', 'UNREAD']),
      rfc822_message_id: null,
      headers_json: JSON.stringify({ references: null, inReplyTo: null, date: null }),
      created_at: at,
    })
    .execute();
  if (opts.classified !== false) {
    await ingestClassification(db, userId, {
      version: 1,
      userId,
      categories: [{ id: 'ff', parentId: null, title: 'Friends & family', depth: 0 }],
      assignments: [{ gmailThreadId: gid, categoryId: 'ff' }],
    });
  }
  return gid;
}

async function cards(gid: string): Promise<string[]> {
  const rows = await db
    .selectFrom('proposals')
    .select('args_json')
    .where('provenance', '=', `gmail:${gid}`)
    .where('status', '=', 'pending')
    .execute();
  return rows.map((r) => (JSON.parse(r.args_json) as { title?: string }).title ?? '');
}

describe('an ask aimed at someone else on the email', () => {
  it('tells the model which address is the user and that they are only on Cc', async () => {
    await seedEmail({
      to: ['tom@example.net'],
      cc: [ME],
      body: 'Hi Tom, when are you free next week for coffee? John cc for visibility.',
    });
    await runEmailMagics(db, userId);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`You: ${ME} (on Cc only)`);
  });

  it('stages no card for an availability ask meant for the To person (prod report)', async () => {
    reply =
      '{"items":[{"kind":"task","title":"Reply to Sarah with times that work for coffee","reply":true,"askedOf":"Tom"}]}';
    const gid = await seedEmail({
      to: ['tom@example.net'],
      cc: [ME],
      body: 'Hi Tom, when are you free next week for coffee? John cc for visibility.',
    });
    await runEmailMagics(db, userId);
    expect(await cards(gid)).toEqual([]);
  });

  it('still stages an ask the sender puts to the user by name while they are on Cc', async () => {
    reply = '{"items":[{"kind":"task","title":"Bring the slides on Thursday","askedOf":"John"}]}';
    const gid = await seedEmail({
      to: ['tom@example.net'],
      cc: [ME],
      body: 'Tom, see below. John, can you bring the slides on Thursday?',
    });
    await runEmailMagics(db, userId);
    expect(await cards(gid)).toEqual(['Bring the slides on Thursday']);
  });

  it('says the user is on To when they are', async () => {
    await seedEmail({ to: [ME, 'tom@example.net'], cc: [], body: 'Both of you, when are you free?' });
    await runEmailMagics(db, userId);
    expect(prompts[0]).toContain(`You: ${ME} (on To)`);
  });
});

describe('the classifier (a "Reply" badge is the same mistake)', () => {
  it('marks a thread the user is only copied on, and not one sent to them', async () => {
    const e = env as { EMAIL_CLASSIFIER: string };
    const was = e.EMAIL_CLASSIFIER;
    e.EMAIL_CLASSIFIER = 'llm';
    reply = '{"assignments":[]}';
    try {
      const ccGid = await seedEmail({
        to: ['tom@example.net'],
        cc: [ME],
        body: 'Hi Tom, when are you free next week?',
        classified: false,
      });
      const toGid = await seedEmail({ to: [ME], cc: [], body: 'When are you free?', classified: false });
      await runLlmClassifier(db, userId);
      const payload = prompts.find((p) => p.includes('"threads"'));
      const threads = JSON.parse(payload!.slice(payload!.indexOf('{"threads"'))) as {
        threads: { gmailThreadId: string; cc?: boolean }[];
      };
      const byId = new Map(threads.threads.map((t) => [t.gmailThreadId, t]));
      expect(byId.get(ccGid)?.cc).toBe(true);
      expect(byId.get(toGid)?.cc).toBeUndefined();
    } finally {
      e.EMAIL_CLASSIFIER = was;
    }
  });
});

describe('parseSuggestions keeps "askedOf"', () => {
  it('on tasks, events and every list entry', () => {
    const got = parseSuggestions(
      JSON.stringify({
        items: [
          { kind: 'task', title: 'Reply to Sarah', askedOf: 'Tom' },
          { kind: 'list', listName: 'Potluck', items: ['salad', 'plates'], askedOf: 'parents' },
          { kind: 'event', title: 'Dentist', startsAt: '2030-01-02T10:00:00-05:00', askedOf: 'me' },
        ],
      }),
    );
    expect(got.map((s) => ('askedOf' in s ? s.askedOf : null))).toEqual(['Tom', 'parents', 'parents', 'me']);
  });
});

describe('askedSomeoneElse', () => {
  const people = {
    me: ['john.doe@neuralads.example', 'John Doe', 'John'],
    others: ['Tom Kent', 'tom.kelly@neuralads.example', 'geoff.judge@judgecapital.example', 'ashton.grant@brightstream.example'],
  };
  it.each([
    ['Geoff', true],
    ['Ash', true],
    ['Tom', true],
    ['John', false],
    ['John and Tom', false],
    ['me', false],
    ['parents', false],
    ['the school', false],
    [undefined, false],
  ])('%s → %s', (asked, expected) => {
    expect(askedSomeoneElse(asked, people)).toBe(expected);
  });
});
