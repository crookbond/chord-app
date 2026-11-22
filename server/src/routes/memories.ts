import { Router } from 'express';

import { API, SSE, type Memory } from '@chord/kernel';

import { loadSession, requireSession } from '../middleware/auth.js';
import { requireMember } from '../middleware/require-member.js';
import { isMember } from '../services/groups.service.js';
import {
  canSeeFact,
  confirmMemory,
  decayMemories,
  listMemories,
  listMemoriesForUser,
  rejectMemory,
} from '../services/memory.service.js';
import { labelMemorySubjects, refreshMemoryNotice } from '../services/memory-notices.service.js';
import { sseHub } from '../services/sse.hub.js';

export const memoriesRouter = Router();

/** ADR 0333 — every fact in a list says who it is about. */
async function withAbout(db: Parameters<typeof labelMemorySubjects>[0], rows: Memory[]): Promise<Memory[]> {
  const labels = await labelMemorySubjects(db, rows);
  return rows.map((m) => ({ ...m, about: labels.get(m.id) ?? 'Someone' }));
}

memoriesRouter.use(loadSession);

/**
 * docs/notes/0189 — the lighter-bar sweep, same lazy-on-read placement as
 * `proposals.ts`'s `sweepAndBroadcastExpired` (no cron): broadcasts the same
 * two-event pattern the manual confirm route below already does, so a client
 * mid-session sees a decayed fact move without waiting for a refetch.
 */
async function sweepAndBroadcastMemoryDecay(req: { db: Parameters<typeof decayMemories>[0] }): Promise<void> {
  const decayed = await decayMemories(req.db);
  for (const { id, groupId, supersededId } of decayed) {
    sseHub.broadcast(groupId, SSE.memoryResolved, { id, status: 'confirmed' });
    if (supersededId) sseHub.broadcast(groupId, SSE.memoryResolved, { id: supersededId, status: 'rejected' });
    await refreshMemoryNotice(req.db, id);
    if (supersededId) await refreshMemoryNotice(req.db, supersededId);
  }
}

memoriesRouter.get(
  '/api/v1/groups/:id/memories',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      await sweepAndBroadcastMemoryDecay(req);
      res.json(await withAbout(req.db, await listMemories(req.db, req.params.id, { viewerId: req.userId! })));
    } catch (err) {
      next(err);
    }
  },
);

memoriesRouter.get(
  API.meMemories,
  requireSession,
  async (req, res, next) => {
    try {
      await sweepAndBroadcastMemoryDecay(req);
      res.json(await withAbout(req.db, await listMemoriesForUser(req.db, req.userId!)));
    } catch (err) {
      next(err);
    }
  },
);

async function loadMemoryForMember(
  req: Parameters<Parameters<typeof memoriesRouter.post>[1]>[0],
): Promise<{ id: string; group_id: string; status: 'proposed' | 'confirmed' } | null> {
  const row = await req.db
    .selectFrom('memories')
    .select(['id', 'group_id', 'status', 'scope', 'persona_id'])
    .where('id', '=', req.params.id)
    .executeTakeFirst();
  if (!row) return null;
  if (!(await isMember(req.db, row.group_id, req.userId!))) return null;
  // ADR 0333 — another member's private fact is not there for them.
  if (!canSeeFact(row, req.userId!)) return null;
  return row;
}

memoriesRouter.post(
  '/api/v1/memories/:id/confirm',
  requireSession,
  async (req, res, next) => {
    try {
      const row = await loadMemoryForMember(req);
      if (!row) {
        res.status(404).json({ error: 'memory not found' });
        return;
      }
      const result = await confirmMemory(req.db, row.id);
      if (!result) {
        res.status(404).json({ error: 'memory not found' });
        return;
      }
      sseHub.broadcast(row.group_id, SSE.memoryResolved, {
        id: row.id,
        status: 'confirmed',
      });
      // If a prior confirmed row for the same key was superseded, tell
      // clients to drop it. The resolved handler removes on 'rejected',
      // which has the right end-state here (row no longer in the live
      // Memory tab); the DB still records `superseded_by` for audit.
      if (result.supersededId) {
        sseHub.broadcast(row.group_id, SSE.memoryResolved, {
          id: result.supersededId,
          status: 'rejected',
        });
      }
      await refreshMemoryNotice(req.db, row.id);
      if (result.supersededId) await refreshMemoryNotice(req.db, result.supersededId);
      res.json(result.memory);
    } catch (err) {
      next(err);
    }
  },
);

memoriesRouter.post(
  '/api/v1/memories/:id/reject',
  requireSession,
  async (req, res, next) => {
    try {
      const row = await loadMemoryForMember(req);
      if (!row) {
        res.status(404).json({ error: 'memory not found' });
        return;
      }
      if (row.status === 'confirmed') {
        res.status(409).json({ error: 'memory already confirmed — use supersede' });
        return;
      }
      const ok = await rejectMemory(req.db, row.id);
      if (!ok) {
        res.status(404).json({ error: 'memory not found' });
        return;
      }
      sseHub.broadcast(row.group_id, SSE.memoryResolved, {
        id: row.id,
        status: 'rejected',
      });
      await refreshMemoryNotice(req.db, row.id);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);
