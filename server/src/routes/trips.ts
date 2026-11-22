import { Router } from 'express';

import { API, AddReservationRequest, SSE, UndoMergeTripsRequest, UpdateTripRequest } from '@chord/kernel';

import { loadSession, requireSession } from '../middleware/auth.js';
import { requireMember } from '../middleware/require-member.js';
import { isMember } from '../services/groups.service.js';
import {
  addReservation,
  deleteTrip,
  getAccommodationWithGroup,
  getTrip,
  getTravelLegWithGroup,
  listTripStatusesForGroup,
  listTripStatusesForUser,
  maybeDeleteEmptyTrip,
  mergeTrips,
  moveAccommodation,
  moveTravelLeg,
  removeAccommodation,
  removeTravelLeg,
  restoreTrip,
  undoMergeTrips,
  updateTrip,
} from '../services/trips.service.js';
import { sseHub } from '../services/sse.hub.js';
import { attachTripSourceLinks } from '../services/trips/source-links.js';

export const tripsRouter = Router();

tripsRouter.use(loadSession);

tripsRouter.get(
  '/api/v1/groups/:id/trips',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      res.json(await attachTripSourceLinks(req.db, req.userId!, await listTripStatusesForGroup(req.db, req.params.id)));
    } catch (err) {
      next(err);
    }
  },
);

tripsRouter.get(
  API.meTrips,
  requireSession,
  async (req, res, next) => {
    try {
      res.json(await attachTripSourceLinks(req.db, req.userId!, await listTripStatusesForUser(req.db, req.userId!)));
    } catch (err) {
      next(err);
    }
  },
);

tripsRouter.delete(
  '/api/v1/groups/:id/trips/:tripId',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      // requireMember gates :id; also bind the trip to that group so a member
      // of group A can't delete group B's trip by passing B's id under A's path.
      const trip = await getTrip(req.db, req.params.tripId);
      if (!trip || trip.groupId !== req.params.id) {
        res.status(404).json({ error: 'trip not found' });
        return;
      }
      const deleted = await deleteTrip(req.db, req.params.tripId);
      if (!deleted) { res.status(404).json({ error: 'trip not found' }); return; }
      sseHub.broadcast(req.params.id, SSE.tripDeleted, { id: req.params.tripId });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

tripsRouter.patch(
  '/api/v1/groups/:id/trips/:tripId',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      const trip = await getTrip(req.db, req.params.tripId);
      if (!trip || trip.groupId !== req.params.id) {
        res.status(404).json({ error: 'trip not found' });
        return;
      }
      const parsed = UpdateTripRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
        return;
      }
      let updated;
      try {
        updated = await updateTrip(req.db, req.params.tripId, parsed.data);
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
        return;
      }
      if (!updated) { res.status(404).json({ error: 'trip not found' }); return; }
      sseHub.broadcast(req.params.id, SSE.tripUpdated, updated);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

tripsRouter.post(
  '/api/v1/groups/:id/trips/:tripId/restore',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      const trip = await getTrip(req.db, req.params.tripId);
      if (!trip || trip.groupId !== req.params.id) {
        res.status(404).json({ error: 'trip not found' });
        return;
      }
      const restored = await restoreTrip(req.db, req.params.tripId);
      if (!restored) { res.status(404).json({ error: 'trip not found' }); return; }
      const fresh = await getTrip(req.db, req.params.tripId);
      sseHub.broadcast(req.params.id, SSE.tripUpdated, fresh!);
      res.json(fresh);
    } catch (err) {
      next(err);
    }
  },
);

