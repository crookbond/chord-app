import { Router, type Request } from 'express';

import {
  API,
  ChangeEventGuestsRequest,
  EventAnswerRequest,
  CreateEventRequest,
  LiveEventIdsRequest,
  SSE,
  UpdateEventRequest,
  UpsertRsvpRequest,
  type EventAnswerResponse,
  type EventGuestsResponse,
  type EventVideoCallResponse,
  type LiveEventIdsResponse,
} from '@chord/kernel';

import { loadSession, requireSession } from '../middleware/auth.js';
import { requireMember } from '../middleware/require-member.js';
import { isMember } from '../services/groups.service.js';
import { resolveTargetCalendarId } from '../services/calendar-sources.service.js';
import { activeHolds, dropHold } from '../services/events/holds.service.js';
import { DEFAULT_FUTURE_DAYS, maybeSyncCalendar } from '../services/google/calendar.service.js';
import {
  autoRsvpCreator,
  createEvent,
  deleteEvent,
  getEvent,
  listEventCopies,
  listEventsForUser,
  listEventsForUserInGroup,
  listAllRsvpsForUser,
  liveEventIdsForUser,
  listRsvps,
  updateEvent,
  upsertRsvp,
  type EventWindow,
} from '../services/events.service.js';
import {
  addVideoCall,
  changeEventGuests,
  eventVideoCallOption,
  providerEventPeople,
  providerGuestEmails,
} from '../services/events/guests.service.js';
import { eventGuestAnswers } from '../services/events/guest-answers.js';
import { answerFamilyInvite } from '../services/events/answer-invite.js';
import { sseHub } from '../services/sse.hub.js';

export const eventsRouter = Router();

eventsRouter.use(loadSession);

// ADR 0346 phase 4 - slots held in Chord while an invitation is on its way.
// The user's own; never written to a calendar.
eventsRouter.get('/api/v1/me/holds', requireSession, async (req, res, next) => {
  try {
    res.json(await activeHolds(req.db, req.userId!));
  } catch (err) {
    next(err);
  }
});

