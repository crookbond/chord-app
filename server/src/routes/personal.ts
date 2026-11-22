import { Router } from 'express';

import {
  CreateContactRequest,
  CreateMediaRequest,
  CreatePlaceRequest,
} from '@chord/kernel';

import { loadSession, requireSession } from '../middleware/auth.js';
import { requireMember } from '../middleware/require-member.js';
import { isMember } from '../services/groups.service.js';
import {
  createContact,
  createMedia,
  createPlace,
  getMediaItem,
  listContacts,
  listMedia,
  listPlaces,
  setMediaDone,
} from '../services/personal.service.js';

export const personalRouter = Router();

personalRouter.use(loadSession);

// ── places ──────────────────────────────────────────────────────────
personalRouter.get(
  '/api/v1/groups/:id/places',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      res.json(await listPlaces(req.db, req.params.id));
    } catch (err) {
      next(err);
    }
  },
);
personalRouter.post(
  '/api/v1/groups/:id/places',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      const parsed = CreatePlaceRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
        return;
      }
      const place = await createPlace(req.db, {
        ...parsed.data,
        groupId: req.params.id,
        createdBy: req.userId!,
      });
      res.status(201).json(place);
    } catch (err) {
      next(err);
    }
  },
);

// ── contacts ────────────────────────────────────────────────────────
personalRouter.get(
  '/api/v1/groups/:id/contacts',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      res.json(await listContacts(req.db, req.params.id));
    } catch (err) {
      next(err);
    }
  },
);
personalRouter.post(
  '/api/v1/groups/:id/contacts',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      const parsed = CreateContactRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
        return;
      }
      const contact = await createContact(req.db, {
        ...parsed.data,
        groupId: req.params.id,
        createdBy: req.userId!,
      });
      res.status(201).json(contact);
    } catch (err) {
      next(err);
    }
  },
);

// ── media ───────────────────────────────────────────────────────────
personalRouter.get(
  '/api/v1/groups/:id/media',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      res.json(await listMedia(req.db, req.params.id));
    } catch (err) {
      next(err);
    }
  },
);
personalRouter.post(
  '/api/v1/groups/:id/media',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      const parsed = CreateMediaRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
        return;
      }
      const item = await createMedia(req.db, {
        ...parsed.data,
        groupId: req.params.id,
        createdBy: req.userId!,
      });
      res.status(201).json(item);
    } catch (err) {
      next(err);
    }
  },
);
personalRouter.patch(
  '/api/v1/media-items/:itemId',
  requireSession,
  async (req, res, next) => {
    try {
      const existing = await getMediaItem(req.db, req.params.itemId);
      if (!existing || !(await isMember(req.db, existing.groupId, req.userId!))) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      if (typeof req.body?.done === 'boolean') {
        const updated = await setMediaDone(req.db, req.params.itemId, req.body.done);
        if (!updated) {
          res.status(404).json({ error: 'not found' });
          return;
        }
        res.json(updated);
        return;
      }
      res.status(400).json({ error: 'nothing to update' });
    } catch (err) {
      next(err);
    }
  },
);
