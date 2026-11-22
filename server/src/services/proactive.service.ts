import { sql, type Kysely } from 'kysely';

import type { BotCard, GroupEvent, Task, Trip } from '@chord/kernel';
import { SSE, isTaskStale } from '@chord/kernel';

import { env } from '../config/env.js';
import { logger } from '../config/logging.js';
import type {
  DB,
  MessagesTable,
  ProactiveMessageKind,
  ProactiveMessagesTable,
  TaskArchivedReason,
} from '../db/schema.js';
import { mapConcurrent } from '../utils/concurrency.js';
import { newId } from '../utils/ids.js';
import { likeContains } from '../utils/like.js';
import { getDefaultPersona } from './bot-personas.service.js';
import { buildEmailDigestBody } from './email/digest.service.js';
import { buildPendingProposalsSection } from './proposals.service.js';
import { whoseTrips } from './trips/whose-trip.js';
import { recordPendingTripTravelers } from './bot/pending-trip-travelers.js';
import { tripGapsToMention } from './briefing/trip-gaps.js';
import { maybeRefreshTicketFreeBusy } from './trips/ticket-free-busy.js';
import {
  eventClashesWithTrip,
  eventsClash,
  loadEventPeople,
  loadTripTravelers,
  ticketsForOthers,
  ticketTravelers,
  ticketTrips,
  tripsClash,
  type OverlapSide,
} from './trips/trip-conflict.js';
import { getEntitlement } from './billing.service.js';
import { hasAiConsent } from './ai-consent.service.js';
import { hasGmailScope, maybeSyncGmail, withMailSyncRound } from './google/gmail.service.js';
import { sweepMailboxes } from './email/mirror-sweep.js';
import { flushReadWrites } from './email/read-writes.js';
import { maybePruneOldRows } from './retention.service.js';
import { maybeCleanupMemories } from './memory-cleanup.service.js';
import { maybeDrainAiBacklog } from './ai-backlog-runners.js';
import { sweepCalendars } from './google/calendar-sweep.js';
import { sweepEmbeddings } from './search/embed-pass.js';
import { sweepReportEmails } from './reports.service.js';
import { topUpSeries } from './events/series.service.js';
import { expireIncidentalAttachments, expireExpiredItineraryAttachments } from './attachments.service.js';
import { maybeSyncAccounts } from './email-accounts/accounts.service.js';
import { eventBlocksTime, loadBusyContext } from './calendar-sources.service.js';
import { computeConflicts, effectiveEndMs, overlaps } from './conflicts.service.js';
import { computeTransparency, DEFAULT_EVENT_DURATION_MS } from './google/two-way-sync.js';
import { TRAVEL_LEG_EXTERNAL_UID_PREFIX } from './events/same-event.js';
import { GoogleAuthError, getAccessToken } from './google/oauth.service.js';
import { buildToolDefs, isToolName, toolSchemas, type ToolName } from './bot/tools.js';
import { listContacts } from './personal.service.js';
import { eventOverlapsRange, eventStartInstant, listEventsForUser, zonedDayRange } from './events.service.js';
import { instantMs, textInstant } from '../db/text-instant.js';
import { getLlmForUser } from './llm/factory.js';
import { byokFallback, describeByokKeyIssue } from './llm/key-health.js';
import { familyFactsForContext } from './memory.service.js';
import { listImportantDayOccurrences } from './people.service.js';
import type {
  LlmMessage,
  LlmService,
  LlmToolCall,
  LlmToolDef,
} from './llm/types.js';
import { rowToMessage } from './messages.service.js';
import { listSavesForUser } from './saves.service.js';
import { buildBriefingFacts, weatherLineForUser } from './briefing/facts.js';
import { collectCelebrations, renderCelebrationsSection } from './briefing/celebrations.js';
import { renderRetiredSection, RETIRED_WINDOW_MS, retiredTodosSince } from './briefing/retired-todos.js';
import { activeHolds, renderWaitingSection } from './events/holds.service.js';
import { waitingOnAnswers } from './email/meetings.service.js';
import {
  type BriefingParts,
  cleanScanText,
  composeBriefing,
  firstOfEach,
  SCAN_NOTHING_TOKEN,
  sameWordsKey,
} from './briefing/compose.js';
import { weatherDriftQuestion } from './geo/location.js';
import { renderTeaser } from './briefing/render.js';
import {
  dayOf,
  daysBetween,
  eventLocalDays,
  fmtTimeOnly,
  hasZone,
  instantInZoneMs,
  isAllDayValue,
  localWhen,
  weekdayOf,
  zonedWallToUtcMs,
} from '../utils/tz.js';
import { sseHub } from './sse.hub.js';
import { isDueInFuture, listTasksForUser } from './tasks.service.js';

/**
 * The subset of `ProactiveMessageKind` that is a SCHEDULED row in
 * `proactive_messages`. Derived rather than restated so the two cannot drift:
 * every kind here also has to be nameable on the message it produces, which is
 * what the publishers read (ADR 0137).
 */
export type ProactiveKind = Extract<
  ProactiveMessageKind,
  | 'task_remind'
  | 'event_created_nudge'
  | 'daily_morning_scan'
  | 'email_digest'
  | 'trip_cancellation'
  | 'email_change_notice'
>;

export interface EmailDigestPayload {
  userId: string;
}

export interface TaskRemindPayload {
  taskId: string;
  title: string;
  cue: string | null;
}

export interface EventCreatedNudgePayload {
  // The newly created entity that triggered the hook.
  kind: 'event' | 'trip';
  title: string;
  when: string;        // ISO date or datetime
  location?: string;
  // Group the event lives in — used in the LLM prompt to give context.
  sourceGroupId: string;
  sourceGroupName: string;
  // Stable references so the nudge renderer can pull neighbor context
  // (other events ±2 days, overlapping trips, open tasks).
  actorUserId: string;
  eventId?: string;
  tripId?: string;
}

/**
 * ADR 0169 — a cancellation email closes out ONE booking on a trip that may
 * have others (a hotel cancelled while the flights stand, or vice versa).
 * `cancelledItems`/`remainingItems` are already formatted at enqueue time
 * (`describeAccommodation`/`describeLeg`) so rendering needs no DB read and
 * no LLM call — the fact is fully known the moment `applyCancellation` runs.
 */
export interface TripCancellationPayload {
  tripId: string;
  tripName: string;
  destination: string;
  cancelledItems: string[];
  /** Empty means the whole trip is now cancelled — nothing left to flag. */
  remainingItems: string[];
}

/**
 * ADR 0248 — an email changed something Chord holds (a booking cancelled or
 * moved, a bill paid). The sentence is built at enqueue time
 * (`email-changes.service.ts`), so rendering needs no DB read and no LLM call.
 */
export interface EmailChangeNoticePayload {
  text: string;
}

export interface DailyMorningScanPayload {
  userId: string;
  // The day this scan was scheduled for, in YYYY-MM-DD. Used to dedupe
  // re-seeding on restart.
  scanDate: string;
}

/** An offset-bearing instant as UTC "…Z"; a floating value is left as-is
 *  rather than guessed into some zone. */
function toUtcIso(iso: string): string {
  if (!hasZone(iso)) return iso;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : iso;
}

/** Queue a proactive nudge derived from a task's remind_at. No-op if absent. */
export async function enqueueFromTask(
  db: Kysely<DB>,
  task: Task,
): Promise<void> {
  if (!task.remindAt) return;
  const payload: TaskRemindPayload = {
    taskId: task.id,
    title: task.title,
    cue: task.remindCue ?? null,
  };
  const row: ProactiveMessagesTable = {
    id: newId('pm'),
    group_id: task.groupId,
    persona_id: task.assigneeId ?? null,
    kind: 'task_remind',
    payload: JSON.stringify(payload),
    // The drain compares scheduled_for to a UTC "…Z" string as text, and a
    // bot-set remindAt carries the user's offset ("…T07:00:00-04:00"), which
    // would fire at 07:00Z. Store the instant in UTC like every other row.
    scheduled_for: toUtcIso(task.remindAt),
    fired_at: null,
    created_at: new Date().toISOString(),
  };
  await db.insertInto('proactive_messages').values(row).execute();
  logger.info(`proactive enqueued ${row.id} for task ${task.id} at ${task.remindAt}`);
}

/** Queue an immediate post-create nudge after the bot creates an event/trip. */
export async function enqueueEventNudge(
  db: Kysely<DB>,
  args: {
    actorUserId: string;
    sourceGroupId: string;
    payload:
      | { kind: 'event'; event: GroupEvent }
      | { kind: 'trip'; trip: Trip };
  },
): Promise<void> {
  const personalGroupId = await findPersonalGroupId(db, args.actorUserId);
  if (!personalGroupId) {
    logger.warn('enqueueEventNudge: no personal group for user', { userId: args.actorUserId });
    return;
  }
  const sourceGroup = await db
    .selectFrom('groups')
    .select('name')
    .where('id', '=', args.sourceGroupId)
    .executeTakeFirst();
  const sourceGroupName = sourceGroup?.name ?? 'a group';
  const payload: EventCreatedNudgePayload =
    args.payload.kind === 'event'
      ? {
          kind: 'event',
          title: args.payload.event.title,
          when: args.payload.event.startsAt,
          location: args.payload.event.location,
          sourceGroupId: args.sourceGroupId,
          sourceGroupName,
          actorUserId: args.actorUserId,
          eventId: args.payload.event.id,
        }
      : {
          kind: 'trip',
          title: args.payload.trip.name,
          when: `${args.payload.trip.startDate} → ${args.payload.trip.endDate} (${args.payload.trip.destination})`,
          sourceGroupId: args.sourceGroupId,
          sourceGroupName,
          actorUserId: args.actorUserId,
          tripId: args.payload.trip.id,
        };
  const row: ProactiveMessagesTable = {
    id: newId('pm'),
    group_id: personalGroupId,
    persona_id: args.actorUserId,
    kind: 'event_created_nudge',
    payload: JSON.stringify(payload),
    scheduled_for: new Date().toISOString(),
    fired_at: null,
    created_at: new Date().toISOString(),
  };
  await db.insertInto('proactive_messages').values(row).execute();
  logger.info(`proactive enqueued event_created_nudge ${row.id} for user ${args.actorUserId}`);
}

/**
 * ADR 0169 — queue an immediate nudge after a cancellation email closes out
 * part of a trip, so the family notices a booking that fell through even if
 * nobody opens the Trips tab. `remainingItems` empty means the whole trip
 * cancelled with it — nothing to flag, so callers should not call this at all
 * in that case (see `applyCancellation`).
 */
export async function enqueueTripCancellationNudge(
  db: Kysely<DB>,
  args: {
    actorUserId: string;
    groupId: string;
    payload: TripCancellationPayload;
  },
): Promise<void> {
  const row: ProactiveMessagesTable = {
    id: newId('pm'),
    group_id: args.groupId,
    persona_id: args.actorUserId,
    kind: 'trip_cancellation',
    payload: JSON.stringify(args.payload),
    scheduled_for: new Date().toISOString(),
    fired_at: null,
    created_at: new Date().toISOString(),
  };
  await db.insertInto('proactive_messages').values(row).execute();
  logger.info(`proactive enqueued trip_cancellation ${row.id} for user ${args.actorUserId}`);
}

/**
 * Queue an email insights digest for a user (ADR 0063). Idempotent: a no-op if
 * one is already pending, so riding the daily scan can't pile them up.
 */
export async function enqueueEmailDigest(
  db: Kysely<DB>,
  userId: string,
  scheduledFor: string = new Date().toISOString(),
): Promise<void> {
  const personalGroupId = await findPersonalGroupId(db, userId);
  if (!personalGroupId) return;
  const pending = await db
    .selectFrom('proactive_messages')
    .select('id')
    .where('kind', '=', 'email_digest')
    .where('persona_id', '=', userId)
    .where('fired_at', 'is', null)
    .executeTakeFirst();
  if (pending) return;
  const payload: EmailDigestPayload = { userId };
  const row: ProactiveMessagesTable = {
    id: newId('pm'),
    group_id: personalGroupId,
    persona_id: userId,
    kind: 'email_digest',
    payload: JSON.stringify(payload),
    scheduled_for: scheduledFor,
    fired_at: null,
    created_at: new Date().toISOString(),
  };
  await db.insertInto('proactive_messages').values(row).execute();
  logger.info(`proactive enqueued email_digest ${row.id} for user ${userId}`);
}

async function renderEmailDigest(db: Kysely<DB>, payload: string): Promise<string | null> {
  try {
    const p = JSON.parse(payload) as EmailDigestPayload;
    return await buildEmailDigestBody(db, p.userId);
  } catch (err) {
    logger.warn('proactive render failed', { err, kind: 'email_digest' });
    return null;
  }
}

// Tappable reconnect target. Native app first (routes to Settings and
// surfaces the Connect-Google-Calendar flow), web fallback for bridged
// surfaces. Mobile's action-card renderer tries appUrl, then url.
const RECONNECT_DEEP_LINK_APP = 'chord://settings?reconnect=calendar';
const RECONNECT_DEEP_LINK_WEB = 'https://chordapp.ai/settings?reconnect=calendar';
const GMAIL_RECONNECT_DEEP_LINK_APP = 'chord://settings?reconnect=gmail';
const GMAIL_RECONNECT_DEEP_LINK_WEB = 'https://chordapp.ai/settings?reconnect=gmail';

/**
 * Warn a user, once per disconnect, that their Google Calendar connection has
 * silently died so they can reconnect. Posts an actionable bot message (with a
 * deep-link action card) into their personal group.
 *
 * Gated by:
 *  - `google_connected_at` set — they were connected and didn't intentionally
 *    disconnect (the disconnect route clears it), and
 *  - `calendar_reconnect_nudged_at` null — not already warned this disconnect
 *    (cleared on reconnect by persistRefreshToken).
 * A live refresh token is probed via getAccessToken (which itself clears a dead
 * token); a transient failure does NOT nudge. Returns true if it warned.
 */
