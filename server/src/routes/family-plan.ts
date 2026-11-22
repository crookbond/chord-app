/**
 * ADR 0231 — the family plan's roster. Account-level (not group-scoped): the
 * owner's roster is theirs alone, so every route is keyed on the session user
 * and an id that isn't theirs reads as not found.
 */
import { Router } from 'express';

import {
  API,
  AcceptFamilyInviteRequest,
  AddFamilyMemberRequest,
  SSE,
  ShareEmailToGroupRequest,
  UpdateFamilyMemberRequest,
  type ShareEmailToGroupResult,
} from '@chord/kernel';

import { loadSession, requireSession } from '../middleware/auth.js';
import {
  acceptFamilyInvite,
  addFamilyMember,
  getFamilyOverview,
  inviteFamilyMember,
  leaveFamily,
  removeFamilyMember,
  updateFamilyMember,
  type FamilyFailure,
} from '../services/family-plan.service.js';

import { familyGroupIdFor } from '../services/family-group.service.js';
import { shareEmailThreadToGroup } from '../services/group-share.service.js';
import { sseHub } from '../services/sse.hub.js';

export const familyPlanRouter = Router();

familyPlanRouter.use(loadSession);

const STATUS: Record<FamilyFailure, number> = {
  not_found: 404,
  invalid_email: 400,
  invalid_code: 400,
  need_contact: 400,
  no_seats: 409,
  already_active: 409,
  own_invite: 409,
  already_in_family: 409,
  owns_family: 409,
};

familyPlanRouter.get(API.meFamily, requireSession, async (req, res, next) => {
  try {
    res.json(await getFamilyOverview(req.db, req.userId!));
  } catch (err) {
    next(err);
  }
});

familyPlanRouter.post(API.meFamily, requireSession, async (req, res, next) => {
  try {
    const parsed = AddFamilyMemberRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const out = await addFamilyMember(req.db, req.userId!, parsed.data);
    if (!out.ok) {
      res.status(STATUS[out.reason]).json({ error: out.reason });
      return;
    }
    res.status(201).json(out.invite ?? { member: out.member });
  } catch (err) {
    next(err);
  }
});

familyPlanRouter.patch(API.meFamilyMember(':id'), requireSession, async (req, res, next) => {
  try {
    const parsed = UpdateFamilyMemberRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', detail: parsed.error.flatten() });
      return;
    }
    const out = await updateFamilyMember(req.db, req.userId!, req.params.id, parsed.data);
    if (!out.ok) {
      res.status(STATUS[out.reason]).json({ error: out.reason });
      return;
    }
    res.json(out.member);
  } catch (err) {
    next(err);
  }
});

familyPlanRouter.delete(API.meFamilyMember(':id'), requireSession, async (req, res, next) => {
  try {
    const out = await removeFamilyMember(req.db, req.userId!, req.params.id);
    if (!out.ok) {
      res.status(STATUS[out.reason]).json({ error: out.reason });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

familyPlanRouter.post(API.meFamilyInvite(':id'), requireSession, async (req, res, next) => {
  try {
    const out = await inviteFamilyMember(req.db, req.userId!, req.params.id);
    if (!out.ok) {
      res.status(STATUS[out.reason]).json({ error: out.reason });
      return;
    }
    res.json(out);
  } catch (err) {
    next(err);
  }
});

familyPlanRouter.post(API.meFamilyAccept, requireSession, async (req, res, next) => {
  try {
    const parsed = AcceptFamilyInviteRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const out = await acceptFamilyInvite(req.db, req.userId!, parsed.data.code);
    if (!out.ok) {
      res.status(STATUS[out.reason]).json({ error: out.reason });
      return;
    }
    res.json({ ownerName: out.ownerName, groupId: out.groupId });
  } catch (err) {
    next(err);
  }
});

/** ADR 0234 - share an email into the family chat (or another group the
 *  caller is in). Mounted here, ahead of the mail router, because it is about
 *  who the email is shown to rather than about the mailbox. */
familyPlanRouter.post(API.meEmailThreadShare(':id'), requireSession, async (req, res, next) => {
  try {
    const parsed = ShareEmailToGroupRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const groupId = parsed.data.groupId ?? (await familyGroupIdFor(req.db, req.userId!));
    if (!groupId) {
      res.status(404).json({ error: 'no_family_group' });
      return;
    }
    const me = await req.db.selectFrom('users').select('last_tz').where('id', '=', req.userId!).executeTakeFirst();
    const out = await shareEmailThreadToGroup(req.db, req.userId!, groupId, req.params.id, {
      note: parsed.data.note,
      tz: me?.last_tz ?? null,
    });
    if (!out.ok) {
      res.status(out.reason === 'not_member' ? 403 : 404).json({ error: out.reason });
      return;
    }
    sseHub.broadcast(groupId, SSE.message, out.message);
    const group = await req.db.selectFrom('groups').select('name').where('id', '=', groupId).executeTakeFirst();
    const body: ShareEmailToGroupResult = { groupId, groupName: group?.name ?? 'Family' };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

familyPlanRouter.post(API.meFamilyLeave, requireSession, async (req, res, next) => {
  try {
    const out = await leaveFamily(req.db, req.userId!);
    if (!out.ok) {
      res.status(STATUS[out.reason]).json({ error: out.reason });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
