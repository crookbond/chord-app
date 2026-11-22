import { Router } from 'express';

import {
  DeleteMessagesRequest,
  PostMessageRequest,
  SSE,
  type DeleteMessagesResponse,
} from '@chord/kernel';

import { loadSession, requireSession } from '../middleware/auth';
import { idempotent } from '../middleware/idempotency';
import { logger } from '../config/logging';
import {
  decideReaction,
  passivelyExtractFromMessage,
  reactToMessage,
} from '../services/bot/bot.service';
import {
  consumeFollowupTurn,
  isWithinFollowupWindow,
  openFollowupWindow,
} from '../services/bot/followup-window';
import { maybeHandleConfirmCommand } from '../services/bot/confirm-verb';
import { isMember, markGroupRead } from '../services/groups.service';
import {
  deletedIdBatches,
  deleteMessages,
  listMessages,
  postMessage,
} from '../services/messages.service';
import { recordUserTimezone } from '../services/proactive.service';
import { sseHub } from '../services/sse.hub';
import { runInBackground } from '../utils/background';

export const messagesRouter = Router();

messagesRouter.use(loadSession);

messagesRouter.get(
  '/api/v1/groups/:id/messages',
  requireSession,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!(await isMember(req.db, id, req.userId!))) {
        res.status(403).json({ error: 'not a member' });
        return;
      }
      const before = typeof req.query.before === 'string' ? req.query.before : undefined;
      const limitStr = typeof req.query.limit === 'string' ? req.query.limit : undefined;
      const limit = limitStr ? Number.parseInt(limitStr, 10) : undefined;
      const msgs = await listMessages(req.db, { groupId: id, before, limit, viewerId: req.userId! });
      res.json(msgs);
    } catch (err) {
      next(err);
    }
  },
);

messagesRouter.post(
  '/api/v1/groups/:id/messages/delete',
  requireSession,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!(await isMember(req.db, id, req.userId!))) {
        res.status(403).json({ error: 'not a member' });
        return;
      }
      const parsed = DeleteMessagesRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
        return;
      }
      const out = await deleteMessages(req.db, {
        groupId: id,
        userId: req.userId!,
        ids: parsed.data.ids,
        all: parsed.data.all,
      });
      // A shared-chat delete is for this user only, so nobody else is told.
      if (out.forEveryone) {
        for (const ids of deletedIdBatches(out.deletedIds)) {
          sseHub.broadcast(id, SSE.messagesDeleted, { groupId: id, ids });
        }
      }
      const body: DeleteMessagesResponse = { deleted: out.deleted, skipped: out.skipped };
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);

messagesRouter.post(
  '/api/v1/groups/:id/messages',
  requireSession,
  idempotent,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!(await isMember(req.db, id, req.userId!))) {
        res.status(403).json({ error: 'not a member' });
        return;
      }
      const parsed = PostMessageRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
        return;
      }
      const msg = await postMessage(req.db, {
        groupId: id,
        senderId: req.userId!,
        kind: 'text',
        body: parsed.data.body,
        attachmentId: parsed.data.attachmentId,
        replyToId: parsed.data.replyToId,
      });
      if (parsed.data.tz && req.userId) {
        // Stash the user's last-seen IANA tz so the proactive scheduler can
        // fire daily nudges at 7am in their local time, not server-local. A
        // changed zone also re-times the pending briefing (see PUT /me/tz,
        // which the client calls on every foreground).
        // Not awaited: the message reaches the group without waiting for it.
        runInBackground(
          recordUserTimezone(req.db, req.userId, parsed.data.tz).catch((err) =>
            logger.warn('failed to persist last_tz', { err }),
          ),
        );
      }
      sseHub.broadcast(id, SSE.message, msg);
      // Posting implies you've read the group; advance the cursor and tell
      // the sender's other devices so their unread badge clears in real time.
      void markGroupRead(req.db, id, req.userId!)
        .then((lastReadAt) =>
          sseHub.broadcast(id, SSE.groupRead, { groupId: id, userId: req.userId!, lastReadAt }),
        )
        .catch(() => {});
      res.status(201).json(msg);

      if (msg.senderId) {
        const urlMatch = msg.body.match(/https?:\/\/[^\s<>'"]+/i);
        if (urlMatch) {
          const url = urlMatch[0];
          let hostname = url;
          try {
            hostname = new URL(url).hostname;
          } catch {
            // ignore
          }
          sseHub.broadcast(id, SSE.botSaveOffer, {
            messageId: msg.id,
            url,
            title: hostname,
          });
        }
      }

      // Independent lookups — run together so the reaction decision (and the
      // bot-turn kickoff downstream of it) isn't delayed by two sequential
      // round trips on this, the highest-volume route in the app.
      const [group, sender] = await Promise.all([
        req.db
          .selectFrom('groups')
          .select(['id', 'kind'])
          .where('id', '=', id)
          .executeTakeFirst(),
        msg.senderId
          ? req.db
              .selectFrom('users')
              .select(['username', 'display_name as displayName', 'listening_mode'])
              .where('id', '=', msg.senderId)
              .executeTakeFirst()
          : Promise.resolve(null),
      ]);
      if (group) {
        const decision = decideReaction({
          kind: msg.kind,
          senderId: msg.senderId,
          groupKind: group.kind,
          body: msg.body,
          listeningMode: (sender?.listening_mode ?? 'invocation') as
            | 'invocation'
            | 'passive'
            | 'active',
          inFollowupWindow: await isWithinFollowupWindow(req.db, group.id),
        });
        // ADR 0051 — keep the group's follow-up window in sync with the decision.
        if (decision.followup === 'open') await openFollowupWindow(req.db, group.id);
        else if (decision.followup === 'consume') await consumeFollowupTurn(req.db, group.id);

        // ADR 0009 phase 5: `@Chord confirm|drop [ref|all]` resolves
        // pending proposals directly — no LLM turn. Falls through to the
        // normal react path when the message isn't a verb.
        const handled = await maybeHandleConfirmCommand(req.db, msg, group).catch((err) => {
          logger.error('confirm-verb handler crashed', { err });
          return false;
        });
        if (!handled) {
          if (decision.react) reactToMessage(req.db, msg, group, parsed.data.tz);
          else if (decision.passiveExtract) passivelyExtractFromMessage(req.db, msg, group);
        }
      }
    } catch (err) {
      next(err);
    }
  },
);
