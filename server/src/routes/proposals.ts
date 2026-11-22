import { Router } from 'express';

import { API, OverlapAnswerRequest, RsvpProposalRequest, SSE } from '@chord/kernel';

import { loadSession, requireSession } from '../middleware/auth.js';
import { idempotent } from '../middleware/idempotency.js';
import { requireMember } from '../middleware/require-member.js';
import { isMember } from '../services/groups.service.js';
import {
  attachSourceHrefs,
  confirmProposal,
  expireStale,
  getProposal,
  listProposalsForGroup,
  listProposalsForUser,
  rejectProposal,
} from '../services/proposals.service.js';
import { respondToInvite } from '../services/google/rsvp.service.js';
import { recordOverlapAnswer } from '../services/events/calendar-fit.service.js';
import { waitForTheirInvite } from '../services/email/meeting-invite-choice.js';
import { sseHub } from '../services/sse.hub.js';

export const proposalsRouter = Router();

proposalsRouter.use(loadSession);

async function sweepAndBroadcastExpired(req: { db: Parameters<typeof expireStale>[0] }): Promise<void> {
  const expired = await expireStale(req.db);
  for (const { id, groupId } of expired) {
    sseHub.broadcast(groupId, SSE.proposalResolved, { id, status: 'expired' });
  }
}

proposalsRouter.get(
  '/api/v1/groups/:id/proposals',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      await sweepAndBroadcastExpired(req);
      const rows = await listProposalsForGroup(req.db, req.params.id);
      res.json(await attachSourceHrefs(req.db, req.userId!, rows));
    } catch (err) {
      next(err);
    }
  },
);

proposalsRouter.get(
  API.meProposals,
  requireSession,
  async (req, res, next) => {
    try {
      await sweepAndBroadcastExpired(req);
      const rows = await listProposalsForUser(req.db, req.userId!);
      res.json(await attachSourceHrefs(req.db, req.userId!, rows));
    } catch (err) {
      next(err);
    }
  },
);

proposalsRouter.post(
  '/api/v1/proposals/:id/confirm',
  requireSession,
  // An answer queued offline is retried after a lost reply (ADR 0311 addendum).
  idempotent,
  async (req, res, next) => {
    try {
      const row = await getProposal(req.db, req.params.id);
      if (!row) {
        res.status(404).json({ error: 'proposal not found' });
        return;
      }
      if (!(await isMember(req.db, row.groupId, req.userId!))) {
        res.status(403).json({ error: 'not a member' });
        return;
      }
      // ADR 0097 — the confirmer may name where this lands. Absent, it goes
      // wherever the proposal was staged (personal, unless a standing routing
      // rule said otherwise). Membership on the named group is enforced in
      // `confirmProposal`, which returns exec_failed rather than routing.
      // ADR 0247 — `targetGroupIds` sends it to several groups at once.
      const wanted = (req.body ?? {}) as {
        targetGroupId?: unknown;
        targetGroupIds?: unknown;
        calendarId?: unknown;
        replaceEventId?: unknown;
        sendInvites?: unknown;
      };
      const many = Array.isArray(wanted.targetGroupIds)
        ? wanted.targetGroupIds.filter((g): g is string => typeof g === 'string')
        : [];
      const result = await confirmProposal(req.db, {
        id: row.id,
        resolvedByUserId: req.userId!,
        ...(typeof wanted.targetGroupId === 'string'
          ? { targetGroupId: wanted.targetGroupId }
          : {}),
        ...(many.length > 0 ? { targetGroupIds: many } : {}),
        // ADR 0312 — the calendar picked on the card.
        ...(typeof wanted.calendarId === 'string' && wanted.calendarId
          ? { calendarId: wanted.calendarId }
          : {}),
        // ADR 0343 — "Move it": move the event the card offered instead.
        ...(typeof wanted.replaceEventId === 'string' && wanted.replaceEventId
          ? { replaceEventId: wanted.replaceEventId }
          : {}),
        // ADR 0348 — only a ticked "Also send invitations" invites anyone.
        ...(wanted.sendInvites === true ? { sendInvites: true } : {}),
      });
      if (!result.ok) {
        const code = result.reason === 'not_found' ? 404
          : result.reason === 'already_resolved' || result.reason === 'replace_unavailable' ? 409
          : result.reason === 'expired' ? 410
          : result.reason === 'invalid_args' ? 422
          : result.reason === 'calendar_required' || result.reason === 'calendar_not_writable' ? 422
          : 500;
        res.status(code).json({ error: result.reason, message: result.message });
        return;
      }
      for (const id of result.affected) {
        sseHub.broadcast(row.groupId, SSE.proposalResolved, { id, status: 'confirmed' });
      }
      res.json({
        proposal: result.proposal,
        summary: result.summary,
        affected: result.affected,
        ...(result.routeSuggestion ? { routeSuggestion: result.routeSuggestion } : {}),
      });
    } catch (err) {
      next(err);
    }
  },
);