eventsRouter.delete('/api/v1/me/holds/:meetingId', requireSession, async (req, res, next) => {
  try {
    const r = await dropHold(req.db, req.userId!, { meetingId: req.params.meetingId });
    if (!r.ok) {
      res.status(404).json({ error: r.reason });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** The calendar screen's look-ahead: always two years (owner call). */
const CALENDAR_FUTURE_DAYS = 730;
/** How often the calendar screen's focus may start a Google reconcile. */
const CALENDAR_SCREEN_SYNC_THROTTLE_MS = 60_000;

/** The throttle for the background reconcile `/me/events` starts. */
export function meEventsSyncThrottleMs(futureDays: number): number {
  return futureDays > DEFAULT_FUTURE_DAYS ? CALENDAR_SCREEN_SYNC_THROTTLE_MS : 180_000;
}
/** How far back an app that does not say (older builds) still sees. */
const CALENDAR_DEFAULT_PAST_DAYS = 365;
const CALENDAR_MAX_PAST_DAYS = 3650;

/**
 * The calendar screen's read window: `?pastDays=` as far back as the view the
 * app is showing, and a fixed two years forward. Not the bot/briefing default
 * (a week back, a month on) - a person paging through months needs them.
 */
async function calendarWindow(req: Request): Promise<EventWindow> {
  const asked = Number(req.query.pastDays);
  const pastDays =
    Number.isFinite(asked) && asked >= 0
      ? Math.min(Math.ceil(asked), CALENDAR_MAX_PAST_DAYS)
      : CALENDAR_DEFAULT_PAST_DAYS;
  const user = await req.db
    .selectFrom('users')
    .select('last_tz')
    .where('id', '=', req.userId!)
    .executeTakeFirst();
  return { pastDays, futureDays: CALENDAR_FUTURE_DAYS, tz: user?.last_tz ?? null };
}

eventsRouter.get(
  '/api/v1/groups/:id/events',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      // ADR 0040 §8 — per-viewer: the requester's own copies tagged for this
      // group (not a god-view of every member's copy).
      res.json(
        await listEventsForUserInGroup(req.db, req.userId!, req.params.id, await calendarWindow(req)),
      );
    } catch (err) {
      next(err);
    }
  },
);

eventsRouter.get(
  API.meEvents,
  requireSession,
  async (req, res, next) => {
    try {
      // Return the local DB IMMEDIATELY — events always render here, including
      // ones still pending a Google push. The Google reconcile (push + pull)
      // runs in the BACKGROUND so the calendar never blocks on a round-trip;
      // the client re-fetches (on focus / its explicit sync) to pick up pulled
      // changes and reverse-deletes. Throttled 180s; the calendar screen's
      // deeper ?futureDays=N (it always sends 730, ADR 0208) gets a shorter
      // 60s throttle, never none: unthrottled, every focus of that screen ran
      // a full two-way sync. Overlapping syncs join each other (syncTwoWay).
      const requested = Number(req.query.futureDays);
      const futureDays =
        Number.isFinite(requested) && requested > DEFAULT_FUTURE_DAYS
          ? requested
          : DEFAULT_FUTURE_DAYS;
      const windowMs = meEventsSyncThrottleMs(futureDays);
      res.json(await listEventsForUser(req.db, req.userId!, await calendarWindow(req)));
      void maybeSyncCalendar(req.db, req.userId!, windowMs, futureDays).catch(() => {});
    } catch (err) {
      next(err);
    }
  },
);

eventsRouter.post(API.meEventsLive, requireSession, async (req, res, next) => {
  try {
    const parsed = LiveEventIdsRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    const body: LiveEventIdsResponse = {
      live: await liveEventIdsForUser(req.db, req.userId!, parsed.data.ids),
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

eventsRouter.get(
  API.meRsvps,
  requireSession,
  async (req, res, next) => {
    try {
      res.json(await listAllRsvpsForUser(req.db, req.userId!));
    } catch (err) {
      next(err);
    }
  },
);

eventsRouter.post(
  '/api/v1/groups/:id/events',
  requireSession,
  requireMember,
  async (req, res, next) => {
    try {
      const parsed = CreateEventRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
        return;
      }
      // ADR 0040/0232 — the user's own default calendar, else primary. REST
      // clients don't name a calendar yet; that's the picker UI's job later.
      const pick = await resolveTargetCalendarId(req.db, { userId: req.userId! });
      const ev = await createEvent(req.db, {
        ...parsed.data,
        groupId: req.params.id,
        createdBy: req.userId!,
        googleCalendarId: pick.calendarId,
      });
      // ADR 0040 — per-owner SSE: one broadcast per fanned-out copy so each
      // member's client receives its own owner-tagged copy (not the creator's).
      for (const copy of await listEventCopies(req.db, ev.id)) {
        sseHub.broadcast(copy.groupId, SSE.eventCreated, copy);
      }
      const rsvp = await autoRsvpCreator(req.db, ev.id, req.userId!);
      if (rsvp) sseHub.broadcast(req.params.id, SSE.rsvpUpdated, rsvp);
      res.status(201).json(ev);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * ADR 0040 gives every member their own copy of a shared event, and an edit
 * or delete of the organizer's copy fans out to every sibling and pushes to
 * its owner's Google Calendar — so only the copy's owner may change it.
 * A legacy row with no owner predates per-owner copies and stays group-owned.
 */
async function mayChangeEvent(
  db: Parameters<typeof isMember>[0],
  ev: { groupId: string; ownerUserId?: string },
  userId: string,
): Promise<boolean> {
  if (!(await isMember(db, ev.groupId, userId))) return false;
  return !ev.ownerUserId || ev.ownerUserId === userId;
}

// ADR 0157 addendum — the event editor's guest list. Read from the calendar
// (ADR 0295: Chord keeps none); any member who can see the event may read it.
eventsRouter.get(API.eventGuests(':eventId'), requireSession, async (req, res, next) => {
  try {
    const ev = await getEvent(req.db, req.params.eventId);
    if (!ev || !(await isMember(req.db, ev.groupId, req.userId!))) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const people = await providerEventPeople(req.db, ev.id);
    // ADR 0319 — what this event's calendar can be given, so the editor
    // offers "Add Google Meet" only where it would work.
    const videoCall = await eventVideoCallOption(req.db, ev.id);
    // ADR 0328 — who has answered, from the organizer's copy, so a member
    // sees it on their own copy too.
    const answers = await eventGuestAnswers(req.db, ev.id, req.userId!);
    const body: EventGuestsResponse =
      people === undefined
        ? { guests: [], organizer: null, videoCall }
        : {
            guests: people?.guests ?? null,
            organizer: people?.organizer ?? null,
            videoCall,
            // ADR 0331 — the calendar's own join link (Meet / Teams), for the event view.
            videoCallLink: people?.videoCallLink ?? null,
          };
    if (answers.length > 0) body.answers = answers;
    // ADR 0328 — the viewer's own invitation, which they can answer here.
    const mine = await req.db
      .selectFrom('events')
      .select('invite_email')
      .where('id', '=', ev.id)
      .where('owner_user_id', '=', req.userId!)
      .executeTakeFirst();
    if (mine?.invite_email) {
      const invitedAt = mine.invite_email.toLowerCase();
      body.myInvite = { response: answers.find((a) => a.email === invitedAt)?.response ?? 'needsAction' };
    }
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// ADR 0328 — a family member answers their invitation: through their own
// calendar, else a reply mailed to the organizer. Same service as the bot's
// answer_invitation.
eventsRouter.post(API.eventAnswer(':eventId'), requireSession, async (req, res, next) => {
  try {
    const parsed = EventAnswerRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    const ev = await getEvent(req.db, req.params.eventId);
    if (!ev || !(await isMember(req.db, ev.groupId, req.userId!))) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const r = await answerFamilyInvite(req.db, {
      eventId: ev.id,
      userId: req.userId!,
      response: parsed.data.response,
    });
    if (r.ok && r.removed) {
      sseHub.broadcast(ev.groupId, SSE.eventDeleted, { id: ev.id, ownerUserId: req.userId! });
    }
    const body: EventAnswerResponse = r.ok
      ? { ok: true, response: r.response, via: r.via, removed: r.removed }
      : { ok: false, reason: r.reason };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// Same service as the bot's update_event invitees/removeInvitees, so a guest
// added here and one added in chat are the same act. A refusal is a 200 with
// `reason`, never a claim that someone was invited.
eventsRouter.post(API.eventGuests(':eventId'), requireSession, async (req, res, next) => {
  try {
    const ev = await getEvent(req.db, req.params.eventId);
    if (!ev || !(await isMember(req.db, ev.groupId, req.userId!))) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const parsed = ChangeEventGuestsRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    const r = await changeEventGuests(req.db, {
      eventId: ev.id,
      actorUserId: req.userId!,
      add: parsed.data.add,
      remove: parsed.data.remove,
    });
    const guests = await providerGuestEmails(req.db, ev.id);
    const body: EventGuestsResponse = r.ok
      ? { guests, added: r.added, removed: r.removed }
      : { guests, reason: r.reason };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// ADR 0317/0323 — same service as the bot's create_event/update_event
// videoCall, so the button and the chat add the same kind of call.
eventsRouter.post(API.eventVideoCall(':eventId'), requireSession, async (req, res, next) => {
  try {
    const ev = await getEvent(req.db, req.params.eventId);
    if (!ev || !(await isMember(req.db, ev.groupId, req.userId!))) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const r = await addVideoCall(req.db, { eventId: ev.id, actorUserId: req.userId! });
    // ADR 0323 — `kind` so the app names what was really added, rather than
    // the button's own guess about this calendar.
    const body: EventVideoCallResponse = r.ok
      ? { link: r.link, kind: r.kind }
      : { link: null, reason: r.reason };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

eventsRouter.get('/api/v1/events/:eventId/rsvps', requireSession, async (req, res, next) => {
  try {
    const ev = await getEvent(req.db, req.params.eventId);
    if (!ev || !(await isMember(req.db, ev.groupId, req.userId!))) {
      res.status(404).json({ error: 'event not found' });
      return;
    }
    res.json(await listRsvps(req.db, ev.id));
  } catch (err) {
    next(err);
  }
});

eventsRouter.patch('/api/v1/events/:eventId', requireSession, async (req, res, next) => {
  try {
    const ev = await getEvent(req.db, req.params.eventId);
    if (!ev || !(await mayChangeEvent(req.db, ev, req.userId!))) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const parsed = UpdateEventRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    const updated = await updateEvent(req.db, ev.id, parsed.data);
    if (updated) {
      // Per-owner SSE: an organizer edit fans across every sibling copy — emit
      // one eventUpdated per copy so each member's client gets its own.
      for (const copy of await listEventCopies(req.db, ev.id)) {
        sseHub.broadcast(copy.groupId, SSE.eventUpdated, copy);
      }
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

eventsRouter.delete('/api/v1/events/:eventId', requireSession, async (req, res, next) => {
  try {
    const ev = await getEvent(req.db, req.params.eventId);
    if (!ev || !(await mayChangeEvent(req.db, ev, req.userId!))) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    // deleteEvent returns exactly the copies it removed (all siblings for an
    // organizer delete, just one for an attendee) — broadcast each so every
    // affected member's client drops its own copy.
    for (const r of await deleteEvent(req.db, ev.id)) {
      sseHub.broadcast(ev.groupId, SSE.eventDeleted, { id: r.id, ownerUserId: r.ownerUserId ?? undefined });
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

eventsRouter.post('/api/v1/events/:eventId/rsvps', requireSession, async (req, res, next) => {
  try {
    const ev = await getEvent(req.db, req.params.eventId);
    if (!ev || !(await isMember(req.db, ev.groupId, req.userId!))) {
      res.status(404).json({ error: 'event not found' });
      return;
    }
    const parsed = UpsertRsvpRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    // An RSVP may name the caller or a fellow member (the bot's record_rsvp
    // does the same); anyone else is a user id the caller has no claim on.
    const forUser = parsed.data.userId;
    if (forUser && forUser !== req.userId && !(await isMember(req.db, ev.groupId, forUser))) {
      res.status(403).json({ error: 'userId is not a member of this group' });
      return;
    }
    const rsvp = await upsertRsvp(req.db, { ...parsed.data, eventId: ev.id });
    sseHub.broadcast(ev.groupId, SSE.rsvpUpdated, rsvp);
    res.status(201).json(rsvp);
  } catch (err) {
    next(err);
  }
});
