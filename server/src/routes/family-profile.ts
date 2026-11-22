import { Router } from 'express';

import { API, CreateFactRequest, SSE, UpdateFactRequest } from '@chord/kernel';

import { loadSession, requireSession } from '../middleware/auth.js';
import { requireMember } from '../middleware/require-member.js';
import { isMember } from '../services/groups.service.js';
import { getGroupProfile } from '../services/family-profile.service.js';
import {
  decayMemories,
  deleteFact,
  canSeeFact,
  getMemory,
  updateFact,
  upsertMemory,
} from '../services/memory.service.js';
import { broadcastFact, refreshMemoryNotice } from '../services/memory-notices.service.js';
import { sseHub } from '../services/sse.hub.js';

export const familyProfileRouter = Router();

familyProfileRouter.use(loadSession);

familyProfileRouter.get(
  '/api/v1/groups/:id/profile',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      // docs/notes/0189 — same lazy-on-read sweep as memories.ts's routes;
      // a persona's attribute fact can decay to confirmed right before the
      // screen that would show it renders.
      const decayed = await decayMemories(req.db);
      for (const { id, groupId, supersededId } of decayed) {
        sseHub.broadcast(groupId, SSE.memoryResolved, { id, status: 'confirmed' });
        if (supersededId) sseHub.broadcast(groupId, SSE.memoryResolved, { id: supersededId, status: 'rejected' });
        await refreshMemoryNotice(req.db, id);
        if (supersededId) await refreshMemoryNotice(req.db, supersededId);
      }
      res.json(await getGroupProfile(req.db, req.params.id, req.userId!));
    } catch (err) {
      next(err);
    }
  },
);

familyProfileRouter.post(
  '/api/v1/groups/:id/facts',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      const parsed = CreateFactRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid fact', detail: parsed.error.flatten() });
        return;
      }
      const d = parsed.data;
      if (d.subjectType !== 'household' && !d.subjectId) {
        res.status(400).json({ error: 'subjectId is required unless subjectType is household' });
        return;
      }
      // ADR 0333 — the person a fact is about must be someone in THIS chat:
      // a member, or a persona on this chat's roster.
      if (d.subjectType === 'user' && !(await isMember(req.db, req.params.id, d.subjectId!))) {
        res.status(400).json({ error: 'that person is not in this chat' });
        return;
      }
      if (d.subjectType === 'persona') {
        const persona = await req.db
          .selectFrom('personas')
          .select('id')
          .where('id', '=', d.subjectId!)
          .where('group_id', '=', req.params.id)
          .executeTakeFirst();
        if (!persona) {
          res.status(400).json({ error: 'that person is not in this chat' });
          return;
        }
      }
      // A typed fact is a direct write — confirmed, not a proposal. `scope` is
      // the legacy axis: only a fact about a real user account is 'persona'
      // (its persona_id can be a users FK); a managed persona or the household
      // is 'group', with the real subject in subject_type/subject_id.
      const fact = await upsertMemory(req.db, {
        groupId: req.params.id,
        scope: d.subjectType === 'user' ? 'persona' : 'group',
        // A fact about a member is private to whoever typed it (ADR 0333):
        // filed under that member, never handed to them as their own.
        ...(d.subjectType === 'user' ? { personaId: req.userId! } : {}),
        key: d.key,
        value: d.value,
        source: 'explicit',
        status: 'confirmed',
        subjectType: d.subjectType,
        subjectId: d.subjectType === 'household' ? null : d.subjectId,
        ...(d.category ? { category: d.category } : {}),
        ...(d.datedAt ? { datedAt: d.datedAt } : {}),
        provenance: 'manual',
      });
      broadcastFact(SSE.memoryCreated, fact);
      res.status(201).json(fact);
    } catch (err) {
      next(err);
    }
  },
);

/** Resolve a `/facts/:id` request to its group + membership. */
async function loadFactForMember(
  req: Parameters<Parameters<typeof familyProfileRouter.patch>[1]>[0],
): Promise<{ id: string; groupId: string } | null> {
  const fact = await getMemory(req.db, req.params.id);
  if (!fact) return null;
  if (!(await isMember(req.db, fact.groupId, req.userId!))) return null;
  // ADR 0333 — another member's private fact is not there for them.
  if (!canSeeFact({ scope: fact.scope, persona_id: fact.personaId }, req.userId!)) return null;
  return { id: fact.id, groupId: fact.groupId };
}

familyProfileRouter.patch(API.fact(':id'), requireSession, async (req, res, next) => {
  try {
    const found = await loadFactForMember(req);
    if (!found) {
      res.status(404).json({ error: 'fact not found' });
      return;
    }
    const parsed = UpdateFactRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid patch', detail: parsed.error.flatten() });
      return;
    }
    const fact = await updateFact(req.db, found.id, parsed.data);
    if (!fact) {
      res.status(404).json({ error: 'fact not found' });
      return;
    }
    broadcastFact(SSE.memoryCreated, fact);
    await refreshMemoryNotice(req.db, found.id);
    res.json(fact);
  } catch (err) {
    next(err);
  }
});

familyProfileRouter.delete(API.fact(':id'), requireSession, async (req, res, next) => {
  try {
    const found = await loadFactForMember(req);
    if (!found) {
      res.status(404).json({ error: 'fact not found' });
      return;
    }
    await deleteFact(req.db, found.id);
    sseHub.broadcast(found.groupId, SSE.memoryResolved, { id: found.id, status: 'rejected' });
    await refreshMemoryNotice(req.db, found.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
