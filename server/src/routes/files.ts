import { Router } from 'express';
import multer from 'multer';
import mime from 'mime-types';

import { API, SSE, ShareAttachmentRequest, type Attachment } from '@chord/kernel';

import { loadSession, requireSession } from '../middleware/auth.js';
import { sseHub } from '../services/sse.hub.js';
import { isMember } from '../services/groups.service.js';
import { logger } from '../config/logging.js';
import { safeFileHeaders } from '../utils/content-disposition.js';
import { blobIsSealed, KeyDestroyedError, NoKeyError, readBlob } from '../db/crypto/index.js';
import {
  absolutePathFor,
  copyAttachmentToGroup,
  deleteAttachment,
  getAttachment,
  listAttachmentsForGroup,
  listAttachmentsForUser,
  markBlobMissing,
  patchAttachmentMeta,
  saveFile,
  setAttachmentPinned,
} from '../services/attachments.service.js';
import { userCanRead } from '../services/permissions.service.js';

export const filesRouter = Router();

filesRouter.use(loadSession);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

filesRouter.post(
  '/api/v1/groups/:id/files',
  requireSession,
  upload.single('file'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!(await isMember(req.db, id, req.userId!))) {
        res.status(403).json({ error: 'not a member' });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: 'file required (multipart field "file")' });
        return;
      }
      const mimeType =
        req.file.mimetype ||
        (mime.lookup(req.file.originalname) || 'application/octet-stream') as string;
      const tzRaw = typeof req.body?.timezoneOffset === 'string' ? parseInt(req.body.timezoneOffset, 10) : undefined;
      const att = await saveFile(req.db, {
        scope: { kind: 'group', groupId: id },
        uploadedBy: req.userId!,
        filename: req.file.originalname || 'upload.bin',
        mimeType,
        buffer: req.file.buffer,
        uploaderTzOffsetMinutes: Number.isFinite(tzRaw) ? tzRaw : undefined,
      });
      res.status(201).json(att);
    } catch (err) {
      next(err);
    }
  },
);

filesRouter.get(
  '/api/v1/groups/:id/files',
  requireSession,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!(await isMember(req.db, id, req.userId!))) {
        res.status(403).json({ error: 'not a member' });
        return;
      }
      const atts = await listAttachmentsForGroup(req.db, id);
      res.json(atts);
    } catch (err) {
      next(err);
    }
  },
);

filesRouter.get(
  API.meFiles,
  requireSession,
  async (req, res, next) => {
    try {
      res.json(await listAttachmentsForUser(req.db, req.userId!));
    } catch (err) {
      next(err);
    }
  },
);

filesRouter.get(
  '/api/v1/attachments/:id',
  requireSession,
  async (req, res, next) => {
    try {
      const att = await getAttachment(req.db, req.params.id);
      if (!att) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      if (!(await userCanRead(req.db, att.id, req.userId!))) {
        res.status(403).json({ error: 'not authorized' });
        return;
      }
      // ADR 0269 — the type is whatever the uploader's client claimed.
      for (const [k, v] of Object.entries(safeFileHeaders(att.mimeType, att.filename))) {
        res.setHeader(k, v);
      }
      // Seed / imported rows can outlive their blob (data dir wiped, file
      // never written). sendFile's default error path leaks the absolute
      // path in the response — give the client a clean signal instead.
      const full = absolutePathFor(att);
      const onError = (err: unknown): void => {
        // The owner's key was destroyed (account erased): the bytes are still
        // on disk but can never be read. Say so plainly rather than a 500.
        if ((err instanceof KeyDestroyedError || err instanceof NoKeyError) && !res.headersSent) {
          res.status(410).json({ error: 'file erased', code: 'CONTENT_ERASED' });
          return;
        }
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' && !res.headersSent) {
          // Log + stamp: without this the failure is invisible in the logs
          // and the dead row keeps surfacing in search forever.
          logger.warn('attachment blob missing on disk', { id: att.id, filename: att.filename });
          void markBlobMissing(req.db, att.id).catch(() => {});
          res.status(410).json({ error: 'file missing on disk', code: 'BLOB_MISSING' });
          return;
        }
        if (!res.headersSent) next(err);
      };
      // A sealed file (ADR 0201) is opened in memory and sent whole. A plain
      // one still goes through sendFile, which keeps range requests and
      // conditional GETs, so turning encryption on costs nothing for files
      // that predate it.
      try {
        if (await blobIsSealed(full)) {
          const data = await readBlob(full);
          res.setHeader('Content-Length', String(data.length));
          res.end(data);
          return;
        }
      } catch (err) {
        onError(err);
        return;
      }
      res.sendFile(full, (err) => {
        if (err) onError(err);
      });
    } catch (err) {
      next(err);
    }
  },
);

filesRouter.post(
  '/api/v1/attachments/:id/share',
  requireSession,
  async (req, res, next) => {
    try {
      const att = await getAttachment(req.db, req.params.id);
      if (!att) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      if (!(await userCanRead(req.db, att.id, req.userId!))) {
        res.status(403).json({ error: 'not authorized' });
        return;
      }
      const parsed = ShareAttachmentRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
        return;
      }
      if (!(await isMember(req.db, parsed.data.groupId, req.userId!))) {
        res.status(403).json({ error: 'not a member of target group' });
        return;
      }
      const tzRaw2 = typeof req.body?.timezoneOffset === 'number' ? req.body.timezoneOffset
        : typeof req.body?.timezoneOffset === 'string' ? parseInt(req.body.timezoneOffset, 10)
        : undefined;
      const copy = await copyAttachmentToGroup(req.db, att, parsed.data.groupId, req.userId!, Number.isFinite(tzRaw2) ? tzRaw2 : undefined);
      res.status(201).json(copy);
    } catch (err) {
      next(err);
    }
  },
);

filesRouter.delete(
  '/api/v1/attachments/:id',
  requireSession,
  async (req, res, next) => {
    try {
      const att = await getAttachment(req.db, req.params.id);
      if (!att) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      if (!(await userCanRead(req.db, att.id, req.userId!))) {
        res.status(403).json({ error: 'not authorized' });
        return;
      }
      await deleteAttachment(req.db, att.id);
      if (att.scope.kind === 'group') {
        sseHub.broadcast(att.scope.groupId, SSE.attachmentDeleted, { id: att.id });
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

filesRouter.patch(
  '/api/v1/attachments/:id',
  requireSession,
  async (req, res, next) => {
    try {
      const att = await getAttachment(req.db, req.params.id);
      if (!att) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      if (!(await userCanRead(req.db, att.id, req.userId!))) {
        res.status(403).json({ error: 'not authorized' });
        return;
      }
      // Build the response from what each mutation already knows rather than
      // re-fetching the row a second time. `patchAttachmentMeta` already
      // returns the fresh row (it has to re-select to merge image_meta), so
      // reuse that; a pinned-only patch just applies the same flip locally.
      let updated: Attachment | null = att;
      if (typeof req.body?.pinned === 'boolean') {
        await setAttachmentPinned(req.db, att.id, req.body.pinned);
        updated = { ...updated, pinned: req.body.pinned };
      }
      const tagsRaw = req.body?.tags;
      const summaryRaw = req.body?.summary;
      const wantTags = Array.isArray(tagsRaw);
      const wantSummary = typeof summaryRaw === 'string' || summaryRaw === null;
      if (wantTags || wantSummary) {
        updated = await patchAttachmentMeta(req.db, att.id, {
          ...(wantTags ? { tags: (tagsRaw as unknown[]).map(String) } : {}),
          ...(wantSummary ? { summary: summaryRaw as string | null } : {}),
        });
      }
      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