// Folds `mergeTripId`'s legs/accommodations/reservations into :tripId (the
// drag target) and soft-deletes the source — the mobile drag-to-combine
// gesture on the Trips tab. Both trips must belong to :id; requireMember
// already gates that group, so this only has to check the SECOND trip
// (mergeTripId) against the same group rather than trusting the body.
tripsRouter.post(
  '/api/v1/groups/:id/trips/:tripId/merge',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      const mergeTripId = typeof req.body?.mergeTripId === 'string' ? req.body.mergeTripId : undefined;
      if (!mergeTripId) { res.status(400).json({ error: 'mergeTripId required' }); return; }
      const [keep, merge] = await Promise.all([
        getTrip(req.db, req.params.tripId),
        getTrip(req.db, mergeTripId),
      ]);
      if (!keep || keep.groupId !== req.params.id || !merge || merge.groupId !== req.params.id) {
        res.status(404).json({ error: 'trip not found' });
        return;
      }
      let result;
      try {
        result = await mergeTrips(req.db, req.params.id, req.params.tripId, mergeTripId);
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
        return;
      }
      if (!result) { res.status(404).json({ error: 'trip not found' }); return; }
      sseHub.broadcast(req.params.id, SSE.tripUpdated, result.status.trip);
      sseHub.broadcast(req.params.id, SSE.tripDeleted, { id: result.mergedTripId });
      res.json(result.status);
    } catch (err) {
      next(err);
    }
  },
);

// Reverses one specific `/merge` call — the mobile "Undo" toast for a
// mis-drop. :tripId is the keeper (same trip the merge was posted onto);
// the body's mergeTripId is the trip that got folded in and needs its rows
// (and itself) back. Same both-trips-in-:id check as /merge.
tripsRouter.post(
  '/api/v1/groups/:id/trips/:tripId/unmerge',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      const parsed = UndoMergeTripsRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
        return;
      }
      const [keep, merged] = await Promise.all([
        getTrip(req.db, req.params.tripId),
        getTrip(req.db, parsed.data.mergeTripId),
      ]);
      if (!keep || keep.groupId !== req.params.id || !merged || merged.groupId !== req.params.id) {
        res.status(404).json({ error: 'trip not found' });
        return;
      }
      const result = await undoMergeTrips(req.db, req.params.id, {
        keepTripId: req.params.tripId,
        ...parsed.data,
      });
      if (!result) { res.status(404).json({ error: 'trip not found' }); return; }
      sseHub.broadcast(req.params.id, SSE.tripUpdated, result.keep.trip);
      sseHub.broadcast(req.params.id, SSE.tripUpdated, result.restored.trip);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

