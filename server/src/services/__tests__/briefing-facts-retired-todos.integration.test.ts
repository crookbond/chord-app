/**
 * ADR 0092 — the retirement notice reaches the abbreviated briefing surfaces.
 *
 * The full briefing lists the retired to-dos by name (ADR 0285), but the ADR
 * 0079 gated teaser and the ADR 0091 out-of-window WhatsApp template render
 * from `buildBriefingFacts` instead and never see it. Without the note those
 * users watch their to-do count drop with no explanation, which is precisely
 * the "silently emptying the list" failure ADR 0092 committed to avoiding.
 *
 * Lives outside `briefing/__tests__` on purpose: the facts suite is ADR 0091's,
 * and this is the ADR 0092 obligation laid over it.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { buildBriefingFacts } from '@/services/briefing/facts.js';
import { renderTeaser, templateParams } from '@/services/briefing/render.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { __testing } from '@/services/proactive.service.js';
import { createTask, retireTasksByProvenance, updateTask } from '@/services/tasks.service.js';

vi.mock('@/config/env.js', async (orig) => {
  const mod = (await orig()) as { env: Record<string, unknown> };
  return { env: { ...mod.env, WEATHER_PROVIDER: '', GEOIP_DB_PATH: '' } };
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

describe('BriefingFacts — retired to-dos (ADR 0092)', () => {
  let db: Kysely<DB>;
  let userId: string;
  let groupId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'sam');
    groupId = (await ensurePersonalGroup(db, userId)).id;
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  // The overdue sweep itself; archiving through updateTask is the user's own
  // Drop, which the briefing does not report (ADR 0285).
  const retire = async (title: string) => {
    const t = await createTask(db, { groupId, createdBy: userId, title, dueAt: daysAgo(400) });
    await __testing.archiveStaleTasks(db);
    return t;
  };

  it('names the retirement alongside the remaining open work', async () => {
    await createTask(db, { groupId, createdBy: userId, title: 'Still live', dueAt: daysAgo(1) });
    await retire('Long gone');

    const f = await buildBriefingFacts(db, userId);

    expect(f.tasks).toContain('1 open task');
    expect(f.tasks).toContain('1 taken off your list (Long gone)');
  });

  it('still says it when the sweep emptied the list entirely', async () => {
    // The case where silence reads as data loss: nothing left to report, so
    // a tasks fact built only from open rows would be null and the user
    // would just see their to-dos gone.
    await retire('Only item');

    const f = await buildBriefingFacts(db, userId);

    expect(f.tasks).toContain('1 taken off your list (Only item)');
  });

  it('counts the ones whose email went away, not the ones the user dropped (ADR 0285)', async () => {
    // It said "2 past-due retired" for one overdue to-do and one the user had
    // dropped (or whose email went away) - neither of the second kind was
    // past due, and the user had no way to tell which was which.
    await createTask(db, {
      groupId,
      createdBy: userId,
      title: 'Reply to the school',
      sourceRawContext: 'gmail:thr_school',
    });
    await retireTasksByProvenance(db, userId, ['gmail:thr_school']);
    const dropped = await createTask(db, {
      groupId,
      createdBy: userId,
      title: 'Renew the passport',
      dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    await updateTask(db, dropped.id, { status: 'archived' });
    await retire('Long gone');

    const f = await buildBriefingFacts(db, userId);
    expect(f.tasks).toContain('2 taken off your list');
    expect(f.tasks).not.toContain('past-due');
  });

  it('says nothing when the sweep retired nothing', async () => {
    await createTask(db, { groupId, createdBy: userId, title: 'Still live', dueAt: daysAgo(1) });

    const f = await buildBriefingFacts(db, userId);

    expect(f.tasks).not.toContain('taken off');
  });

  it('reaches both rendered surfaces, and stays one line for Meta', async () => {
    await retire('Long gone');

    const f = await buildBriefingFacts(db, userId);

    expect(renderTeaser(f)).toContain('taken off your list (Long gone)');
    const params = templateParams(f);
    expect(params).toHaveLength(5);
    expect(params[3]).toContain('taken off your list (Long gone)');
    for (const p of params) expect(p).not.toMatch(/[\r\n\t]| {2,}/);
  });
});