export async function maybeNudgeCalendarReconnect(
  db: Kysely<DB>,
  userId: string,
): Promise<boolean> {
  const u = await db
    .selectFrom('users')
    .select(['google_connected_at', 'calendar_reconnect_nudged_at', 'refresh_token_ciphertext'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!u || !u.google_connected_at || u.calendar_reconnect_nudged_at) return false;

  let disconnected = false;
  if (u.refresh_token_ciphertext) {
    try {
      await getAccessToken(db, userId); // healthy → still connected
    } catch (err) {
      if (err instanceof GoogleAuthError && err.needsReconnect) disconnected = true;
      else return false; // transient (network / 5xx) — don't cry wolf
    }
  } else {
    disconnected = true; // was connected, token already gone
  }
  if (!disconnected) return false;

  const personalGroupId = await findPersonalGroupId(db, userId);
  if (!personalGroupId) return false;

  const card: BotCard = {
    kind: 'action',
    title: 'Reconnect Google Calendar',
    subtitle: 'Opens Settings → Connect',
    url: RECONNECT_DEEP_LINK_WEB,
    appUrl: RECONNECT_DEEP_LINK_APP,
  };
  const nowIso = new Date().toISOString();
  const msg: MessagesTable = {
    id: newId('m'),
    group_id: personalGroupId,
    sender_id: null,
    kind: 'bot',
    body: '⚠️ Your Google Calendar disconnected — reconnect to keep your events in sync. Anything you add in Chord meanwhile will sync once you reconnect.',
    attachment_id: null,
    reply_to_id: null,
    mentions_bot: 0,
    created_at: nowIso,
    source: null,
    external_message_id: null,
    chord_visible: 1,
    mentions_others: 0,
    auto_mirror: 1,
    bot_persona_id: getDefaultPersona().id,
    is_proactive: 1,
    proactive_kind: 'calendar_reconnect',
  };
  const cardsJson = JSON.stringify([card]);
  await db.insertInto('messages').values(msg).execute();
  await db
    .insertInto('message_cards')
    .values({ message_id: msg.id, cards_json: cardsJson, created_at: nowIso })
    .execute();
  await db
    .updateTable('users')
    .set({ calendar_reconnect_nudged_at: nowIso })
    .where('id', '=', userId)
    .execute();
  sseHub.broadcast(personalGroupId, SSE.message, rowToMessage(msg, cardsJson));
  logger.info(`calendar reconnect nudge → message ${msg.id} for user ${userId}`);
  return true;
}

/**
 * Warn a user, once per disconnect, that their Gmail connection has silently
 * died. Mirrors maybeNudgeCalendarReconnect (ADR 0042) but keys off
 * gmail_synced_at (they had imported mail) rather than google_connected_at
 * (shared with Calendar — clearing calendar must not block a Gmail nudge).
 */
export async function maybeNudgeGmailReconnect(
  db: Kysely<DB>,
  userId: string,
): Promise<boolean> {
  if (!env.GMAIL_ENABLED) return false;
  const u = await db
    .selectFrom('users')
    .select([
      'gmail_synced_at',
      'gmail_reconnect_nudged_at',
      'refresh_token_ciphertext',
      'refresh_token_scopes',
    ])
    .where('id', '=', userId)
    .executeTakeFirst();
  // Only nudge if they previously synced Gmail (intentional disconnect clears
  // gmail_synced_at via disconnectGmail).
  if (!u || !u.gmail_synced_at || u.gmail_reconnect_nudged_at) return false;

  let disconnected = false;
  if (u.refresh_token_ciphertext) {
    // Still has gmail.modify in scopes but token is dead — or scopes lost the
    // gmail grant while the sync cursor remains (partial reconnect).
    const stillHasScope =
      /https:\/\/www\.googleapis\.com\/auth\/gmail\.modify/.test(u.refresh_token_scopes ?? '') ||
      env.GMAIL_PROVIDER === 'mock';
    try {
      await getAccessToken(db, userId);
      if (!stillHasScope) disconnected = true;
    } catch (err) {
      if (err instanceof GoogleAuthError && err.needsReconnect) disconnected = true;
      else return false;
    }
  } else {
    disconnected = true;
  }
  if (!disconnected) return false;

  const personalGroupId = await findPersonalGroupId(db, userId);
  if (!personalGroupId) return false;

  const card: BotCard = {
    kind: 'action',
    title: 'Reconnect Gmail',
    subtitle: 'Opens Settings → Connect Gmail',
    url: GMAIL_RECONNECT_DEEP_LINK_WEB,
    appUrl: GMAIL_RECONNECT_DEEP_LINK_APP,
  };
  const nowIso = new Date().toISOString();
  const msg: MessagesTable = {
    id: newId('m'),
    group_id: personalGroupId,
    sender_id: null,
    kind: 'bot',
    body: '⚠️ Your Gmail connection disconnected — reconnect to keep reading mail and surfacing inbox insights in Chord.',
    attachment_id: null,
    reply_to_id: null,
    mentions_bot: 0,
    created_at: nowIso,
    source: null,
    external_message_id: null,
    chord_visible: 1,
    mentions_others: 0,
    auto_mirror: 1,
    bot_persona_id: getDefaultPersona().id,
    is_proactive: 1,
    proactive_kind: 'gmail_reconnect',
  };
  const cardsJson = JSON.stringify([card]);
  await db.insertInto('messages').values(msg).execute();
  await db
    .insertInto('message_cards')
    .values({ message_id: msg.id, cards_json: cardsJson, created_at: nowIso })
    .execute();
  await db
    .updateTable('users')
    .set({ gmail_reconnect_nudged_at: nowIso })
    .where('id', '=', userId)
    .execute();
  sseHub.broadcast(personalGroupId, SSE.message, rowToMessage(msg, cardsJson));
  logger.info(`gmail reconnect nudge → message ${msg.id} for user ${userId}`);
  return true;
}

const BYOK_KEY_DEEP_LINK_APP = 'chord://settings?open=model';
const BYOK_KEY_DEEP_LINK_WEB = 'https://chordapp.ai/settings?open=model';
const BYOK_PLAN_DEEP_LINK_APP = 'chord://settings?open=plan';
const BYOK_PLAN_DEEP_LINK_WEB = 'https://chordapp.ai/settings?open=plan';

/** A failed call has to sit this long before the sweep nudges, so a chat reply
 *  that already told the user can claim the outage first (ADR 0252). */
const BYOK_NUDGE_DELAY_MS = 45_000;

/**
 * ADR 0252 - tell a user, once per outage, that their own AI key has run out of
 * credit (or been rejected) and what that pauses. Posts into their 1:1 chat with
 * a card that opens Settings → AI model. Mirrors maybeNudgeGmailReconnect, and
 * like it only fires from a recorded state, so a healthy key never reaches it.
 *
 * Claimed atomically before anything is written: two ticks (or two processes)
 * racing must not post the same warning twice.
 */
export async function maybeNudgeByokKeyIssue(db: Kysely<DB>, userId: string): Promise<boolean> {
  const claimed = await db
    .updateTable('users')
    .set({ byok_key_nudged_at: new Date().toISOString() })
    .where('id', '=', userId)
    .where('byok_key_issue', 'is not', null)
    .where('byok_key_nudged_at', 'is', null)
    .where('model_key_ciphertext', 'is not', null)
    .returning(['byok_key_issue', 'model_provider', 'model_base_url'])
    .executeTakeFirst();
  if (!claimed?.byok_key_issue || !claimed.model_provider) return false;

  const personalGroupId = await findPersonalGroupId(db, userId);
  if (!personalGroupId) return false;

  const { message } = describeByokKeyIssue(
    claimed.model_provider,
    claimed.byok_key_issue,
    claimed.model_base_url,
  );
  // Said as the provider's thing to do, in the provider's terms: this is the
  // user's own key, not a charge from Chord.
  const cards: BotCard[] = [
    {
      kind: 'action',
      title: claimed.byok_key_issue === 'credit' ? 'Add credits to your key' : 'Update your AI key',
      subtitle: 'Opens Settings → AI model',
      url: BYOK_KEY_DEEP_LINK_WEB,
      appUrl: BYOK_KEY_DEEP_LINK_APP,
    },
  ];
  // Someone may rather let Chord supply the AI than keep topping up their own: a
  // plan where Chord sells them, else Chord's own AI where that is free.
  const fallback = byokFallback();
  if (fallback === 'plan') {
    cards.push({
      kind: 'action',
      title: 'Use a Chord plan instead',
      subtitle: 'Opens Settings → AI Plan',
      url: BYOK_PLAN_DEEP_LINK_WEB,
      appUrl: BYOK_PLAN_DEEP_LINK_APP,
    });
  } else if (fallback === 'system') {
    cards.push({
      kind: 'action',
      title: "Use Chord's AI instead",
      subtitle: 'Opens Settings → AI model',
      url: BYOK_KEY_DEEP_LINK_WEB,
      appUrl: BYOK_KEY_DEEP_LINK_APP,
    });
  }
  const nowIso = new Date().toISOString();
  const msg: MessagesTable = {
    id: newId('m'),
    group_id: personalGroupId,
    sender_id: null,
    kind: 'bot',
    body: message,
    attachment_id: null,
    reply_to_id: null,
    mentions_bot: 0,
    created_at: nowIso,
    source: null,
    external_message_id: null,
    chord_visible: 1,
    mentions_others: 0,
    auto_mirror: 1,
    bot_persona_id: getDefaultPersona().id,
    is_proactive: 1,
    proactive_kind: 'byok_key_issue',
  };
  const cardsJson = JSON.stringify(cards);
  await db.insertInto('messages').values(msg).execute();
  await db
    .insertInto('message_cards')
    .values({ message_id: msg.id, cards_json: cardsJson, created_at: nowIso })
    .execute();
  sseHub.broadcast(personalGroupId, SSE.message, rowToMessage(msg, cardsJson));
  logger.info(`byok key nudge → message ${msg.id} for user ${userId}`);
  return true;
}

/** Nudge everyone whose key failed and who has not been told yet. */
export async function sweepByokKeyNudges(db: Kysely<DB>, limit = 20): Promise<number> {
  const cutoff = new Date(Date.now() - BYOK_NUDGE_DELAY_MS).toISOString();
  const due = await db
    .selectFrom('users')
    .select('id')
    .where('byok_key_issue', 'is not', null)
    .where('byok_key_nudged_at', 'is', null)
    .where('byok_key_issue_at', '<=', cutoff)
    .where('shadow', '=', 0)
    .limit(limit)
    .execute();
  let posted = 0;
  for (const u of due) {
    try {
      if (await maybeNudgeByokKeyIssue(db, u.id)) posted += 1;
    } catch (err) {
      logger.warn('byok key nudge failed', { userId: u.id, err });
    }
  }
  return posted;
}

async function renderTaskRemind(
  db: Kysely<DB>,
  payload: string,
): Promise<string | null> {
  try {
    const p = JSON.parse(payload) as TaskRemindPayload;
    const task = await db
      .selectFrom('tasks')
      .select(['title', 'status', 'remind_cue'])
      .where('id', '=', p.taskId)
      .executeTakeFirst();
    // Task was deleted, or already moved past open/active — skip the nudge.
    if (!task) return null;
    if (task.status !== 'open' && task.status !== 'active') return null;
    const cue = task.remind_cue ? ` (${task.remind_cue})` : '';
    return `⏰ Reminder: ${task.title}${cue}`;
  } catch (err) {
    logger.warn('proactive render failed', { err, kind: 'task_remind' });
    return null;
  }
}

const NUDGE_SYSTEM_PROMPT = (name: string) => `You are ${name}, a proactive family assistant. A calendar item was just created. Your ONLY job here is to flag scheduling conflicts. Prep, follow-ups, and look-ahead reminders belong to the daily morning briefing — do NOT raise them here.

A conflict requires a TIME clash. An item in NEIGHBORS (or TRIP_OVERLAPPING) conflicts only when it:
  • overlaps the new item's time range, or is back-to-back with it, or
  • double-books the same person at an overlapping time, or
  • is so close in time to the new item that traveling between their two locations isn't possible, or
  • lands during an overlapping trip.

When you mention a trip, say whose it is: with "travelers:", name them; with only "booked by: X", say "the trip X booked"; with neither, do not guess.

Two events on the SAME DAY but at non-overlapping times (e.g. one 10am–2pm, another at 5pm) are NOT a conflict. Different locations alone are NEVER a conflict — location only matters when the times are tight enough that travel is impossible. Compare the actual start/end times before flagging anything. If an item has no end time, treat it as a brief point in time.

If there are no conflicts, output an empty response. Nothing. No greeting, no "all clear", no prep suggestions.

If there ARE conflicts, output exactly:

🚨 Conflict:
- "<other title>" on <when> — <one short factual reason, e.g. "overlaps 3–4pm", "same person double-booked", "back-to-back across town, no travel time">

End with one short question asking how to resolve (e.g. "Move one, keep both, or drop one?"). No other prose.

Rules:
- Facts only. Quote titles and times from the context verbatim.
- Bullets, no preamble. Under 60 words.
- Never invent details. Never propose prep tasks here.`;

/** Read-only tools the morning scan can call to dig into context. */
const SCAN_TOOL_NAMES: ToolName[] = [
  'find_events',
  'list_tasks',
  'lookup_contact',
  'search_saves',
];

const SCAN_MAX_ITERATIONS = 4;

/** Bound on concurrent per-group/per-user work in this module's batch passes
 *  (family-facts fan-out, daily-scan seeding) — enough to cut wall clock
 *  without opening a connection-pool-sized burst against Postgres. */
const SCAN_BATCH_CONCURRENCY = 5;
const SEED_BATCH_CONCURRENCY = 10;

/**
 * The tags the context blocks carry so the model can reason about a day —
 * never for the user to read. Prod shipped "Onam tomorrow [INFO_ONLY]".
 *
 * Scrubbed as well as forbidden in the prompt, on the ADR 0100/0102 precedent:
 * a rule the model is asked to follow is not a guarantee, and a briefing is
 * free prose with no other choke point. Matched by NAME — a general `[...]`
 * strip would eat the user's own brackets ("dinner [rescheduled]").
 */
const CONTEXT_TAG_NAMES = ['INFO_ONLY', 'OVERDUE', 'STALE', 'OVERLAPS_WITH', 'DURING_TRIP'];
/** Optional brackets, and an optional `:value` payload - OVERLAPS_WITH and
 *  DURING_TRIP carry one, and half a tag left behind reads worse than all of
 *  it. */
const CONTEXT_TAGS = new RegExp(
  String.raw`\s*\[?\b(?:${CONTEXT_TAG_NAMES.join('|')})\b(?::(?:"[^"\n]*"|[^\s\]\n]*))?\]?`,
  'g',
);

export function stripContextTags(text: string | null): string | null {
  if (!text) return text;
  const out = text
    .replace(CONTEXT_TAGS, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +$/gm, '');
  return out.trim() || null;
}

const SCAN_SYSTEM_PROMPT = (name: string) => `You are ${name}, a proactive family assistant. The user's next 30 days are below, bucketed by recency, with overlap and trip-readiness tags pre-computed. Produce a morning briefing.

You have read-only tools to dig deeper before answering:
- find_events(startDate, endDate, titleContains?) — date-scoped event lookup across all the user's groups.
- list_tasks(status?, limit?) — currently active to-dos.
- lookup_contact(name) — pulls a saved contact (good for confirming birthdays/relationships).
- search_saves(query?, tripLabel?, limit?) — past saves (e.g. last year's gift ideas, restaurant short-lists).

Use them only when the static context above is insufficient — e.g. you need to confirm a birthday, recall last year's plan, or check whether a prep task already exists. Prefer at most 2–3 tool calls; do not loop unnecessarily.

Events tagged [INFO_ONLY] are on a calendar the user set not to block time (shared read-only schedules — kids' soccer, partner schedule, holidays) or are marked free. They are heads-up items, NEVER conflicts. Reference them only as gentle FYI under 📋 Heads-up when relevant.

CONFLICTS is the complete list of conflicts, worked out already. Report each of its lines once and nothing else as a conflict — not an INFO_ONLY event, not two events that merely share a day, and not anything you find with find_events (an event there with blocksTime: false never conflicts). If CONFLICTS is absent, there are no conflicts.

An event may carry "(context: ...)" — a short, already-computed note of what it's about, mined from real correspondence with whoever it's with. When it's there, you may work it into your line naturally ("meeting with Bill Mills Thursday to discuss budget, timeline and staffing"). When it's absent, say nothing about why the event exists — never guess or invent a reason.

Today comes first. The TODAY bucket is everything on the user's calendar today, all-day events and events already under way included: list every one of them under 📅 Today, in time order, all-day ones first. Say "all day" for an all-day event; for one marked "under way since", say it is ongoing and when it ends; leave out one marked "(already over)" unless something still has to be done about it. Never move a today event into another section, and never drop one to stay under the word limit — shorten the other sections instead.

Reason through, in order:
1. Conflicts — the CONFLICTS lines, each once.
2. Open reminders / tasks — anything in OPEN_TASKS with a due date in the next 7 days, or tagged [OVERDUE]. Tasks tagged [STALE] have been sitting for days and the user has already seen them: do NOT give them a line each. Collapse them into at most ONE line naming the count ("3 stale to-dos — review in To Do's") and only when there is room. An OPEN_TASK with no due date is a someday item — mention it only if something else today makes it relevant.
3. Calendar events on the radar — TOMORROW / THIS_WEEK from the buckets above (TODAY is already under 📅 Today).
4. Time-sensitive prep — booking, RSVP, ticket windows closing in the next 7–14 days.
5. Gifts & social obligations — birthdays, anniversaries within 14 days (IMPORTANT_DAYS, and any calendar event, to-do or email about one). The system prints every birthday and anniversary in its own section ABOVE your text, so do NOT list them again; mention one only to add prep that is not already a to-do (a gift, a card, an RSVP).
   FAMILY_FACTS are durable household facts (addresses, schools, allergies, sizes). Use them to ANSWER logistics questions and to flag anything tagged [UPCOMING]; do not list them for their own sake.
6. Holidays — entries from HOLIDAYS within 7 days are worth a one-liner ("Mother's Day Sunday — anything planned?"); further-out holidays only if they tie into a trip or prep window.
7. Trip readiness — TRIP_INCOMPLETE entries starting within 14 days. Say a trip has no accommodation or no tickets ONLY when its line carries that TRIP_INCOMPLETE tag: the tag is left off once the user has been told, so never work it out yourself from a trip's dates.
   Whenever you mention a trip — in any section, a conflict included — say whose it is. With "travelers:", name them ("Ada and Ben leave for Vail Thursday"). With only "booked by: X", say "the Vail trip X booked" (the booker may not be going). With neither, do not guess.
8. Long-lead prep — physicals, school forms, passports.

Output — only these sections, in this order, no greeting (the system adds the greeting and the weather):
📅 Today: …            (every TODAY event; omit section if the bucket is empty)
🚨 Conflicts: …       (omit section if none)
⏰ This week: …        (action needed in next 7 days)
📋 Heads-up: …         (further out but worth flagging)

Rules:
- Under 150 words, bullets, no greeting, no preamble, no sign-off. 📅 Today does not count towards the limit.
- Do not narrate your lookups ("Let me check…"). Write only the briefing itself.
- The tags in the context above (INFO_ONLY, OVERDUE, STALE, TRIP_INCOMPLETE)
  are notes to you. NEVER print them. Say what they mean instead
  — an overdue task is "overdue", not "[OVERDUE]".
- Say each thing once. An event, to-do, conflict or trip that appears in one
  section must not appear again in another, and two to-dos that say the same
  thing are one line.
- Skip anything already covered by an OPEN_TASK.
- If nothing warrants action and TODAY is empty, reply with exactly: ${SCAN_NOTHING_TOKEN}`;

async function loadNudgeContext(
  db: Kysely<DB>,
  p: EventCreatedNudgePayload,
): Promise<string> {
  const today = new Date();
  const actorRow = await db
    .selectFrom('users')
    .select('last_tz')
    .where('id', '=', p.actorUserId)
    .executeTakeFirst();
  const actorTz = actorRow?.last_tz ?? null;
  const todayStr = dayOf(today.toISOString(), actorTz);
  let dayName: string;
  try {
    dayName = today.toLocaleDateString('en-US', {
      weekday: 'long',
      ...(actorTz ? { timeZone: actorTz } : {}),
    });
  } catch {
    dayName = today.toLocaleDateString('en-US', { weekday: 'long' });
  }

  // Anchor day for the new entity: event start day, or trip start day.
  const anchorDay =
    p.kind === 'event' ? dayOf(p.when, actorTz) : dayOf(p.when.split(' ')[0] ?? todayStr, actorTz);
  const windowDays = 2;
  // The actor's own days, compared as instants: UTC-midnight bounds put an
  // evening event on the edge day in or out by the offset.
  const shiftDay = (d: string, n: number) =>
    new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const { lo: winStartIso, hi: winEndIso } = zonedDayRange(
    shiftDay(anchorDay, -windowDays),
    shiftDay(anchorDay, windowDays),
    actorTz,
  );
  const neighborStart = eventStartInstant(actorTz);

  // Neighbors: every event the actor can see, ±2 days around the anchor —
  // EXCLUDING the event that triggered this nudge. Without the exclusion the new
  // event appears in its own conflict-candidate list and the model compares it
  // to itself (especially when another event shares the title), producing
  // nonsense like "back-to-back with itself."
  const newEventId = p.kind === 'event' ? p.eventId : undefined;
  // All five below need only actorTz/anchorDay/sourceGroupId, already
  // resolved above, and are mutually independent — batch them.
  const [neighborRows, busyCtx, overlappingTrips, openTasks, roster] = await Promise.all([
    db
      .selectFrom('events')
      .innerJoin('group_members', 'group_members.group_id', 'events.group_id')
      .where('group_members.user_id', '=', p.actorUserId)
      .where('events.owner_user_id', '=', p.actorUserId)
      .where('events.deleted_at', 'is', null)
      .where('events.status', '!=', 'cancelled')
      .where(neighborStart, '>=', winStartIso)
      .where(neighborStart, '<', winEndIso)
      .$if(!!newEventId, (qb) => qb.where('events.id', '!=', newEventId!))
      // Events the user marked "free" (transparency=transparent) never block
      // time, so they must never be offered as conflict candidates. NULL is
      // legacy-opaque and stays in.
      .where((eb) =>
        eb.or([
          eb('events.transparency', 'is', null),
          eb('events.transparency', '!=', 'transparent'),
        ]),
      )
      .selectAll('events')
      .orderBy(neighborStart, 'asc')
      .execute(),
    // Conflict detection only considers events that actually block the user's
    // time. Drop events synced from informational ("info") calendars — shared
    // read-only schedules the user does not treat as busy — exactly as
    // find_conflicts does, so they never surface as a conflict here.
    loadBusyContext(db, p.actorUserId),
    // Trips overlapping the anchor day.
    db
      .selectFrom('trips')
      .innerJoin('group_members', 'group_members.group_id', 'trips.group_id')
      .where('group_members.user_id', '=', p.actorUserId)
      .where('trips.start_date', '<=', anchorDay)
      .where('trips.end_date', '>=', anchorDay)
      .where('trips.cancelled_at', 'is', null)
      .where('trips.deleted_at', 'is', null)
      .selectAll('trips')
      .execute(),
    // Open tasks in the source group only — these are the closest in scope.
    db
      .selectFrom('tasks')
      .where('group_id', '=', p.sourceGroupId)
      .where('status', 'in', ['open', 'active'])
      .select(['title', 'due_at'])
      .orderBy(sql`${textInstant('tasks.due_at', actorTz)} asc nulls last`)
      .orderBy('created_at', 'desc')
      .limit(20)
      .execute(),
    // Family roster — group members in the source group.
    db
      .selectFrom('group_members')
      .innerJoin('users', 'users.id', 'group_members.user_id')
      .where('group_members.group_id', '=', p.sourceGroupId)
      .select(['users.display_name', 'group_members.role'])
      .execute(),
  ]);
  const otherTrips = overlappingTrips.filter((t) => !(p.tripId && t.id === p.tripId));
  // ADR 0289 — for a new trip, a neighbour or another trip clashes only if
  // someone on it is travelling; a trip that names nobody clashes on time alone.
  const newTripId = p.kind === 'trip' ? p.tripId : undefined;
  const travelers = newTripId
    ? await loadTripTravelers(db, [newTripId, ...otherTrips.map((t) => t.id)], actorTz)
    : new Map();
  const newTravelers = newTripId ? travelers.get(newTripId) ?? [] : [];
  const blockingNeighbors = neighborRows.filter((n) => eventBlocksTime(n, busyCtx));
  const neighborPeople =
    newTripId && newTravelers.length
      ? await loadEventPeople(db, blockingNeighbors.map((n) => n.id))
      : new Map();
  // A ticket among the neighbours is its trip's travellers' time (ADR 0289
  // addendum): for a new event, someone else's ticket is not the actor's
  // time; for a new trip, a ticket clashes only with someone on both trips.
  const [neighborTickets, othersTickets] = await Promise.all([
    ticketTravelers(db, blockingNeighbors, actorTz),
    ticketsForOthers(db, p.actorUserId, blockingNeighbors, actorTz),
  ]);
  const neighbors = blockingNeighbors.filter((n) => {
    if (!newTripId) return !othersTickets.has(n.id);
    const ticket = neighborTickets.get(n.id);
    if (ticket) return tripsClash(newTravelers, ticket);
    return eventClashesWithTrip({ title: n.title, people: neighborPeople.get(n.id) ?? [] }, newTravelers);
  });
  const clashingTrips = otherTrips.filter(
    (t) => !newTripId || tripsClash(newTravelers, travelers.get(t.id) ?? []),
  );

  const lines: string[] = [];
  lines.push(`TODAY: ${todayStr} (${dayName}; times below are in the user's own zone, weekday included — quote them as shown)`);
  if (p.kind === 'event') {
    lines.push(
      `NEW_EVENT: "${p.title}" on ${localWhen(p.when, actorTz)}${p.location ? ` @ ${p.location}` : ''} (group: ${p.sourceGroupName})`,
    );
  } else {
    lines.push(`NEW_TRIP: "${p.title}" — ${p.when} (group: ${p.sourceGroupName})`);
  }

  lines.push(`NEIGHBORS (±${windowDays} days):`);
  if (neighbors.length === 0) {
    lines.push('  (none)');
  } else {
    for (const n of neighbors) {
      if (p.eventId && n.id === p.eventId) continue;
      const ends = n.ends_at ? ` to ${localWhen(n.ends_at, actorTz)}` : '';
      lines.push(
        `  - "${n.title}" on ${localWhen(n.starts_at, actorTz)}${ends}${n.location ? ` @ ${n.location}` : ''}`,
      );
    }
  }

  if (clashingTrips.length > 0) {
    const whose = await whoseTrips(db, clashingTrips, actorTz);
    lines.push('TRIP_OVERLAPPING:');
    for (const t of clashingTrips) {
      const who = whose.get(t.id);
      lines.push(`  - "${t.name}" to ${t.destination}, ${t.start_date} → ${t.end_date}${who ? ` (${who})` : ''}`);
    }
  }

  lines.push('OPEN_TASKS (source group):');
  if (openTasks.length === 0) {
    lines.push('  (none)');
  } else {
    for (const t of openTasks) {
      lines.push(`  - ${t.title}${t.due_at ? ` (due ${localWhen(t.due_at, actorTz)})` : ''}`);
    }
  }

  lines.push('FAMILY:');
  if (roster.length === 0) {
    lines.push('  (none)');
  } else {
    for (const r of roster) {
      lines.push(`  - ${r.display_name} (${r.role})`);
    }
  }

  return lines.join('\n');
}

export async function loadScanContext(db: Kysely<DB>, userId: string): Promise<string> {
  const horizonMs = 30 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  // "Today" is the USER'S today — a 9pm-ET briefing row must not bucket
  // tomorrow's events as today because UTC already rolled over.
  const scanUser = await db
    .selectFrom('users')
    .select('last_tz')
    .where('id', '=', userId)
    .executeTakeFirst();
  const userTz = scanUser?.last_tz ?? null;
  const todayStr = dayOf(new Date(now).toISOString(), userTz);
  const horizonStr = dayOf(new Date(now + horizonMs).toISOString(), userTz);

  // Only `trips` needs userTz (via todayStr/horizonStr, already resolved
  // above) — the rest are mutually independent reads. Batch them. (The
  // to-dos Chord retired are not here: code lists them, ADR 0285.)
  const [events, busyCtx, trips, openTasks, importantDays] = await Promise.all([
    listEventsForUser(db, userId, { tz: userTz }),
    // Events synced from informational ("info") calendars — shared read-only
    // schedules the user doesn't treat as busy — must never be presented as
    // conflict candidates. They still appear in the briefing as heads-up items
    // but are tagged INFO_ONLY so the LLM treats them accordingly.
    loadBusyContext(db, userId),
    db
      .selectFrom('trips')
      .innerJoin('group_members', 'group_members.group_id', 'trips.group_id')
      .where('group_members.user_id', '=', userId)
      .where('trips.end_date', '>=', todayStr)
      .where('trips.start_date', '<=', horizonStr)
      .where('trips.cancelled_at', 'is', null)
      .where('trips.deleted_at', 'is', null)
      .selectAll('trips')
      .orderBy('trips.start_date', 'asc')
      .execute(),
    // Open tasks across all the user's groups — keep it bounded. Dated work
    // wins the row budget: ordering by created_at spent it on whatever was
    // typed most recently, which pushed the things that actually have a
    // deadline out of the briefing entirely.
    db
      .selectFrom('tasks')
      .innerJoin('group_members', 'group_members.group_id', 'tasks.group_id')
      .where('group_members.user_id', '=', userId)
      .where('tasks.status', 'in', ['open', 'active'])
      .select(['tasks.title', 'tasks.due_at'])
      .orderBy(sql`${textInstant('tasks.due_at', userTz)} asc nulls last`)
      .orderBy('tasks.created_at', 'desc')
      // Twice the 30 shown: copies of one to-do (ADR 0232 group copies, a
      // restated email) are folded below and must not use up the budget.
      .limit(60)
      .execute(),
    // ADR 0016 — important days within the same horizon. Recurring entries
    // (birthdays/anniversaries) get an occurrence in the year that lands in
    // the window. Empty when the user hasn't saved any people.
    listImportantDayOccurrences(db, userId, 30),
  ]);
  // Everything on the user's calendar from the start of their today: an event
  // already under way (started earlier, or a multi-day event that began
  // before today) and an all-day event, whose floating midnight is already
  // behind "now" by briefing time, are today's too.
  const daysOf = (e: GroupEvent) => eventLocalDays(e.startsAt, e.endsAt, userTz);
  const spanOf = (e: GroupEvent): [number, number] => {
    const start = instantInZoneMs(e.startsAt, userTz);
    const end = e.endsAt ? instantInZoneMs(e.endsAt, userTz) : Number.NaN;
    return [start, end > start ? end : start + DEFAULT_EVENT_DURATION_MS];
  };
  // One line per event: the same title at the same instant (a Google copy and
  // a phone-calendar copy, two group copies) is one event, and two copies of
  // it otherwise "overlapped" each other as a conflict.
  const inWindow = firstOfEach(
    events
      .filter((e) => {
        const { first, last } = daysOf(e);
        return last >= todayStr && first <= horizonStr;
      })
      .sort((a, b) => spanOf(a)[0] - spanOf(b)[0]),
    (e) => `${sameWordsKey(e.title)}|${spanOf(e)[0]}`,
  );
  // Which entries are a journey: a leg's own calendar entry, or the same
  // departure arriving under another name (Amtrak's invite, a Google copy).
  // ADR 0289 — such an entry is its travellers' time, not the user's.
  const tickets = await ticketTrips(db, inWindow, userTz);
  const isLegEntry = (e: GroupEvent): boolean =>
    !!e.externalUid?.startsWith(TRAVEL_LEG_EXTERNAL_UID_PREFIX);
  // A second entry for a journey already listed (by its leg's own entry, same
  // trip, same departure) is the same thing said twice.
  const upcoming = inWindow.filter((e) => {
    const trip = tickets.get(e.id)?.tripId;
    if (!trip || isLegEntry(e)) return true;
    return !inWindow.some(
      (o) =>
        o !== e &&
        isLegEntry(o) &&
        tickets.get(o.id)?.tripId === trip &&
        Math.abs(spanOf(o)[0] - spanOf(e)[0]) <= 10 * 60_000,
    );
  });
  // Which calendar each event is on. A two-way-synced copy (ADR 0040) names
  // its calendar in `google_calendar_id` and has no `external_uid`; judging it
  // by `external_uid` alone read it as Chord-native, which always blocks, so
  // an event on a calendar set not to block became a conflict.
  const calendarOf = new Map<string, { external_uid: string | null; google_calendar_id: string | null }>();
  if (upcoming.length) {
    const rows = await db
      .selectFrom('events')
      .select(['id', 'external_uid', 'google_calendar_id'])
      .where(
        'id',
        'in',
        upcoming.map((e) => e.id),
      )
      .execute();
    for (const r of rows) calendarOf.set(r.id, r);
  }
  const isInfoOnly = (e: GroupEvent): boolean =>
    !eventBlocksTime(
      calendarOf.get(e.id) ?? { external_uid: e.externalUid ?? null, google_calendar_id: null },
      busyCtx,
    ) || e.transparency === 'transparent';


  // Pre-compute trip readiness: legs + accommodations counts per upcoming trip.
  const tripIds = trips.map((t) => t.id);
  const [legs, accos, whose] = await Promise.all([
    tripIds.length
      ? db.selectFrom('travel_legs').where('trip_id', 'in', tripIds).select(['trip_id']).execute()
      : Promise.resolve([]),
    tripIds.length
      ? db.selectFrom('accommodations').where('trip_id', 'in', tripIds).select(['trip_id']).execute()
      : Promise.resolve([]),
    whoseTrips(db, trips, userTz),
  ]);
  const legCount = new Map<string, number>();
  for (const l of legs) legCount.set(l.trip_id, (legCount.get(l.trip_id) ?? 0) + 1);
  const accoCount = new Map<string, number>();
  for (const a of accos) accoCount.set(a.trip_id, (accoCount.get(a.trip_id) ?? 0) + 1);
  const tripWho = (t: { id: string }): string => whose.get(t.id) ?? '';

  function bucketFor(day: string): 'TODAY' | 'TOMORROW' | 'THIS_WEEK' | 'LATER' {
    const delta = daysBetween(day, todayStr);
    if (delta <= 0) return 'TODAY';
    if (delta === 1) return 'TOMORROW';
    if (delta <= 7) return 'THIS_WEEK';
    return 'LATER';
  }

  // A free / non-blocking event never counts as a conflict. Mirrors
  // computeConflicts exactly so the daily briefing can't drift from the
  // deterministic per-event check: info-only calendars, an explicit
  // 'transparent', and the structural free rule (all-day / <5-min).
  const isFreeForConflict = (e: GroupEvent): boolean =>
    isInfoOnly(e) ||
    e.transparency === 'transparent' ||
    computeTransparency({
      startsAt: e.startsAt,
      endsAt: e.endsAt ?? null,
      allDay: isAllDayValue(e.startsAt) && (!e.endsAt || isAllDayValue(e.endsAt)),
    }) === 'transparent';

  const tagsFor = (e: GroupEvent): string => (isInfoOnly(e) ? ' [INFO_ONLY]' : '');

  // The conflicts, worked out here and listed once each. They used to be tags
  // on every event involved, so a clash between A and B arrived twice (on A
  // and on B) and was reported twice. Only events that block time take part:
  // a calendar set not to block, an event marked free, an all-day or <5-min
  // event can be FYI but never a conflict.
  // An event already over takes no part: a clash earlier this morning is
  // history, not something to act on.
  const conflictLines: string[] = [];
  const blocking = upcoming
    .filter((e) => !isFreeForConflict(e) && spanOf(e)[1] > now)
    .sort((a, b) => spanOf(a)[0] - spanOf(b)[0]);
  // ADR 0289 — an event during a trip clashes only if one of its people is
  // travelling; a trip that names nobody clashes on time alone. A ticket's
  // calendar entry is about its trip's travellers, so two travellers' tickets
  // (or Ben's flight and the owner's dinner) overlapping is no clash either.
  const [tripTravelers, eventPeople] = await Promise.all([
    loadTripTravelers(db, tripIds, userTz),
    loadEventPeople(db, blocking.map((e) => e.id)),
  ]);
  const sideOf = (e: GroupEvent): OverlapSide => ({
    title: e.title,
    people: eventPeople.get(e.id) ?? [],
    ticketTravelers: tickets.get(e.id)?.travelers ?? null,
    ticketTripId: tickets.get(e.id)?.tripId ?? null,
  });
  for (let i = 0; i < blocking.length; i++) {
    const a = blocking[i];
    const [aStart, aEnd] = spanOf(a);
    // A real time-range clash, not mere same-day co-occurrence.
    const clashes = blocking
      .slice(i + 1)
      .filter((b) => overlaps(aStart, aEnd, ...spanOf(b)) && eventsClash(sideOf(a), sideOf(b)))
      .map((b) => `"${b.title}" (${localWhen(b.startsAt, userTz)})`);
    if (clashes.length) {
      conflictLines.push(`  - "${a.title}" (${localWhen(a.startsAt, userTz)}) overlaps ${clashes.join(' and ')}`);
    }
    // A trip's own flight is the trip, not a clash with it.
    if (tickets.has(a.id)) continue;
    const day = dayOf(a.startsAt, userTz);
    const trip = trips.find(
      (t) =>
        t.start_date <= day &&
        t.end_date >= day &&
        eventClashesWithTrip(
          { title: a.title, people: eventPeople.get(a.id) ?? [] },
          tripTravelers.get(t.id) ?? [],
        ),
    );
    if (trip) {
      const who = tripWho(trip);
      conflictLines.push(
        `  - "${a.title}" (${localWhen(a.startsAt, userTz)}) falls during the trip "${trip.name}" to ${trip.destination}${who ? ` (${who})` : ''}`,
      );
    }
  }

  // Public holidays in the next 30 days. Today the list is US-federal only;
  // add a `users.country` column + per-country tables when other locales
  // come online.
  const holidays = upcomingHolidays(todayStr, 30);

  if (
    upcoming.length === 0 &&
    trips.length === 0 &&
    openTasks.length === 0 &&
    importantDays.length === 0 &&
    holidays.length === 0
  ) {
    return ''; // signals "nothing on the radar"
  }

  const buckets: Record<string, string[]> = {
    TODAY: [],
    TOMORROW: [],
    THIS_WEEK: [],
    LATER: [],
  };
  for (const e of upcoming) {
    const { first, last } = daysOf(e);
    const b = bucketFor(first);
    // ADR 0163 — a meeting's own "what it's about", mined once at invite time
    // and stored on the row. Ground truth like the other tags: mention it
    // naturally when present, never invent one when absent (prompt rule below).
    const context = e.meetingContext ? ` (context: ${e.meetingContext})` : '';
    const [startMs, endMs] = spanOf(e);
    const when =
      first < todayStr
        ? `under way since ${weekdayOf(first)} ${first}, last day ${weekdayOf(last)} ${last}`
        : `on ${localWhen(e.startsAt, userTz)}`;
    const state =
      first >= todayStr && endMs <= now && last === todayStr
        ? ' (already over)'
        : first >= todayStr && startMs <= now && endMs > now && !isAllDayValue(e.startsAt)
          ? ' (under way now)'
          : '';
    buckets[b].push(
      `  - "${e.title}" ${when}${state}${e.location ? ` @ ${e.location}` : ''}${context}${tagsFor(e)}`,
    );
  }

  const lines: string[] = [];
  lines.push(`TODAY: ${weekdayOf(todayStr)} ${todayStr} (times below are in the user's own zone, weekday included — quote them as shown)`);
  for (const key of ['TODAY', 'TOMORROW', 'THIS_WEEK', 'LATER'] as const) {
    if (buckets[key].length === 0) continue;
    lines.push(`${key}:`);
    lines.push(...buckets[key]);
  }

  if (conflictLines.length > 0) {
    lines.push('CONFLICTS:');
    lines.push(...conflictLines);
  }

  if (trips.length > 0) {
    lines.push('TRIPS:');
    const gapsOf = (t: { id: string }): string[] => [
      ...((legCount.get(t.id) ?? 0) === 0 ? ['no travel legs'] : []),
      ...((accoCount.get(t.id) ?? 0) === 0 ? ['no accommodation'] : []),
    ];
    // A missing hotel is said on two mornings in all, not every morning.
    const mention = await tripGapsToMention(
      db,
      userId,
      trips.flatMap((t) => gapsOf(t).map((g) => `${t.id}:${g}`)),
      todayStr,
    );
    for (const t of trips) {
      const daysOut = Math.max(0, daysBetween(t.start_date, todayStr));
      const incomplete = gapsOf(t).filter((g) => mention.has(`${t.id}:${g}`));
      const tag = incomplete.length
        ? ` [TRIP_INCOMPLETE: ${incomplete.join(', ')}]`
        : '';
      const whoText = tripWho(t);
      const who = whoText ? `; ${whoText}` : '';
      lines.push(
        `  - "${t.name}" → ${t.destination}, ${t.start_date} → ${t.end_date} (in ${daysOut}d)${who}${tag}`,
      );
    }
  }

  if (openTasks.length > 0) {
    // Tag the way events/trips/important-days already are, rather than
    // handing the model raw ISO strings and asking it to compare dates.
    const nowMs = Date.now();
    lines.push('OPEN_TASKS:');
    // One line per to-do: copies of the same one in several groups (ADR 0232)
    // or restated by a second email were each read back. Rows arrive soonest
    // due first, so the copy kept carries the earliest date.
    const distinctTasks = firstOfEach(openTasks, (t) => sameWordsKey(t.title)).slice(0, 30);
    for (const t of distinctTasks) {
      const tags: string[] = [];
      if (t.due_at && Date.parse(t.due_at) < nowMs) {
        tags.push(isTaskStale(t.due_at, nowMs) ? 'STALE' : 'OVERDUE');
      }
      const tag = tags.length ? ` [${tags.join('; ')}]` : '';
      lines.push(`  - ${t.title}${t.due_at ? ` (due ${localWhen(t.due_at, userTz)})` : ''}${tag}`);
    }
  }

  if (importantDays.length > 0) {
    lines.push('IMPORTANT_DAYS:');
    for (const d of importantDays) {
      const days = daysBetween(d.on, todayStr);
      const tag = days === 0 ? 'TODAY' : days === 1 ? 'TOMORROW' : `IN_${days}_DAYS`;
      lines.push(`  - ${d.kind} for ${d.personName} on ${d.on} [${tag}]`);
    }
  }

  if (holidays.length > 0) {
    lines.push('HOLIDAYS:');
    for (const h of holidays) {
      const days = daysBetween(h.on, todayStr);
      const tag = days === 0 ? 'TODAY' : days === 1 ? 'TOMORROW' : `IN_${days}_DAYS`;
      lines.push(`  - ${h.name} on ${h.on} [${tag}]`);
    }
  }

  // Phase 3a — durable family-profile facts (household + managed personas)
  // across the user's family groups. Supplementary context, not a reason to
  // brief, so it sits after the "nothing on the radar" early return.
  const familyGroups = await db
    .selectFrom('group_members')
    .innerJoin('groups', 'groups.id', 'group_members.group_id')
    .where('group_members.user_id', '=', userId)
    .where('groups.kind', '=', 'group')
    .select('groups.id as id')
    .execute();
  // One query per family group; independent of each other. Fan out
  // bounded-concurrent instead of sequentially — a real fix would batch this
  // into one query keyed by group id, but familyFactsForContext is shared
  // with bot/context.ts's single-group call site, so widening its signature
  // is out of scope for this pass.
  const familyFactsByGroup = await mapConcurrent(familyGroups, SCAN_BATCH_CONCURRENCY, (g) =>
    familyFactsForContext(db, g.id, { limit: 20 }),
  );
  const famLines: string[] = [];
  const seenFam = new Set<string>();
  for (const facts of familyFactsByGroup) {
    if (famLines.length >= 20) break;
    for (const f of facts) {
      // ADR 0333 — the same fact (same person, key and value) once; two
      // people who share a label, or two values, are never merged.
      const dedupe = `${f.subjectKey}|${f.key}|${f.value}`.toLowerCase();
      if (seenFam.has(dedupe)) continue;
      seenFam.add(dedupe);
      let tag = '';
      if ((f.category === 'school' || f.category === 'dates') && f.datedAt) {
        const d = daysBetween(f.datedAt, todayStr);
        if (d >= 0 && d <= 30) tag = ` [UPCOMING${d === 0 ? ' TODAY' : ` in ${d}d`}]`;
      }
      famLines.push(`  - ${f.subjectLabel} · ${f.key}: ${f.value}${tag}`);
      if (famLines.length >= 20) break;
    }
  }
  if (famLines.length > 0) {
    lines.push('FAMILY_FACTS:');
    lines.push(...famLines);
  }

  return lines.join('\n');
}

/**
 * US federal + widely-observed holidays that fall within `[today, today+horizonDays]`.
 * Fixed-date holidays (New Year's, Independence Day, Veterans, Christmas) and a
 * handful of floating ones computed inline. Keep the list short and culturally
 * obvious — the goal is "morning briefing, oh right Thanksgiving's next week",
 * not a complete civic almanac.
 */
export function upcomingHolidays(
  todayIsoDate: string,
  horizonDays: number,
): { name: string; on: string }[] {
  const start = Date.parse(`${todayIsoDate}T00:00:00Z`);
  if (Number.isNaN(start)) return [];
  const end = start + horizonDays * 86400000;
  const years = new Set<number>([
    new Date(start).getUTCFullYear(),
    new Date(end).getUTCFullYear(),
  ]);
  const fixed: { name: string; mmdd: string }[] = [
    { name: "New Year's Day", mmdd: '01-01' },
    { name: "Valentine's Day", mmdd: '02-14' },
    { name: "St. Patrick's Day", mmdd: '03-17' },
    { name: 'Earth Day', mmdd: '04-22' },
    { name: 'Cinco de Mayo', mmdd: '05-05' },
    { name: 'Juneteenth', mmdd: '06-19' },
    { name: 'Independence Day', mmdd: '07-04' },
    { name: 'Halloween', mmdd: '10-31' },
    { name: 'Veterans Day', mmdd: '11-11' },
    { name: 'Christmas Eve', mmdd: '12-24' },
    { name: 'Christmas Day', mmdd: '12-25' },
    { name: "New Year's Eve", mmdd: '12-31' },
  ];
  const out: { name: string; on: string }[] = [];
  for (const y of years) {
    for (const f of fixed) {
      const iso = `${y}-${f.mmdd}`;
      const t = Date.parse(`${iso}T00:00:00Z`);
      if (t >= start && t <= end) out.push({ name: f.name, on: iso });
    }
    // Floating: Thanksgiving (4th Thu of Nov), Mother's Day (2nd Sun May),
    // Father's Day (3rd Sun Jun), Labor Day (1st Mon Sep), Memorial Day
    // (last Mon May), MLK Day (3rd Mon Jan), Presidents Day (3rd Mon Feb).
    const floating: { name: string; on: string }[] = [
      { name: 'MLK Day', on: nthWeekday(y, 0, 1, 3) },
      { name: 'Presidents Day', on: nthWeekday(y, 1, 1, 3) },
      { name: "Mother's Day", on: nthWeekday(y, 4, 0, 2) },
      { name: 'Memorial Day', on: lastWeekday(y, 4, 1) },
      { name: "Father's Day", on: nthWeekday(y, 5, 0, 3) },
      { name: 'Labor Day', on: nthWeekday(y, 8, 1, 1) },
      { name: 'Thanksgiving', on: nthWeekday(y, 10, 4, 4) },
    ];
    for (const fh of floating) {
      const t = Date.parse(`${fh.on}T00:00:00Z`);
      if (t >= start && t <= end) out.push(fh);
    }
  }
  return out.sort((a, b) => a.on.localeCompare(b.on));
}

/** Nth weekday-of-month (e.g. 3rd Monday of January). dow: 0=Sun..6=Sat. */
function nthWeekday(year: number, month: number, dow: number, n: number): string {
  const first = new Date(Date.UTC(year, month, 1));
  const shift = (dow - first.getUTCDay() + 7) % 7;
  const day = 1 + shift + (n - 1) * 7;
  const d = new Date(Date.UTC(year, month, day));
  return d.toISOString().slice(0, 10);
}

/** Last weekday of a month (e.g. last Monday of May). */
function lastWeekday(year: number, month: number, dow: number): string {
  const last = new Date(Date.UTC(year, month + 1, 0));
  const shift = (last.getUTCDay() - dow + 7) % 7;
  const day = last.getUTCDate() - shift;
  const d = new Date(Date.UTC(year, month, day));
  return d.toISOString().slice(0, 10);
}

async function renderEventCreatedNudge(
  db: Kysely<DB>,
  payload: string,
): Promise<string | null> {
  const p = JSON.parse(payload) as EventCreatedNudgePayload;
  // Events: deterministic conflict detection (times + free/busy, no LLM). The
  // model can't do interval arithmetic reliably — it called events an hour apart
  // "back-to-back" — and it isn't needed: overlap is just math.
  if (p.kind === 'event') return renderEventConflictNudge(db, p);
  // A trip that names nobody would clash with every event in its dates
  // (ADR 0289), so it asks who is going instead; the answer re-runs this.
  if (p.tripId) {
    const question = await whoIsGoingQuestion(db, p.tripId, p.actorUserId);
    if (question !== undefined) return question;
  }
  // Trips: keep the LLM path for now (coarse date-range overlap, lower risk).
  try {
    const userPrompt = await loadNudgeContext(db, p);
    const llm = await getLlmForUser(db, p.actorUserId, 'nudge');
    const body = await llm.complete(
      [
        { role: 'system', content: NUDGE_SYSTEM_PROMPT(getDefaultPersona().promptName) },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0.4, maxTokens: 400 },
    );
    return body.trim() || null;
  } catch (err) {
    logger.warn('event_created_nudge render failed', { err });
    return null;
  }
}

const NUDGE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Nov 13 – Nov 15" from two YYYY-MM-DD days (one day: "Nov 13"). */
function tripDates(start: string, end: string): string {
  const day = (d: string) => {
    const m = d.match(/^\d{4}-(\d{2})-(\d{2})/);
    return m ? `${NUDGE_MONTHS[Number(m[1]) - 1]} ${Number(m[2])}` : d;
  };
  return start === end ? day(start) : `${day(start)} – ${day(end)}`;
}

/**
 * ADR 0289 addendum — the question that stands in for a trip's conflict check
 * while the trip names nobody: `undefined` when it does name someone (run the
 * check), `null` when the trip is gone, else the question, recorded so the
 * answer can find the trip.
 */
async function whoIsGoingQuestion(
  db: Kysely<DB>,
  tripId: string,
  actorUserId: string,
): Promise<string | null | undefined> {
  const trip = await db
    .selectFrom('trips')
    .select(['id', 'name', 'start_date', 'end_date', 'deleted_at', 'cancelled_at'])
    .where('id', '=', tripId)
    .executeTakeFirst();
  if (!trip || trip.deleted_at || trip.cancelled_at) return null;
  const travelers = await loadTripTravelers(db, [tripId], null);
  if ((travelers.get(tripId) ?? []).length > 0) return undefined;
  const dates = tripDates(trip.start_date, trip.end_date);
  await recordPendingTripTravelers(db, actorUserId, { tripId, tripName: trip.name, dates });
  return `✈️ Who is going on "${trip.name}" (${dates})? Tell me who, and I'll check it against their plans.`;
}

/** "Jun 3, 9:00 AM" — in the user's timezone when `tz` is given and the
 *  string names an instant; otherwise its literal wall-clock (offset-stored
 *  strings already carry the user's local time). */
function fmtWhen(iso: string, tz?: string | null): string {
  if (tz && hasZone(iso)) {
    try {
      return new Date(iso).toLocaleString('en-US', {
        timeZone: tz,
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    } catch {
      // unknown zone → wall-clock fallback below
    }
  }
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return iso;
  const month = NUDGE_MONTHS[Number(m[2]) - 1] ?? m[2];
  let h = Number(m[4]);
  const ampm = h < 12 ? 'AM' : 'PM';
  h = h % 12 || 12;
  return `${month} ${Number(m[3])}, ${h}:${m[5]} ${ampm}`;
}

/**
 * ADR 0079 — the gated user's daily briefing: a deterministic teaser (no LLM)
 * with a few real lines about their day and a "read more" pointer at AI Plan.
 * Keeps the daily touchpoint alive so lapsed users come back.
 *
 * ADR 0091 — renders from the same `BriefingFacts` the out-of-window WhatsApp
 * template uses, so the two abbreviated surfaces cannot drift apart.
 */
async function buildGatedBriefingTeaser(db: Kysely<DB>, userId: string): Promise<string> {
  return renderTeaser(await buildBriefingFacts(db, userId));
}

/**
 * Deterministic event conflict nudge: compute hard conflicts (interval overlap +
 * free/busy) and template the message. No conflicts → null (drain retires it, no
 * retry loop). The triggering event is excluded from its own candidate list.
 */
async function renderEventConflictNudge(
  db: Kysely<DB>,
  p: EventCreatedNudgePayload,
): Promise<string | null> {
  if (!p.eventId) return null;
  const ev = await db
    .selectFrom('events')
    .select(['id', 'starts_at', 'ends_at', 'title', 'external_uid'])
    .where('id', '=', p.eventId)
    .executeTakeFirst();
  if (!ev) return null; // event deleted before the nudge ran
  const actor = await db
    .selectFrom('users')
    .select('last_tz')
    .where('id', '=', p.actorUserId)
    .executeTakeFirst();
  const tz = actor?.last_tz ?? null;
  // Ben's flight landing on his parent's calendar does not take the
  // parent's time, so it cannot clash with the parent's dinner.
  if ((await ticketsForOthers(db, p.actorUserId, [ev], tz)).has(ev.id)) return null;
  const conflicts = await computeConflicts(db, {
    userId: p.actorUserId,
    startIso: new Date(instantInZoneMs(ev.starts_at, tz)).toISOString(),
    endIso: new Date(effectiveEndMs(ev.starts_at, ev.ends_at, tz)).toISOString(),
    excludeEventId: p.eventId,
  });
  if (conflicts.length === 0) return null;

  const lines = [`🚨 Conflict: "${ev.title}" (${fmtWhen(ev.starts_at, tz)}) overlaps:`];
  for (const c of conflicts) {
    const range = c.endsAt
      ? `${fmtWhen(c.startsAt, tz)}–${fmtTimeOnly(c.endsAt, tz)}`
      : fmtWhen(c.startsAt, tz);
    const cal = c.calendar && c.calendar !== 'Chord' ? ` · ${c.calendar}` : '';
    lines.push(`- "${c.title}" — ${range}${cal}`);
  }
  lines.push('Move one, keep both, or drop one?');
  return lines.join('\n');
}

/**
 * ADR 0169 — deterministic, no DB read and no LLM call: everything the
 * message needs was already formatted when `applyCancellation` staged this
 * row. Null only if the payload is malformed (defensive — never true for a
 * row this module wrote itself).
 */
function renderTripCancellationNudge(payload: string): string | null {
  let p: TripCancellationPayload;
  try {
    p = JSON.parse(payload) as TripCancellationPayload;
  } catch {
    return null;
  }
  if (p.remainingItems.length === 0) {
    return (
      `Your ${p.destination} trip (${p.tripName}) is now cancelled — ` +
      `${p.cancelledItems.join(' and ')} came back cancelled.`
    );
  }
  return (
    `Heads up — ${p.cancelledItems.join(' and ')} for your ${p.destination} trip ` +
    `${p.cancelledItems.length === 1 ? 'was' : 'were'} cancelled, but you still have ` +
    `${p.remainingItems.join(' and ')} booked for the same trip. Want me to update anything?`
  );
}

/** ADR 0248 — deterministic, like the trip cancellation note above. */
function renderEmailChangeNotice(payload: string): string | null {
  let p: EmailChangeNoticePayload;
  try {
    p = JSON.parse(payload) as EmailChangeNoticePayload;
  } catch {
    return null;
  }
  return typeof p.text === 'string' && p.text.trim() ? p.text.trim() : null;
}

/**
 * Read-only tool dispatcher used by the morning-scan loop. User-scoped: every
 * lookup pulls across the user's own groups rather than a single group_id, so
 * "list_tasks" surfaces to-dos in any group they belong to.
 */
async function executeScanTool(
  db: Kysely<DB>,
  userId: string,
  call: { name: string; args: unknown },
): Promise<Record<string, unknown>> {
  if (!isToolName(call.name)) return { error: `unknown tool: ${call.name}` };
  if (!SCAN_TOOL_NAMES.includes(call.name)) {
    return { error: `${call.name} is not available in the morning scan` };
  }
  const schema = toolSchemas[call.name];
  const parsed = schema.safeParse(call.args ?? {});
  if (!parsed.success) {
    return { error: `invalid args: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  }

  switch (call.name) {
    case 'find_events': {
      const args = parsed.data as {
        startDate: string;
        endDate: string;
        titleContains?: string;
      };
      const tzRow = await db
        .selectFrom('users')
        .select('last_tz')
        .where('id', '=', userId)
        .executeTakeFirst();
      const { lo, hi } = zonedDayRange(args.startDate, args.endDate, tzRow?.last_tz);
      const startsAt = eventStartInstant(tzRow?.last_tz);
      // Same rows the bot's own find_events (executor.ts) and the briefing's
      // event list (listEventsForUser) read: the user's OWN copies, minus
      // tombstones. Fan-out (ADR 0040 §7) gives every member a copy, and an
      // attendee's edit touches only their row — so without the owner filter a
      // date the user moved or deleted came straight back via a sibling's
      // stale copy, and a delete still waiting on its Google push (status
      // 'cancelled' + deleted_at) was reported as a live event.
      let q = db
        .selectFrom('events')
        .innerJoin('group_members', 'group_members.group_id', 'events.group_id')
        .where('group_members.user_id', '=', userId)
        .where('events.owner_user_id', '=', userId)
        .where('events.deleted_at', 'is', null)
        .where('events.status', '!=', 'cancelled')
        .where(eventOverlapsRange(tzRow?.last_tz, lo, hi))
        .selectAll('events')
        .orderBy(startsAt, 'asc')
        .limit(20);
      if (args.titleContains) {
        const needle = likeContains(args.titleContains.toLowerCase());
        q = q.where((eb) =>
          eb.or([
            eb(eb.fn('lower', ['events.title']), 'like', needle),
            eb(eb.fn('lower', ['events.location']), 'like', needle),
          ]),
        );
      }
      const [rows, busyCtx] = await Promise.all([q.execute(), loadBusyContext(db, userId)]);
      return {
        events: rows.map((e) => ({
          id: e.id,
          title: e.title,
          startsAt: e.starts_at,
          location: e.location,
          groupId: e.group_id,
          // The scan prompt: an event with blocksTime false is never a conflict.
          blocksTime:
            e.transparency !== 'transparent' &&
            computeTransparency({ startsAt: e.starts_at, endsAt: e.ends_at, allDay: e.all_day === 1 }) !==
              'transparent' &&
            eventBlocksTime(e, busyCtx),
        })),
        total: rows.length,
      };
    }
    case 'list_tasks': {
      const args = parsed.data as { status?: string; limit?: number };
      const all = await listTasksForUser(db, userId);
      const filtered = args.status ? all.filter((t) => t.status === args.status) : all;
      const capped = filtered.slice(0, args.limit ?? 15);
      return {
        tasks: capped.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          dueAt: t.dueAt ?? null,
          groupId: t.groupId,
        })),
        total: filtered.length,
      };
    }
    case 'lookup_contact': {
      const args = parsed.data as { name: string };
      const needle = args.name.trim().toLowerCase();
      const groupIds = (
        await db
          .selectFrom('group_members')
          .where('user_id', '=', userId)
          .select('group_id')
          .execute()
      ).map((r) => r.group_id);
      for (const gid of groupIds) {
        const all = await listContacts(db, gid);
        const match =
          all.find((c) => c.name.toLowerCase() === needle) ??
          all.find((c) => c.name.toLowerCase().includes(needle));
        if (match) {
          return {
            contact: {
              name: match.name,
              org: match.org ?? null,
              family: match.family ?? null,
              tags: match.tags,
              note: match.note ?? null,
              groupId: gid,
            },
          };
        }
      }
      return { contact: null };
    }
    case 'search_saves': {
      const args = parsed.data as {
        query?: string;
        tripLabel?: string;
        limit?: number;
      };
      const all = await listSavesForUser(db, userId);
      const q = args.query?.toLowerCase().trim() ?? '';
      const filtered = all.filter((s) => {
        if (args.tripLabel && s.tripLabel !== args.tripLabel) return false;
        if (!q) return true;
        const hay = [s.title, s.note ?? '', s.url ?? '', s.tags.join(' '), s.tripLabel ?? '']
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      });
      const capped = filtered.slice(0, args.limit ?? 8);
      return {
        saves: capped.map((s) => ({
          id: s.id,
          kind: s.kind,
          title: s.title,
          url: s.url ?? null,
          note: s.note ?? null,
          tags: s.tags,
          tripLabel: s.tripLabel ?? null,
        })),
        total: filtered.length,
      };
    }
    default:
      return { error: `unhandled tool: ${call.name}` };
  }
}

/**
 * Iterative tool-use loop for the morning scan. Mirrors the bot's runNativeLoop
 * (ADR 0005) but read-only and without SSE — we don't surface tool chatter to
 * the user; we just want the final briefing text.
 */
async function runScanLoop(
  llm: LlmService,
  db: Kysely<DB>,
  userId: string,
  contextBlock: string,
): Promise<string | null> {
  const tools: LlmToolDef[] = buildToolDefs().filter((t) =>
    SCAN_TOOL_NAMES.includes(t.name as ToolName),
  );
  const working: LlmMessage[] = [
    { role: 'system', content: SCAN_SYSTEM_PROMPT(getDefaultPersona().promptName) },
    { role: 'user', content: contextBlock },
  ];
  const streamRound = async () => {
    let text = '';
    const calls: LlmToolCall[] = [];
    for await (const chunk of llm.stream(working, {
      tools,
      temperature: 0.3,
      maxTokens: 500,
    })) {
      if (chunk.type === 'text') text += chunk.delta;
      else if (chunk.type === 'tool_call') calls.push(chunk.call);
      else if (chunk.type === 'done') break;
    }
    return { text, calls };
  };

  // Only the round that answers without a lookup is the briefing. Text
  // written beside a lookup ("Let me check your trips…") is the model talking
  // to itself, and adding it up put that narration into the message.
  for (let iter = 0; iter < SCAN_MAX_ITERATIONS; iter++) {
    const { text: iterText, calls } = await streamRound();
    if (calls.length === 0) return iterText.trim() || null;

    working.push({ role: 'assistant', content: iterText, toolCalls: calls });

    for (const call of calls) {
      const result = await executeScanTool(db, userId, call);
      working.push({
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        content: JSON.stringify(result),
      });
    }
  }

  // Out of rounds while still looking things up: ask for the briefing from
  // what it has. Tools stay declared (some providers refuse a history with
  // tool results and no tools); any further lookup is ignored.
  working.push({
    role: 'user',
    content: 'Write the briefing now from what you have. Do not look anything else up.',
  });
  const final = await streamRound();
  return final.text.trim() || null;
}

/**
 * The model-written part of the briefing, greeting removed: '' when there is
 * nothing to report, null when rendering failed (the caller retries). The
 * greeting and the parts built in code are added by `composeBriefing`.
 */
async function renderDailyMorningScan(
  db: Kysely<DB>,
  payload: string,
): Promise<string | null> {
  const clean = (text: string | null) => {
    const stripped = stripContextTags(text);
    return stripped === null ? null : cleanScanText(stripped);
  };
  try {
    const p = JSON.parse(payload) as DailyMorningScanPayload;
    const userPrompt = await loadScanContext(db, p.userId);
    if (!userPrompt) return '';
    const llm = await getLlmForUser(db, p.userId, 'briefing');
    if (llm.supportsNativeTools) {
      return clean(await runScanLoop(llm, db, p.userId, userPrompt));
    }
    // Fallback for providers without native function-calling (mock): single-shot.
    const body = await llm.complete(
      [
        { role: 'system', content: SCAN_SYSTEM_PROMPT(getDefaultPersona().promptName) },
        { role: 'user', content: userPrompt },
      ],
      { temperature: 0.3, maxTokens: 500 },
    );
    const trimmed = body.trim();
    if (!trimmed) {
      logger.warn('daily_morning_scan render returned empty body', {
        userId: p.userId,
        scanDate: p.scanDate,
      });
      return null;
    }
    return clean(trimmed);
  } catch (err) {
    logger.warn('daily_morning_scan render failed', { err });
    return null;
  }
}

/**
 * How long after `scheduled_for` a row is still allowed to fire. Past that,
 * we mark it fired and skip — the user shouldn't get yesterday's 7am morning
 * briefing at 3pm just because the server was down. The next-day row, queued
 * by the self-reschedule path, will fire at its own scheduled time.
 *
 * Per-kind because the windows mean different things:
 *  - daily_morning_scan: tied to a wall clock; once the morning is gone,
 *    skip it entirely.
 *  - task_remind: tied to a specific moment; a few hours late is still useful
 *    ("you missed picking up Sam"), but a day-plus late is just noise.
 *  - event_created_nudge: post-create echo; if it didn't fire within a few
 *    hours of the event being created, the moment has passed.
 *  - trip_cancellation: same shape as event_created_nudge — a stale-by-days
 *    "heads up, that cancelled" is still true but reads as noise once the
 *    Trips tab itself has long since caught up.
 */
const STALE_AFTER_MS: Record<ProactiveKind, number> = {
  daily_morning_scan: 30 * 60_000,        // 30 min
  task_remind: 6 * 60 * 60_000,           // 6 hours
  event_created_nudge: 2 * 60 * 60_000,   // 2 hours
  email_digest: 12 * 60 * 60_000,         // 12 hours — don't fire a day-old digest
  trip_cancellation: 2 * 60 * 60_000,     // 2 hours
  email_change_notice: 2 * 60 * 60_000, // 2 hours
};

async function fireOne(
  db: Kysely<DB>,
  row: ProactiveMessagesTable,
): Promise<boolean> {
  const kind = row.kind as ProactiveKind;
  // ADR 0013: dev-triggered scans carry `-dev-` in their scanDate.
  const isDevTriggered =
    kind === 'daily_morning_scan' && row.payload.includes('-dev-');

  // Don't fire stale rows that piled up while the server was down. Dev-triggered
  // scans are user-initiated ("send me a briefing now") and skip the staleness
  // gate — their scheduled_for is "now" by design.
  if (!isDevTriggered) {
    const cutoff = STALE_AFTER_MS[kind];
    if (cutoff !== undefined) {
      const scheduledMs = Date.parse(row.scheduled_for);
      if (
        Number.isFinite(scheduledMs) &&
        Date.now() - scheduledMs > cutoff
      ) {
        await db
          .updateTable('proactive_messages')
          .set({ fired_at: new Date().toISOString() })
          .where('id', '=', row.id)
          .execute();
        logger.info(
          `proactive ${row.id} (${kind}) skipped — stale by ${Math.round(
            (Date.now() - scheduledMs) / 60_000,
          )}m`,
        );
        return false;
      }
    }
  }

  // No per-person rate limit here. There used to be a 24h one; every other
  // kind was exempted from it over time, leaving it on task_remind alone —
  // where the morning briefing's own fired row then blocked every reminder
  // in a personal chat until the staleness cutoff retired it unsent. A
  // reminder fires at the time its owner picked.

  // ADR 0079 — post-trial gate: LLM-driven proactive kinds don't render for
  // an unentitled persona. Digests and conflict nudges retire silently; the
  // DAILY BRIEFING keeps arriving as a deterministic teaser (a few real
  // lines + "read more") — the daily touchpoint that brings lapsed users
  // back. Zero LLM cost either way.
  let gatedTeaser: string | null = null;
  // ADR 0283 — the same kinds wait for the user's AI consent; the briefing
  // still arrives, as the no-model teaser.
  if (
    row.persona_id &&
    (kind === 'daily_morning_scan' || kind === 'email_digest' || kind === 'event_created_nudge') &&
    !(await hasAiConsent(db, row.persona_id))
  ) {
    if (kind !== 'daily_morning_scan') {
      await db
        .updateTable('proactive_messages')
        .set({ fired_at: new Date().toISOString() })
        .where('id', '=', row.id)
        .execute();
      return false;
    }
    gatedTeaser = renderTeaser(
      await buildBriefingFacts(db, row.persona_id),
      'Your full briefing is written by Chord’s AI, which is off until you allow it. Open the Chord app, or reply AGREE here to turn it on.',
    );
  }
  if (
    gatedTeaser === null &&
    env.BILLING_ENABLED &&
    row.persona_id &&
    (kind === 'daily_morning_scan' || kind === 'email_digest' || kind === 'event_created_nudge')
  ) {
    const ent = await getEntitlement(db, row.persona_id);
    if (!ent.entitled) {
      if (kind !== 'daily_morning_scan') {
        await db
          .updateTable('proactive_messages')
          .set({ fired_at: new Date().toISOString() })
          .where('id', '=', row.id)
          .execute();
        return false;
      }
      gatedTeaser = await buildGatedBriefingTeaser(db, row.persona_id);
    }
  }

  let body: string | null = null;
  if (gatedTeaser !== null) body = gatedTeaser;
  else if (kind === 'task_remind') body = await renderTaskRemind(db, row.payload);
  else if (kind === 'event_created_nudge') body = await renderEventCreatedNudge(db, row.payload);
  else if (kind === 'trip_cancellation') body = renderTripCancellationNudge(row.payload);
  else if (kind === 'email_change_notice') body = renderEmailChangeNotice(row.payload);
  else if (kind === 'daily_morning_scan') {
    const scan = await renderDailyMorningScan(db, row.payload);
    // Every part below is best-effort: one that fails or has nothing is
    // simply absent, never a broken briefing. `composeBriefing` puts them in
    // order and writes the greeting once it knows whether there is any news.
    const parts: BriefingParts = { scan: scan ?? '' };
    // ADR 0091 — weather first, above the birthdays (owner, 2026-10-24).
    if (scan !== null && row.persona_id) {
      try {
        parts.weather = await weatherLineForUser(db, row.persona_id);
      } catch (err) {
        logger.warn('briefing weather line failed', { err, userId: row.persona_id });
      }
    }
    // ADR 0272 — birthdays and anniversaries from People, the calendar,
    // to-dos and email lead the message, right under the greeting.
    if (scan !== null && row.persona_id) {
      try {
        const u = await db
          .selectFrom('users')
          .select('last_tz')
          .where('id', '=', row.persona_id)
          .executeTakeFirst();
        const tz = u?.last_tz ?? null;
        parts.celebrations = renderCelebrationsSection(
          await collectCelebrations(db, row.persona_id, tz),
          dayOf(new Date().toISOString(), tz),
        );
      } catch (err) {
        logger.warn('briefing celebrations section failed', { err, userId: row.persona_id });
      }
    }
    // ADR 0285 — the to-dos Chord took off the list since yesterday, by name,
    // so none disappears without the user being told. Printed by code: the
    // model was asked never to omit the count, and a rule asked of a model is
    // not a guarantee.
    if (scan !== null && row.persona_id) {
      try {
        parts.retired = renderRetiredSection(
          await retiredTodosSince(db, row.persona_id, new Date(Date.now() - RETIRED_WINDOW_MS).toISOString()),
        );
      } catch (err) {
        logger.warn('briefing retired to-dos failed', { err, userId: row.persona_id });
      }
    }
    // ADR 0346 — "Waiting on Rob's invite", printed by code like the above.
    if (scan !== null && row.persona_id) {
      try {
        const u = await db.selectFrom('users').select('last_tz').where('id', '=', row.persona_id).executeTakeFirst();
        parts.waiting = renderWaitingSection(
          await activeHolds(db, row.persona_id),
          u?.last_tz ?? null,
          await waitingOnAnswers(db, row.persona_id),
        );
      } catch (err) {
        logger.warn('briefing waiting-on-invites failed', { err, userId: row.persona_id });
      }
    }
    // ADR 0148 — if the stored weather location looks stale (a fresh IP /
    // timezone fix is far from it), append one line asking whether to switch.
    // The user answers in chat; `set_weather_location` acts on it. Nothing is
    // changed here. Best-effort, same contract as the sections around it.
    if (scan !== null && row.persona_id) {
      try {
        parts.weatherQuestion = await weatherDriftQuestion(db, row.persona_id);
      } catch (err) {
        logger.warn('briefing weather drift check failed', { err, userId: row.persona_id });
      }
    }
    // ADR 0072 — ONE morning message: the email section (pending suggestions +
    // mail worth a look) rides the briefing instead of firing as a second
    // email_digest message. Best-effort; a failure never breaks the briefing.
    let emailSectionRendered = false;
    if (scan !== null && row.persona_id && env.GMAIL_ENABLED) {
      try {
        const prefs = await db
          .selectFrom('users')
          .select('email_digest_enabled')
          .where('id', '=', row.persona_id)
          .executeTakeFirst();
        const digestOn = Number(prefs?.email_digest_enabled ?? 1) === 1;
        // ADR 0080 — attached mailboxes count as a connected email source and
        // refresh alongside Gmail so the section sees all fresh mail.
        const accountCount = digestOn
          ? await db
              .selectFrom('email_accounts')
              .select(db.fn.countAll().as('n'))
              .where('user_id', '=', row.persona_id)
              .executeTakeFirst()
          : undefined;
        const hasAccounts = Number(accountCount?.n ?? 0) > 0;
        if (digestOn && ((await hasGmailScope(db, row.persona_id)) || hasAccounts)) {
          // Fresh mail before the section renders. Throttled; never throws.
          // ONE round across both mailbox sources (ADR 0137) — and it must
          // CLOSE here, before the section is built: the digest reads what
          // the AI passes produce, so deferring the flush past this point
          // would render it from pre-pipeline state.
          await withMailSyncRound(db, row.persona_id, async () => {
            if (hasAccounts) await maybeSyncAccounts(db, row.persona_id!);
            await maybeSyncGmail(db, row.persona_id!);
          });
          const section = await buildEmailDigestBody(db, row.persona_id);
          if (section) {
            parts.email = section;
            emailSectionRendered = true;
          }
        }
      } catch (err) {
        logger.warn('briefing email section failed', { err, userId: row.persona_id });
      }
    }
    // Unaccepted proposals ride the briefing too — chat/attachment ones
    // always; gmail magics only when the email section didn't already list
    // them. Best-effort, same contract as the email section.
    if (scan !== null && row.persona_id) {
      try {
        parts.proposals = await buildPendingProposalsSection(db, row.persona_id, {
          excludeGmail: emailSectionRendered,
        });
      } catch (err) {
        logger.warn('briefing proposals section failed', { err, userId: row.persona_id });
      }
    }
    // A failed render stays null so the row retries next tick.
    body = scan === null ? null : composeBriefing(parts);
  } else if (kind === 'email_digest') {
    // Legacy standalone digest (pre-ADR-0072 pending rows drain here; no new
    // ones are enqueued).
    if (row.persona_id) await maybeSyncGmail(db, row.persona_id);
    body = await renderEmailDigest(db, row.payload);
  }
  if (!body) {
    // Retire (don't retry) when an empty render is a *final* answer rather than
    // a transient failure:
    //   - task_remind: the task was completed/deleted — permanent.
    //   - event_created_nudge: an empty body is the DESIGNED "no scheduling
    //     conflict" response (see NUDGE_SYSTEM_PROMPT: "If there are no
    //     conflicts, output an empty response"). Retrying just re-asks the LLM
    //     every drain tick for the whole TTL — hundreds of calls per
    //     conflict-free event. A genuine transient LLM error also retires here;
    //     acceptable for a best-effort conflict nudge.
    // daily_morning_scan still retries: an empty there is more likely a real
    // transient failure, and the staleness cutoff retires it if it persists.
    if (
      kind === 'task_remind' ||
      kind === 'event_created_nudge' ||
      kind === 'email_digest' ||
      kind === 'trip_cancellation' ||
      kind === 'email_change_notice'
    ) {
      // email_digest: an empty body means an empty inbox — a final answer, not a
      // transient failure. Retire it (don't retry every tick for the TTL).
      await db
        .updateTable('proactive_messages')
        .set({ fired_at: new Date().toISOString() })
        .where('id', '=', row.id)
        .execute();
    } else {
      const wait = await deferRetry(db, row);
      logger.warn(
        `proactive ${row.id} (${kind}) render returned null — will retry in ${Math.round(wait / 1000)}s`,
      );
    }
    return false;
  }

  const msg: MessagesTable = {
    id: newId('m'),
    group_id: row.group_id,
    sender_id: null,
    kind: 'bot',
    body,
    attachment_id: null,
    reply_to_id: null,
    mentions_bot: 0,
    created_at: new Date().toISOString(),
    source: null,
    external_message_id: null,
    chord_visible: 1,
    mentions_others: 0,
    auto_mirror: 1,
    bot_persona_id: getDefaultPersona().id,
    is_proactive: 1,
    proactive_kind: kind,
  };
  await db.insertInto('messages').values(msg).execute();
  await db
    .updateTable('proactive_messages')
    .set({ fired_at: msg.created_at })
    .where('id', '=', row.id)
    .execute();
  sseHub.broadcast(row.group_id, SSE.message, rowToMessage(msg));
  logger.info(`proactive fired ${row.id} → message ${msg.id}`);

  // Once a day (riding the morning scan), check whether the user's Google
  // Calendar / Gmail connection has silently died and warn them if so.
  // Best-effort — never let it break the briefing fire.
  if (kind === 'daily_morning_scan' && row.persona_id) {
    // Independent: different provider, different user columns
    // (calendar_reconnect_nudged_at vs gmail_reconnect_nudged_at), separate
    // message rows. Each keeps its own try/catch so one failing never
    // suppresses the other.
    const personaId = row.persona_id;
    await Promise.all([
      maybeNudgeCalendarReconnect(db, personaId).catch((err) => {
        logger.warn('calendar reconnect nudge check failed', { err, userId: personaId });
      }),
      maybeNudgeGmailReconnect(db, personaId).catch((err) => {
        logger.warn('gmail reconnect nudge check failed', { err, userId: personaId });
      }),
    ]);
  }

  // Self-rescheduling: after a daily scan fires, queue tomorrow's row at the
  // user's configured nudge time — unless they've turned the briefing off.
  if (kind === 'daily_morning_scan' && row.persona_id) {
    try {
      const user = await db
        .selectFrom('users')
        .select(['last_tz', 'nudge_hour', 'nudge_minute', 'nudge_enabled'])
        .where('id', '=', row.persona_id)
        .executeTakeFirst();
      if (Number(user?.nudge_enabled ?? 1) === 1) {
        await enqueueDailyScanForUser(
          db,
          row.persona_id,
          nextScanDate(user?.last_tz ?? null, user?.nudge_hour ?? 7, user?.nudge_minute ?? 0),
          user?.last_tz ?? null,
        );
      }
    } catch (err) {
      logger.warn('failed to reseed daily_morning_scan', { err, userId: row.persona_id });
    }
  }
  return true;
}

const ARCHIVE_EVERY_MS = 10 * 60_000;
/** Last archive pass per database handle. In memory: a restart runs one
 *  more pass. Keyed on the handle so each test database gets its own. */
const lastArchiveAt = new WeakMap<object, number>();

/** The archive pass scans every live task; the proactive tick runs every 15 s,
 *  and nothing it retires is that urgent. */
async function maybeArchiveStaleTasks(db: Kysely<DB>, nowMs = Date.now()): Promise<number> {
  const last = lastArchiveAt.get(db);
  if (last !== undefined && nowMs - last < ARCHIVE_EVERY_MS) return 0;
  lastArchiveAt.set(db, nowMs);
  return archiveStaleTasks(db);
}

/**
 * Three archive rules, all recoverable (spec v4 §6.2, ADR 0092):
 *
 *  1. done + ARCHIVE_DONE_MINUTES elapsed since completed_at. Keyed off
 *     completed_at, not due_at — otherwise an old-due task got re-archived
 *     immediately on toggle-to-done.
 *  2. open/active with an explicit live_until in the past.
 *  3. open/active carrying a due_at more than TASK_OVERDUE_ARCHIVE_DAYS past.
 *
 * Rule 3 is deliberately narrow. A task with NO due date is never
 * auto-archived however old it is — only the user closes undated work. A
 * pending reminder defers it (never retire something we're about to ping
 * about), and `archived_at IS NULL` makes it fire at most ONCE per task: if
 * the user pulls an item back out of Archived, we never overrule them again.
 * That guard is also what stops an open↔archived oscillation on reopen, the
 * same failure the completed_at keying above was written to prevent.
 *
 * Rules 2 and 3 never retire a task whose due date is still ahead. Rule 3
 * cannot by construction; rule 2 could (a lapsed live_until beside a later
 * due date), and the check is made on the parsed instant because due_at is
 * text in mixed offsets (ADR 0208).
 */
async function archiveStaleTasks(db: Kysely<DB>): Promise<number> {
  const now = new Date();
  const nowIso = now.toISOString();
  const doneCut = new Date(now.getTime() - env.ARCHIVE_DONE_MINUTES * 60_000).toISOString();
  const overdueCut = new Date(
    now.getTime() - env.TASK_OVERDUE_ARCHIVE_DAYS * 24 * 60 * 60_000,
  ).toISOString();

  const candidates = await db
    .selectFrom('tasks')
    .select(['id', 'status', 'due_at', 'live_until'])
    .where('status', 'not in', ['archived', 'superseded'])
    .where((eb) =>
      eb.or([
        eb.and([
          eb('status', '=', 'done'),
          eb('completed_at', 'is not', null),
          eb('completed_at', '<', doneCut),
        ]),
        // Instants, not text: "07:00-04:00" is AFTER "09:00Z" but sorts
        // before it, so a reminder still ahead read as already past.
        eb.and([
          eb('status', 'in', ['open', 'active']),
          eb('live_until', 'is not', null),
          eb(textInstant('tasks.live_until'), '<', sql<string>`${nowIso}::timestamptz`),
        ]),
        eb.and([
          eb('status', 'in', ['open', 'active']),
          eb('due_at', 'is not', null),
          eb(textInstant('tasks.due_at'), '<', sql<string>`${overdueCut}::timestamptz`),
          eb('archived_at', 'is', null),
          eb.or([
            eb('remind_at', 'is', null),
            eb(textInstant('tasks.remind_at'), '<', sql<string>`${nowIso}::timestamptz`),
          ]),
        ]),
      ]),
    )
    .execute();
  const rows = candidates.filter(
    (t) => t.status === 'done' || !isDueInFuture(t.due_at, now.getTime()),
  );

  if (rows.length === 0) return 0;
  // ADR 0285 — record which rule retired it: the briefing tells the user
  // about the overdue and expired ones, not a finished task being filed.
  const reasonOf = (t: (typeof rows)[number]): TaskArchivedReason =>
    t.status === 'done'
      ? 'completed'
      : instantMs(t.live_until) < now.getTime()
        ? 'expired'
        : 'overdue';
  const byReason = new Map<TaskArchivedReason, string[]>();
  for (const t of rows) {
    const reason = reasonOf(t);
    byReason.set(reason, [...(byReason.get(reason) ?? []), t.id]);
  }
  for (const [reason, ids] of byReason) {
    await db
      .updateTable('tasks')
      .set({ status: 'archived', archived_at: nowIso, archived_reason: reason })
      .where('id', 'in', ids)
      .execute();
  }
  return rows.length;
}

const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;

/** The wait before a failed row's next try: 1 min, doubling, at most 30. */
export function proactiveRetryDelayMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts), RETRY_MAX_MS);
}

/** Records one failed try and holds the row back; returns the wait. The
 *  staleness cutoff still retires a row that never succeeds. */
async function deferRetry(db: Kysely<DB>, row: ProactiveMessagesTable): Promise<number> {
  const attempts = Number(row.attempts ?? 0);
  const wait = proactiveRetryDelayMs(attempts);
  await db
    .updateTable('proactive_messages')
    .set({ attempts: attempts + 1, retry_after: new Date(Date.now() + wait).toISOString() })
    .where('id', '=', row.id)
    .where('fired_at', 'is', null)
    .execute();
  return wait;
}

/** Kinds whose whole point is their time: drained before the rest. */
const TIME_CRITICAL_KINDS = ['task_remind'];

export async function drainOnce(db: Kysely<DB>): Promise<void> {
  const nowIso = new Date().toISOString();
  const due = await db
    .selectFrom('proactive_messages')
    .selectAll()
    .where('fired_at', 'is', null)
    .where('scheduled_for', '<=', nowIso)
    .where((eb) => eb.or([eb('retry_after', 'is', null), eb('retry_after', '<=', nowIso)]))
    .orderBy(
      sql`CASE WHEN kind IN (${sql.join(TIME_CRITICAL_KINDS)}) THEN 0 ELSE 1 END`,
    )
    .orderBy('scheduled_for', 'asc')
    .limit(20)
    .execute();

  for (const row of due) {
    try {
      await fireOne(db, row);
    } catch (err) {
      logger.error('proactive fire failed', { err, id: row.id });
      try {
        await deferRetry(db, row);
      } catch (deferErr) {
        logger.error('proactive retry deferral failed', { err: deferErr, id: row.id });
      }
    }
  }

  try {
    const n = await maybeArchiveStaleTasks(db);
    if (n > 0) logger.info(`archived ${n} stale tasks`);
  } catch (err) {
    logger.error('archive pass failed', { err });
  }

  // ADR 0226 — once a day, remove rows past their kept-for window.
  try {
    await maybePruneOldRows(db);
  } catch (err) {
    logger.error('retention prune failed', { err: (err as Error).message });
  }

  // ADR 0281 — once a day, tidy learned facts (repeats, stale suggestions,
  // facts saved twice under different words).
  try {
    await maybeCleanupMemories(db);
  } catch (err) {
    logger.error('memory cleanup failed', { err: (err as Error).message });
  }

  // docs/notes/0199 — read/unread changes a provider refused are retried with
  // backoff (due rows only, so most ticks do one indexed query and stop).
  try {
    const r = await flushReadWrites(db);
    if (r.written + r.retrying + r.abandoned > 0) {
      logger.info(
        `read-state retries: ${r.written} written, ${r.retrying} still owed, ${r.abandoned} abandoned`,
      );
    }
  } catch (err) {
    logger.error('read-state retry pass failed', { err });
  }

  // AI work held back for consent or allowance runs once both are met.
  try {
    const n = await maybeDrainAiBacklog(db);
    if (n > 0) logger.info(`ai backlog: ran ${n} held-back item(s)`);
  } catch (err) {
    logger.error('ai backlog pass failed', { err: (err as Error).message });
  }

  // ADR 0252 - tell people whose own AI key stopped working, once per outage.
  try {
    const n = await sweepByokKeyNudges(db);
    if (n > 0) logger.info(`byok key nudges posted: ${n}`);
  } catch (err) {
    logger.error('byok key nudge sweep failed', { err });
  }

  // ADR 0144 — keep the mailbox mirror fresh for people who are not staring at
  // the Email tab. Mirror depth only: this never reaches the AI passes.
  try {
    const n = await sweepMailboxes(db);
    if (n > 0) logger.info(`mail sweep refreshed ${n} mailbox owner(s)`);
  } catch (err) {
    logger.error('mail sweep failed', { err });
  }

  // ADR 0181 — keep the calendar mirror fresh for people who are not
  // triggering an opportunistic sync. Catches a Google-side edit (e.g. an
  // event moved to a different calendar) within one sweep cadence instead of
  // leaving it stale until the next bot call or foreground refresh.
  // ADR 0289 addendum — someone else's ticket shows as free on your calendar.
  // Hourly; before the calendar sweep so a change is pushed this tick.
  try {
    await maybeRefreshTicketFreeBusy(db);
  } catch (err) {
    logger.error('ticket free/busy refresh failed', { err });
  }
  try {
    const n = await sweepCalendars(db);
    if (n > 0) logger.info(`calendar sweep refreshed ${n} user(s)`);
  } catch (err) {
    logger.error('calendar sweep failed', { err });
  }

  // ADR 0276 — search vectors for mail that has none yet. Bounded per tick;
  // a no-op unless EMBEDDINGS_ENABLED.
  try {
    const n = await sweepEmbeddings(db);
    if (n > 0) logger.info(`embedding sweep updated ${n} user(s)`);
  } catch (err) {
    logger.error('embedding sweep failed', { err });
  }

  // ADR 0301 — a report whose email did not go out is retried.
  try {
    const n = await sweepReportEmails(db);
    if (n > 0) logger.info(`emailed ${n} content report(s)`);
  } catch (err) {
    logger.error('report email sweep failed', { err });
  }

  // ADR 0217 — write repeating events' occurrences out to the horizon as the
  // days pass. One indexed query when nothing is due.
  try {
    const n = await topUpSeries(db);
    if (n > 0) logger.info(`series top-up wrote ${n} occurrence(s)`);
  } catch (err) {
    logger.error('series top-up failed', { err });
  }

  // insurance-cards-file-link-bug — incidental (email-auto-imported,
  // unpinned) attachments age out; a direct upload never does.
  try {
    const n = await expireIncidentalAttachments(db);
    if (n > 0) logger.info(`expired ${n} incidental attachment(s)`);
  } catch (err) {
    logger.error('attachment expiry sweep failed', { err });
  }

  // insurance-cards-file-link-bug — a boarding pass / hotel confirmation
  // ages out once its OWN trip is over, regardless of upload origin.
  try {
    const n = await expireExpiredItineraryAttachments(db);
    if (n > 0) logger.info(`expired ${n} itinerary attachment(s)`);
  } catch (err) {
    logger.error('itinerary attachment expiry sweep failed', { err });
  }
}

export interface SchedulerHandle {
  stop: () => void;
}

export function startProactiveScheduler(db: Kysely<DB>): SchedulerHandle {
  logger.info(
    `proactive scheduler tick=${env.PROACTIVE_TICK_MS}ms`,
  );
  // Seed today's daily scan rows (one per user with a personal group).
  // Idempotent — won't insert if a row already exists for today.
  seedDailyScan(db).catch((err) => logger.error('seedDailyScan failed', { err }));
  let inFlight = false;
  const interval = setInterval(async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await drainOnce(db);
    } finally {
      inFlight = false;
    }
  }, env.PROACTIVE_TICK_MS);
  interval.unref?.();
  return { stop: () => clearInterval(interval) };
}

async function findPersonalGroupId(
  db: Kysely<DB>,
  userId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('groups')
    .select('id')
    .where('kind', '=', 'personal')
    .where('created_by', '=', userId)
    .executeTakeFirst();
  return row?.id ?? null;
}

/**
 * The zone a briefing is timed in: the user's own, else the configured
 * default, else UTC if that default is itself junk. `last_tz` is guarded by
 * `isValidTz` on write, but rows predating that guard still exist — an invalid
 * one must land on the default, not on the server clock (ADR 0098).
 */
function pickBriefingZone(tz?: string | null): string {
  if (tz && isValidTz(tz)) return tz;
  if (isValidTz(env.BRIEFING_DEFAULT_TZ)) return env.BRIEFING_DEFAULT_TZ;
  return 'UTC';
}

/**
 * Returns the next occurrence of `hour:minute` (default 07:00) in the user's
 * local timezone as a UTC ISO string. When `tz` is unset or invalid, falls
 * back to `BRIEFING_DEFAULT_TZ`.
 *
 * That fallback used to be the *server's* clock, which on a UTC VM queued a
 * 07:00 briefing for 07:00Z — midnight Pacific. The hour has to come from a
 * zone someone chose, not from where the box happens to run (ADR 0098).
 *
 * Implementation: render "now" as a wall-clock string in `tz`, build the
 * target wall clock in that same zone, then compute the UTC instant that
 * matches it. If today's target has already passed in `tz`, roll one day
 * forward.
 */
export function nextScanDate(
  tz?: string | null,
  hour = 7,
  minute = 0,
): string {
  const now = new Date();
  const hh2 = String(hour).padStart(2, '0');
  const mm2 = String(minute).padStart(2, '0');
  const zone = pickBriefingZone(tz);
  try {
    // "YYYY-MM-DD HH:MM:SS" wall clock in zone.
    const local = now.toLocaleString('sv-SE', { timeZone: zone });
    const [datePart, timePart] = local.split(' ');
    const [nowHh, nowMm] = timePart.split(':').map(Number);
    // Target wall-clock day = today if the target hasn't happened yet, else tomorrow.
    const baseDate = new Date(`${datePart}T00:00:00Z`);
    if (nowHh > hour || (nowHh === hour && nowMm >= minute)) {
      baseDate.setUTCDate(baseDate.getUTCDate() + 1);
    }
    const targetDay = baseDate.toISOString().slice(0, 10);
    // The zone's offset at the target moment, which may differ from today's.
    return new Date(zonedWallToUtcMs(`${targetDay}T${hh2}:${mm2}:00`, zone)).toISOString();
  } catch {
    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
    return target.toISOString();
  }
}

/** YYYY-MM-DD of an ISO timestamp in server-local time. */
function localDayOf(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function isShadowUser(db: Kysely<DB>, userId: string): Promise<boolean> {
  const row = await db
    .selectFrom('users')
    .select('shadow')
    .where('id', '=', userId)
    .executeTakeFirst();
  return row?.shadow === 1;
}

/**
 * A briefing already queued for that day keeps its row but takes the time just
 * computed, which reflects the user's current zone and settings. Rows queued
 * before a fix to the time itself (one an hour early on the day US clocks fell
 * back) are corrected by the next startup seed this way. A sent one is history.
 */
async function retimePending(
  db: Kysely<DB>,
  row: { id: string; scheduled_for: string; fired_at: string | null },
  scheduledForIso: string,
): Promise<void> {
  if (row.fired_at !== null) return;
  if (instantMs(row.scheduled_for) === instantMs(scheduledForIso)) return;
  await db
    .updateTable('proactive_messages')
    .set({ scheduled_for: scheduledForIso })
    .where('id', '=', row.id)
    .where('fired_at', 'is', null)
    .execute();
  logger.info('daily briefing re-timed', {
    id: row.id,
    from: row.scheduled_for,
    to: scheduledForIso,
  });
}

async function enqueueDailyScanForUser(
  db: Kysely<DB>,
  userId: string,
  scheduledForIso: string,
  tz?: string | null,
  shadow?: boolean,
): Promise<void> {
  // ADR 0098 — a shadow owns a personal group only because the WhatsApp taster
  // needed somewhere to put the bot's reply (ADR 0053). It never asked for a
  // daily message, each one is billed, and it can never report a `last_tz` to
  // time one by. Gated here rather than in `seedDailyScan` so a reschedule
  // can't put the row back. `shadow` is optional: seedDailyScan's own SELECT
  // already joins `users` and passes it to skip this re-fetch across every
  // owner at startup; other callers (self-reschedule, Settings-triggered
  // reschedule) omit it and fall back to fetching it here.
  const isShadow = shadow ?? (await isShadowUser(db, userId));
  if (isShadow) return;
  const personalGroupId = await findPersonalGroupId(db, userId);
  if (!personalGroupId) return;
  // The dedup key is "one briefing per the USER'S day" — computed in their
  // zone, not the server's, or a user hours ahead keys on the wrong day and
  // a legitimate re-queue gets swallowed.
  const scanDate = dayOf(scheduledForIso, tz);
  const existing = await db
    .selectFrom('proactive_messages')
    .select(['id', 'scheduled_for', 'fired_at', 'payload'])
    .where('kind', '=', 'daily_morning_scan')
    .where('persona_id', '=', userId)
    .where('payload', 'like', `%"scanDate":"${scanDate}"%`)
    .executeTakeFirst();
  if (existing) {
    // An asked-for briefing ("-dev-", runDailyScanForUserNow) is due now, not at the hour.
    if (!existing.payload.includes('-dev-')) await retimePending(db, existing, scheduledForIso);
    return;
  }
  // A pending row may carry a key computed under a different zone (the user
  // travelled, or this is the first enqueue after the server-local keys). Match
  // on the day it actually lands on so the zone change re-times the briefing
  // instead of adding a second one.
  const pending = await db
    .selectFrom('proactive_messages')
    .select(['id', 'scheduled_for', 'fired_at'])
    .where('kind', '=', 'daily_morning_scan')
    .where('persona_id', '=', userId)
    .where('fired_at', 'is', null)
    .where('payload', 'not like', '%-dev-%')
    .execute();
  const sameDay = pending.find((r) => dayOf(r.scheduled_for, tz) === scanDate);
  if (sameDay) {
    await retimePending(db, sameDay, scheduledForIso);
    return;
  }
  const payload: DailyMorningScanPayload = { userId, scanDate };
  const row: ProactiveMessagesTable = {
    id: newId('pm'),
    group_id: personalGroupId,
    persona_id: userId,
    kind: 'daily_morning_scan',
    payload: JSON.stringify(payload),
    scheduled_for: scheduledForIso,
    fired_at: null,
    created_at: new Date().toISOString(),
  };
  await db.insertInto('proactive_messages').values(row).execute();
}

/**
 * ADR 0013 testability: queue a `daily_morning_scan` for `userId` with
 * `scheduled_for = now()`, bypassing the per-day dedup so it always fires
 * on the next tick. Returns the inserted row (so callers can fire just that
 * one — see `runDailyScanForUserNow`), or null when the user has no personal
 * group.
 */
export async function enqueueDailyScanForUserNow(
  db: Kysely<DB>,
  userId: string,
): Promise<ProactiveMessagesTable | null> {
  const personalGroupId = await findPersonalGroupId(db, userId);
  if (!personalGroupId) return null;
  const nowIso = new Date().toISOString();
  const payload: DailyMorningScanPayload = {
    userId,
    // Tag with a unique scanDate so the regular dedup path can never prevent
    // the dev-triggered scan from being queued, and tomorrow's seed still works.
    scanDate: `${localDayOf(nowIso)}-dev-${Date.now()}`,
  };
  const row: ProactiveMessagesTable = {
    id: newId('pm'),
    group_id: personalGroupId,
    persona_id: userId,
    kind: 'daily_morning_scan',
    payload: JSON.stringify(payload),
    scheduled_for: nowIso,
    fired_at: null,
    created_at: nowIso,
  };
  await db.insertInto('proactive_messages').values(row).execute();
  return row;
}

/**
 * Queue an on-demand briefing for `userId` and fire *only that row* inline,
 * rather than draining the whole due queue. This keeps the "send me a
 * briefing now" action from prematurely firing other users' scheduled
 * nudges. Returns true when a briefing was posted. Safe to expose to end
 * users (it touches only the caller's personal group).
 */
export async function runDailyScanForUserNow(
  db: Kysely<DB>,
  userId: string,
): Promise<boolean> {
  const row = await enqueueDailyScanForUserNow(db, userId);
  if (!row) return false;
  return fireOne(db, row);
}

/**
 * Apply a changed nudge schedule: drop the user's pending (unfired) daily
 * scan and re-queue it at the current `nudge_*` settings. Called after the
 * user edits their nudge time/enabled in Settings or via chat, so the change
 * takes effect today rather than only from the next briefing onward. A no-op
 * for users without a personal group; queues nothing when nudges are off.
 */
export async function rescheduleDailyScanForUser(
  db: Kysely<DB>,
  userId: string,
): Promise<void> {
  await db
    .deleteFrom('proactive_messages')
    .where('kind', '=', 'daily_morning_scan')
    .where('persona_id', '=', userId)
    .where('fired_at', 'is', null)
    .where('payload', 'not like', '%-dev-%')
    .execute();
  const user = await db
    .selectFrom('users')
    .select(['last_tz', 'nudge_hour', 'nudge_minute', 'nudge_enabled'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!user || Number(user.nudge_enabled ?? 1) !== 1) return;
  await enqueueDailyScanForUser(
    db,
    userId,
    nextScanDate(user.last_tz ?? null, user.nudge_hour ?? 7, user.nudge_minute ?? 0),
    user.last_tz ?? null,
  );
}

/** Valid IANA zone? Guards `last_tz` against a client sending junk — a bad
 *  zone would silently fall the scheduler back to server-local for good. */
function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist the user's current IANA zone, and when it actually changed, re-time
 * their pending briefing.
 *
 * Without the reschedule a traveller keeps the old zone's fire time until the
 * *next* briefing fires and re-seeds — so a there-and-back trip lands the
 * briefing at the wrong hour in both directions. Returns true when the zone
 * changed (i.e. the schedule moved).
 */
export async function recordUserTimezone(
  db: Kysely<DB>,
  userId: string,
  tz: string,
): Promise<boolean> {
  // The client reports its zone with EVERY message post and every foreground,
  // and it almost never changes. This process already knows what it last saw
  // stored for the user, so an unchanged zone costs nothing: no zone-validity
  // check (an Intl.DateTimeFormat construction) and no `users` read on the
  // highest-volume route.
  if (confirmedTz.get(userId) === tz) return false;
  if (!isValidTz(tz)) return false;
  const row = await db
    .selectFrom('users')
    .select('last_tz')
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!row) return false;
  if (row.last_tz === tz) {
    rememberTz(userId, tz);
    return false;
  }
  await db.updateTable('users').set({ last_tz: tz }).where('id', '=', userId).execute();
  await rescheduleDailyScanForUser(db, userId);
  rememberTz(userId, tz);
  return true;
}

/** userId -> the zone this process last saw stored (or stored) for them. */
const confirmedTz = new Map<string, string>();
const CONFIRMED_TZ_MAX = 50_000;
function rememberTz(userId: string, tz: string): void {
  // Bounded: an unbounded map is a slow leak on a long-lived server. Dropping it
  // all just costs each user one read again.
  if (confirmedTz.size >= CONFIRMED_TZ_MAX) confirmedTz.clear();
  confirmedTz.set(userId, tz);
}

/**
 * Drop pending briefings belonging to shadow users. `enqueueDailyScanForUser`
 * stops new ones being queued, but rows queued before that rule existed would
 * still fire — so the seed reconciles them away on its next tick instead of
 * needing a hand-run DELETE in production (ADR 0098).
 */
async function purgeShadowDailyScans(db: Kysely<DB>): Promise<number> {
  const res = await db
    .deleteFrom('proactive_messages')
    .where('kind', '=', 'daily_morning_scan')
    .where('fired_at', 'is', null)
    // Same carve-out the other delete paths make: a dev-triggered scan was
    // queued on purpose and must survive the tick that would otherwise race it.
    .where('payload', 'not like', '%-dev-%')
    .where((eb) =>
      eb(
        'persona_id',
        'in',
        eb.selectFrom('users').select('id').where('shadow', '=', 1),
      ),
    )
    .executeTakeFirst();
  return Number(res.numDeletedRows ?? 0);
}

/** Seed the next daily scan for every real user that has a personal group and
 *  has the briefing enabled. Each user gets a row scheduled for their
 *  configured nudge time in their own last-seen IANA tz; users who have never
 *  posted one fall back to `BRIEFING_DEFAULT_TZ` (ADR 0098). Shadow users and
 *  users with nudge_enabled=0 are skipped. */
export async function seedDailyScan(db: Kysely<DB>): Promise<void> {
  const purged = await purgeShadowDailyScans(db);
  if (purged > 0) {
    logger.info(`seedDailyScan: dropped ${purged} pending briefing(s) for shadow users`);
  }
  const rows = await db
    .selectFrom('groups')
    .innerJoin('users', 'users.id', 'groups.created_by')
    .select([
      'groups.created_by as userId',
      'users.last_tz as tz',
      'users.nudge_hour as hour',
      'users.nudge_minute as minute',
      'users.nudge_enabled as enabled',
      // Already joined here — pass it through so enqueueDailyScanForUser
      // doesn't re-fetch `shadow` per user on every seed pass.
      'users.shadow as shadow',
    ])
    .where('groups.kind', '=', 'personal')
    .where('groups.created_by', 'is not', null)
    .execute();
  const owners = rows.filter(
    (r): r is typeof r & { userId: string } => !!r.userId && Number(r.enabled ?? 1) === 1,
  );
  // Startup-time batch job over every user, not per-request — a higher bound
  // than the other batches in this file is reasonable here.
  const seededFlags = await mapConcurrent(owners, SEED_BATCH_CONCURRENCY, async (r) => {
    try {
      await enqueueDailyScanForUser(
        db,
        r.userId,
        nextScanDate(r.tz, r.hour ?? 7, r.minute ?? 0),
        r.tz,
        Number(r.shadow ?? 0) === 1,
      );
      return true;
    } catch (err) {
      logger.warn('seedDailyScan: skipping user', { err, userId: r.userId });
      return false;
    }
  });
  const seeded = seededFlags.filter(Boolean).length;
  logger.info(`seedDailyScan: queued ${seeded} daily scans at each user's nudge time`);
}

export const __testing = {
  renderTripCancellationNudge,
  renderEmailChangeNotice,
  executeScanTool,
  runScanLoop,
  loadNudgeContext,
  renderEventCreatedNudge,
  archiveStaleTasks,
  maybeArchiveStaleTasks,
  resetArchiveThrottle: (db: object) => lastArchiveAt.delete(db),
};