tripsRouter.delete(
  '/api/v1/groups/:id/trips/:tripId/legs/:legId',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      const found = await getTravelLegWithGroup(req.db, req.params.legId);
      if (!found || found.groupId !== req.params.id || found.leg.tripId !== req.params.tripId) {
        res.status(404).json({ error: 'leg not found' });
        return;
      }
      await removeTravelLeg(req.db, req.params.legId);
      const tripDeleted = await maybeDeleteEmptyTrip(req.db, req.params.tripId);
      if (tripDeleted) {
        sseHub.broadcast(req.params.id, SSE.tripDeleted, { id: req.params.tripId });
      } else {
        sseHub.broadcast(req.params.id, SSE.tripUpdated, (await getTrip(req.db, req.params.tripId))!);
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

tripsRouter.delete(
  '/api/v1/groups/:id/trips/:tripId/accommodations/:accomId',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      const found = await getAccommodationWithGroup(req.db, req.params.accomId);
      if (!found || found.groupId !== req.params.id || found.accommodation.tripId !== req.params.tripId) {
        res.status(404).json({ error: 'accommodation not found' });
        return;
      }
      await removeAccommodation(req.db, req.params.accomId);
      const tripDeleted = await maybeDeleteEmptyTrip(req.db, req.params.tripId);
      if (tripDeleted) {
        sseHub.broadcast(req.params.id, SSE.tripDeleted, { id: req.params.tripId });
      } else {
        sseHub.broadcast(req.params.id, SSE.tripUpdated, (await getTrip(req.db, req.params.tripId))!);
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);

// Re-parent a single leg onto a DIFFERENT trip in the same group — the
// Trips tab's per-row drag gesture (split one item out of a merge, or fix a
// mis-filed leg, without moving the whole trip). Broadcasts the same way the
// DELETE routes above do: tripDeleted for a source trip the move emptied
// out, tripUpdated otherwise, plus tripUpdated for the target either way.
tripsRouter.post(
  '/api/v1/groups/:id/trips/:tripId/legs/:legId/move',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      const found = await getTravelLegWithGroup(req.db, req.params.legId);
      if (!found || found.groupId !== req.params.id || found.leg.tripId !== req.params.tripId) {
        res.status(404).json({ error: 'leg not found' });
        return;
      }
      const targetTripId = typeof req.body?.targetTripId === 'string' ? req.body.targetTripId : undefined;
      if (!targetTripId) { res.status(400).json({ error: 'targetTripId required' }); return; }
      const target = await getTrip(req.db, targetTripId);
      if (!target || target.groupId !== req.params.id) {
        res.status(404).json({ error: 'target trip not found' });
        return;
      }
      const result = await moveTravelLeg(req.db, req.params.id, req.params.legId, targetTripId);
      if (!result) { res.status(404).json({ error: 'leg not found' }); return; }
      if (result.sourceTripDeleted) {
        sseHub.broadcast(req.params.id, SSE.tripDeleted, { id: result.sourceTripId });
      } else if (result.sourceTripId !== targetTripId) {
        sseHub.broadcast(req.params.id, SSE.tripUpdated, (await getTrip(req.db, result.sourceTripId))!);
      }
      sseHub.broadcast(req.params.id, SSE.tripUpdated, (await getTrip(req.db, targetTripId))!);
      res.json(result.leg);
    } catch (err) {
      next(err);
    }
  },
);

tripsRouter.post(
  '/api/v1/groups/:id/trips/:tripId/accommodations/:accomId/move',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      const found = await getAccommodationWithGroup(req.db, req.params.accomId);
      if (!found || found.groupId !== req.params.id || found.accommodation.tripId !== req.params.tripId) {
        res.status(404).json({ error: 'accommodation not found' });
        return;
      }
      const targetTripId = typeof req.body?.targetTripId === 'string' ? req.body.targetTripId : undefined;
      if (!targetTripId) { res.status(400).json({ error: 'targetTripId required' }); return; }
      const target = await getTrip(req.db, targetTripId);
      if (!target || target.groupId !== req.params.id) {
        res.status(404).json({ error: 'target trip not found' });
        return;
      }
      const result = await moveAccommodation(req.db, req.params.id, req.params.accomId, targetTripId);
      if (!result) { res.status(404).json({ error: 'accommodation not found' }); return; }
      if (result.sourceTripDeleted) {
        sseHub.broadcast(req.params.id, SSE.tripDeleted, { id: result.sourceTripId });
      } else if (result.sourceTripId !== targetTripId) {
        sseHub.broadcast(req.params.id, SSE.tripUpdated, (await getTrip(req.db, result.sourceTripId))!);
      }
      sseHub.broadcast(req.params.id, SSE.tripUpdated, (await getTrip(req.db, targetTripId))!);
      res.json(result.accommodation);
    } catch (err) {
      next(err);
    }
  },
);

tripsRouter.post('/api/v1/trips/:tripId/reservations', requireSession, async (req, res, next) => {
  try {
    const trip = await getTrip(req.db, req.params.tripId);
    if (!trip || !(await isMember(req.db, trip.groupId, req.userId!))) {
      res.status(404).json({ error: 'trip not found' });
      return;
    }
    const parsed = AddReservationRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    // The checked trip wins: AddReservationRequest carries an optional
    // tripId (the bot path uses it), and spreading it last let a body
    // retarget the write onto a trip in a group the caller isn't in.
    const reservation = await addReservation(req.db, {
      ...parsed.data,
      tripId: req.params.tripId,
    });
    sseHub.broadcast(req.params.tripId, SSE.reservationCreated, reservation);
    res.status(201).json(reservation);
  } catch (err) {
    next(err);
  }
});
