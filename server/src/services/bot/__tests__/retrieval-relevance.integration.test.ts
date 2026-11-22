/**
 * ADR 0288 — which files a bot turn puts in the prompt.
 *
 * The prod case (owner's personal chat, 2026-10-22): a restaurant question
 * pulled four legal PDFs into the prompt because "Friday" and "date" each hit
 * a chunk of every contract, and one hit on any single word was enough.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@/config/env.js';
import type { DB } from '@/db/schema.js';
import { indexAttachmentChunks } from '@/services/attachments.index.js';
import { selectExcerptsForTurn } from '@/services/bot/retrieval.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { runEmbedPass } from '@/services/search/embed-pass.js';
import { __resetSemanticCachesForTests } from '@/services/search/semantic.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

const flags = env as { EMBEDDINGS_ENABLED: boolean };
const saved = { EMBEDDINGS_ENABLED: env.EMBEDDINGS_ENABLED };

let db: Kysely<DB>;
let userId: string;
let groupId: string;

async function addFile(filename: string, summary: string, text: string): Promise<string> {
  const id = newId('a');
  const now = new Date().toISOString();
  await db
    .insertInto('attachments')
    .values({
      id,
      scope_kind: 'group',
      scope_id: groupId,
      uploaded_by: userId,
      filename,
      mime_type: 'application/pdf',
      size: 1000,
      path: `tests/${id}.pdf`,
      summary,
      extracted_text: text,
      image_meta: null,
      pinned: 0,
      indexed_at: now,
      created_at: now,
    })
    .execute();
  await indexAttachmentChunks(db, id);
  return id;
}

async function seedProdFiles(): Promise<void> {
  await addFile(
    '316 West 84th Street Corp - 26-27 Insurance Proposal - All Lines.pdf',
    'Insurance proposal for the 2026-27 policy year with coverage options and premiums by line.',
    [
      'Coverage options are shown for each line. The effective date is 12:01 AM on the renewal date.',
      '',
      'Binding instructions must be received by Friday. Follow the link in the cover email to bind.',
    ].join('\n'),
  );
  await addFile(
    'Change-Pro Redline - Project Street - LSD Side Letter.pdf',
    'Redline of the side letter comparing draft dates and the options to extend.',
    'The closing date shall be no later than Friday, subject to the extension options set out below.',
  );
  await addFile(
    'Alteration Agreement_Berkowitz Signed.pdf',
    'Signed alteration agreement; work hours, completion date and remedies on default.',
    [
      'Work may be performed Monday through Friday only, between the hours of 9 AM and 5 PM.',
      '',
      'The completion date is binding on the shareholder and the contractor.',
    ].join('\n'),
  );
  await addFile(
    'John Doe.pdf',
    'Personal document listing dates, options and contact details.',
    'As of the date below, the options listed on the following page remain open until Friday.',
  );
}

const PROD_QUESTION = '@Chord can you suggest a restaurant for Friday? Date night with Alice';

const injected = async (triggerText: string) =>
  (await selectExcerptsForTurn(db, { groupId, triggeringUserId: userId, triggerText })).map((a) => a.filename);

beforeEach(async () => {
  db = await openTestDb();
  userId = await createUser(db, 'john');
  groupId = (await ensurePersonalGroup(db, userId)).id;
  __resetSemanticCachesForTests();
});

afterEach(async () => {
  Object.assign(flags, saved);
  await closeTestDb(db);
});

describe('files put in the prompt', () => {
  it('leaves the four legal PDFs out of the prod restaurant question (keywords only)', async () => {
    await seedProdFiles();
    expect(await injected(PROD_QUESTION)).toEqual([]);
  });

  it('leaves them out when the files have vectors too', async () => {
    flags.EMBEDDINGS_ENABLED = true;
    await seedProdFiles();
    expect((await runEmbedPass(db, userId)).files).toBe(4);
    expect(await injected(PROD_QUESTION)).toEqual([]);
  });

  it('still brings in a file the question is really about (keywords only)', async () => {
    await seedProdFiles();
    expect(await injected('@Chord what hours can the contractor work under the alteration agreement?')).toEqual([
      'Alteration Agreement_Berkowitz Signed.pdf',
    ]);
  });

  it('brings in a file by meaning when no word is shared', async () => {
    flags.EMBEDDINGS_ENABLED = true;
    await seedProdFiles();
    await addFile(
      'Field trip permission slip.pdf',
      'Permission slip for the aquarium visit.',
      'Sign and return by Monday so your child can join the aquarium visit.',
    );
    await runEmbedPass(db, userId);
    expect(await injected('@Chord where is the kids excursion paperwork?')).toEqual(['Field trip permission slip.pdf']);
  });

  it('does not count one generic word as a match', async () => {
    await seedProdFiles();
    expect(await injected('anything happening friday?')).toEqual([]);
  });
});
