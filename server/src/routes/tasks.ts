import { Router } from 'express';

import { API, CreateTaskRequest, SSE, TodoSyncRequest, UpdateTaskRequest } from '@chord/kernel';

import { loadSession, requireSession } from '../middleware/auth.js';
import { idempotent } from '../middleware/idempotency.js';
import { requireMember } from '../middleware/require-member.js';
import { isMember } from '../services/groups.service.js';
import { enqueueFromTask } from '../services/proactive.service.js';
import { sseHub } from '../services/sse.hub.js';
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  listTasksForUser,
  updateTask,
} from '../services/tasks.service.js';
import { applyTodoOp } from '../services/todo-sync.service.js';

export const tasksRouter = Router();

tasksRouter.use(loadSession);

tasksRouter.get(
  '/api/v1/groups/:id/tasks',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      res.json(await listTasks(req.db, req.params.id));
    } catch (err) {
      next(err);
    }
  },
);

tasksRouter.get(
  API.meTasks,
  requireSession,
  async (req, res, next) => {
    try {
      res.json(await listTasksForUser(req.db, req.userId!));
    } catch (err) {
      next(err);
    }
  },
);

tasksRouter.post(
  '/api/v1/groups/:id/tasks',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      const parsed = CreateTaskRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
        return;
      }
      const task = await createTask(req.db, {
        ...parsed.data,
        groupId: req.params.id,
        createdBy: req.userId!,
      });
      sseHub.broadcast(req.params.id, SSE.taskCreated, task);
      await enqueueFromTask(req.db, task);
      res.status(201).json(task);
    } catch (err) {
      next(err);
    }
  },
);

tasksRouter.patch('/api/v1/tasks/:taskId', requireSession, async (req, res, next) => {
  try {
    const existing = await getTask(req.db, req.params.taskId);
    if (!existing || !(await isMember(req.db, existing.groupId, req.userId!))) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    const parsed = UpdateTaskRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    const updated = await updateTask(req.db, req.params.taskId, parsed.data);
    if (updated) {
      sseHub.broadcast(updated.groupId, SSE.taskUpdated, updated);
      // If the caller set a new remindAt and the task is still actionable,
      // queue a fresh reminder (updateTask cancelled any pending one).
      if (
        parsed.data.remindAt !== undefined &&
        updated.remindAt &&
        (updated.status === 'open' || updated.status === 'active')
      ) {
        await enqueueFromTask(req.db, updated);
      }
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

tasksRouter.delete('/api/v1/tasks/:taskId', requireSession, async (req, res, next) => {
  try {
    const existing = await getTask(req.db, req.params.taskId);
    if (!existing || !(await isMember(req.db, existing.groupId, req.userId!))) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    await deleteTask(req.db, req.params.taskId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ADR 0311 addendum - one to-do or list change the app made offline, replayed.
tasksRouter.post(API.meTodoSync, requireSession, idempotent, async (req, res, next) => {
  try {
    const parsed = TodoSyncRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    res.json(await applyTodoOp(req.db, req.userId!, parsed.data.op, parsed.data.force ?? false));
  } catch (err) {
    next(err);
  }
});

// Silence unused-variable warning for `API` import in future refactors.
void API;
