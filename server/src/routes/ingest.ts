import { Router } from 'express';
import multer from 'multer';

import { API } from '@chord/kernel';

import { logger } from '../config/logging.js';
import { loadSession, requireSession } from '../middleware/auth.js';
import { isMember } from '../services/groups.service.js';
import { importIcs } from '../services/ingest/ics/pipeline.js';
import { importWhatsAppZip } from '../services/ingest/whatsapp/pipeline.js';

export const ingestRouter = Router();

ingestRouter.use(loadSession);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

ingestRouter.post(
  API.ingestWhatsApp,
  requireSession,
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'file required (multipart field "file")' });
        return;
      }
      const groupName =
        typeof req.body?.groupName === 'string' && req.body.groupName.trim()
          ? req.body.groupName.trim()
          : undefined;

      const result = await importWhatsAppZip(req.db, {
        zipBuffer: req.file.buffer,
        uploaderId: req.userId!,
        groupName,
        runExtractionAsync: true,
      });

      logger.info(
        `whatsapp import: user=${req.userId} group=${result.groupId} msgs=${result.messagesInserted}`,
      );
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);

ingestRouter.post(
  API.ingestIcs,
  requireSession,
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        res.status(400).json({ error: 'file required (multipart field "file")' });
        return;
      }
      const groupId = typeof req.body?.groupId === 'string' ? req.body.groupId : null;
      if (!groupId) {
        res.status(400).json({ error: 'groupId required' });
        return;
      }

      if (!(await isMember(req.db, groupId, req.userId!))) {
        res.status(403).json({ error: 'not a member' });
        return;
      }
      const result = await importIcs(req.db, {
        groupId,
        uploaderId: req.userId!,
        filename: req.file.originalname || 'calendar.ics',
        buffer: req.file.buffer,
      });

      logger.info(
        `ics import: user=${req.userId} group=${groupId} created=${result.eventsCreated} deduped=${result.eventsDeduped}`,
      );
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },
);