proposalsRouter.post(
  '/api/v1/proposals/:id/reject',
  requireSession,
  idempotent,
  async (req, res, next) => {
    try {
      const row = await getProposal(req.db, req.params.id);
      if (!row) {
        res.status(404).json({ error: 'proposal not found' });
        return;
      }
      if (!(await isMember(req.db, row.groupId, req.userId!))) {
        res.status(403).json({ error: 'not a member' });
        return;
      }
      const updated = await rejectProposal(req.db, {
        id: row.id,
        resolvedByUserId: req.userId!,
      });
      if (!updated) {
        res.status(404).json({ error: 'proposal not found' });
        return;
      }
      for (const id of updated.affected) {
        sseHub.broadcast(row.groupId, SSE.proposalResolved, { id, status: 'rejected' });
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

/**
 * ADR 0346 phase 5 - "Send Rob an invite, or wait for his?" answered wait:
 * the card goes, the slot is held until his invitation arrives.
 */
proposalsRouter.post('/api/v1/proposals/:id/wait-for-invite', requireSession, async (req, res, next) => {
  try {
    const out = await waitForTheirInvite(req.db, req.userId!, { proposalId: req.params.id });
    if (!out.ok) {
      res.status(out.reason === 'not_found' ? 404 : 422).json({ error: out.reason });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * ADR 0346 - the user answers a question the card asked: is this the same
 * meeting, or can this block of yours move? Remembered so it is asked once.
 */
proposalsRouter.post('/api/v1/proposals/:id/overlap', requireSession, async (req, res, next) => {
  try {
    const parsed = OverlapAnswerRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(422).json({ error: 'invalid_args', message: parsed.error.message });
      return;
    }
    const out = await recordOverlapAnswer(req.db, req.userId!, req.params.id, parsed.data.eventId, parsed.data.answer);
    if (!out.ok) {
      res.status(out.reason === 'not_found' ? 404 : 422).json({ error: out.reason });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * ADR 0104 — answer a calendar invitation.
 *
 * Not a variant of confirm: a decline resolves the proposal without creating
 * anything, and every answer has to reach the organizer before we record
 * anything locally. If the RSVP fails the proposal stays pending, so the user
 * sees an unanswered invitation rather than a Chord row implying they replied.
 */
proposalsRouter.post(
  '/api/v1/proposals/:id/rsvp',
  requireSession,
  async (req, res, next) => {
    try {
      const row = await getProposal(req.db, req.params.id);
      if (!row) {
        res.status(404).json({ error: 'proposal not found' });
        return;
      }
      if (!(await isMember(req.db, row.groupId, req.userId!))) {
        res.status(403).json({ error: 'not a member' });
        return;
      }
      const parsed = RsvpProposalRequest.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(422).json({ error: 'invalid_args', message: parsed.error.message });
        return;
      }
      const args = JSON.parse(row.argsJson || '{}') as {
        externalUid?: string;
        alreadyInGoogle?: boolean;
        organizerEmail?: string;
        title?: string;
      };
      if (row.toolName !== 'create_event' || !args.alreadyInGoogle || !args.externalUid) {
        res.status(422).json({ error: 'not_an_invitation' });
        return;
      }

      const rsvp = await respondToInvite(req.db, req.userId!, {
        icalUid: args.externalUid,
        response: parsed.data.response,
        organizerEmail: args.organizerEmail ?? null,
        title: args.title ?? null,
        provenance: row.provenance,
      });
      if (!rsvp.ok) {
        // The reason IS the error here: `request()` on the client surfaces
        // only the `error` field, and each reason has a different next step.
        res.status(502).json({ error: rsvp.reason ?? 'rsvp_failed' });
        return;
      }

      // Declining answers the organizer and closes the suggestion; there is no
      // event to record. The Google pull's selfDeclined branch keeps it that
      // way if the invitation later syncs.
      if (parsed.data.response === 'declined') {
        const rejected = await rejectProposal(req.db, {
          id: row.id,
          resolvedByUserId: req.userId!,
        });
        for (const id of rejected?.affected ?? []) {
          sseHub.broadcast(row.groupId, SSE.proposalResolved, { id, status: 'rejected' });
        }
        res.json({ rsvp: parsed.data.response, via: rsvp.via, created: false });
        return;
      }

      const result = await confirmProposal(req.db, {
        id: row.id,
        resolvedByUserId: req.userId!,
        inviteAnswered: true,
      });
      if (!result.ok) {
        // The organizer HAS been answered; only the local copy failed. Say so
        // rather than reporting the whole thing as a failure (ADR 0102).
        res.status(500).json({ error: 'recorded_remotely_only', reason: result.reason });
        return;
      }
      for (const id of result.affected) {
        sseHub.broadcast(row.groupId, SSE.proposalResolved, { id, status: 'confirmed' });
      }
      res.json({
        rsvp: parsed.data.response,
        via: rsvp.via,
        created: true,
        proposal: result.proposal,
        summary: result.summary,
      });
    } catch (err) {
      next(err);
    }
  },
);
