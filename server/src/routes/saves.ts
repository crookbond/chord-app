import { Router } from 'express';

import { API, CreateSaveRequest, SSE, UpdateSaveRequest } from '@chord/kernel';

import { loadSession, requireSession } from '../middleware/auth.js';
import { requireMember } from '../middleware/require-member.js';
import { isMember } from '../services/groups.service.js';
import { createSaveWithDedup, deleteSave, getSave, listSaves, listSavesForUser, updateSave } from '../services/saves.service.js';
import { sseHub } from '../services/sse.hub.js';

export const savesRouter = Router();

/** `/me/saves` page size: well past what a family keeps, so the app's one
 *  read still holds everything in practice. */
export const ME_SAVES_DEFAULT_LIMIT = 500;
const ME_SAVES_MAX_LIMIT = 1000;

savesRouter.use(loadSession);

savesRouter.get(
  '/api/v1/groups/:id/saves',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      const trip = typeof req.query.trip === 'string' ? req.query.trip : undefined;
      res.json(await listSaves(req.db, req.params.id, { tripLabel: trip }));
    } catch (err) {
      next(err);
    }
  },
);

savesRouter.get(
  API.meSaves,
  requireSession,
  async (req, res, next) => {
    try {
      // Newest first, a page at a time (`?before=<createdAt>` for the next):
      // every save in every group the user is in was one unbounded read.
      const requested = Number(req.query.limit);
      const limit = Number.isInteger(requested) && requested > 0
        ? Math.min(requested, ME_SAVES_MAX_LIMIT)
        : ME_SAVES_DEFAULT_LIMIT;
      const before = typeof req.query.before === 'string' && req.query.before ? req.query.before : undefined;
      res.json(await listSavesForUser(req.db, req.userId!, { limit, before }));
    } catch (err) {
      next(err);
    }
  },
);

savesRouter.post(
  '/api/v1/groups/:id/saves',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      const parsed = CreateSaveRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
        return;
      }
      const { save, created } = await createSaveWithDedup(req.db, {
        ...parsed.data,
        groupId: req.params.id,
        createdBy: req.userId!,
      });
      if (created) sseHub.broadcast(req.params.id, SSE.saveAdded, save);
      res.status(created ? 201 : 200).json(save);
    } catch (err) {
      next(err);
    }
  },
);

savesRouter.patch('/api/v1/saves/:saveId', requireSession, async (req, res, next) => {
  try {
    const parsed = UpdateSaveRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    const existing = await getSave(req.db, req.params.saveId);
    if (!existing || !(await isMember(req.db, existing.groupId, req.userId!))) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const updated = await updateSave(req.db, req.params.saveId, parsed.data);
    if (!updated) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    sseHub.broadcast(updated.groupId, SSE.saveAdded, updated);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

savesRouter.delete('/api/v1/saves/:saveId', requireSession, async (req, res, next) => {
  try {
    const existing = await getSave(req.db, req.params.saveId);
    if (!existing || !(await isMember(req.db, existing.groupId, req.userId!))) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    await deleteSave(req.db, req.params.saveId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
