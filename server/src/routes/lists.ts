import { Router } from 'express';

import {
  AddListItemRequest,
  API,
  MoveListToSavesRequest,
  SSE,
  UpdateListItemRequest,
  UpsertListRequest,
} from '@chord/kernel';

import { loadSession, requireSession } from '../middleware/auth.js';
import { requireMember } from '../middleware/require-member.js';
import { isMember } from '../services/groups.service.js';
import {
  addItem,
  createList,
  deleteItem,
  deleteList,
  getItem,
  getList,
  listLists,
  listListsForUser,
  renameList,
  setItemChecked,
  setItemText,
} from '../services/lists.service.js';
import { moveListToSaves } from '../services/list-to-saves.service.js';
import { sseHub } from '../services/sse.hub.js';

export const listsRouter = Router();

listsRouter.use(loadSession);

listsRouter.get(
  '/api/v1/groups/:id/lists',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      res.json(await listLists(req.db, req.params.id));
    } catch (err) {
      next(err);
    }
  },
);

listsRouter.get(
  API.meLists,
  requireSession,
  async (req, res, next) => {
    try {
      res.json(await listListsForUser(req.db, req.userId!));
    } catch (err) {
      next(err);
    }
  },
);

listsRouter.post(
  '/api/v1/groups/:id/lists',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      const parsed = UpsertListRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
        return;
      }
      const list = await createList(req.db, {
        groupId: req.params.id,
        name: parsed.data.name,
        createdBy: req.userId!,
      });
      sseHub.broadcast(req.params.id, SSE.listUpdated, { listId: list.id });
      res.status(201).json(list);
    } catch (err) {
      next(err);
    }
  },
);

listsRouter.post('/api/v1/lists/:listId/items', requireSession, async (req, res, next) => {
  try {
    const list = await getList(req.db, req.params.listId);
    if (!list || !(await isMember(req.db, list.groupId, req.userId!))) {
      res.status(404).json({ error: 'list not found' });
      return;
    }
    const parsed = AddListItemRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    const { item, created } = await addItem(req.db, list.id, parsed.data.text);
    if (created) {
      sseHub.broadcast(list.groupId, SSE.listUpdated, { listId: list.id, item });
    }
    res.status(created ? 201 : 200).json(item);
  } catch (err) {
    next(err);
  }
});

listsRouter.patch('/api/v1/list-items/:itemId', requireSession, async (req, res, next) => {
  try {
    const it = await getItem(req.db, req.params.itemId);
    const list = it ? await getList(req.db, it.listId) : null;
    if (!it || !list || !(await isMember(req.db, list.groupId, req.userId!))) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const parsed = UpdateListItemRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    const { text, checked } = parsed.data;
    if (text === undefined && checked === undefined) {
      res.status(400).json({ error: 'nothing to update' });
      return;
    }
    let updated = it;
    if (text !== undefined) {
      updated = (await setItemText(req.db, it.id, text)) ?? updated;
    }
    if (checked !== undefined) {
      updated = (await setItemChecked(req.db, it.id, checked)) ?? updated;
    }
    sseHub.broadcast(list.groupId, SSE.listUpdated, { listId: list.id, item: updated });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

listsRouter.patch('/api/v1/lists/:listId', requireSession, async (req, res, next) => {
  try {
    const list = await getList(req.db, req.params.listId);
    if (!list || !(await isMember(req.db, list.groupId, req.userId!))) {
      res.status(404).json({ error: 'list not found' });
      return;
    }
    const parsed = UpsertListRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    const updated = await renameList(req.db, list.id, parsed.data.name);
    // A rename that collides merges (ADR 0094), so the surviving list may be a
    // different row than the one addressed — the client has to reconcile that,
    // which is why `merged` rides along instead of just the list.
    if (updated) {
      sseHub.broadcast(updated.list.groupId, SSE.listUpdated, { listId: updated.list.id });
      if (updated.merged) {
        sseHub.broadcast(updated.list.groupId, SSE.listUpdated, {
          listId: updated.merged.removedListId,
        });
      }
    }
    res.json(updated ? { ...updated.list, merged: updated.merged } : null);
  } catch (err) {
    next(err);
  }
});

listsRouter.delete('/api/v1/lists/:listId', requireSession, async (req, res, next) => {
  try {
    const list = await getList(req.db, req.params.listId);
    if (!list || !(await isMember(req.db, list.groupId, req.userId!))) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    await deleteList(req.db, list.id);
    sseHub.broadcast(list.groupId, SSE.listUpdated, { listId: list.id });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

listsRouter.post('/api/v1/lists/:listId/move-to-saves', requireSession, async (req, res, next) => {
  try {
    const list = await getList(req.db, req.params.listId);
    if (!list || !(await isMember(req.db, list.groupId, req.userId!))) {
      res.status(404).json({ error: 'list not found' });
      return;
    }
    const parsed = MoveListToSavesRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    const result = await moveListToSaves(req.db, {
      listId: list.id,
      actorUserId: req.userId!,
      kind: parsed.data.kind,
    });
    if (!result) {
      res.status(404).json({ error: 'list not found' });
      return;
    }
    const { created, ...body } = result;
    for (const s of created) sseHub.broadcast(list.groupId, SSE.saveAdded, s);
    sseHub.broadcast(list.groupId, SSE.listUpdated, { listId: list.id });
    res.json(body);
  } catch (err) {
    next(err);
  }
});

listsRouter.delete('/api/v1/list-items/:itemId', requireSession, async (req, res, next) => {
  try {
    const it = await getItem(req.db, req.params.itemId);
    const list = it ? await getList(req.db, it.listId) : null;
    if (!it || !list || !(await isMember(req.db, list.groupId, req.userId!))) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    await deleteItem(req.db, it.id);
    sseHub.broadcast(list.groupId, SSE.listUpdated, { listId: list.id });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
