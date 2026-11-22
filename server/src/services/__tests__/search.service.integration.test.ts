/**
 * ADR 0059 — unified `search` tool + service.
 *
 * Covers the two things most likely to regress: the automatic scope model
 * (personal chat → cross-group; shared group → this-group only, enforced by
 * both the query scope and ADR 0032's scrubber) and the per-category
 * matching, including the tasks-vs-reminders split. Exercised through
 * `applyToolCall` so the executor's personal-detection and the scrubber run
 * for real.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { indexAttachmentChunks } from '@/services/attachments.index.js';
import { createGroup } from '@/services/groups.service.js';
import { postMessage } from '@/services/messages.service.js';
import { searchEverything, type SearchResults } from '@/services/search.service.js';
import { createTask } from '@/services/tasks.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

async function runSearch(
  db: Kysely<DB>,
  groupId: string,
  userId: string,
  args: { query: string; categories?: string[]; limit?: number },
): Promise<SearchResults> {
  const r = await applyToolCall(db, {
    groupId,
    actorUserId: userId,
    provenance: null,
    call: { name: 'search', args },
  });
  return r.data as SearchResults;
}

async function seedAttachment(
  db: Kysely<DB>,
  opts: { id: string; groupId: string; userId: string; filename: string; text: string },
): Promise<void> {
  await db
    .insertInto('attachments')
    .values({
      id: opts.id,
      scope_kind: 'group',
      scope_id: opts.groupId,
      uploaded_by: opts.userId,
      filename: opts.filename,
      mime_type: 'text/plain',
      size: opts.text.length,
      path: `x/${opts.id}.txt`,
      summary: null,
      extracted_text: opts.text,
      image_meta: null,
      pinned: 0,
      indexed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    })
    .execute();
  await indexAttachmentChunks(db, opts.id);
}

describe('searchEverything / `search` tool', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  it('from the personal 1:1 chat, searches ACROSS all the user\'s groups', async () => {
    const john = await createUser(db, 'john', 'John');
    const personal = await createGroup(db, { name: 'John', kind: 'personal', createdBy: john });
    const family = await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john });

    await createTask(db, { groupId: family.id, createdBy: john, title: 'renew passport' });

    const res = await runSearch(db, personal.id, john, { query: 'passport' });
    expect(res.scope).toBe('all-groups');
    expect(res.tasks.map((t) => t.title)).toContain('renew passport');
    // Group NAME is surfaced (not a raw groupId that the scrubber would drop).
    expect(res.tasks[0]!.group).toBe('Doe Family');
    expect(res.tasks[0]).not.toHaveProperty('groupId');
  });

  it('from a shared group, searches THAT group only (no cross-group leak)', async () => {
    const john = await createUser(db, 'john', 'John');
    const family = await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john });
    const work = await createGroup(db, { name: 'Work', kind: 'group', createdBy: john });

    await createTask(db, { groupId: family.id, createdBy: john, title: 'family passport renewal' });
    await createTask(db, { groupId: work.id, createdBy: john, title: 'work passport for travel' });

    const res = await runSearch(db, family.id, john, { query: 'passport' });
    expect(res.scope).toBe('this-group');
    expect(res.tasks.map((t) => t.title)).toEqual(['family passport renewal']);
  });

  it('splits reminders (remindAt set) from plain tasks', async () => {
    const john = await createUser(db, 'john', 'John');
    const family = await createGroup(db, { name: 'Family', kind: 'group', createdBy: john });

    await createTask(db, { groupId: family.id, createdBy: john, title: 'buy vitamins' });
    await createTask(db, {
      groupId: family.id,
      createdBy: john,
      title: 'vitamins refill',
      remindAt: '2030-01-01T09:00:00-05:00',
    });

    const res = await runSearch(db, family.id, john, { query: 'vitamins' });
    expect(res.tasks.map((t) => t.title)).toEqual(['buy vitamins']);
    expect(res.reminders.map((t) => t.title)).toEqual(['vitamins refill']);
  });

  it('matches chat messages and returns a snippet + sender', async () => {
    const john = await createUser(db, 'john', 'John');
    const family = await createGroup(db, { name: 'Family', kind: 'group', createdBy: john });
    await postMessage(db, {
      groupId: family.id,
      senderId: john,
      body: 'I left the plumber\'s card on the fridge, his name is Dave',
    });

    const res = await runSearch(db, family.id, john, { query: 'plumber' });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0]!.from).toBe('John');
    expect(res.messages[0]!.snippet.toLowerCase()).toContain('plumber');
  });

  it('matches uploaded files via the tsvector chunk index', async () => {
    const john = await createUser(db, 'john', 'John');
    const family = await createGroup(db, { name: 'Family', kind: 'group', createdBy: john });
    await seedAttachment(db, {
      id: 'a_pass',
      groupId: family.id,
      userId: john,
      filename: 'nolan-doc.txt',
      text: 'Nolan passport number A1234567 issued in 2024, expires 2034.',
    });

    const r = await applyToolCall(db, {
      groupId: family.id,
      actorUserId: john,
      provenance: null,
      call: { name: 'search', args: { query: 'passport' } },
    });
    const res = r.data as SearchResults;
    expect(res.files.map((f) => f.filename)).toContain('nolan-doc.txt');
    expect(res.files[0]!.group).toBe('Family');
    // The file card opens the actual attachment (id + mime), not a nav href.
    const fileCard = (r.cards ?? []).find((c) => c.attachmentId === 'a_pass');
    expect(fileCard).toBeDefined();
    expect(fileCard!.mimeType).toBe('text/plain');
    expect(fileCard!.href).toBeUndefined();
  });

  it('honors the categories filter', async () => {
    const john = await createUser(db, 'john', 'John');
    const family = await createGroup(db, { name: 'Family', kind: 'group', createdBy: john });
    await createTask(db, { groupId: family.id, createdBy: john, title: 'passport photos' });
    await postMessage(db, { groupId: family.id, senderId: john, body: 'got the passport back' });

    const res = await searchEverything(db, {
      userId: john,
      groupId: family.id,
      crossGroup: false,
      query: 'passport',
      categories: ['tasks'],
    });
    expect(res.tasks).toHaveLength(1);
    expect(res.messages).toHaveLength(0);
  });

  it('returns tappable cards with in-app hrefs for the top hits', async () => {
    const john = await createUser(db, 'john', 'John');
    const family = await createGroup(db, { name: 'Family', kind: 'group', createdBy: john });
    await createTask(db, { groupId: family.id, createdBy: john, title: 'passport renewal' });
    await postMessage(db, { groupId: family.id, senderId: john, body: 'passport is in the drawer' });

    const r = await applyToolCall(db, {
      groupId: family.id,
      actorUserId: john,
      provenance: null,
      call: { name: 'search', args: { query: 'passport' } },
    });
    const cards = r.cards ?? [];
    expect(cards.length).toBeGreaterThan(0);
    // Every search card is tappable (carries an in-app href) and none leaks a raw url.
    expect(cards.every((c) => typeof c.href === 'string' && c.href.length > 0)).toBe(true);
    expect(cards.find((c) => c.href === '/catchup/tasks')).toBeDefined();
    expect(cards.find((c) => c.href === `/groups/${family.id}`)).toBeDefined();
  });

  it('a non-member gets nothing from another group\'s content', async () => {
    const john = await createUser(db, 'john', 'John');
    const stranger = await createUser(db, 'stranger', 'Stranger');
    const strangerPersonal = await createGroup(db, {
      name: 'Stranger',
      kind: 'personal',
      createdBy: stranger,
    });
    const family = await createGroup(db, { name: 'Family', kind: 'group', createdBy: john });
    await createTask(db, { groupId: family.id, createdBy: john, title: 'secret passport plan' });

    const res = await runSearch(db, strangerPersonal.id, stranger, { query: 'passport' });
    expect(res.totalHits).toBe(0);
  });

  // Regression: tasks/saves/lists/events used to be found via `ftsMatchIds`
  // (a real, unscoped tsvector match against the WHOLE table) intersected
  // against listTasks(ForUser)/etc's 200-row `created_at DESC` page — so a
  // real FTS hit was thrown away whenever it wasn't ALSO on that recency
  // page. searchTasksScoped/searchEventsScoped (tasks.service.ts,
  // events.service.ts) query scope + match together instead.
  it('finds a task and an event behind 200+ newer rows of each', async () => {
    const john = await createUser(db, 'john', 'John');
    const family = await createGroup(db, { name: 'Doe Family', kind: 'group', createdBy: john });

    // The target task must predate the filler for the old recency-cap bug to
    // bite (listTasks orders `created_at DESC` — newest survive the cutoff).
    await db
      .insertInto('tasks')
      .values({
        id: 't_target',
        group_id: family.id,
        title: 'Renew passport',
        status: 'open',
        created_by: john,
        created_at: new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toISOString(),
      })
      .execute();
    const filler = Array.from({ length: 210 }, (_, i) => ({
      id: `t_filler${i}`,
      group_id: family.id,
      title: `Buy item ${i}`,
      status: 'open' as const,
      created_by: john,
      created_at: new Date(Date.UTC(2026, 5, 1, 12, 0, i)).toISOString(),
    }));
    await db.insertInto('tasks').values(filler).execute();

    const eventFiller = Array.from({ length: 510 }, (_, i) => ({
      id: `e_filler${i}`,
      group_id: family.id,
      title: `Old meeting ${i}`,
      starts_at: new Date(Date.UTC(2020, 0, 1, 9, 0, 0) + i * 86_400_000).toISOString(),
      created_by: john,
      created_at: new Date().toISOString(),
    }));
    await db.insertInto('events').values(eventFiller).execute();
    await db
      .insertInto('events')
      .values({
        id: 'e_target',
        group_id: family.id,
        title: 'Lenox Hill Radiology appointment',
        starts_at: '2026-09-22T11:00:00-04:00',
        created_by: john,
        created_at: new Date().toISOString(),
      })
      .execute();

    const taskRes = await runSearch(db, family.id, john, { query: 'passport' });
    expect(taskRes.tasks.map((t) => t.title)).toContain('Renew passport');

    const eventRes = await runSearch(db, family.id, john, { query: 'radiology' });
    expect(eventRes.events.map((e) => e.title)).toContain('Lenox Hill Radiology appointment');
  });
});
