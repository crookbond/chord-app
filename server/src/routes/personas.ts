import { Router } from 'express';

import {
  API,
  CreatePersonaRequest,
  PromotePersonRequest,
  SSE,
  UpdatePersonaRequest,
} from '@chord/kernel';

import { loadSession, requireSession } from '../middleware/auth.js';
import { requireMember } from '../middleware/require-member.js';
import { isMember } from '../services/groups.service.js';
import {
  createPersona,
  deletePersona,
  getPersona,
  listPersonas,
  promotePersonToGroup,
  updatePersona,
} from '../services/personas.service.js';
import { sseHub } from '../services/sse.hub.js';

export const personasRouter = Router();

personasRouter.use(loadSession);

personasRouter.get(
  '/api/v1/groups/:id/personas',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      res.json(await listPersonas(req.db, req.params.id));
    } catch (err) {
      next(err);
    }
  },
);

personasRouter.post(
  '/api/v1/groups/:id/personas',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      const parsed = CreatePersonaRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid persona', detail: parsed.error.flatten() });
        return;
      }
      const persona = await createPersona(req.db, {
        groupId: req.params.id,
        name: parsed.data.name,
        householdRole: parsed.data.householdRole,
        birthdate: parsed.data.birthdate ?? null,
        managedBy: req.userId!,
      });
      sseHub.broadcast(req.params.id, SSE.personaCreated, persona);
      res.status(201).json(persona);
    } catch (err) {
      next(err);
    }
  },
);

personasRouter.post(
  API.groupPersonasPromote(':id'),
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      const parsed = PromotePersonRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid request', detail: parsed.error.flatten() });
        return;
      }
      const out = await promotePersonToGroup(req.db, {
        userId: req.userId!,
        groupId: req.params.id,
        personId: parsed.data.fromPersonId,
      });
      if (!out.ok) {
        // not_owner is reported as 404 too — telling a caller a person exists
        // but isn't theirs is a small leak of someone else's roster.
        res.status(404).json({ error: 'person not found' });
        return;
      }
      if (!out.result.reused) {
        sseHub.broadcast(req.params.id, SSE.personaCreated, out.result.persona);
      }
      res.status(201).json(out.result);
    } catch (err) {
      next(err);
    }
  },
);

/** Resolve a `/personas/:id` request to its group + membership. */
async function loadPersonaForMember(
  req: Parameters<Parameters<typeof personasRouter.patch>[1]>[0],
): Promise<{ id: string; groupId: string } | null> {
  const persona = await getPersona(req.db, req.params.id);
  if (!persona) return null;
  if (!(await isMember(req.db, persona.groupId, req.userId!))) return null;
  return { id: persona.id, groupId: persona.groupId };
}

personasRouter.patch(API.persona(':id'), requireSession, async (req, res, next) => {
  try {
    const found = await loadPersonaForMember(req);
    if (!found) {
      res.status(404).json({ error: 'persona not found' });
      return;
    }
    const parsed = UpdatePersonaRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid patch', detail: parsed.error.flatten() });
      return;
    }
    const persona = await updatePersona(req.db, found.id, parsed.data);
    if (!persona) {
      res.status(404).json({ error: 'persona not found' });
      return;
    }
    sseHub.broadcast(found.groupId, SSE.personaUpdated, persona);
    res.json(persona);
  } catch (err) {
    next(err);
  }
});

personasRouter.delete(API.persona(':id'), requireSession, async (req, res, next) => {
  try {
    const found = await loadPersonaForMember(req);
    if (!found) {
      res.status(404).json({ error: 'persona not found' });
      return;
    }
    const result = await deletePersona(req.db, found.id);
    if (result === 'not_found') {
      res.status(404).json({ error: 'persona not found' });
      return;
    }
    if (result === 'linked') {
      res
        .status(409)
        .json({ error: 'account members follow their group membership — leave the group instead' });
      return;
    }
    sseHub.broadcast(found.groupId, SSE.personaDeleted, { id: found.id, groupId: found.groupId });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
