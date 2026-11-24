/**
 * Executes a validated ToolCall against the service layer. Broadcasts the
 * matching SSE event so mobile resource views update live. Returns a short
 * human-readable summary for logging, an optional BotCard for chat rendering,
 * and optional structured data for read-side tools.
 *
 * Called by the bot turn loop and (after Phase A ships) by the WhatsApp import
 * pipeline. The input object carries the identity of whoever triggered the
 * call (`actorUserId`) and, for imports, the raw message context that produced
 * this call (`provenance`) so downstream entities can be traced back.
 */
import { sql, type Kysely } from 'kysely';

import type {
  BotCard,
  EmailAction,
  GroupEvent,
  MovableSaveKind,
  SseEventMap,
  SseEventName,
  Trip,
} from '@chord/kernel';
import { byInstant, instantMs } from '../../db/text-instant.js';
import {
  buildRrule,
  describeRrule,
  localWallOf,
  looksLikeRecurrenceRequest,
  trimRepeatToRequest,
  type RepeatSpec,
} from '../events/recurrence.js';
import {
  convertEventToSeries,
  deleteOccurrence,
  deleteSeries,
  getSeries,
  seriesZoneFor,
  updateSeries,
} from '../events/series.service.js';
import {
  SSE,
  calendarColorName,
  checkSender,
  describeRecipients,
  formatTimeOfDay,
  listNameKey,
  listNameTokens,
  looksLikeVideoCallRequest,
  videoCallKindNamed,
  videoCallLabel,
  pickReplyTarget,
  placeTimeZone,
  replyRecipients,
  replyToWarning,
  resolveListName,
  describeWorkHours,
  suggestionWhen,
} from '@chord/kernel';

import { logger } from '../../config/logging.js';
import { runAfterCommit } from '../../db/after-commit.js';
import { suggestFanoutGroups } from '../events/fanout-suggestion.js';
import { suggestTripShareGroups } from '../trips/share-suggestion.js';
import { setEventTrip } from '../trips/trip-conflict.js';
import { addTripTravelers, resolveTripTraveler, travelerByName } from '../trips/travelers.js';
import { familyGroupIdFor } from '../family-group.service.js';
import { describeSystemLlm } from '../llm/system-llm.js';
import { aiRecipient } from '../llm/ai-recipient.js';
import { setAiConsent } from '../ai-consent.service.js';
import { startOpenRouterConnect } from '../openrouter-connect.service.js';
import { emailSharePreview, postToGroup, shareEmailThreadToGroup } from '../group-share.service.js';
import { readBlob } from '../../db/crypto/index.js';
import type { DB } from '../../db/schema.js';
import { mapConcurrent } from '../../utils/concurrency.js';
import { likeContains } from '../../utils/like.js';
import { listBindingsForGroup } from '../connectors/channel-resolver.js';
import { connectorRegistry } from '../connectors/registry.js';
import type { ConnectorPlatform } from '../connectors/types.js';
import { counterpartNames } from '../groups.service.js';
import { calendarConnection } from '../outlook-calendar/accounts.js';
import { maybeSyncCalendar } from '../google/calendar.service.js';
import {
  calendarLabel,
  calendarSourceLabel,
  getDefaultCalendar,
  listCalendarSources,
  resolveTargetCalendarId,
  setCalendarColor,
  setDefaultCalendar,
  type CalendarPick,
} from '../calendar-sources.service.js';
import { chooseEventCalendar } from '../events/calendar-choice.js';
import { emailCalendarPick, isWritableCalendar } from '../email/source-mailbox.js';
import { computeConflicts } from '../conflicts.service.js';
import { mailboxColors, setMailboxColor } from '../email/mailbox-colors.service.js';
import { mailboxSignatureRow, namesMailbox, setMailboxSignature, signedBody } from '../email/signature.js';
import { signaturePictureFromAttachment, signaturePictureTag } from '../email/signature-images.js';
import { noteAddressesSeen, unknownAddressInstruction, unknownAddresses } from '../email/known-addresses.js';
import { getCategoryOrder, listCategoryTitles, setCategoryOrder } from '../email/category-order.service.js';
import { addSortRule, createUserCategory, listSortRules, removeSortRules } from '../email/sort-rules.service.js';
import {
  getDefaultMailbox,
  listMailboxChoices,
  matchMailboxByName,
  resolveSendMailbox,
  setDefaultMailbox,
} from '../email/default-mailbox.js';
import { createProposal } from '../proposals.service.js';
import { emailThreadPeopleOf, findEmailEventTwin } from '../event-convergence.service.js';
import { askAboutEmailTwin } from '../events/email-twin-question.js';
import { sendAccountReply, threadAccountId } from '../email-accounts/accounts.service.js';
import { summarizeEmailWindow } from '../email/summary.service.js';
import { askWhichPersonInstruction } from '../email/mail-query.js';
import { forwardPreview } from '../email/forward.service.js';
import { sendReply } from '../google/gmail.service.js';
import {
  deleteRoutingRule,
  inferRuleKind,
  listRoutingRules,
  setRoutingRule,
} from '../email/routing-rules.service.js';
import {
  deleteBriefingRule,
  listBriefingRules,
  resolveBriefingPattern,
  setBriefingRule,
} from '../email/briefing-rules.service.js';
import { buildAndStoreMeetingContext } from '../events/meeting-context.js';
import { appendEditNote, buildEventEditNote } from '../events/context-excerpt.js';
import {
  addVideoCall,
  changeEventGuests,
  eventVideoCallOption,
  providerEventPeople,
  videoCallNote,
} from '../events/guests.service.js';
import type { FamilyInviteResult } from '../events/family-invites.js';
import { waitForFamilyInvites } from '../events/family-invite-tracker.js';
import { answerFamilyInvite } from '../events/answer-invite.js';
import { waitingInvitations } from '../events/guest-answers.js';
import {
  autoRsvpCreator,
  createEvent,
  deleteEvent,
  moveEventIntoGroup,
  findEventByExternalUid,
  findEventsByTitle,
  findNearestEvent,
  findOwnedEventByIcalUid,
  findSimilarEvent,
  getEvent,
  listEventCopies,
  listRsvps,
  updateEvent,
  upsertRsvp,
  eventOverlapsRange,
  eventStartInstant,
  zonedDayRange,
} from '../events.service.js';
import {
  addItem,
  listListNames,
  listLists,
  listListsForUser,
  renameList,
  resolveOrCreateListByName,
  searchListsScoped,
} from '../lists.service.js';
import { postMessage } from '../messages.service.js';
import {
  addImportantDate,
  createPerson,
  findPersonByName,
  getPersonProfile,
  listPeopleForUser,
  promoteProvisionalPerson,
  updatePerson,
  type ImportantDateKind,
} from '../people.service.js';
import { env } from '../../config/env.js';
import { phoneCandidates } from '../family-contact-match.js';
import { startPhoneVerification, verifyPhone } from '../phone/phone.service.js';
import { deletePendingState, getPendingState, putPendingState } from './pending-state.js';
import { startSkill, stepSkill, type SkillAction } from './skills/index.js';
import { skillToolResult } from './skills/tool-result.js';
import { requestDeviceContact, type DeviceLookupOutcome } from './device-contact-lookup.js';
import { dropUnaskedMailFilters } from './search-filter-guard.js';
import { queryForTurn as queryMemoriesForTurn } from '../memory.service.js';
import { factEventChannel, labelMemorySubjects } from '../memory-notices.service.js';
import { correctMemoryForTurn, findMemoriesForTurn, forgetMemoryForTurn, rememberFactForTurn } from './memory-tools.js';
import { userAvailability } from '../availability.service.js';
import { getWorkHours, setWorkHours } from '../work-hours.service.js';
import { openOverlapQuestions, recordOverlapAnswer } from '../events/calendar-fit.service.js';
import { activeHolds, dropHold } from '../events/holds.service.js';
import { waitForTheirInvite } from '../email/meeting-invite-choice.js';
import { getBillingStatus } from '../billing-status.service.js';
import { disconnectApp, listConnectedApps } from '../ai-apps/oauth.service.js';
import { startCheckout } from '../checkout.service.js';
import { changePlan, setRenewal } from '../subscription-renewal.service.js';
import {
  addFamilyMember,
  findFamilyMemberByName,
  getFamilyOverview,
  removeFamilyMember,
} from '../family-plan.service.js';
import { inviteByEmail, listPendingInvites, respondToInvite } from '../chat-invites.service.js';
import {
  enqueueEventNudge,
  enqueueFromTask,
  rescheduleDailyScanForUser,
  runDailyScanForUserNow,
} from '../proactive.service.js';
import {
  clearUserWeatherLocation,
  declineWeatherDrift,
  setUserWeatherLocation,
} from '../geo/location.js';
import { createSaveWithDedup, listSaves, listSavesForUser, searchSavesScoped } from '../saves.service.js';
import { moveListToSaves } from '../list-to-saves.service.js';
import { literalQueryUsable, searchEverything, toTsQuery, type SearchCategory } from '../search.service.js';
import { getSearchProvider } from '../search/index.js';
import { sseHub } from '../sse.hub.js';
import { signaturePatch } from '../email/signature.js';
import { deleteGroupAs, ensurePairGroup, getMemberRole, isMember, leaveGroupAs, renameGroup } from '../groups.service.js';
import { resolveContactToUser } from '../contacts/contacts.service.js';
import {
  blockMember,
  isBlocked,
  listBlockedUsers,
  resolveBlockablePerson,
  resolveBlockedPerson,
  unblockUser,
} from '../blocks.service.js';
import { newestMessageFrom, reportMessage } from '../reports.service.js';
import {
  createTaskWithDedup,
  findTasksByTitle,
  getTaskInScope,
  listTasks,
  listTasksForUser,
  updateTask,
  type UpdateTaskInput,
} from '../tasks.service.js';
import { TrustError, requestPermission, isTrusted, isTrustedForPersona } from '../trust.service.js';
import { getPersona, resolveManagedPersonaByName } from '../personas.service.js';
import {
  addAccommodation,
  addReservation,
  addTravelLeg,
  assignPassengersToTrip,
  createTrip,
  findMatchingAccommodations,
  findMatchingLegs,
  findTripByDateRange,
  findTripForStay,
  findTripForTraveler,
  getTrip,
  listAccommodationsForTrip,
  shareTripWithGroup,
  getTripStatus,
  listTripsForGroup,
  listTripsForPersona,
  mergeTrips,
  moveAccommodation,
  moveTravelLeg,
  pickActiveTrip,
  setLegPassenger,
  updateTrip,
} from '../trips.service.js';
import {
  createForm,
  extractFilledValues,
  extractFormSchema,
  finalizeForm,
  gatherKnowledge,
  getForm,
  resolveFields,
} from '../forms.service.js';
import { absolutePathFor, getAttachment, patchAttachmentMeta } from '../attachments.service.js';
import { importIcs } from '../ingest/ics/pipeline.js';
import { fetchIcsBuffer, CalendarFetchError } from '../ingest/ics/fetch-ics.js';
import { resolveDistrictCalendar } from '../ingest/ics/district-registry.js';
import { normalizeImage } from '../images/normalize.js';
import { getLlmForUser } from '../llm/factory.js';
import { parseJsonObject } from '../../utils/json-repair.js';
import {
  dayOf,
  hasStarted,
  isPastEventStart,
  localDay,
  localWhen,
  localWhenOrNull,
  offsetMinutesOf,
  ownWhen,
  tzToOffsetMinutes,
  weekdayOf,
  zonedDayEndUtc,
  zonedDayStartUtc,
} from '../../utils/tz.js';
import { legDatetime, placeDatetime } from './trip_classifier.js';
import {
  archivedReasonText,
  eventComposeHref,
  eventReplyAllRecipients,
  isValidTimeZone,
  normalizeImageTag,
  plainTextToSignatureHtml,
  pickInviteeFromDevice,
  type EmailForwardPreview,
  type OverlapAnswer,
} from '@chord/kernel';
import {
  claimLooseTaskMutation,
  claimOncePerTurn,
  recordTaskEnumeration,
  resolveTaskOrdinals,
} from './enumeration.js';
import { clearPendingFanout, getPendingFanout, recordPendingFanout } from './pending-fanout.js';
import { recordPendingInvitees } from './pending-invites.js';
import { getLastEvent, looksLikeLastEvent, recordLastEvent } from './pending-last-event.js';
import { answerPendingTripTravelers } from './pending-trip-travelers.js';
import { pastDateWasConfirmed, recordPastDateAsk } from './pending-past-dates.js';
import {
  buildExternalAction,
  type ExternalActionKind,
  type ExternalActionQuery,
} from './external-actions.js';
import { enrichExternalActionQuery, findFlightForPassenger } from './external-actions-enrich.js';
import { resolvePackageTracking } from './package-tracking.js';
import { setFeatureTips } from '../reengage/reengage.service.js';
import {
  cancelLatestQueuedSend,
  queueComposedEmail,
  queueForwardedEmail,
  readEmailThread,
  setBriefingChannelByName,
  setEmailDigestEnabled,
  trashEmailThread,
  changeEmailThreads,
  findEmailsForChange,
} from './email-actions.js';
import {
  listSubscriptions,
  resolveSubscriptionSender,
  unsubscribeFromSenders,
  unsubscribeThread,
  type MailingListSender,
} from '../email/unsubscribe.service.js';
import { listAutoTrash, setAutoTrash } from '../email/auto-trash.service.js';
import { resolveCorrespondent } from '../email/person-resolve.js';
import {
  addFilingRule,
  checkFolderName,
  listFilingRules,
  looksLikeExistingMailRequest,
  parseMatch as parseFilterMatch,
  removeFilingRules,
} from '../email/filing.service.js';
import { senderStats, type SenderRank } from '../email/sender-stats.service.js';
import {
  UNKNOWN_CURRENCY,
  detectRecurring,
  listReceipts,
  summarizeSpending,
  type Receipt,
} from '../email/receipts.service.js';
import { isWriteTool, normalizeDatetimes, type ToolCall, type ToolName } from './tools.js';
import {
  deletedIdBatches,
  deleteMessages,
  recentDeletableMessageIds,
} from '../messages.service.js';

/**
 * Write-side tools that respect `mode: 'propose'`. Read tools never pass
 * through this set (no side effects to gate). Everything here defers to the
 * shared proposals table (ADR 0009) when the bot is the caller; WhatsApp
 * ingest + proposal-confirm paths still bypass via `mode: 'commit'`.
 *
 * Holds exactly one tool. The rest of the write surface commits directly: a
 * task or a list item is cheap to undo, so a confirm step would be friction
 * without a safety gain. Sending mail is neither cheap to undo nor internal to
 * Chord — it leaves the building under the user's name — and the email design
 * (`docs/tasks/chord_email.md` §3.4) makes that a rule: *nothing is sent
 * without a human tap*. So the model drafts and the user sends.
 */
const PROPOSABLE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  'reply_to_email',
  // ADR 0214 — the same rule for the other two ways mail leaves the building.
  'compose_email',
  'forward_email',
  // ADR 0215 — the model picks a thread by id from a search; a wrong pick
  // would put the wrong mail in Trash, so the user sees which one and taps.
  'trash_email',
  // Up to 500 emails picked by a filter, not by the user one at a time: the
  // user sees how many and which kind before anything changes.
  'update_emails_matching',
  // ADR 0246 - unsubscribing POSTs to the sender or mails them from the user's
  // own mailbox, and the model resolved the sender from a name.
  'unsubscribe_from_sender',
  'unsubscribe_from_senders',
  // A standing rule that moves the user's mail: they see which senders and tap.
  'trash_future_mail',
  // ADR 0309 — the same for a filing rule: who, which folder, then a tap.
  'add_mail_filter',
  // ADR 0242 - deleting messages cannot be undone, so the user sees how many
  // and taps.
  'delete_messages',
  // ADR 0259 - leaving or deleting a whole chat, picked from a spoken name: the user
  // sees which chat and taps.
  'leave_group',
  'delete_group',
  // ADR 0234 addendum - a post into a group is in front of the whole family,
  // and deleting it hides it for the poster only (ADR 0242): the user sees
  // the exact text (or which email) and the group, and taps.
  'message_group',
  'share_email_with_group',
  // ADR 0236 — accepting charges (or credits) the difference at once, so the
  // user taps to confirm rather than a chat sentence moving money.
  'change_subscription_plan',
]);

/**
 * Maps a proposable tool call to a BotCard so the chat bubble renders a
 * preview of what's being proposed. Falls back to a generic "proposed" card
 * for unknown shapes (shouldn't happen once PROPOSABLE_TOOLS is in sync).
 */
/**
 * Drop an LLM-supplied `remindAt` if it falls within the next 5 minutes
 * (or in the past). That window almost always means the LLM misread
 * "remind me to X" as "fire a reminder NOW" rather than as a request
 * to record a future reminder. Tasks with no remindAt still get
 * surfaced in the daily 7am morning-scan nudge.
 */
const IMMEDIATE_REMIND_WINDOW_MS = 5 * 60_000;

/**
 * Start work behind a write without waiting for it. Never on a transaction
 * handle: the work outlives the transaction and then fails on the closed
 * handle (a calendar sync left its event claimed and never pushed; a
 * meeting summary was never saved). Inside a transaction the job goes to the
 * caller's `afterCommit`, which runs it on its own handle once committed.
 */
function startAfterWrite(
  db: Kysely<DB>,
  input: Pick<ApplyToolCallInput, 'afterCommit'>,
  job: (db: Kysely<DB>) => Promise<void>,
): void {
  runAfterCommit(db, job, 'after-write work', input.afterCommit);
}

function syncCalendarSoon(
  db: Kysely<DB>,
  input: Pick<ApplyToolCallInput, 'afterCommit'>,
  userId: string,
): void {
  startAfterWrite(db, input, (h) => maybeSyncCalendar(h, userId));
}

function storeMeetingContextSoon(
  db: Kysely<DB>,
  input: Pick<ApplyToolCallInput, 'afterCommit'>,
  userId: string,
  eventId: string,
  invited: string[],
): void {
  startAfterWrite(db, input, (h) =>
    buildAndStoreMeetingContext(h, userId, eventId, invited).catch((err) => {
      logger.warn('meeting-context build failed', { err: String(err), eventId });
    }),
  );
}

export function sanitizeRemindAt(
  candidate: string | undefined,
  now: Date = new Date(),
): string | undefined {
  if (!candidate) return undefined;
  const parsed = Date.parse(candidate);
  if (Number.isNaN(parsed)) return undefined;
  if (parsed - now.getTime() < IMMEDIATE_REMIND_WINDOW_MS) return undefined;
  return candidate;
}

/**
 * Fill in the parts of a proposal the model must not choose. Today that is the
 * reply audience: `reply_to_email` takes a boolean `replyAll`, and the actual
 * addresses are resolved from the thread here so the card can show them and the
 * send can use the same list (ADR 0107).
 *
 * Returns the call unchanged for everything else.
 */
/** What a forward card shows of the email it passes on: who and when from
 *  the quoted header, the opening of the body, and the files' names. */
export function forwardCardFields(preview: EmailForwardPreview): {
  messageId: string;
  previewFrom?: string;
  previewDate?: string;
  previewBody?: string;
  previewFiles?: string[];
} {
  const field = (name: string) => {
    const line = preview.header.find((l) => l.startsWith(`${name}: `));
    return line ? line.slice(name.length + 2).slice(0, 400) : undefined;
  };
  const flat = preview.body.replace(/\s+/g, ' ').trim();
  return {
    messageId: preview.messageId,
    previewFrom: field('From'),
    previewDate: field('Date'),
    ...(flat ? { previewBody: flat.length > 280 ? `${flat.slice(0, 279)}…` : flat } : {}),
    ...(preview.attachments.length
      ? { previewFiles: preview.attachments.slice(0, 20).map((a) => a.filename.slice(0, 300)) }
      : {}),
  };
}

async function stageProposalArgs(
  db: Kysely<DB>,
  actorUserId: string | null,
  call: ToolCall,
  turn: { groupId: string; triggeringMessageId?: string | null },
): Promise<ToolCall> {
  if (call.name === 'delete_messages' && actorUserId) {
    // "The last 3" is resolved to ids now: by the time the card is tapped the
    // chat has moved on, and the newest three would be different messages.
    const args = call.args as { scope: 'last' | 'all'; count?: number };
    const { messageIds: _ignored, forUserId: _alsoIgnored, ...given } = call.args as Record<
      string,
      unknown
    >;
    // In a shared chat the delete is for the asker only, so the card must not
    // act on whoever happens to tap it.
    const rest = { ...given, forUserId: actorUserId };
    if (args.scope !== 'last') return { ...call, args: rest } as ToolCall;
    const messageIds = await recentDeletableMessageIds(db, {
      groupId: turn.groupId,
      userId: actorUserId,
      count: args.count ?? 1,
      exceptId: turn.triggeringMessageId ?? null,
    });
    return { ...call, args: { ...rest, messageIds } } as ToolCall;
  }
  if (call.name === 'compose_email' && actorUserId) {
    // ADR 0255 — the card must say which mailbox it sends from, and the send
    // must use that one, so the sender is fixed here, not at tap time.
    const { fromMailbox: _m, fromAddress: _a, ...rest } = call.args as Record<string, unknown>;
    const from = await resolveSendMailbox(db, actorUserId);
    return {
      ...call,
      args: from
        ? { ...rest, fromMailbox: from.mailbox, fromAddress: from.address ?? from.label }
        : rest,
    } as ToolCall;
  }
  if (call.name === 'forward_email' && actorUserId) {
    // The card shows the email itself, built by the same loader as the send
    // (ADR 0112 addendum), and pins that message so the tap forwards exactly
    // what was shown. Anything the model put in these fields is dropped.
    const {
      threadSubject: _s,
      messageId: _m,
      previewFrom: _f,
      previewDate: _d,
      previewBody: _b,
      previewFiles: _x,
      ...rest
    } = call.args as Record<string, unknown>;
    const threadId = String(rest.threadId ?? '');
    const thread = await db
      .selectFrom('email_threads')
      .select('subject')
      .where('id', '=', threadId)
      .where('user_id', '=', actorUserId)
      .executeTakeFirst();
    if (!thread) return { ...call, args: rest } as ToolCall;
    const preview = await forwardPreview(db, actorUserId, threadId).catch(() => null);
    return {
      ...call,
      args: {
        ...rest,
        threadSubject: thread.subject || '(no subject)',
        ...(preview ? forwardCardFields(preview) : {}),
      },
    } as ToolCall;
  }
  if (call.name === 'trash_email' && actorUserId) {
    // The card must say WHICH email is being passed on; the model only holds
    // an id, and a subject it typed could name a different thread.
    const args = call.args as { threadId: string };
    const thread = await db
      .selectFrom('email_threads')
      .select('subject')
      .where('id', '=', args.threadId)
      .where('user_id', '=', actorUserId)
      .executeTakeFirst();
    const { threadSubject: _ignored, ...rest } = call.args as Record<string, unknown>;
    return {
      ...call,
      args: thread ? { ...rest, threadSubject: thread.subject || '(no subject)' } : rest,
    } as ToolCall;
  }
  if (call.name !== 'reply_to_email' || !actorUserId) return call;
  const args = call.args as { threadId: string; replyAll?: boolean };
  // Oldest-first, so pickReplyTarget can walk back from the newest. Capped:
  // we only need the newest message that is not the user's own.
  const recent = await db
    .selectFrom('email_messages')
    .select([
      'from_email',
      'from_name',
      'reply_to',
      'auth_results',
      'to_emails',
      'cc_emails',
      'account_id',
      'gmail_label_ids',
    ])
    .where('thread_id', '=', args.threadId)
    .where('user_id', '=', actorUserId)
    .orderBy('internal_date', 'desc')
    .limit(20)
    .execute();
  if (recent.length === 0) return call;
  const ordered = [...recent].reverse();
  const account = ordered.find((m) => m.account_id) ?? ordered[ordered.length - 1];
  // "My address" is the MAILBOX's, not the login's: a thread on an attached
  // Yahoo/Outlook account is addressed to that address, and filtering by the
  // Google login would leave the user cc'ing themselves.
  const myEmail = account.account_id
    ? (
        await db
          .selectFrom('email_accounts')
          .select('email_address')
          .where('id', '=', account.account_id)
          .where('user_id', '=', actorUserId)
          .executeTakeFirst()
      )?.email_address ?? null
    : (
        await db
          .selectFrom('users')
          .select('email')
          .where('id', '=', actorUserId)
          .executeTakeFirst()
      )?.email ?? null;
  const parse = (v: unknown): string[] => {
    if (Array.isArray(v)) return v as string[];
    if (typeof v !== 'string' || v.length === 0) return [];
    try {
      const out = JSON.parse(v);
      return Array.isArray(out) ? (out as string[]) : [];
    } catch {
      return [];
    }
  };
  // The newest message NOT from the user: replying to a thread you already
  // answered must not address the draft to yourself.
  //
  // The address alone is not enough to decide that. A demo/legacy user can have
  // no `users.email` at all, and then every message looks like someone else's -
  // which is exactly how a draft ends up addressed to the sender's own mailbox.
  // The SENT label is the second, independent signal, and it is set by the
  // provider rather than inferred by us.
  const isOwn = (m: (typeof ordered)[number]): boolean => {
    const labels = Array.isArray(m.gmail_label_ids) ? (m.gmail_label_ids as string[]) : [];
    if (labels.includes('SENT')) return true;
    const from = m.from_email?.toLowerCase() ?? null;
    return myEmail !== null && from !== null && from === myEmail.toLowerCase();
  };
  const inbound = ordered.filter((m) => !isOwn(m));
  const target =
    pickReplyTarget(
      (inbound.length > 0 ? inbound : ordered).map((m) => ({ ...m, fromEmail: m.from_email })),
      myEmail,
    ) ?? ordered[ordered.length - 1];
  const { to, cc } = replyRecipients(
    {
      fromEmail: target.from_email,
      replyTo: target.reply_to,
      toEmails: parse(target.to_emails),
      ccEmails: parse(target.cc_emails),
    },
    { replyAll: args.replyAll === true, myEmail },
  );
  // ADR 0294 addendum: a likely fake that asks for replies elsewhere is named
  // on the card, so the warning is in front of the user at the tap.
  const { senderWarning: _w, ...rest } = call.args as Record<string, unknown>;
  const risk = replyToWarning(
    checkSender({
      fromName: target.from_name,
      fromEmail: target.from_email,
      replyTo: target.reply_to,
      auth: target.auth_results ?? null,
      toEmails: parse(target.to_emails),
      ccEmails: parse(target.cc_emails),
      ownAddresses: myEmail ? [myEmail] : [],
    }),
  );
  return {
    ...call,
    args: { ...rest, to, cc, ...(risk?.level === 'danger' ? { senderWarning: risk.message } : {}) },
  } as ToolCall;
}

/** The confirm button's word: the card's own verb, so "tap Send" in the
 *  bot's prose names a button that is really there. */
function confirmLabelFor(toolName: string): string {
  switch (toolName) {
    case 'reply_to_email':
    case 'compose_email':
    case 'forward_email':
      return 'Send';
    case 'trash_email':
      return 'Move to Trash';
    case 'update_emails_matching':
      return 'Apply';
    case 'unsubscribe_from_sender':
      return 'Unsubscribe';
    case 'unsubscribe_from_senders':
      return 'Unsubscribe from all';
    case 'trash_future_mail':
      return 'Send to Trash';
    case 'add_mail_filter':
      return 'Add filter';
    case 'message_group':
      return 'Post';
    case 'share_email_with_group':
      return 'Share';
    default:
      return 'Confirm';
  }
}

export function proposeCardFor(call: ToolCall, tz?: string): { title: string; card: BotCard } {
  const a = call.args as Record<string, unknown>;
  const s = (k: string): string | undefined =>
    typeof a[k] === 'string' ? (a[k] as string) : undefined;
  const arr = (k: string): string[] | undefined =>
    Array.isArray(a[k]) ? (a[k] as string[]) : undefined;
  // A suggestion's date as a person reads it, in the asker's zone - the card
  // goes to the app, WhatsApp and Telegram, none of which can format it.
  const when = (k: string, withTime = true, clock: 'viewer' | 'written' = 'viewer') =>
    suggestionWhen(a[k], { withTime, allDay: a.allDay === true, clock, timeZone: tz, locale: 'en-US' }) ?? undefined;

  switch (call.name) {
    case 'create_task':
      return {
        title: s('title') ?? '(untitled task)',
        card: {
          kind: 'task',
          title: s('title') ?? '(untitled task)',
          subtitle: s('assigneeName') ? `@${s('assigneeName')}` : undefined,
          meta: when('dueAt', false) ? `due ${when('dueAt', false)}` : s('remindCue'),
        },
      };
    case 'add_list_item': {
      const items = arr('items') ?? [];
      return {
        title: `${items.length} item${items.length === 1 ? '' : 's'} → ${s('listName') ?? 'list'}`,
        card: {
          kind: 'list',
          title: s('listName') ?? 'list',
          subtitle: items.join(', '),
          meta: `${items.length} item${items.length === 1 ? '' : 's'}`,
        },
      };
    }
    case 'create_event':
      return {
        title: s('title') ?? '(untitled event)',
        card: {
          kind: 'event',
          title: s('title') ?? '(untitled event)',
          subtitle: s('location'),
          meta: when('startsAt'),
        },
      };
    case 'reply_to_email': {
      const body = s('body') ?? '';
      // The card shows the draft itself: the decision the user is making is
      // "does this say what I mean", which they cannot judge from a summary.
      const preview = body.length > 140 ? `${body.slice(0, 139)}…` : body;
      const audience = describeRecipients(
        { to: arr('to') ?? [], cc: arr('cc') ?? [] },
        { max: 3 },
      );
      const warning = s('senderWarning');
      return {
        title: preview || '(empty reply)',
        card: {
          kind: 'email',
          title: a.replyAll === true ? 'Reply all' : 'Reply',
          subtitle: preview,
          // Who it goes to rides on the card, so a widened audience is never
          // invisible at the moment the user taps Send.
          meta: [warning ? `⛔ ${warning}` : undefined, audience, 'tap to send'].filter(Boolean).join(' · '),
        },
      };
    }
    case 'compose_email': {
      const body = s('body') ?? '';
      const preview = body.length > 140 ? `${body.slice(0, 139)}…` : body;
      const audience = describeRecipients({ to: arr('to') ?? [], cc: arr('cc') ?? [] }, { max: 3 });
      const from = s('fromAddress');
      return {
        title: s('subject') ?? '(no subject)',
        card: {
          kind: 'email',
          title: `New email: ${s('subject') ?? '(no subject)'}`,
          subtitle: preview,
          meta: [from ? `from ${from}` : undefined, audience, 'tap to send'].filter(Boolean).join(' · '),
        },
      };
    }
    case 'forward_email': {
      const audience = describeRecipients({ to: arr('to') ?? [], cc: arr('cc') ?? [] }, { max: 3 });
      const subject = s('threadSubject') ?? 'email';
      const files = arr('previewFiles') ?? [];
      // The card IS the check that this is the right email: who sent it,
      // when, how it opens, and what files go with it (ADR 0112 addendum).
      // Multi-line on purpose: a bridged chat (WhatsApp, Telegram) prints it
      // whole, and the app card leads with the sender line.
      const subtitle = [
        [s('previewFrom'), s('previewDate')].filter(Boolean).join(' · ') || undefined,
        s('previewBody') ? `“${s('previewBody')}”` : undefined,
        files.length
          ? `📎 ${files.join(', ')}${a.includeAttachments === false ? ' (not included)' : ''}`
          : undefined,
        s('note') ? `Your note: ${s('note')}` : undefined,
      ]
        .filter(Boolean)
        .join('\n');
      return {
        title: `Forward "${subject}"`,
        card: {
          kind: 'email',
          title: `Forward: ${subject}`,
          subtitle: subtitle || undefined,
          meta: [
            audience,
            a.includeAttachments === false && !files.length ? 'without attachments' : undefined,
            'tap to send',
          ]
            .filter(Boolean)
            .join(' · '),
          ...(s('threadId') ? { href: `/email/${s('threadId')}` } : {}),
        },
      };
    }
    case 'change_subscription_plan': {
      const plan = s('plan') === 'family' ? 'Family' : 'Individual';
      const period = s('interval') === 'year' ? 'annual' : 'monthly';
      return {
        title: `Switch to ${plan} (${period})`,
        card: {
          kind: 'action',
          title: `Switch to the ${plan} plan, ${period}`,
          meta: 'charges or credits the difference now · tap to confirm',
        },
      };
    }
    case 'leave_group': {
      const name = s('groupName') ?? 'this chat';
      const title = `Leave ${name}`;
      return {
        title,
        card: { kind: 'action', title, meta: 'you stop receiving its messages · tap to confirm' },
      };
    }
    case 'delete_group': {
      const name = s('groupName') ?? 'this chat';
      const title = `Delete ${name} for everyone`;
      return {
        title,
        card: {
          kind: 'action',
          title,
          meta: 'every message, file, task and event · cannot be undone · tap to confirm',
        },
      };
    }
    case 'message_group': {
      const group = s('groupName') ?? 'the group';
      const body = s('body') ?? '';
      // The whole text: the decision is "should my family read exactly this".
      const shown = body.length > 1000 ? `${body.slice(0, 999)}…` : body;
      return {
        title: `Post to ${group}`,
        card: {
          kind: 'action',
          title: `Post to ${group}`,
          subtitle: shown,
          meta: `everyone in ${group} sees it, from you · tap to post`,
        },
      };
    }
    case 'share_email_with_group': {
      const group = s('groupName') ?? 'the group';
      const subject = s('threadSubject') ?? 'email';
      const files = arr('previewFiles') ?? [];
      // Multi-line like the forward card: a bridged chat prints it whole.
      const subtitle = [
        [s('threadFrom'), s('previewWhen')].filter(Boolean).join(' · ') || undefined,
        s('previewBody') ? `“${s('previewBody')}”` : undefined,
        files.length ? `📎 ${files.join(', ')} (names only, files not included)` : undefined,
        s('note') ? `Your note: ${s('note')}` : undefined,
      ]
        .filter(Boolean)
        .join('\n');
      return {
        title: `Share "${subject}" with ${group}`,
        card: {
          kind: 'email',
          title: `Share with ${group}: ${subject}`,
          subtitle: subtitle || undefined,
          meta: `posted in ${group} as you · tap to share`,
          ...(s('threadId') ? { href: `/email/${s('threadId')}` } : {}),
        },
      };
    }
    case 'delete_messages': {
      const n = (arr('messageIds') ?? []).length;
      const title =
        s('scope') === 'all'
          ? 'Delete the messages in this chat'
          : `Delete the last ${n === 1 ? 'message' : `${n} messages`}`;
      return {
        title,
        card: { kind: 'action', title, meta: 'cannot be undone · tap to confirm' },
      };
    }
    case 'unsubscribe_from_sender': {
      const who = s('senderName') ?? s('senderEmail') ?? s('sender') ?? 'sender';
      return {
        title: `Unsubscribe from ${who}`,
        card: {
          kind: 'email',
          title: `Unsubscribe: ${who}`,
          subtitle: s('senderName') ? s('senderEmail') : undefined,
          meta: 'tap to unsubscribe',
        },
      };
    }
    case 'add_mail_filter': {
      const who = s('who') ?? s('from') ?? 'this sender';
      const title = `File mail from ${who} into "${s('folder') ?? '?'}"`;
      return {
        title,
        card: {
          kind: 'email',
          title,
          subtitle: (arr('matches') ?? []).join(' · ') || undefined,
          meta: a.alsoExisting === true ? 'new and existing mail · tap to confirm' : 'new mail from now on · tap to confirm',
        },
      };
    }
    case 'trash_future_mail': {
      const names = arr('senderNames') ?? arr('senderEmails') ?? arr('senders') ?? [];
      const title = `Send future mail to Trash: ${names.length === 1 ? names[0] : `${names.length} senders`}`;
      return {
        title,
        card: {
          kind: 'email',
          title,
          subtitle: names.length > 1 ? names.join(' · ') : undefined,
          meta: 'from now on · tap to confirm',
        },
      };
    }
    case 'unsubscribe_from_senders': {
      const names = arr('senderNames') ?? arr('senderEmails') ?? arr('senders') ?? [];
      if (names.length === 1) {
        return {
          title: `Unsubscribe from ${names[0]}`,
          card: { kind: 'email', title: `Unsubscribe: ${names[0]}`, subtitle: arr('senderEmails')?.[0], meta: 'tap to unsubscribe' },
        };
      }
      const title = `Unsubscribe from ${names.length} lists`;
      return {
        title,
        card: {
          kind: 'email',
          title,
          subtitle: names.join(' · ') || undefined,
          meta: 'tap to unsubscribe from all',
        },
      };
    }
    case 'trash_email': {
      const subject = s('threadSubject') ?? 'email';
      return {
        title: `Move "${subject}" to Trash`,
        card: {
          kind: 'email',
          title: `Trash: ${subject}`,
          meta: 'tap to move to Trash',
        },
      };
    }
    case 'update_emails_matching': {
      const count = arr('threadIds')?.length ?? 0;
      const what = describeEmailChange(a);
      const title = `${what}: ${count}${a.truncated ? '+' : ''} email${count === 1 ? '' : 's'}`;
      return {
        title,
        card: {
          kind: 'email',
          title,
          subtitle: (arr('samples') ?? []).join(' · ') || undefined,
          meta: a.truncated ? `newest ${count} only · tap to apply` : 'tap to apply',
        },
      };
    }
    case 'record_rsvp':
      return {
        title: `RSVP ${s('displayName') ?? ''}: ${s('status') ?? ''}`.trim(),
        card: {
          kind: 'event',
          title: `RSVP: ${s('displayName') ?? ''}`,
          subtitle: s('status'),
          meta: s('dish'),
        },
      };
    case 'save_link':
      return {
        title: s('title') ?? s('url') ?? '(link)',
        card: {
          kind: 'save',
          title: s('title') ?? '(link)',
          subtitle: s('url'),
          meta: 'link',
        },
      };
    case 'save_place':
      return {
        title: s('name') ?? '(place)',
        card: {
          kind: 'save',
          title: s('name') ?? '(place)',
          subtitle: [s('area'), s('city')].filter(Boolean).join(' · ') || undefined,
          meta: 'place',
        },
      };
    case 'save_contact':
      return {
        title: s('name') ?? '(contact)',
        card: {
          kind: 'save',
          title: s('name') ?? '(contact)',
          subtitle: s('org'),
          meta: 'contact',
        },
      };
    case 'save_media':
      return {
        title: s('title') ?? '(media)',
        card: {
          kind: 'save',
          title: s('title') ?? '(media)',
          subtitle: s('kind'),
          meta: 'media',
        },
      };
    case 'create_trip':
      return {
        title: s('name') ?? '(trip)',
        card: {
          kind: 'trip',
          title: s('name') ?? '(trip)',
          subtitle: s('destination'),
          meta: `${when('startDate', false) ?? '?'} → ${when('endDate', false) ?? '?'}`,
        },
      };
    case 'add_travel_leg':
      return {
        title: `${s('origin') ?? '?'} → ${s('destination') ?? '?'}`,
        card: {
          kind: 'trip',
          title: `${s('origin') ?? '?'} → ${s('destination') ?? '?'}`,
          subtitle: [s('carrier'), s('flightNo')].filter(Boolean).join(' ') || s('mode'),
          meta: when('departAt', true, 'written'),
        },
      };
    case 'add_accommodation':
      return {
        title: s('propertyName') ?? '(stay)',
        card: {
          kind: 'trip',
          title: s('propertyName') ?? '(stay)',
          subtitle: s('address'),
          meta: `${when('checkinDate', false) ?? '?'} → ${when('checkoutDate', false) ?? '?'}`,
        },
      };
    case 'add_reservation':
      return {
        title: s('name') ?? '(reservation)',
        card: {
          kind: 'trip',
          title: s('name') ?? '(reservation)',
          subtitle: s('kind'),
          meta: when('dateTime', true, 'written'),
        },
      };
    default:
      return {
        title: call.name,
        card: { kind: 'task', title: `proposed ${call.name}` },
      };
  }
}

async function displayNameFor(
  db: Kysely<DB>,
  userId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('users')
    .select(['display_name', 'username'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (!row) return null;
  return row.display_name ?? row.username ?? null;
}

/**
 * Render a stored ISO due timestamp for the user's bridge. The DB always
 * holds an absolute instant in UTC; for the prose card we shift back to
 * the user's local wall-clock so "due 2026-06-07T09:00:00Z" reads as
 * "due Sun Jun 7 9:00 AM" instead of leaking the storage encoding.
 */
/** Rides beside any result carrying pre-rendered times: the raw ISO fields
 *  stay for tool calls, the rendered ones are what the user should hear. */
const LOCAL_WHEN_INSTRUCTION =
  'Times in `when` / `due` / `remind` fields are already in the user\'s own time zone with the weekday — quote them as given (never say UTC, never re-derive a weekday from the raw ISO fields).';
const OWN_WHEN_INSTRUCTION =
  '`departs` / `arrives` / `when` are local time where that leg or booking happens (as on the ticket), with the weekday — quote them as given; never say UTC or convert them yourself.';
/** A `repeat` spec `buildRrule`/`validateRepeat` could not express (ADR 0217).
 *  `message` already names the offending part in plain words; this tells the
 *  model what to DO with it, kept separate from `summary` so a weaker model
 *  does not just relay the instruction text itself back as the reply. */
const REPEAT_INSTRUCTION =
  'Tell the user plainly which part of the repeat could not be stored (use `message` above, in your own ' +
  'words — do not quote it verbatim), then suggest the nearest pattern Chord CAN express for what they ' +
  'described and ask if that works. Do not write anything until they confirm.';

/** How far back, and how many messages, count as "the conversation so far"
 *  when deciding whether anyone asked for a repeat (ADR 0229) or for a video
 *  call (ADR 0319). */
const REPEAT_CONTEXT_MS = 30 * 60 * 1000;
const REPEAT_CONTEXT_MESSAGES = 8;

/**
 * Did the conversation ask for this, or did the model fill in an optional
 * field nobody mentioned?
 *
 *   'no'      — a turn we can read, and no such wording in it or just before
 *               it. The caller treats the field as a default, not a request.
 *   'yes'     — the wording is there. The bot's own messages are included, so
 *               "yes, that works" answering something the bot proposed counts.
 *   'unknown' — no message to read (ingest, a proposal confirm, a scripted
 *               call). No signal either way, so the field is taken as given.
 */
async function askedInConversation(
  db: Kysely<DB>,
  triggeringMessageId: string | null | undefined,
  matches: (text: string) => boolean,
): Promise<'yes' | 'no' | 'unknown'> {
  if (!triggeringMessageId) return 'unknown';
  const trigger = await db
    .selectFrom('messages')
    .select(['body', 'group_id', 'created_at'])
    .where('id', '=', triggeringMessageId)
    .executeTakeFirst();
  if (!trigger) return 'unknown';
  if (matches(trigger.body)) return 'yes';
  const before = await db
    .selectFrom('messages')
    .select(['body', 'created_at'])
    .where('group_id', '=', trigger.group_id)
    .where('id', '!=', triggeringMessageId)
    .where('created_at', '<=', trigger.created_at)
    .orderBy('created_at', 'desc')
    .limit(REPEAT_CONTEXT_MESSAGES)
    .execute();
  const since = Date.parse(trigger.created_at) - REPEAT_CONTEXT_MS;
  const asked = before.some((m) => Date.parse(m.created_at) >= since && matches(m.body));
  return asked ? 'yes' : 'no';
}

/**
 * A calendar the user named that the model left out of the call. Prod: "add
 * to Neural Calendar - Call with Gautam @ A91 at 830a" reached `create_event`
 * with no `calendar`, so the event went to the default calendar. Only the
 * triggering message is read (a calendar named for an earlier event is not a
 * request for this one), and a name is kept only when it picks out ONE real
 * calendar: an inferred name never raises an "which calendar?" question or a
 * "could not find" note of its own.
 */
/** A message's text, '' when there is none. */
async function messageBody(db: Kysely<DB>, messageId: string | null | undefined): Promise<string> {
  if (!messageId) return '';
  const row = await db.selectFrom('messages').select('body').where('id', '=', messageId).executeTakeFirst();
  return row?.body ?? '';
}

/**
 * The person asked for a call in their own words ("... Teams meeting") but
 * the model put that in `location` and left `videoCall` out (prod,
 * 2026-11-11). Only the triggering message counts: a call asked for an
 * earlier event is not a request for this one.
 */
async function videoCallAskedInTrigger(db: Kysely<DB>, messageId: string | null | undefined): Promise<boolean> {
  return looksLikeVideoCallRequest(await messageBody(db, messageId));
}


/**
 * ADR 0319 — what to say about this event's video call, after doing whatever
 * the conversation actually asked for. `''` means nothing was asked and
 * nothing was done, so there is nothing to mention (ADR 0229's posture for an
 * ignored repeat).
 *
 * A `videoCall: true` nobody asked for IS the default, and the default
 * follows the calendar's provider (ADR 0323): a Google Meet on a
 * Google-driven calendar, a Teams meeting on an Outlook / 365 one, nothing on
 * a mailbox with no calendar of its own. A real request is still honoured,
 * and refused in plain words where it cannot be met (ADR 0102).
 *
 * An unasked default that FAILS also says nothing — not only one with no
 * option. An Outlook calendar offers Teams but an unlicensed tenant refuses,
 * and reporting that refusal would be a complaint about a meeting nobody
 * asked for, which is the noise ADR 0319 removed.
 */
async function videoCallNoteFor(
  db: Kysely<DB>,
  triggeringMessageId: string | null | undefined,
  eventId: string,
  actorUserId: string,
): Promise<string> {
  const asked = (await askedInConversation(db, triggeringMessageId, looksLikeVideoCallRequest)) !== 'no';
  const option = await eventVideoCallOption(db, eventId);
  if (!asked && !option) return '';
  // "Teams meeting" on a Google calendar is not a request for a Meet: the
  // kinds are never crossed (ADR 0323), so a named kind the calendar cannot
  // host is refused in words rather than swapped for the other one.
  const named = asked ? videoCallKindNamed(await messageBody(db, triggeringMessageId)) : null;
  if (named && option && named !== option) {
    return ` · NO video call link was added: the user asked for a ${videoCallLabel(named)} but this event's calendar hosts ${videoCallLabel(option)} (say so; do NOT add or claim a link)`;
  }
  const result = await addVideoCall(db, { eventId, actorUserId });
  if (!asked && !result.ok) return '';
  return videoCallNote(result);
}

/**
 * Did anyone ask for this event to repeat (ADR 0229)?
 *
 * The model attaches a `repeat` to plain one-time requests often enough that
 * it has been seen three times in production. Twice the spec contradicted
 * itself and was caught by validation; a spec that happened to be VALID
 * (`{ frequency: "daily" }`) would have gone straight through and made a
 * daily series out of "lunch tomorrow at noon". So the question is asked of
 * the conversation, before the spec is looked at.
 *
 *   'no'      — a turn we can read, and no repeat wording in it or just before
 *               it. The caller ignores the `repeat`.
 *   'yes'     — repeat wording is there. Covers "yes, that works" answering a
 *               pattern the bot proposed: the proposal is in the window.
 *   'unknown' — no message to read (ingest, a proposal confirm, a scripted
 *               call). No signal either way, so the `repeat` is taken as given.
 */
async function repeatWasAsked(
  db: Kysely<DB>,
  triggeringMessageId: string | null | undefined,
): Promise<'yes' | 'no' | 'unknown'> {
  return askedInConversation(db, triggeringMessageId, looksLikeRecurrenceRequest);
}

/**
 * The user's own words just before and in the triggering message (newest
 * first, same window as `repeatWasAsked`), or null when there is no message
 * to read. The bot's messages are left out: only the user can ask for a filter.
 */
async function recentUserText(
  db: Kysely<DB>,
  triggeringMessageId: string | null | undefined,
): Promise<string[] | null> {
  if (!triggeringMessageId) return null;
  const trigger = await db
    .selectFrom('messages')
    .select(['body', 'group_id', 'created_at'])
    .where('id', '=', triggeringMessageId)
    .executeTakeFirst();
  if (!trigger) return null;
  const before = await db
    .selectFrom('messages')
    .select(['body', 'created_at'])
    .where('group_id', '=', trigger.group_id)
    .where('id', '!=', triggeringMessageId)
    .where('sender_id', 'is not', null)
    .where('created_at', '<=', trigger.created_at)
    .orderBy('created_at', 'desc')
    .limit(REPEAT_CONTEXT_MESSAGES)
    .execute();
  const since = Date.parse(trigger.created_at) - REPEAT_CONTEXT_MS;
  return [trigger.body, ...before.filter((m) => Date.parse(m.created_at) >= since).map((m) => m.body)];
}

/**
 * The source check for an address the model wrote (known-addresses.ts),
 * against the user's own recent words. Undefined when no person is behind
 * the call (ingest, a confirmed card): nothing to check against.
 */
async function addressChecker(
  db: Kysely<DB>,
  actorUserId: string | null,
  triggeringMessageId: string | null | undefined,
  turnId: string | null | undefined,
): Promise<((addresses: string[]) => Promise<string[]>) | undefined> {
  if (!actorUserId) return undefined;
  const words = await recentUserText(db, triggeringMessageId);
  if (words === null) return undefined;
  const typed = words.join('\n');
  return (addresses) => unknownAddresses(db, actorUserId, addresses, typed, turnId);
}

function formatDueAt(iso: string, tzOffset: string | undefined): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  let offsetMinutes = 0;
  if (tzOffset) {
    const m = tzOffset.match(/^([+-])(\d{2}):(\d{2})$/);
    if (m) {
      const sign = m[1] === '-' ? -1 : 1;
      offsetMinutes = sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
    }
  }
  const local = new Date(t + offsetMinutes * 60_000);
  const day = local.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const time = local.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  return `${day} ${time}`;
}

/**
 * Add minutes to an ISO datetime, keeping the SAME trailing offset (or `Z`) in
 * the output rather than collapsing to UTC. Used by update_event's
 * `durationMinutes` so a computed `endsAt` reads in the same zone as `startsAt`
 * (both `…-04:00`) instead of one offset + one `Z` for the same instant.
 */
function addMinutesPreservingOffset(iso: string, minutes: number): string {
  const ms = new Date(iso).getTime() + minutes * 60_000;
  const off = iso.match(/(Z|[+-]\d{2}:\d{2})$/)?.[1];
  if (!off || off === 'Z') return new Date(ms).toISOString();
  const m = off.match(/^([+-])(\d{2}):(\d{2})$/)!;
  const offMin = (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
  const d = new Date(ms + offMin * 60_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}${off}`;
}

/**
 * Resolve a free-text name to a member of THIS group, by id. Returns the
 * member's id plus their canonical display name so callers store the id and a
 * stable label (never a name from outside the group). Scoped to the group's
 * roster — a name that isn't a current member resolves to undefined.
 */
async function resolveGroupMember(
  db: Kysely<DB>,
  groupId: string,
  name: string,
): Promise<{ id: string; displayName: string } | undefined> {
  const rows = await db
    .selectFrom('group_members')
    .innerJoin('users', 'users.id', 'group_members.user_id')
    .where('group_members.group_id', '=', groupId)
    .select(['users.id as id', 'users.username as username', 'users.display_name as displayName'])
    .execute();
  const needle = name.trim().toLowerCase();
  const hit = rows.find(
    (r) =>
      r.username.toLowerCase() === needle ||
      (r.displayName ? r.displayName.toLowerCase() === needle : false),
  );
  return hit ? { id: hit.id, displayName: hit.displayName ?? hit.username } : undefined;
}

async function resolveAssignee(
  db: Kysely<DB>,
  groupId: string,
  name: string,
): Promise<string | undefined> {
  return (await resolveGroupMember(db, groupId, name))?.id;
}

/**
 * ADR 0151 — resolve an assignee name to either an account member or a managed
 * persona in the group. A member wins a name collision (it is checked first).
 * Used only by create_task / update_task / create_event; the plain
 * `resolveAssignee` above stays member-only for its many other callers.
 */
type AssigneeTarget =
  | { kind: 'user'; id: string; displayName: string }
  | { kind: 'persona'; id: string; managedBy: string; name: string };

async function resolveAssigneeTarget(
  db: Kysely<DB>,
  groupId: string,
  name: string,
): Promise<AssigneeTarget | undefined> {
  const member = await resolveGroupMember(db, groupId, name);
  if (member) return { kind: 'user', id: member.id, displayName: member.displayName };
  const persona = await resolveManagedPersonaByName(db, groupId, name);
  if (persona?.managedBy) {
    return { kind: 'persona', id: persona.id, managedBy: persona.managedBy, name: persona.name };
  }
  return undefined;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * ADR 0157 — turn a list of "invitee" tokens (each an email OR a person's name)
 * into resolved guest emails + the names we could not find an address for.
 * Name resolution is sender-scoped (ADR 0065): the asker's own saved people
 * (`people.email`, ADR 0076), then their Chord contacts. The model is never
 * trusted to supply an address for a name — that is why a name that resolves
 * to nothing comes back as `unresolved` (→ a "pick from Contacts" card) rather
 * than being dropped or guessed at.
 */
interface InviteeResolution {
  emails: string[];
  unresolved: string[];
  /** ADR 0157 addendum — names the asker's phone answered for. */
  fromPhone: Array<{ asked: string; name: string; email: string }>;
  /** Names several phone contacts fit: the bot asks which, never picks. */
  ambiguous: Array<{ asked: string; candidates: Array<{ name: string; email: string }> }>;
  /** Addresses given as-is that have no source (known-addresses.ts): not invited. */
  unverified: string[];
}

/** The reply note for guest addresses that were not invited for lack of a source. */
function unverifiedInviteeNote(unverified: string[]): string {
  if (unverified.length === 0) return '';
  return ` · NOT invited: ${unverified.join(', ')} - not in the user's mail, People or contacts and not typed by` +
    ' them (do NOT say they were invited; never guess an address - ask the user for it)';
}

/** Asks the asker's phone about one name (ADR 0212). */
type PhoneAsk = (name: string) => Promise<DeviceLookupOutcome>;

async function resolveInvitees(
  db: Kysely<DB>,
  actorUserId: string | null,
  tokens: string[] | undefined,
  askPhone?: PhoneAsk,
  checkAddresses?: (addresses: string[]) => Promise<string[]>,
): Promise<InviteeResolution> {
  const emails: string[] = [];
  const unresolved: string[] = [];
  const fromPhone: InviteeResolution['fromPhone'] = [];
  const ambiguous: InviteeResolution['ambiguous'] = [];
  const given: string[] = [];
  for (const raw of tokens ?? []) {
    const token = raw.trim();
    if (!token) continue;
    if (EMAIL_RE.test(token)) {
      given.push(token.toLowerCase());
      continue;
    }
    if (!actorUserId) {
      unresolved.push(token);
      continue;
    }
    const person = await findPersonByName(db, actorUserId, token);
    if (person?.email) {
      emails.push(person.email.toLowerCase());
      continue;
    }
    const contact = await resolveContactToUser(db, actorUserId, token);
    if (contact.kind === 'match') {
      const u = await db
        .selectFrom('users')
        .select('email')
        .where('id', '=', contact.chordUserId)
        .executeTakeFirst();
      if (u?.email) {
        emails.push(u.email.toLowerCase());
        continue;
      }
    }
    unresolved.push(token);
  }
  // ADR 0157 addendum — what the server could not place, the phone may have.
  // Asked side by side: with the app closed every one times out together.
  if (askPhone && unresolved.length > 0) {
    const answers = await Promise.all(unresolved.map((name) => askPhone(name).catch(() => null)));
    const still: string[] = [];
    unresolved.forEach((name, i) => {
      const a = answers[i];
      const pick = a && a.status === 'found' ? pickInviteeFromDevice(name, a.matches) : { kind: 'none' as const };
      if (pick.kind === 'email') {
        emails.push(pick.email);
        fromPhone.push({ asked: name, name: pick.name, email: pick.email });
        return;
      }
      if (pick.kind === 'ambiguous') ambiguous.push({ asked: name, candidates: pick.candidates });
      still.push(name);
    });
    unresolved.splice(0, unresolved.length, ...still);
  }
  // An address the model wrote itself is a guest only when it has a source: an
  // invitation goes to whoever is at that address, by email, from the user.
  const unverified = checkAddresses && given.length ? await checkAddresses(given) : [];
  emails.push(...given.filter((e) => !unverified.includes(e)));
  return { emails: [...new Set(emails)], unresolved, fromPhone, ambiguous, unverified };
}

/**
 * The phone lookup for invitees, only on a live chat turn with a person
 * behind it: ingest and proposal confirms have no phone to ask, and a turn
 * from WhatsApp/Telegram has no app listening (callers pass no turn id).
 */
function invitePhoneAsker(
  emit: SseBroadcaster,
  groupId: string,
  actorUserId: string | null,
  turnId: string | null | undefined,
): PhoneAsk | undefined {
  if (!actorUserId || !turnId) return undefined;
  return (name) =>
    requestDeviceContact({ emit, groupId, userId: actorUserId, query: name, timeoutMs: env.CONTACT_LOOKUP_TIMEOUT_MS });
}

/** What the reply must say about names settled (or not) by the phone. */
function phoneInviteeNote(r: InviteeResolution): string {
  const found = r.fromPhone.map((f) => `${f.asked} = ${f.name} <${f.email}> (from the phone's contacts)`);
  const asks = r.ambiguous.map(
    (a) =>
      `several phone contacts match "${a.asked}": ${a.candidates.map((c) => `${c.name} <${c.email}>`).join('; ')}` +
      ' — ask which one (do NOT pick)',
  );
  return [...found, ...asks].map((s) => ` · ${s}`).join('');
}

/**
 * ADR 0328 — what the bot says about a group event's invitations: who was
 * invited (they get an email and can answer), and who only got the event on
 * their calendar because no invitation could go out. Built from the outcome,
 * never the request (ADR 0102).
 */
export function familyInviteNote(r: FamilyInviteResult | null): string {
  if (!r) return '';
  const label = (p: { name: string | null; email?: string }) => p.name ?? p.email ?? 'a member';
  if (r.ok) {
    const how = r.via === 'calendar' ? 'from your calendar' : 'by email from your mailbox';
    return (
      ` · invited ${r.invited.map(label).join(', ')} ${how}` +
      ' (they get an invitation they can answer, and later changes to the time or place reach them)'
    );
  }
  return (
    ` · NO invitations went out (${r.reason.replace(/_/g, ' ')}); ${r.copied.map(label).join(', ')}` +
    ' got the event on their own calendars instead, without an invitation (say that; do NOT say anyone was invited)'
  );
}

/** ADR 0157 — one card per name we still need an email for; mobile turns it
 *  into the OS contact picker, bridged surfaces show it as a text prompt. */
function contactPickCards(names: string[]): BotCard[] {
  return names.map((name) => ({
    kind: 'contact' as const,
    title: `Add ${name} from Contacts`,
    subtitle: `I need ${name}'s email to send the invite`,
    contactName: name,
  }));
}

/**
 * ADR 0295 — add/remove guests on the provider event and say exactly what
 * happened. `invited` lists only people the calendar actually took.
 */
async function applyGuestChange(
  db: Kysely<DB>,
  eventId: string,
  actorUserId: string | null,
  add: string[],
  remove: string[],
): Promise<{ note: string; invited: string[]; data: Record<string, unknown> }> {
  if (add.length === 0 && remove.length === 0) return { note: '', invited: [], data: {} };
  if (!actorUserId) {
    return {
      note: ' · NOBODY was invited or removed (no user to send it as; do NOT say anyone was)',
      invited: [],
      data: { guestChange: 'not_organizer' },
    };
  }
  const res = await changeEventGuests(db, { eventId, actorUserId, add, remove });
  if (!res.ok) {
    const why = {
      not_found: 'the event could not be found',
      not_organizer: 'someone else organizes this event, so only they can change who is invited',
      not_on_calendar:
        'this event is only in Chord, not on a connected Google or Outlook calendar, so no invitation can be sent',
      provider_error: 'the calendar refused the change or could not be reached',
    }[res.reason];
    return {
      note: ` · NOBODY was invited or removed: ${why} (say exactly that; do NOT say anyone was invited or removed)`,
      invited: [],
      data: { guestChange: res.reason },
    };
  }
  const parts: string[] = [];
  if (res.added.length) parts.push(`invited ${res.added.join(', ')} (the calendar emails them the invitation)`);
  if (res.removed.length) parts.push(`removed ${res.removed.join(', ')} from the guests (the calendar tells them)`);
  if (res.alreadyInvited.length) parts.push(`${res.alreadyInvited.join(', ')} already invited, nothing sent`);
  if (res.notInvited.length) parts.push(`${res.notInvited.join(', ')} was not a guest, nothing to remove`);
  return {
    note: parts.length ? ` · ${parts.join(' · ')}` : '',
    invited: res.added,
    data: {
      invited: res.added,
      removedGuests: res.removed,
      alreadyInvited: res.alreadyInvited,
      notInvited: res.notInvited,
    },
  };
}

export interface ToolExecutionResult {
  summary: string;
  card?: BotCard;
  /** Multiple cards for tools that surface a set of results (ADR 0059 —
   *  `search`). Accumulated alongside `card` by the bot turn loop. */
  cards?: BotCard[];
  data?: unknown;
}

export interface ApplyToolCallInput {
  groupId: string;
  call: ToolCall;
  /**
   * Set by update_event moving an event to another calendar: the
   * create_event it runs is that event again, not a second meeting, so the
   * "same as the event just made" check does not apply.
   */
  replacesEventId?: string;
  /** Who triggered this call — stored as `created_by` on new entities. */
  actorUserId: string | null;
  /** Raw source text (e.g. the ±5 messages that produced this call during
   *  import). Stored as `source_raw_context` on entities that support it. */
  provenance: string | null;
  /**
   * `commit` (default) writes immediately — used by ingest + by proposal
   * confirmation. `propose` writes a proposal row + broadcasts
   * `proposal.created`, but only for tools in `PROPOSABLE_TOOLS`; other
   * tools always commit (ADR 0009). Read tools are never gated.
   */
  mode?: 'commit' | 'propose';
  /**
   * For propose mode — the chat message that produced this call. Recorded
   * on the proposal row so the UI can drill back to the triggering turn.
   */
  triggeringMessageId?: string | null;
  /**
   * For propose mode — groups related proposals so confirm/reject applies
   * atomically across a bundle (e.g. a trip + its legs + its accommodations
   * originating from the same flight PDF). Set by the bot turn loop.
   */
  bundleId?: string | null;
  /**
   * Optional sink for SSE broadcasts. When provided, the executor emits
   * through this callback instead of the global hub — so a caller running
   * inside a DB transaction can buffer broadcasts and flush them only
   * after the transaction commits. When omitted, the global hub is used
   * directly (the normal non-transactional path).
   */
  emit?: SseBroadcaster;
  /**
   * Where a caller running this inside a DB transaction takes background work
   * (calendar sync, meeting summary) to run once it has committed, on its own
   * handle. Unset outside a transaction: the work starts at once.
   */
  afterCommit?: (job: (db: Kysely<DB>) => Promise<void>) => void;
  /**
   * The connector binding this turn was triggered from, when the trigger
   * came in via an IM bridge. Used by the `relay` tool so target='all'
   * excludes the source surface (no echo back to where the user spoke).
   * Null/undefined when the trigger came from the native Chord client.
   */
  sourceBinding?: {
    platform: ConnectorPlatform;
    externalChannelId: string;
    /** ADR 0025 — null = deploy-wide bot; non-null = BYO. */
    botUserId: string | null;
  } | null;
  /**
   * User's timezone offset as `±HH:MM`. Used by tools that need to
   * compute a wall-clock default in the user's local time — currently
   * `create_task`'s fallback remindAt (next 7am local).
   */
  tzOffset?: string;
  /**
   * User's IANA zone (e.g. "America/New_York"), when known. Preferred over
   * `tzOffset` for normalizing a bare datetime the LLM emitted: `tzOffset`
   * is a "right now" snapshot, so stamping it onto a datetime for a
   * different date silently gets the DST side wrong whenever "now" and the
   * named date disagree about it. Omit only when no zone is on record —
   * `tzOffset` (or UTC) is the honest fallback there.
   */
  tz?: string | null;
  /**
   * ADR 0012 + 0013: when true, skip the per-event proactive nudge (event-write
   * hook). Used by ingest paths that create many events at once and emit a
   * single batched summary nudge instead of N individual ones.
   */
  suppressEventNudges?: boolean;
  /**
   * ADR 0247 — proposal confirm sending one item to several groups: every
   * group after the first. A `create_event` then fans out to that group's
   * other members only (the actor already has their copy) and sends no
   * second nudge.
   */
  additionalGroupShare?: boolean;
  /**
   * ADR 0093 — identifies the bot turn this call belongs to (the bot message
   * id). Used to allow only one task mutation per turn that resolves by id or
   * title, so a set of tasks has to go through server-resolved `ordinals`.
   * Omitted by non-conversational callers (ingest, proposal confirm), which
   * act on data they were handed rather than on a reference.
   */
  turnId?: string | null;
  /**
   * ADR 0155 — the triggering message carried an uploaded file. A past
   * `create_event` / `update_event` on such a turn is historical context from
   * a document (a school calendar, a term schedule), not a typo: the executor
   * still writes nothing but tells the model NOT to ask about it. Off on a
   * plain typed turn, which stays on ADR 0100's "read it back and ask".
   */
  triggerFromAttachment?: boolean;
  /**
   * ADR 0279 — the user's own words for a turn with no stored message (a side
   * chat). When absent, they are read from the triggering message.
   */
  userText?: string[];
  /**
   * ADR 0312 — the calendar picked on an email card. Checked: it must be one
   * the user can write to. Without it, an email event goes to the calendar of
   * the mailbox the email came to, or is refused when that mailbox has none.
   */
  calendarId?: string | null;
  /**
   * ADR 0335 — propose mode stages EVERY write tool, not only the
   * PROPOSABLE_TOOLS set. An outside AI app (the MCP connector) has no human
   * watching its turn, so even a to-do waits in Action Items for a tap.
   */
  stageWrites?: boolean;
}

export type SseBroadcaster = <K extends SseEventName>(
  channel: string,
  event: K,
  data: SseEventMap[K],
) => void;

/**
 * ADR 0096 — scope for the precise read tools.
 *
 * `search` already followed the ADR 0004 boundary: from the user's personal
 * 1:1 it reads across every group they belong to; inside a shared group it
 * reads only that group. `get_list`, `list_tasks` and `search_saves` did not —
 * they were pinned to the turn's group, so from the personal chat they could
 * not see a list living in a shared group at all. And the `search` tool
 * description tells the model to PREFER the precise tools when the intent is
 * precise, so doing the recommended thing went blind.
 *
 * Membership is what bounds the cross-group read, exactly as in
 * `searchEverything` — never a global scan.
 */
async function isPersonalTurn(db: Kysely<DB>, groupId: string): Promise<boolean> {
  const grp = await db
    .selectFrom('groups')
    .select('kind')
    .where('id', '=', groupId)
    .executeTakeFirst();
  return grp?.kind === 'personal';
}

/** How many near-miss group names a refusal may carry. */
const MAX_GROUP_CANDIDATES = 5;

export type GroupNameResolution =
  | { ok: true; groupId: string; groupName: string }
  | { ok: false; reason: 'not_found' | 'ambiguous'; candidates: string[] };

/**
 * Resolve a user-typed group name to one of the actor's own shared groups
 * (email routes, posting or sharing into a group, the answer to a share
 * offer). Never decides where a new item is created: that is always the
 * chat it was asked in.
 *
 * Exact-name-or-ask (ADR 0077): never fuzzy-write to the wrong group — one
 * exact case-insensitive match wins, otherwise the candidate names come back
 * for the model to relay and ask. The candidates are near misses only, capped;
 * a name matching nothing returns none (never the whole roster). Also matches on the ADR 0101 counterpart
 * display name, so an unnamed two-person chat with "Alice" resolves on
 * "Alice" even though its stored `groups.name` is still "Direct message".
 *
 * Membership is enforced by the join — this can only ever return a group the
 * actor already belongs to.
 */
async function resolveGroupByName(
  db: Kysely<DB>,
  actorUserId: string,
  wantedName: string,
): Promise<GroupNameResolution> {
  const rows = await db
    .selectFrom('groups')
    .innerJoin('group_members', 'group_members.group_id', 'groups.id')
    .where('group_members.user_id', '=', actorUserId)
    .where('groups.kind', '!=', 'personal')
    .select(['groups.id as id', 'groups.kind as kind', 'groups.name as name', 'groups.name_is_custom as name_is_custom'])
    .execute();
  const counterparts = await counterpartNames(db, actorUserId, rows);
  const candidates = rows.map((g) => ({ id: g.id, name: counterparts.get(g.id) ?? g.name }));

  const wanted = wantedName.trim().toLowerCase();
  const exact = candidates.filter((g) => g.name.trim().toLowerCase() === wanted);
  if (exact.length === 1) {
    return { ok: true, groupId: exact[0].id, groupName: exact[0].name };
  }
  // Near misses only, and only a handful. A name that matches nothing returns
  // NO candidates: the asker may be in hundreds of chats, and reading them all
  // back answers a question nobody asked.
  const near = exact.length > 1 ? exact : candidates.filter((g) => g.name.toLowerCase().includes(wanted));
  return {
    ok: false,
    reason: exact.length === 0 ? 'not_found' : 'ambiguous',
    candidates: near.slice(0, MAX_GROUP_CANDIDATES).map((g) => g.name),
  };
}

/**
 * ADR 0232 addendum - the family member a shared event is for, as they appear
 * in the group it is moving to. Personas are per group, so the original's row
 * only works when it is already that group's; otherwise the same person is
 * found by the People row they stand for, else by name. Null = no such person
 * there (the event is still shared; its title still names them).
 */
async function personaInGroup(db: Kysely<DB>, personaId: string, groupId: string): Promise<string | null> {
  const from = await db
    .selectFrom('personas')
    .select(['id', 'group_id', 'name', 'linked_person_id'])
    .where('id', '=', personaId)
    .executeTakeFirst();
  if (!from) return null;
  if (from.group_id === groupId) return from.id;
  const there = await db
    .selectFrom('personas')
    .select(['id', 'name', 'linked_person_id'])
    .where('group_id', '=', groupId)
    .where('is_managed', '=', 1)
    .where('managed_by', 'is not', null)
    .execute();
  const byPerson = from.linked_person_id ? there.find((p) => p.linked_person_id === from.linked_person_id) : undefined;
  if (byPerson) return byPerson.id;
  const byName = there.filter((p) => p.name.trim().toLowerCase() === from.name.trim().toLowerCase());
  return byName.length === 1 ? byName[0]!.id : null;
}

/**
 * ADR 0234 addendum - a group post runs only from a staged card: the group it
 * names, and only the asker's tap. A call with no pinned group never posts
 * (a bot turn always stages; nothing else should reach this without a card).
 */
function postTargetFromCard(
  args: { groupName?: string; groupId?: string; forUserId?: string },
  actorUserId: string,
  tool: 'message_group' | 'share_email_with_group',
):
  | { ok: true; groupId: string; groupName: string }
  | { ok: false; result: ToolExecutionResult } {
  if (args.forUserId && args.forUserId !== actorUserId) {
    return {
      ok: false,
      result: { summary: `${tool}: only the person who asked can confirm this`, data: { ok: false, reason: 'not_the_asker' } },
    };
  }
  if (!args.groupId) {
    return {
      ok: false,
      result: {
        summary: `${tool}: nothing posted - it needs the user's tap on a card`,
        data: { ok: false, reason: 'needs_confirmation', instruction: 'Nothing was posted. Do NOT claim it was.' },
      },
    };
  }
  return { ok: true, groupId: args.groupId, groupName: args.groupName ?? 'the group' };
}

/** ADR 0234 - where a "post/share this" goes: the group the user named, else the
 *  family chat. Naming goes through the exact-name-or-ask resolver; with no name
 *  and no family chat the model is told to ask, never to pick. */
async function resolveShareTarget(
  db: Kysely<DB>,
  actorUserId: string,
  groupName?: string,
): Promise<
  | { ok: true; groupId: string; groupName: string }
  | { ok: false; reason: 'no_family_group' | 'not_found' | 'ambiguous'; candidates?: string[] }
> {
  if (groupName) return resolveGroupByName(db, actorUserId, groupName);
  const familyId = await familyGroupIdFor(db, actorUserId);
  if (!familyId) return { ok: false, reason: 'no_family_group' };
  const row = await db.selectFrom('groups').select('name').where('id', '=', familyId).executeTakeFirst();
  return { ok: true, groupId: familyId, groupName: row?.name ?? 'Family' };
}

/**
 * ADR 0233 - after a trip is created in a personal chat, offer to share it with
 * the group it looks like it belongs to. Only on a live bot turn (a proposal
 * commit has no turn and no one to ask), only once per trip, and never shares by
 * itself - the answer arrives as a later "yes" the pending record resolves.
 */
async function tripShareOffer(
  db: Kysely<DB>,
  o: {
    groupId: string;
    actorUserId: string | null | undefined;
    turnId: string | null | undefined;
    tripId: string;
    tripName: string;
  },
): Promise<{ groups: string[]; instruction: string } | undefined> {
  if (!o.actorUserId || !o.turnId) return undefined;
  if (!(await isPersonalTurn(db, o.groupId))) return undefined;
  const already = await getPendingFanout(db, o.groupId, o.actorUserId);
  if (already?.kind === 'trip' && already.entityId === o.tripId) return undefined;
  const hits = await suggestTripShareGroups(db, o.actorUserId, o.tripId);
  if (hits.length === 0) return undefined;
  const names = hits.map((h) => h.name);
  await recordPendingFanout(db, o.groupId, o.actorUserId, {
    kind: 'trip',
    entityId: o.tripId,
    title: o.tripName,
    groups: names,
  });
  return {
    groups: names,
    instruction:
      `This trip is on the asker's own account only. In your reply, ask ONCE, in one short sentence, whether they want to share it with ` +
      (names.length === 1
        ? `the "${names[0]}" group`
        : `one of these groups (${names.map((n) => `"${n}"`).join(', ')}) - ask which`) +
      ' so the people in it can see who is travelling when. Do NOT share it unless they say yes, and never say it was shared before then. If they say yes, call share_trip.',
  };
}

/**
 * Group NAMES for cross-group results. ADR 0032's scrubber strips group ids
 * from anything the model sees, so a hit from another group has to say where
 * it came from by name or not at all (ADR 0059 settled this for `search`).
 */
async function groupNamesFor(
  db: Kysely<DB>,
  groupIds: string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(groupIds)];
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectFrom('groups')
    .select(['id', 'name'])
    .where('id', 'in', ids)
    .execute();
  return new Map(rows.map((r) => [r.id, r.name]));
}

function statusVerb(status: 'done' | 'open' | 'archived'): string {
  return status === 'done' ? 'marked done' : status === 'archived' ? 'dropped' : 'reopened';
}

/** Human summary of what an `update_task` patch changed, for the card + reply. */
function describeTaskPatch(p: UpdateTaskInput): string {
  const bits: string[] = [];
  if (p.title !== undefined) bits.push('renamed');
  if (p.dueAt === null) bits.push('due date cleared');
  else if (p.dueAt !== undefined) bits.push('due date changed');
  if (p.remindAt === null) bits.push('reminder cleared');
  else if (p.remindAt !== undefined) bits.push('reminder changed');
  if (p.assigneeId !== undefined || p.assigneePersonaId !== undefined) bits.push('reassigned');
  if (p.details !== undefined) bits.push('details updated');
  if (p.remindCue !== undefined) bits.push('reminder note updated');
  return bits.join(', ') || 'updated';
}

async function resolveEventInGroup(
  db: Kysely<DB>,
  groupId: string,
  eventId: string,
) {
  const event = await getEvent(db, eventId);
  return event && event.groupId === groupId ? event : null;
}

/**
 * ADR 0217 — a title matches every occurrence of a repeating event. Matches
 * from one series are one answer: the occurrence nearest now (the next one,
 * else the latest past one). Distinct events still come back separately, so
 * the bot asks only when the user could really mean two different things.
 */
function collapseSeriesMatches(matches: GroupEvent[]): GroupEvent[] {
  const now = Date.now();
  const byKey = new Map<string, GroupEvent[]>();
  for (const m of matches) {
    const key = m.seriesId ?? m.id;
    byKey.set(key, [...(byKey.get(key) ?? []), m]);
  }
  return [...byKey.values()].map((group) => {
    const sorted = [...group].sort(byInstant((e) => e.startsAt));
    return sorted.find((e) => instantMs(e.startsAt) >= now) ?? sorted[sorted.length - 1]!;
  });
}

/** ADR 0217 — the model must ask "just this one, or all of them?" rather than
 *  pick; it answers the same way ADR 0094 answers an ambiguous list name. */
function scopeRequired(tool: 'update_event' | 'delete_event', target: GroupEvent, tz: string | null | undefined) {
  return {
    summary:
      `${tool}: "${target.title}" repeats — nothing was changed yet. Ask the user whether they mean ` +
      `just this one (${localWhen(target.startsAt, tz)}) or every occurrence, then call again with ` +
      'scope "this" or "all"',
    data: {
      [tool === 'update_event' ? 'updated' : 'deleted']: false,
      reason: 'scope_required',
      id: target.id,
      when: localWhen(target.startsAt, tz),
    },
  };
}

// When userId is present, verify group membership; when absent (bot acting without
// an actor), verify the trip at least belongs to the current groupId so the bot
// can reference trips it just created in the same turn.
async function checkTripAccess(
  db: Kysely<DB>,
  userId: string,
  groupId: string,
  tripId: string,
): Promise<'ok' | 'forbidden' | 'missing'> {
  const trip = await getTrip(db, tripId);
  if (!trip) return 'missing';
  // Trip is in the current group — the user already passed route auth for this group.
  if (trip.groupId === groupId) return 'ok';
  // Cross-group reference — user must be a member of the trip's group.
  if (!userId) return 'forbidden';
  const membership = await db
    .selectFrom('group_members')
    .select('user_id')
    .where('group_id', '=', trip.groupId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return membership ? 'ok' : 'forbidden';
}

type TripCandidate = { id: string; name: string; destination: string; startDate: string; endDate: string };

type TripResolution =
  | { ok: true; tripId: string }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'ambiguous'; candidates: TripCandidate[] };

/**
 * Shared by every trip-mutating/reading tool that accepts `tripId?` +
 * `tripQuery?` (update_trip, set_trip_passengers, get_trip_status) — the
 * exact-name-or-ask resolution these all need, extracted once a third call
 * site needed the identical block (ADR 0164's precedent for
 * resolveGroupByName). A hint matching nothing falls back to every trip in
 * the group rather than failing outright: a single trip then resolves
 * cleanly, several still ask.
 */
async function resolveTripId(
  db: Kysely<DB>,
  userId: string,
  groupId: string,
  args: { tripId?: string; tripQuery?: string },
): Promise<TripResolution> {
  let tripId = args.tripId;
  if (tripId && (await checkTripAccess(db, userId, groupId, tripId)) !== 'ok') tripId = undefined;
  if (tripId) return { ok: true, tripId };

  // ADR 0171 — a deleted trip is in the bin; it must not make a name
  // ambiguous or be the one a tool edits. In the personal chat a trip may
  // live in any of the user's groups (ADR 0096): the "who is going?" question
  // about a family trip is asked there.
  const groupIds =
    userId && (await isPersonalTurn(db, groupId))
      ? (
          await db.selectFrom('group_members').select('group_id').where('user_id', '=', userId).execute()
        ).map((r) => r.group_id)
      : [groupId];
  const allTrips = (await Promise.all(groupIds.map((g) => listTripsForGroup(db, g))))
    .flat()
    .filter((t) => !t.deletedAt);
  let candidates = allTrips;
  if (args.tripQuery) {
    const q = args.tripQuery.toLowerCase();
    let matched = allTrips.filter(
      (t) => t.name.toLowerCase().includes(q) || (t.destination ?? '').toLowerCase().includes(q),
    );
    // A hint that is a whole sentence ("Trip to Ann Arbor is Ben Doe")
    // still names a trip whose full name is inside it.
    if (matched.length === 0) {
      matched = allTrips.filter((t) => {
        const name = t.name.toLowerCase().trim();
        return name.length >= 4 && q.includes(name);
      });
    }
    if (matched.length > 0) candidates = matched;
  }
  if (candidates.length === 0) return { ok: false, reason: 'not_found' };
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      candidates: candidates.map((t) => ({
        id: t.id, name: t.name, destination: t.destination, startDate: t.startDate, endDate: t.endDate,
      })),
    };
  }
  return { ok: true, tripId: candidates[0]!.id };
}

/**
 * update_event with `calendar`: the event made again on that calendar, the
 * old one removed. Null when it is already on that calendar (the rest of the
 * edit then goes ahead in place).
 */
async function moveEventToCalendar(
  db: Kysely<DB>,
  input: ApplyToolCallInput,
  target: GroupEvent,
  args: {
    calendar?: string;
    title?: string;
    startsAt?: string;
    endsAt?: string;
    durationMinutes?: number;
    location?: string;
    invitees?: string[];
    videoCall?: boolean;
  },
): Promise<ToolExecutionResult | null> {
  const owner = target.ownerUserId ?? input.actorUserId!;
  const pick = await resolveTargetCalendarId(db, { userId: owner, requestedName: args.calendar });
  if (pick.candidates?.length) {
    return {
      summary: `update_event: calendar "${args.calendar}" matched ${pick.candidates.length} calendars — nothing was moved`,
      data: {
        updated: false,
        reason: 'ambiguous_calendar',
        candidates: pick.candidates.map((c) => c.summary),
        instruction: 'Ask which of these calendars they mean, listing them verbatim, then call update_event again with that exact name.',
      },
    };
  }
  if (pick.requestedNotFound) {
    return {
      summary: `update_event: no calendar is called "${args.calendar}" — nothing was moved`,
      data: { updated: false, reason: 'calendar_not_found', instruction: 'Say no calendar of theirs has that name and ask which one they mean.' },
    };
  }
  const row = await db
    .selectFrom('events')
    .select(['google_calendar_id', 'series_id', 'guest_emails'])
    .where('id', '=', target.id)
    .executeTakeFirst();
  if (!row || (row.google_calendar_id ?? 'primary') === pick.calendarId) return null;
  if (row.series_id) {
    return {
      summary: 'update_event: a repeating event cannot be moved to another calendar — nothing was moved',
      data: { updated: false, reason: 'repeating', instruction: 'Tell the user a repeating event cannot be moved between calendars here.' },
    };
  }
  const onProvider = await providerEventPeople(db, target.id);
  const guests = [
    ...new Set([...(onProvider?.guests ?? row.guest_emails ?? []), ...(args.invitees ?? [])].map((g) => g.trim())),
  ].filter(Boolean);
  const startsAt = args.startsAt ?? target.startsAt;
  const lengthMs =
    target.endsAt && Date.parse(target.endsAt) > Date.parse(target.startsAt)
      ? Date.parse(target.endsAt) - Date.parse(target.startsAt)
      : null;
  const endsAt =
    args.durationMinutes !== undefined
      ? addMinutesPreservingOffset(startsAt, args.durationMinutes)
      : (args.endsAt ?? (lengthMs !== null ? addMinutesPreservingOffset(startsAt, Math.round(lengthMs / 60_000)) : undefined));
  const made = await applyToolCall(db, {
    ...input,
    replacesEventId: target.id,
    call: {
      name: 'create_event',
      args: {
        title: args.title ?? target.title,
        startsAt,
        ...(endsAt ? { endsAt } : {}),
        ...((args.location ?? target.location) ? { location: args.location ?? target.location } : {}),
        calendar: args.calendar,
        ...(guests.length ? { invitees: guests } : {}),
        ...(args.videoCall || onProvider?.videoCallLink ? { videoCall: true } : {}),
      },
    } as ToolCall,
  });
  const refused = (made.data as { created?: boolean } | undefined)?.created === false;
  if (refused) return { ...made, summary: `update_event: not moved — ${made.summary}` };
  const emit: SseBroadcaster = input.emit ?? ((ch, ev, data) => sseHub.broadcast(ch, ev, data));
  for (const r of await deleteEvent(db, target.id)) {
    emit(target.groupId, SSE.eventDeleted, { id: r.id, ownerUserId: r.ownerUserId ?? undefined });
  }
  return {
    ...made,
    summary:
      `update_event: moved "${target.title}" to another calendar — ${made.summary}` +
      (guests.length ? ' · the invitation from the old calendar was cancelled, so guests get a cancellation and this new invitation' : ''),
  };
}

export async function applyToolCall(
  db: Kysely<DB>,
  input: ApplyToolCallInput,
): Promise<ToolExecutionResult> {
  const result = await applyToolCallImpl(db, input);
  return scrubCrossGroupLeak(result, input.groupId);
}

/**
 * ADR 0059 — turn `search` results into tappable chat cards. Each card's
 * `href` deep-links to the right in-app screen (the mobile bubble renders
 * href cards as a Pressable → router.push). A few cards per category, capped
 * overall, so the chat shows a representative sample; the full result set
 * still rides in the tool `data` for the model's prose summary.
 */
const SEARCH_CARDS_PER_CATEGORY = 3;
const SEARCH_CARDS_TOTAL = 12;

function stripMarks(s: string): string {
  return s.replace(/[«»]/g, '').trim();
}

/** Keeps a card's preview line short enough to sit under a title without
 *  turning the card into an essay. */
function truncate(s: string, max = 80): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function buildSearchCards(r: {
  messages: Array<{ snippet: string; from: string; group: string; href: string }>;
  files: Array<{ id: string; filename: string; mimeType: string; snippet: string | null; group: string }>;
  tasks: Array<{ title: string; status: string; dueAt: string | null; group: string; href: string }>;
  reminders: Array<{ title: string; remindAt: string | null; group: string; href: string }>;
  saves: Array<{ title: string; kind: string; note: string | null; group: string; href: string }>;
  events: Array<{ title: string; location: string | null; startsAt: string; group: string; href: string }>;
  lists: Array<{
    listName: string;
    matchedItems: { id: string; text: string; checked: boolean }[];
    group: string;
    href: string;
  }>;
  places: Array<{ name: string; note: string | null; group: string; href: string }>;
  contacts: Array<{ name: string; note: string | null; group: string; href: string }>;
  media: Array<{ title: string; kind: string; note: string | null; group: string; href: string }>;
  emails: Array<{
    subject: string;
    from: string | null;
    action: string | null;
    receivedAt: string;
    snippet: string;
    href: string;
  }>;
}): BotCard[] {
  const out: BotCard[] = [];
  const take = <T,>(rows: T[], make: (row: T) => BotCard): void => {
    for (const row of rows.slice(0, SEARCH_CARDS_PER_CATEGORY)) {
      if (out.length >= SEARCH_CARDS_TOTAL) return;
      out.push(make(row));
    }
  };

  take(r.messages, (m) => ({
    kind: 'action',
    title: m.from,
    subtitle: m.group,
    preview: truncate(stripMarks(m.snippet)),
    meta: 'message',
    href: m.href,
  }));
  take(r.files, (f) => ({
    kind: 'action',
    title: f.filename,
    subtitle: f.group,
    preview: f.snippet ? truncate(stripMarks(f.snippet)) : undefined,
    meta: 'file',
    // Tapping opens the actual PDF/image/doc, not the Files list.
    attachmentId: f.id,
    mimeType: f.mimeType,
  }));
  take(r.tasks, (t) => ({
    kind: 'task',
    title: t.title,
    subtitle: t.group,
    meta: t.dueAt ? `due ${t.dueAt.slice(0, 10)}` : t.status,
    href: t.href,
  }));
  take(r.reminders, (t) => ({
    kind: 'task',
    title: t.title,
    subtitle: t.group,
    meta: t.remindAt ? `remind ${t.remindAt.slice(0, 10)}` : 'reminder',
    href: t.href,
  }));
  take(r.saves, (s) => ({
    kind: 'save',
    title: s.title,
    subtitle: s.group,
    preview: s.note ? truncate(s.note) : undefined,
    meta: s.kind,
    href: s.href,
  }));
  take(r.events, (e) => ({
    kind: 'event',
    title: e.title,
    subtitle: e.location ?? e.group,
    meta: e.startsAt.slice(0, 10),
    href: e.href,
  }));
  take(r.lists, (l) => {
    const unchecked = l.matchedItems.filter((i) => !i.checked).map((i) => i.text);
    return {
      kind: 'list',
      title: l.listName,
      subtitle: l.group,
      preview: unchecked.length ? truncate(unchecked.join(', ')) : undefined,
      meta: `${l.matchedItems.length} item${l.matchedItems.length === 1 ? '' : 's'}`,
      href: l.href,
    };
  });
  take(r.places, (p) => ({
    kind: 'save',
    title: p.name,
    subtitle: p.group,
    preview: p.note ? truncate(p.note) : undefined,
    meta: 'place',
    href: p.href,
  }));
  take(r.contacts, (c) => ({
    kind: 'save',
    title: c.name,
    subtitle: c.group,
    preview: c.note ? truncate(c.note) : undefined,
    meta: 'contact',
    href: c.href,
  }));
  take(r.media, (m) => ({
    kind: 'save',
    title: m.title,
    subtitle: m.group,
    preview: m.note ? truncate(m.note) : undefined,
    meta: m.kind,
    href: m.href,
  }));
  // Deep-links to the thread's own decisions screen (`/email/[threadId].tsx`),
  // the same target the tiles/feed UI already uses - it renders that
  // thread's magic suggestions, not just its content.
  take(r.emails, (e) => ({
    kind: 'email',
    title: e.subject,
    subtitle: e.from ?? undefined,
    preview: e.snippet ? truncate(e.snippet) : undefined,
    // Either an EmailAction (mobile renders the same colored to-do/reply
    // badge the Email tab itself uses) or, absent one, the received date.
    meta: e.action ?? e.receivedAt.slice(0, 10),
    href: e.href,
  }));

  return out;
}

/**
 * ADR 0032 — defense-in-depth post-filter. Walks the tool result's `data`
 * payload and drops any object that carries a `groupId` field whose value
 * doesn't match the current group. Catches cross-group leaks that slipped
 * past pre-call SQL scoping (e.g. a future tool that forgets to scope, or
 * a service helper joining across groups).
 */
function scrubCrossGroupLeak(
  result: ToolExecutionResult,
  groupId: string,
): ToolExecutionResult {
  if (result.data === undefined || result.data === null) return result;
  const scrubbed = scrubValue(result.data, groupId);
  if (scrubbed === result.data) return result;
  return { ...result, data: scrubbed };
}

function scrubValue(v: unknown, groupId: string): unknown {
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    let changed = false;
    for (const item of v) {
      if (
        item !== null &&
        typeof item === 'object' &&
        'groupId' in (item as Record<string, unknown>) &&
        (item as { groupId?: unknown }).groupId !== groupId
      ) {
        changed = true;
        continue;
      }
      const s = scrubValue(item, groupId);
      if (s !== item) changed = true;
      out.push(s);
    }
    return changed ? out : v;
  }
  if (v !== null && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    let changed = false;
    for (const [k, val] of Object.entries(src)) {
      const s = scrubValue(val, groupId);
      if (s !== val) changed = true;
      out[k] = s;
    }
    return changed ? out : v;
  }
  return v;
}

const UNSUBSCRIBE_OUTCOME_INSTRUCTION =
  'Report exactly what happened: unsubscribed=true means done; requested=true means the request was sent and Chord cannot see whether the list honoured it; kind "link" means the user finishes on the sender\'s page. Never say "unsubscribed" for the last two.';

/** What the bot says for a list Chord could not leave for the user (needsYou). */
const UNSUBSCRIBE_NEEDS_YOU_INSTRUCTION =
  'For each list marked needsYou, say plainly that Chord could not unsubscribe them from it on its own (it needs a click on the sender\'s side), and give them the two ways out: ' +
  'tap the "Unsubscribe" card to open that sender\'s page in the browser and finish there (only when a card is attached for it), ' +
  'or have Chord send that sender\'s future mail to Trash from now on (call trash_future_mail if they say yes). ' +
  'A list with autoTrash: true already goes to Trash; say so instead of offering it.';

function formatMoney(amount: number, currency: string): string {
  return currency === UNKNOWN_CURRENCY ? amount.toFixed(2) : `${amount.toFixed(2)} ${currency}`;
}

function subscriptionRow(s: MailingListSender) {
  return {
    senderEmail: s.senderEmail,
    senderName: s.senderName,
    messages: s.messages,
    opened: s.opened,
    lastReceivedAt: s.lastReceivedAt,
    kind: s.kind,
    ...(s.requestedAt ? { requestedAt: s.requestedAt } : {}),
    ...(s.stillMailing ? { stillMailing: true } : {}),
  };
}

function unsubscribeLinkCard(who: string, url: string): BotCard {
  return { kind: 'action', title: `Unsubscribe from ${who}`, meta: 'opens the sender’s page', url };
}

/**
 * Settle WHICH mailing list an unsubscribe is for before a card is staged.
 * Returns the call with the sender pinned, or a finished result when there is
 * nothing to confirm: no match, several matches, or a sender that only offers
 * a page (the user finishes that one themselves, so a confirm tap would be a
 * tap that does nothing).
 */
/** "Mark read, label Docs" - what a bulk email change does, for its card. */
function describeEmailChange(a: Record<string, unknown>): string {
  const parts: string[] = [];
  if (a.markRead === true) parts.push('Mark read');
  if (a.markRead === false) parts.push('Mark unread');
  if (a.archive === true) parts.push('Archive');
  if (a.archive === false) parts.push('Move to inbox');
  const add = Array.isArray(a.addLabels) ? (a.addLabels as string[]) : [];
  const remove = Array.isArray(a.removeLabels) ? (a.removeLabels as string[]) : [];
  if (add.length) parts.push(`label ${add.join(', ')}`);
  if (remove.length) parts.push(`remove label ${remove.join(', ')}`);
  const text = parts.join(', ') || 'Change';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The emails a bulk change means are found BEFORE the card exists, and their
 * ids ride on it: the card must act on the emails it counted, not on whatever
 * matches when it is tapped (new mail arriving in between would widen it).
 * No match, a person who could be several people, or no filter at all is a
 * reply, not a card.
 */
async function resolveEmailMatchTarget(
  db: Kysely<DB>,
  actorUserId: string | null,
  groupId: string,
  call: ToolCall,
  tz: string | null | undefined,
): Promise<{ call: ToolCall } | { result: ToolExecutionResult }> {
  const tool = 'update_emails_matching';
  const args = call.args as {
    markRead?: boolean;
    archive?: boolean;
    addLabels?: string[];
    removeLabels?: string[];
    from?: string;
    about?: string;
    hasAttachment?: boolean;
    after?: string;
    before?: string;
    label?: string;
    unreadOnly?: boolean;
    all?: boolean;
  };
  if (!actorUserId) return { result: { summary: `${tool}: no actor` } };
  if (!(await isPersonalTurn(db, groupId))) {
    return { result: { summary: `${tool}: refused — personal chats only`, data: { matched: 0, reason: 'personal_only' } } };
  }
  if (args.markRead === undefined && args.archive === undefined && !args.addLabels?.length && !args.removeLabels?.length) {
    return { result: { summary: `${tool}: nothing to change`, data: { matched: 0, reason: 'empty' } } };
  }
  const dayAfter = (day: string) => {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  };
  const found = await findEmailsForChange(db, actorUserId, {
    from: args.from,
    about: args.about,
    hasAttachment: args.hasAttachment,
    after: args.after ? zonedDayStartUtc(args.after, tz ?? null).toISOString() : undefined,
    before: args.before
      ? new Date(zonedDayStartUtc(dayAfter(args.before), tz ?? null).getTime() - 1).toISOString()
      : undefined,
    label: args.label,
    // Marking read only ever needs the unread ones; touching the rest is a
    // provider write per email for nothing.
    unreadOnly: args.unreadOnly || args.markRead === true,
    all: args.all,
  });
  if (!found.ok && found.reason === 'no_filter') {
    return {
      result: {
        summary: `${tool}: no filter given`,
        data: {
          matched: 0,
          reason: 'no_filter',
          instruction: 'Ask which emails they mean (from someone, about something, with attachments, a date range), or use all: true only if they said every email.',
        },
      },
    };
  }
  if (!found.ok) {
    return {
      result: {
        summary: `${tool}: more than one person matches "${args.from ?? ''}"`,
        data: { matched: 0, reason: 'ambiguous', people: found.people, instruction: askWhichPersonInstruction(found.people) },
      },
    };
  }
  if (found.threadIds.length === 0) {
    return { result: { summary: `${tool}: no emails match`, data: { matched: 0 } } };
  }
  const { threadIds: _t, truncated: _tr, samples: _s, forUserId: _f, ...rest } = call.args as Record<string, unknown>;
  return {
    call: {
      ...call,
      args: {
        ...rest,
        threadIds: found.threadIds,
        truncated: found.truncated,
        samples: found.samples.map((x) => (x.from ? `${x.subject} (${x.from})` : x.subject)),
        forUserId: actorUserId,
      },
    } as ToolCall,
  };
}

/**
 * Several lists, one card. Every list is fixed before the card exists. The
 * lists that can go on it are staged; the ones that cannot (no match, several
 * brands match, web page only, already asked) are handed back beside the card
 * so the user hears about them before tapping, but they never hold the rest
 * back.
 */
async function splitJoinedSenders(db: Kysely<DB>, userId: string, senders: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const sender of senders) {
    // A real name can hold "&" or "and" (Barnes & Noble), so the whole name
    // wins when it names a list; only otherwise is it read as several.
    const parts = sender.split(/\s*(?:,|;|&|\band\b)\s*/i).map((p) => p.trim()).filter((p) => p.length >= 2);
    if (parts.length < 2 || (await resolveSubscriptionSender(db, userId, sender)).ok) out.push(sender);
    else out.push(...parts);
  }
  return out;
}

async function resolveUnsubscribeManyTarget(
  db: Kysely<DB>,
  actorUserId: string | null,
  groupId: string,
  call: ToolCall,
): Promise<
  | { call: ToolCall; note?: { summary: string; data: Record<string, unknown> } }
  | { result: ToolExecutionResult }
> {
  const args = call.args as { senders: string[] };
  if (!actorUserId) return { result: { summary: 'unsubscribe_from_senders: no actor' } };
  if (!(await isPersonalTurn(db, groupId))) {
    return {
      result: {
        summary: 'unsubscribe_from_senders: refused — personal chats only',
        data: { reason: 'personal_only' },
      },
    };
  }
  // One entry per list the user named; a list can carry several addresses.
  const picked = new Map<string, { name: string; emails: string[] }>();
  const problems: Array<{ sender: string; problem: string; candidates?: unknown[] }> = [];
  for (const sender of await splitJoinedSenders(db, actorUserId, args.senders)) {
    const match = await resolveSubscriptionSender(db, actorUserId, sender);
    if (!match.ok) {
      problems.push({
        sender,
        problem: match.reason === 'ambiguous' ? 'several lists match' : 'no mailing list matches',
        ...(match.candidates.length ? { candidates: match.candidates.map(subscriptionRow) } : {}),
      });
      continue;
    }
    const name = match.sender.senderName ?? match.sender.senderEmail;
    if (picked.has(name)) continue;
    const emails: string[] = [];
    let reason: string | null = null;
    for (const s of match.senders) {
      if (s.requestedAt) reason ??= `already asked to stop on ${s.requestedAt.slice(0, 10)}`;
      else if (s.kind === 'link' || s.kind === null)
        reason ??= 'only offers a web page; use unsubscribe_from_sender for its link';
      else if (await pendingUnsubscribeFor(db, actorUserId, s.senderEmail))
        reason ??= 'a card for it is already waiting for the user';
      else emails.push(s.senderEmail);
    }
    // An address of the brand that cannot be left from here does not hold back
    // the ones that can; only a list with nothing left to do is a problem.
    if (emails.length > 0) picked.set(name, { name, emails });
    else problems.push({ sender, problem: reason ?? 'no mailing list matches' });
  }
  if (picked.size === 0) {
    return {
      result: {
        summary: `unsubscribe_from_senders: nothing staged — ${problems.length} list(s) need attention`,
        data: {
          reason: 'needs_attention',
          ready: [],
          problems,
          instruction:
            'NOTHING has been sent and no card was made. Tell the user which lists could not go on a card and why. ' +
            'Name every list the user asked about in your reply.',
        },
      },
    };
  }
  const lists = [...picked.values()];
  return {
    call: {
      ...call,
      args: {
        senders: args.senders,
        senderEmails: lists.flatMap((l) => l.emails),
        senderNames: lists.map((l) => l.name),
      },
    } as ToolCall,
    // The lists that could go on the card are not held back by the ones that
    // could not; those are reported beside the card.
    ...(problems.length
      ? {
          note: {
            summary: `${problems.length} list(s) not on the card`,
            data: {
              notOnCard: problems,
              instruction:
                'A card was made for the lists named on it and is waiting for the user to tap Unsubscribe. ' +
                'Also tell the user which lists are NOT on the card and why (notOnCard). Never say any of them is done.',
            },
          },
        }
      : {}),
  };
}

/**
 * A sender named for "send their future mail to Trash": a mailing list the
 * user is on, matched the way unsubscribe matches it, or failing that an exact
 * address the user has had mail from. Never a guess at someone else.
 */
async function resolveMailSender(
  db: Kysely<DB>,
  userId: string,
  sender: string,
): Promise<{ emails: string[]; name: string } | { problem: string; candidates?: unknown[] }> {
  const match = await resolveSubscriptionSender(db, userId, sender);
  if (match.ok) {
    return {
      emails: match.senders.map((s) => s.senderEmail),
      name: match.sender.senderName ?? match.sender.senderEmail,
    };
  }
  const address = sender.trim().toLowerCase();
  if (match.reason === 'not_found' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    const seen = await db
      .selectFrom('email_messages')
      .select('from_name')
      .where('user_id', '=', userId)
      .where(sql<boolean>`lower(from_email) = ${address}`)
      .limit(1)
      .executeTakeFirst();
    if (seen) return { emails: [address], name: seen.from_name?.trim() || address };
  }
  return {
    problem: match.reason === 'ambiguous' ? 'several senders match' : 'no mail from a sender like that',
    ...(match.candidates.length ? { candidates: match.candidates.map(subscriptionRow) } : {}),
  };
}

async function resolveTrashFutureMailTarget(
  db: Kysely<DB>,
  actorUserId: string | null,
  groupId: string,
  call: ToolCall,
): Promise<
  | { call: ToolCall; note?: { summary: string; data: Record<string, unknown> } }
  | { result: ToolExecutionResult }
> {
  const args = call.args as { senders: string[] };
  if (!actorUserId) return { result: { summary: 'trash_future_mail: no actor' } };
  if (!(await isPersonalTurn(db, groupId))) {
    return { result: { summary: 'trash_future_mail: refused — personal chats only', data: { reason: 'personal_only' } } };
  }
  const already = new Set((await listAutoTrash(db, actorUserId)).map((r) => r.sender));
  const picked = new Map<string, string>();
  const problems: Array<{ sender: string; problem: string; candidates?: unknown[] }> = [];
  for (const sender of args.senders) {
    const r = await resolveMailSender(db, actorUserId, sender);
    if ('problem' in r) {
      problems.push({ sender, ...r });
      continue;
    }
    const fresh = r.emails.filter((e) => !already.has(e));
    if (fresh.length === 0) problems.push({ sender, problem: 'its mail already goes to Trash' });
    else for (const e of fresh) picked.set(e, r.name);
  }
  if (picked.size === 0) {
    return {
      result: {
        summary: `trash_future_mail: nothing staged — ${problems.length} sender(s) need attention`,
        data: {
          reason: 'needs_attention',
          ready: [],
          problems,
          instruction: 'Nothing was changed and no card was made. Tell the user which senders could not be used and why.',
        },
      },
    };
  }
  return {
    call: {
      ...call,
      args: { senders: args.senders, senderEmails: [...picked.keys()], senderNames: [...new Set(picked.values())] },
    } as ToolCall,
    ...(problems.length
      ? {
          note: {
            summary: `${problems.length} sender(s) not on the card`,
            data: {
              notOnCard: problems,
              instruction:
                'A card was made for the senders named on it and is waiting for the user to confirm. ' +
                'Also tell the user which senders are NOT on the card and why (notOnCard). Never say any of them is done.',
            },
          },
        }
      : {}),
  };
}

/**
 * ADR 0309 — what a filter's `from` means, from the user's own mail only: an
 * address or a domain as typed, or a person's name resolved to their addresses
 * (ADR 0270). Several people = ask; nobody = say so.
 */
async function resolveFilterFrom(
  db: Kysely<DB>,
  userId: string,
  from: string,
): Promise<
  | { ok: true; matches: string[]; who: string }
  | { ok: false; reason: 'ambiguous' | 'not_found'; candidates?: Array<{ name: string | null; emails: string[] }> }
> {
  const direct = parseFilterMatch(from);
  if (direct) return { ok: true, matches: [direct.value], who: direct.value };
  const r = await resolveCorrespondent(db, userId, from, { direction: 'from' });
  if (r.status === 'resolved' && r.addresses.length > 0) {
    const name = r.candidates[0]?.name ?? r.label;
    return { ok: true, matches: r.addresses.slice(0, 5), who: name };
  }
  if (r.status === 'ambiguous') {
    return {
      ok: false,
      reason: 'ambiguous',
      candidates: r.candidates.slice(0, 5).map((c) => ({ name: c.name, emails: c.emails.slice(0, 3) })),
    };
  }
  return { ok: false, reason: 'not_found' };
}

async function resolveMailFilterTarget(
  db: Kysely<DB>,
  actorUserId: string | null,
  groupId: string,
  call: ToolCall,
  triggeringMessageId: string | null | undefined,
): Promise<{ call: ToolCall } | { result: ToolExecutionResult }> {
  const args = call.args as { from: string; folder: string; alsoExisting?: boolean };
  if (!actorUserId) return { result: { summary: 'add_mail_filter: no actor' } };
  if (!(await isPersonalTurn(db, groupId))) {
    return { result: { summary: 'add_mail_filter: refused — personal chats only', data: { reason: 'personal_only' } } };
  }
  const folder = checkFolderName(args.folder);
  if (!folder.ok) {
    return {
      result: {
        summary: `add_mail_filter: nothing staged — folder "${args.folder}" cannot be used (${folder.reason})`,
        data: {
          reason: folder.reason,
          instruction:
            folder.reason === 'reserved_folder'
              ? 'That is one of the mailbox\'s own folders (Inbox, Trash, Sent...). Ask for another folder name.'
              : 'That folder name cannot be used. Ask for a plain folder name.',
        },
      },
    };
  }
  const who = await resolveFilterFrom(db, actorUserId, args.from);
  if (!who.ok) {
    return {
      result: {
        summary: `add_mail_filter: nothing staged — ${who.reason === 'ambiguous' ? 'several people match' : 'no mail from anyone like that'} "${args.from}"`,
        data: { reason: who.reason, ...(who.candidates ? { candidates: who.candidates } : {}) },
      },
    };
  }
  // Moving mail already in the inbox is a second, bigger thing to agree to:
  // ADR 0309 files only new mail without it. Honoured only when the user's own
  // words asked for it, so the card cannot offer a mailbox move nobody
  // mentioned under a main sentence that is exactly right (ADR 0319's
  // addendum). Resolved here, at staging, so the card states the truth.
  const alsoExisting =
    args.alsoExisting === true &&
    (await askedInConversation(db, triggeringMessageId, looksLikeExistingMailRequest)) !== 'no';
  return {
    call: {
      ...call,
      args: { from: args.from, folder: folder.folder, alsoExisting, matches: who.matches, who: who.who },
    } as ToolCall,
  };
}

/** The id of this user's still-untapped unsubscribe card for that sender, if any. */
async function pendingUnsubscribeFor(
  db: Kysely<DB>,
  userId: string,
  senderEmail: string,
): Promise<string | null> {
  const rows = await db
    .selectFrom('proposals')
    .select(['id', 'args_json'])
    .where('proposed_by_user_id', '=', userId)
    .where('tool_name', 'in', ['unsubscribe_from_sender', 'unsubscribe_from_senders'])
    .where('status', '=', 'pending')
    // Expiry is applied lazily; a card past its time is not waiting any more.
    .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', new Date().toISOString())]))
    .orderBy('created_at', 'desc')
    .execute();
  const wanted = senderEmail.toLowerCase();
  for (const r of rows) {
    try {
      // A several-lists card is waiting for each address on it, too.
      const a = JSON.parse(r.args_json) as { senderEmail?: string; senderEmails?: string[] };
      const on = [a.senderEmail, ...(a.senderEmails ?? [])].filter((e): e is string => typeof e === 'string');
      if (on.some((e) => e.toLowerCase() === wanted)) return r.id;
    } catch {
      /* unreadable args are not this sender's card */
    }
  }
  return null;
}

async function resolveUnsubscribeTarget(
  db: Kysely<DB>,
  actorUserId: string | null,
  groupId: string,
  call: ToolCall,
): Promise<{ call: ToolCall } | { result: ToolExecutionResult }> {
  const args = call.args as { sender: string };
  if (!actorUserId) return { result: { summary: 'unsubscribe_from_sender: no actor' } };
  if (!(await isPersonalTurn(db, groupId))) {
    return {
      result: {
        summary: 'unsubscribe_from_sender: refused — personal chats only',
        data: { unsubscribed: false, reason: 'personal_only' },
      },
    };
  }
  const match = await resolveSubscriptionSender(db, actorUserId, args.sender);
  if (!match.ok) {
    return {
      result: {
        summary: `unsubscribe_from_sender: ${match.reason === 'ambiguous' ? 'several mailing lists match' : 'no mailing list matches'} "${args.sender}"`,
        data: {
          unsubscribed: false,
          reason: match.reason,
          candidates: match.candidates.map(subscriptionRow),
        },
      },
    };
  }
  // One brand mailing from several addresses is one list to the user: leave
  // every address of it, on the several-lists card.
  if (match.senders.length > 1) {
    return { call: { ...call, name: 'unsubscribe_from_senders', args: { senders: [args.sender] } } as ToolCall };
  }
  const who = match.sender.senderName ?? match.sender.senderEmail;
  // Asked again before tapping the card ("I don't think you unsubscribed me"):
  // the answer is the card that is already waiting, never a second card and
  // never "sent". Prod staged a duplicate pair and the bot said it had sent them.
  const waiting = await pendingUnsubscribeFor(db, actorUserId, match.sender.senderEmail);
  if (waiting) {
    return {
      result: {
        summary: `unsubscribe_from_sender: ${who} — a card is already waiting for the user's tap; NOTHING has been sent`,
        data: {
          sender: who,
          unsubscribed: false,
          requested: false,
          reason: 'awaiting_confirmation',
          proposalId: waiting,
          instruction:
            'Nothing has been sent to this sender yet. Tell the user the unsubscribe card from earlier is still ' +
            'waiting for them to tap Unsubscribe (in this chat and in Action Items). Never say it was sent or done.',
        },
      },
    };
  }
  if (match.sender.requestedAt) {
    return {
      result: {
        summary: `unsubscribe_from_sender: ${who} — already asked to stop on ${match.sender.requestedAt.slice(0, 10)}`,
        data: {
          sender: who,
          unsubscribed: false,
          reason: 'already_requested',
          requestedAt: match.sender.requestedAt,
          senderEmail: match.sender.senderEmail,
          ...(match.sender.autoTrash ? { autoTrash: true } : {}),
          instruction:
            'Chord already asked this sender to stop on that date. Say so; lists can take a few days to stop, ' +
            'and Chord cannot see whether this one honoured it. If they say it is still mailing them, offer to send ' +
            'its future mail to Trash (trash_future_mail), unless autoTrash is already true.',
        },
      },
    };
  }
  if (match.sender.kind === 'link' || match.sender.kind === null) {
    const out = await unsubscribeThread(db, actorUserId, match.sender.threadId);
    return {
      result: {
        summary: `unsubscribe_from_sender: ${who} — ${out.message}`,
        data: {
          sender: who,
          senderEmail: match.sender.senderEmail,
          kind: out.kind,
          unsubscribed: false,
          needsYou: true,
          ...(match.sender.autoTrash ? { autoTrash: true } : {}),
          message: out.url
            ? 'This sender only offers an unsubscribe page; the link is on the card.'
            : out.message,
          instruction: `${UNSUBSCRIBE_OUTCOME_INSTRUCTION} ${UNSUBSCRIBE_NEEDS_YOU_INSTRUCTION}`,
        },
        ...(out.url ? { card: unsubscribeLinkCard(who, out.url) } : {}),
      },
    };
  }
  return {
    call: {
      ...call,
      args: {
        sender: args.sender,
        senderEmail: match.sender.senderEmail,
        ...(match.sender.senderName ? { senderName: match.sender.senderName } : {}),
      },
    } as ToolCall,
  };
}

/**
 * ADR 0259 - fix the chat a leave / delete card is about BEFORE the card exists: the
 * name resolves exactly or comes back as a question, and an owner-only delete is refused up
 * front so nobody taps a card that cannot work. The tap then acts on the id the card named.
 */
async function resolveGroupLifecycleTarget(
  db: Kysely<DB>,
  actorUserId: string | null,
  groupId: string,
  call: ToolCall,
): Promise<{ call: ToolCall } | { result: ToolExecutionResult }> {
  const tool = call.name as 'leave_group' | 'delete_group';
  if (!actorUserId) return { result: { summary: `${tool}: no actor` } };
  if (!(await isPersonalTurn(db, groupId))) {
    return {
      result: {
        summary: `${tool}: only offered in the asker's own chat`,
        data: { ok: false, reason: 'personal_chat_only' },
      },
    };
  }
  const { groupName } = call.args as { groupName: string };
  const resolved = await resolveGroupByName(db, actorUserId, groupName);
  if (!resolved.ok) {
    return {
      result: {
        summary: `${tool}: chat name "${groupName}" did not resolve exactly`,
        data: { ok: false, reason: resolved.reason, candidates: resolved.candidates },
      },
    };
  }
  if (tool === 'delete_group' && (await getMemberRole(db, resolved.groupId, actorUserId)) !== 'owner') {
    return {
      result: {
        summary: `delete_group: the asker does not own "${resolved.groupName}"`,
        data: { ok: false, reason: 'not_owner', groupName: resolved.groupName },
      },
    };
  }
  return {
    call: {
      ...call,
      args: { groupName: resolved.groupName, groupId: resolved.groupId, forUserId: actorUserId },
    } as ToolCall,
  };
}

/**
 * ADR 0234 addendum - fix where a group post goes, and for an email which
 * message, BEFORE the card exists: the group resolves exactly or comes back as
 * a question, the email must be the asker's own, and the card is pinned to the
 * asker so nobody else's tap posts in their name.
 */
async function resolveGroupPostTarget(
  db: Kysely<DB>,
  actorUserId: string | null,
  groupId: string,
  call: ToolCall,
  tz: string | null | undefined,
): Promise<{ call: ToolCall } | { result: ToolExecutionResult }> {
  const tool = call.name as 'message_group' | 'share_email_with_group';
  if (!actorUserId) return { result: { summary: `${tool}: no actor`, data: { ok: false, reason: 'no_actor' } } };
  if (!(await isPersonalTurn(db, groupId))) {
    return { result: { summary: `${tool}: personal chat only`, data: { ok: false, reason: 'personal_only' } } };
  }
  // Anything the model put in the pinned fields is dropped.
  const {
    groupId: _g,
    forUserId: _f,
    threadSubject: _s,
    threadFrom: _t,
    messageDate: _d,
    previewBody: _b,
    previewFiles: _x,
    previewWhen: _w,
    ...given
  } = call.args as Record<string, unknown>;
  const target = await resolveShareTarget(db, actorUserId, given.groupName as string | undefined);
  if (!target.ok) {
    return {
      result: {
        summary: `${tool}: ${target.reason}`,
        data: { ok: false, reason: target.reason, candidates: target.candidates },
      },
    };
  }
  const pinned = { ...given, groupName: target.groupName, groupId: target.groupId, forUserId: actorUserId };
  if (tool === 'message_group') return { call: { ...call, args: pinned } as ToolCall };
  const preview = await emailSharePreview(db, actorUserId, String(given.threadId ?? ''), tz);
  if (!preview) {
    return {
      result: {
        summary: 'share_email_with_group: thread_not_found',
        data: { ok: false, reason: 'thread_not_found' },
      },
    };
  }
  return {
    call: {
      ...call,
      args: {
        ...pinned,
        threadSubject: preview.subject,
        threadFrom: preview.from,
        messageDate: preview.date,
        ...(preview.when ? { previewWhen: preview.when } : {}),
        ...(preview.body ? { previewBody: preview.body } : {}),
        ...(preview.files.length ? { previewFiles: preview.files } : {}),
      },
    } as ToolCall,
  };
}

async function applyToolCallImpl(
  db: Kysely<DB>,
  input: ApplyToolCallInput,
): Promise<ToolExecutionResult> {
  const { groupId, actorUserId, provenance, tzOffset, tz } = input;
  const suppressEventNudges = input.suppressEventNudges || input.additionalGroupShare;
  // Coerce LLM datetimes into valid ISO here — the single choke point for every
  // caller (native loop, text-fence path, direct commit, ingest). Without this
  // a fenced add_travel_leg from a flight screenshot stored e.g. "…T14:30"
  // (no seconds), which passed proposal creation but failed isoDatetime on
  // confirm ("Invalid datetime"). Idempotent for already-normalized args.
  const call: ToolCall = {
    ...input.call,
    args: normalizeDatetimes(input.call.args, tzOffset ?? '+00:00', tz),
  } as ToolCall;
  const mode = input.mode ?? 'commit';
  const emit: SseBroadcaster = input.emit ?? ((ch, ev, data) => sseHub.broadcast(ch, ev, data));
  const userId = actorUserId ?? '';

  if (mode === 'propose' && (PROPOSABLE_TOOLS.has(call.name) || (input.stageWrites && isWriteTool(call.name)))) {
    let toStage = call;
    let stagedNote: { summary: string; data: Record<string, unknown> } | null = null;
    if (call.name === 'leave_group' || call.name === 'delete_group') {
      const resolved = await resolveGroupLifecycleTarget(db, actorUserId, groupId, call);
      if ('result' in resolved) return resolved.result;
      toStage = resolved.call;
    }
    if (call.name === 'message_group' || call.name === 'share_email_with_group') {
      const resolved = await resolveGroupPostTarget(db, actorUserId, groupId, call, tz);
      if ('result' in resolved) return resolved.result;
      toStage = resolved.call;
    }
    if (call.name === 'unsubscribe_from_sender') {
      // The sender is fixed before the card exists: a name that matches no
      // list, or several, is a question for the user, not a card to tap.
      const resolved = await resolveUnsubscribeTarget(db, actorUserId, groupId, call);
      if ('result' in resolved) return resolved.result;
      toStage = resolved.call;
    }
    if (toStage.name === 'unsubscribe_from_senders') {
      const resolved = await resolveUnsubscribeManyTarget(db, actorUserId, groupId, toStage);
      if ('result' in resolved) return resolved.result;
      toStage = resolved.call;
      stagedNote = resolved.note ?? null;
    }
    if (call.name === 'trash_future_mail') {
      const resolved = await resolveTrashFutureMailTarget(db, actorUserId, groupId, call);
      if ('result' in resolved) return resolved.result;
      toStage = resolved.call;
      stagedNote = resolved.note ?? null;
    }
    if (call.name === 'add_mail_filter') {
      const resolved = await resolveMailFilterTarget(db, actorUserId, groupId, call, input.triggeringMessageId);
      if ('result' in resolved) return resolved.result;
      toStage = resolved.call;
    }
    if (call.name === 'update_emails_matching') {
      const resolved = await resolveEmailMatchTarget(db, actorUserId, groupId, call, tz);
      if ('result' in resolved) return resolved.result;
      toStage = resolved.call;
    }
    // A recipient the model wrote needs a source before it can go on a Send
    // card: a plausible guess reads as right at the tap, and mail sent to a
    // stranger cannot be called back.
    if (toStage.name === 'compose_email' || toStage.name === 'forward_email') {
      const a = toStage.args as { to?: string[]; cc?: string[] };
      const check = await addressChecker(db, actorUserId, input.triggeringMessageId, input.turnId);
      const unknown = check ? await check([...(a.to ?? []), ...(a.cc ?? [])]) : [];
      if (unknown.length) {
        return {
          summary: `${toStage.name}: nothing staged — no source for ${unknown.join(', ')}`,
          data: { reason: 'unknown_address', unknownAddresses: unknown, instruction: unknownAddressInstruction(unknown) },
        };
      }
    }
    // Recipients are resolved HERE, not at confirm: the addresses on the card
    // must be the addresses that get mailed. Resolving them again at send time
    // would let a newly-arrived reply widen an audience the user already
    // approved.
    const staged = await stageProposalArgs(db, actorUserId, toStage, {
      groupId,
      triggeringMessageId: input.triggeringMessageId,
    });
    if (staged.name === 'delete_messages') {
      const a = staged.args as { scope: string; messageIds?: string[] };
      if (a.scope === 'last' && (a.messageIds ?? []).length === 0) {
        return {
          summary: 'delete_messages: there is no message here to delete',
          data: { deleted: 0, reason: 'nothing_to_delete' },
        };
      }
    }
    const { title, card } = proposeCardFor(staged, tz ?? undefined);
    const proposal = await createProposal(db, {
      groupId,
      proposedByUserId: actorUserId,
      proposedByMessageId: input.triggeringMessageId ?? null,
      toolName: staged.name,
      args: staged.args,
      provenance,
      bundleId: input.bundleId ?? null,
    });
    emit(groupId, SSE.proposalCreated, proposal);
    return {
      summary:
        `proposed ${staged.name}: "${title}" (awaiting confirmation — proposal ${proposal.id})` +
        (stagedNote ? `; ${stagedNote.summary}` : ''),
      card: {
        ...card,
        subtitle: card.subtitle ?? 'proposed — awaiting confirmation',
        // The app answers from the proposal itself and ignores these; WhatsApp
        // and Telegram have nothing else to answer with.
        buttons: [
          { label: confirmLabelFor(staged.name), callback: { verb: 'p+', id: proposal.id } },
          { label: 'Cancel', callback: { verb: 'p-', id: proposal.id } },
        ],
      },
      data: {
        proposalId: proposal.id,
        bundleId: proposal.bundleId,
        ...(stagedNote?.data ?? {}),
        ...(staged.name === 'reply_to_email' && (staged.args as { senderWarning?: string }).senderWarning
          ? {
              senderWarning: (staged.args as { senderWarning: string }).senderWarning,
              instruction:
                'This email looks fake and asks for replies to go to an address that is not the sender. ' +
                'Say so plainly first, in your own words, before mentioning the draft: tell the user not to reply ' +
                'or share account details, and that they can cancel the card.',
            }
          : {}),
      },
    };
  }

  switch (call.name) {
    // ADR 0067 — flagship: message a resolved contact by name. Resolves within
    // the SENDER's own contacts, honors the recipient's block, and delivers via
    // a find-or-created pair group (existing broadcast → push). Returns the
    // recipient NAME, never the pair group's id, so ADR 0032's scrubber leaves
    // it intact (like search/find_events).
    case 'message_user': {
      const args = call.args as {
        recipientName: string;
        body: string;
        event?: { title: string; startsAt: string; endsAt?: string; location?: string };
      };
      if (!userId) {
        return { summary: 'message_user: no acting user', data: { ok: false, reason: 'no_actor' } };
      }
      const resolution = await resolveContactToUser(db, userId, args.recipientName);
      if (resolution.kind === 'none') {
        return {
          summary: `message_user: no Chord contact matches "${args.recipientName}"`,
          data: { ok: false, reason: 'not_found', recipientName: args.recipientName },
        };
      }
      if (resolution.kind === 'ambiguous') {
        return {
          summary: `message_user: "${args.recipientName}" matches multiple contacts`,
          data: {
            ok: false,
            reason: 'ambiguous',
            matches: resolution.matches.map((m) => ({ name: m.name, displayName: m.displayName })),
          },
        };
      }
      const recipientId = resolution.chordUserId;
      if (await isBlocked(db, recipientId, userId)) {
        return {
          summary: `message_user: ${resolution.displayName} isn't accepting messages`,
          data: { ok: false, reason: 'blocked', recipient: resolution.displayName },
        };
      }
      // ADR 0298: the asker blocked them, so a reply would be hidden from the
      // asker anyway. Say so rather than open a chat that cannot work.
      if (await isBlocked(db, userId, recipientId)) {
        return {
          summary: `message_user: you blocked ${resolution.displayName}`,
          data: { ok: false, reason: 'you_blocked', recipient: resolution.displayName },
        };
      }
      const pair = await ensurePairGroup(db, userId, recipientId);

      // Optional calendar invite: a shared event in the pair group fans out to
      // both members (ADR 0040), so it lands on both people's calendars. It
      // is a `create_event` run in the pair group, so every rule that tool
      // has holds here too: a past date is refused and asked about (ADR 0100),
      // a two-calendar name is asked about (ADR 0137), the reply names the
      // real calendar (ADR 0182). This path once called `createEvent` itself
      // and filed a stale-year coffee with no question. Done BEFORE the
      // message, so a refusal sends nothing and the retry sends it once.
      let eventCreated = false;
      let calendarSentence = '';
      if (args.event) {
        const res = await applyToolCallImpl(db, {
          ...input,
          groupId: pair.id,
          mode: 'commit',
          call: { name: 'create_event', args: args.event },
        });
        const data = (res.data ?? {}) as Record<string, unknown>;
        if (data.created === false || data.permissionRequestId) {
          return {
            summary:
              `message_user: NOTHING was sent to ${resolution.displayName} (not the message either) — ` +
              `the invite was refused: ${res.summary}`,
            data: {
              ok: false,
              reason: data.reason ?? 'event_refused',
              recipient: resolution.displayName,
              ...(data.when ? { when: data.when } : {}),
              ...(data.candidates ? { candidates: data.candidates } : {}),
              instruction:
                typeof data.instruction === 'string'
                  ? data.instruction
                  : 'Do NOT say the message was sent. Read the problem back to the user and ask; then call message_user again.',
            },
          };
        }
        eventCreated = true;
        calendarSentence = res.summary.replace(/^event /, ' · invite: ');
      }

      const msg = await postMessage(db, { groupId: pair.id, senderId: userId, body: args.body });
      emit(pair.id, SSE.message, msg);
      return {
        summary: `message_user: sent to ${resolution.displayName}${calendarSentence}`,
        data: { ok: true, recipient: resolution.displayName, eventCreated },
      };
    }
    case 'create_task': {
      const args = call.args as {
        title: string;
        details?: string;
        assigneeName?: string;
        dueAt?: string;
        remindAt?: string;
        remindCue?: string;
        closesOnReply?: boolean;
      };
      const targetGroupId = groupId;
      // ADR 0151 — the assignee is an account member or a managed persona
      // (a kid on the roster) of the target group. A member wins a name
      // collision.
      const target = args.assigneeName
        ? await resolveAssigneeTarget(db, targetGroupId, args.assigneeName)
        : undefined;
      const assigneeId = target?.kind === 'user' ? target.id : undefined;
      const assigneePersonaId = target?.kind === 'persona' ? target.id : undefined;
      // No per-task default reminder: open tasks already surface in the
      // daily 7am scan (proactive.service `renderDailyMorningScan`).
      // We only enqueue a `task_remind` proactive when the user
      // explicitly stated a remind time, which the prompt coaches the
      // LLM to honor. As a safety net, reject any remindAt within the
      // next 5 minutes — that's almost always the LLM misreading
      // "remind me to X" as an immediate-fire directive.
      const remindAt = sanitizeRemindAt(args.remindAt);
      let outcome;
      try {
        outcome = await createTaskWithDedup(db, {
          groupId: targetGroupId,
          createdBy: actorUserId,
          title: args.title,
          details: args.details,
          assigneeId,
          assigneePersonaId,
          dueAt: args.dueAt,
          remindAt,
          remindCue: args.remindCue,
          sourceRawContext: provenance,
          // ADR 0314 — only an email's to-do has a thread to reply in.
          closesOnReply: args.closesOnReply === true && !!provenance?.startsWith('gmail:'),
        });
      } catch (err) {
        if (err instanceof TrustError && actorUserId) {
          const pr = await requestPermission(db, {
            recipientUserId: err.recipientUserId,
            senderUserId: actorUserId,
            groupId: targetGroupId,
            scopes: ['task'],
            reason: `task: ${args.title}`,
          });
          return {
            summary: `permission requested: ${args.title} (request ${pr.id})`,
            card: {
              kind: 'task',
              title: args.title,
              subtitle: 'permission requested',
              meta: `awaiting ${args.assigneeName ?? 'recipient'}'s approval`,
            },
            data: { permissionRequestId: pr.id },
          };
        }
        throw err;
      }
      const { task, created, updated } = outcome;
      // A dedup hit is still a state change worth broadcasting when it moved a
      // date; an exact restatement changes nothing, so stay quiet.
      if (created || updated.length > 0) {
        emit(targetGroupId, SSE.taskCreated, task);
        await enqueueFromTask(db, task);
      }
      const assigneeLabel = task.assigneeId
        ? await displayNameFor(db, task.assigneeId)
        : task.assigneePersonaId
          ? ((await getPersona(db, task.assigneePersonaId))?.name ?? null)
          : null;
      const dedupSummary = created
        ? `task ${task.id} "${task.title}"`
        : updated.length > 0
          ? `task ${task.id} "${task.title}" already existed — updated ${updated.join(', ')}`
          : `task ${task.id} "${task.title}" already on the list — nothing added`;
      return {
        summary: dedupSummary,
        card: {
          kind: 'task',
          title: task.title,
          subtitle: assigneeLabel ? `assignee: ${assigneeLabel}` : undefined,
          meta: created
            ? task.dueAt
              ? `due ${formatDueAt(task.dueAt, tzOffset)}`
              : (task.remindCue ?? undefined)
            : updated.length > 0
              ? `already on the list — ${updated.join(', ')} updated`
              : 'already on the list',
        },
        data: { taskId: task.id, created, updated },
      };
    }

    case 'add_list_item': {
      const args = call.args as { listName: string; items: string[] };
      const targetGroupId = groupId;
      const resolved = await resolveOrCreateListByName(db, targetGroupId, args.listName, actorUserId);
      // Several lists fit the name — adding to a guess is how a "books" item
      // lands on "Books to buy" when the user meant "Books to read". Hand the
      // names back and let the model ask.
      if (resolved.status === 'ambiguous') {
        return {
          summary: `add_list_item: "${args.listName}" matches ${resolved.candidates.length} lists`,
          data: {
            added: false,
            reason: 'ambiguous',
            candidates: resolved.candidates.map((l) => l.name),
          },
        };
      }
      const list = resolved.match;
      let added = 0;
      const duplicates: string[] = [];
      for (const text of args.items) {
        const { item, created } = await addItem(db, list.id, text);
        if (created) {
          emit(targetGroupId, SSE.listUpdated, { listId: list.id, item });
          added++;
        } else {
          duplicates.push(item.text);
        }
      }
      const dupNote =
        duplicates.length > 0
          ? ` (${duplicates.length} already on the list: ${duplicates.slice(0, 3).join(', ')}${duplicates.length > 3 ? '…' : ''})`
          : '';
      return {
        summary: `${added}/${args.items.length} items → ${args.listName}${dupNote}`,
        card: {
          kind: 'list',
          title: args.listName,
          subtitle: args.items.join(', '),
          meta: added === args.items.length
            ? `${added} item${added === 1 ? '' : 's'} added`
            : `${added} added · ${duplicates.length} already there`,
        },
      };
    }

    case 'save_link': {
      const args = call.args as {
        title: string;
        url: string;
        tripLabel?: string;
        tags?: string[];
        note?: string;
      };
      const { save, created } = await createSaveWithDedup(db, {
        groupId,
        createdBy: actorUserId,
        kind: 'link',
        title: args.title,
        url: args.url,
        tripLabel: args.tripLabel,
        tags: args.tags ?? [],
        note: args.note,
        sourceRawContext: provenance,
      });
      if (created) emit(groupId, SSE.saveAdded, save);
      return {
        summary: created ? `save link ${save.id}` : `link already saved as "${save.title}" (${save.id})`,
        card: {
          kind: 'save',
          title: save.title,
          subtitle: save.url,
          meta: created ? 'link saved' : 'already saved — no duplicate added',
        },
      };
    }

    case 'save_place': {
      const args = call.args as {
        name: string;
        area?: string;
        city?: string;
        tags?: string[];
        note?: string;
      };
      const targetGroupId = groupId;
      // Route through saves so the place shows up in /me/saves for every
      // group member (rather than disappearing into the orphaned `places`
      // table, which no UI surface reads).
      const locParts = [args.area, args.city].filter(Boolean);
      const noteParts = [...locParts];
      if (args.note) noteParts.push(args.note);
      const { save, created } = await createSaveWithDedup(db, {
        groupId: targetGroupId,
        createdBy: actorUserId,
        kind: 'place',
        title: args.name,
        note: noteParts.join(' · ') || undefined,
        tags: args.tags ?? [],
        sourceRawContext: provenance,
      });
      if (created) emit(targetGroupId, SSE.saveAdded, save);
      return {
        summary: (created ? `place ${args.name}` : `place "${args.name}" already saved`),
        card: {
          kind: 'save',
          title: args.name,
          subtitle: locParts.join(' · ') || undefined,
          meta: created ? 'place saved' : 'already saved — no duplicate added',
        },
      };
    }

    case 'save_media': {
      const args = call.args as {
        kind: 'book' | 'podcast' | 'show' | 'movie' | 'article';
        title: string;
        note?: string;
      };
      // Route through saves so it appears in /me/saves. The book/podcast/
      // … subtype is preserved as a tag and prepended to note for context.
      const noteWithKind = args.note
        ? `${args.kind} · ${args.note}`
        : args.kind;
      const { save, created } = await createSaveWithDedup(db, {
        groupId,
        createdBy: actorUserId,
        kind: 'media',
        title: args.title,
        note: noteWithKind,
        tags: [args.kind],
        sourceRawContext: provenance,
      });
      if (created) emit(groupId, SSE.saveAdded, save);
      return {
        summary: created ? `media ${args.kind}:${args.title}` : `${args.kind} "${args.title}" already saved`,
        card: { kind: 'save', title: args.title, subtitle: args.kind, meta: created ? 'added' : 'already saved' },
      };
    }

    case 'save_contact': {
      const args = call.args as {
        name: string;
        org?: string;
        education?: string[];
        family?: string;
        tags?: string[];
        note?: string;
      };
      // Route through saves so the contact appears in /me/saves alongside
      // every other save kind. Structured fields collapse into the note
      // (org · family · education · free-text) so nothing is lost.
      const noteParts: string[] = [];
      if (args.org) noteParts.push(args.org);
      if (args.family) noteParts.push(args.family);
      if (args.education && args.education.length > 0) {
        noteParts.push(args.education.join(', '));
      }
      if (args.note) noteParts.push(args.note);
      const { save, created } = await createSaveWithDedup(db, {
        groupId,
        createdBy: actorUserId,
        kind: 'contact',
        title: args.name,
        note: noteParts.join(' · ') || undefined,
        tags: args.tags ?? [],
        sourceRawContext: provenance,
      });
      if (created) emit(groupId, SSE.saveAdded, save);
      return {
        summary: created ? `contact ${args.name}` : `contact "${args.name}" already saved`,
        card: {
          kind: 'save',
          title: args.name,
          subtitle: args.org ?? undefined,
          meta: created ? 'contact saved' : 'already saved — no duplicate added',
        },
      };
    }

    case 'create_event': {
      const args = call.args as {
        title: string;
        startsAt: string;
        endsAt?: string;
        location?: string;
        assigneeName?: string;
        externalUid?: string;
        allDay?: boolean;
        calendar?: string;
        confirmPast?: boolean;
        alreadyInGoogle?: boolean;
        invitees?: string[];
        videoCall?: boolean;
        repeat?: RepeatSpec;
      };
      // ADR 0217 — build the rule before anything is written, so a repeat the
      // rule cannot express refuses cleanly instead of storing a one-off that
      // the reply would then call recurring.
      let repeat: { rrule: string; tz: string } | undefined;
      // ADR 0229 — a `repeat` nobody asked for is ignored, valid or not: the
      // event is the one-time event that was asked for. Refusing the whole
      // event over it (the first behaviour) blocked plain requests; acting
      // on it only when it failed validation (the second) left a valid
      // made-up repeat free to create a series.
      // ADR 0319's addendum — `allDay` has to AGREE with the time it arrived
      // with. It overrides `createEvent`'s floating-midnight sniff both ways,
      // and `normalizeDatetimes` has already stamped the user's offset onto
      // the floating midnight the prompt asks for, so the field is the model's
      // only way to say "all day" and cannot simply be ignored here. What it
      // must not do is contradict the start: `true` beside a 3pm meeting is a
      // filled-in field (ADR 0229's addendum), and honouring it files that
      // meeting as an all-day, non-blocking row. So on a conversational turn
      // it is honoured only when the value's OWN clock reads midnight —
      // floating, offset-stamped or `Z`. The question is whether the model
      // contradicted itself, which is about the time it wrote, not about which
      // zone that instant lands in: nobody emits 7pm as `T00:00:00Z`, and
      // excluding `Z` here (the first shape of this guard) silently stopped a
      // UTC-zone user's all-day event from being all-day, which a
      // before-and-after matrix caught. Anything else falls back to the sniff.
      // Ingest, the .ics import and proposal confirm carry no `turnId` (ADR
      // 0093) and are taken as given.
      const startsAtMidnight = /T00:00:00(\.\d+)?([+-]\d{2}:?\d{2}|Z)?$/.test(args.startsAt);
      const allDayForWrite = !input.turnId
        ? args.allDay
        : args.allDay === true && startsAtMidnight
          ? true
          : undefined;
      const repeatUnasked =
        !!args.repeat && (await repeatWasAsked(db, input.triggeringMessageId)) === 'no';
      if (args.repeat && !repeatUnasked) {
        const zone = await seriesZoneFor(db, actorUserId, tz);
        const firstLocal = localWallOf(args.startsAt, zone);
        const spec = trimRepeatToRequest(
          args.repeat,
          await recentUserText(db, input.triggeringMessageId),
          firstLocal,
        );
        try {
          repeat = { rrule: buildRrule(spec, firstLocal), tz: zone };
        } catch (err) {
          return {
            summary: `create_event: cannot repeat that way (${(err as Error).message}) — nothing was created`,
            data: {
              created: false,
              reason: 'bad_repeat',
              message: (err as Error).message,
              instruction: REPEAT_INSTRUCTION,
            },
          };
        }
      }
      // Refuse a start that is already past and make the bot ask instead of
      // writing — but only on a conversational turn. Ingest, ICS import and
      // proposal confirm legitimately file history and carry no `turnId`
      // (ADR 0093), as does anything stamped with an externalUid (ADR 0013).
      const invitesSomeone = (args.invitees?.length ?? 0) > 0 || args.videoCall === true;
      if (
        input.turnId &&
        !args.externalUid &&
        (isPastEventStart(args.startsAt, tzOffset) || (invitesSomeone && hasStarted(args.startsAt)))
      ) {
        // `confirmPast` means "the user was asked and said yes", so it is
        // believed only against a refusal they were actually shown and
        // answered — never because a model filled the optional field in (ADR
        // 0319 addendum; ADR 0229's addendum records that it does).
        const pastDay = localDay(args.startsAt, offsetMinutesOf(tzOffset ?? '+00:00'));
        const confirmed =
          !!args.confirmPast &&
          !!pastDay &&
          (await pastDateWasConfirmed(db, groupId, actorUserId, input.turnId, pastDay));
        if (!confirmed) {
          // ADR 0155 — from a file, a past date is history the document states,
          // not a typo. Write nothing and tell the model not to ask; only the
          // future rows should become events. The file stays indexed. Nothing
          // is recorded: this path asks nobody, so no answer can license a
          // later `confirmPast`.
          if (input.triggerFromAttachment) {
            return {
              summary:
                `create_event: "${args.title}" starts ${localWhen(args.startsAt, tz)}, which has already passed — ` +
                'nothing was created. This date is in an uploaded file, so treat it as historical ' +
                'context: do NOT create it and do NOT ask the user about it. Only add the events ' +
                'that are still in the future.',
              data: { created: false, reason: 'past', fromFile: true, startsAt: args.startsAt, when: localWhen(args.startsAt, tz) },
            };
          }
          if (pastDay) await recordPastDateAsk(db, groupId, actorUserId, input.turnId, pastDay);
          return {
            summary:
              `create_event: "${args.title}" starts ${localWhen(args.startsAt, tz)}, which has already passed — ` +
              'nothing was created. Read the date back to the user and ask whether they meant it',
            data: { created: false, reason: 'past', startsAt: args.startsAt, when: localWhen(args.startsAt, tz) },
          };
        }
      }
      // The event a message ago again: a correction ("for tomorrow", "on the
      // Rudderstack calendar") is a change to that event, not a second
      // meeting with a second invitation (prod 2026-11-17). Asked once.
      if (input.turnId && actorUserId && !args.externalUid && !input.replacesEventId) {
        const last = await getLastEvent(db, groupId, actorUserId);
        if (
          last &&
          looksLikeLastEvent(last, { title: args.title, invitees: args.invitees ?? [], turnId: input.turnId }) &&
          (await getEvent(db, last.eventId))
        ) {
          await recordLastEvent(db, groupId, actorUserId, { ...last, askedSameMeeting: true });
          return {
            summary:
              `create_event: "${args.title}" looks like the event just made, "${last.title}" ` +
              `(${localWhen(last.startsAt, tz)}, id ${last.eventId}) — nothing was created and nobody was invited`,
            data: {
              created: false,
              reason: 'same_meeting',
              eventId: last.eventId,
              title: last.title,
              when: localWhen(last.startsAt, tz),
              instruction:
                `If the user is correcting that event (a new day or time, another calendar, a call link, more guests), call update_event with eventId "${last.eventId}" and ONLY the fields that change (\`calendar\` moves it to another calendar). ` +
                'Do NOT claim a new event was made. Only if they clearly want a SECOND, separate meeting, ask them; on their yes call create_event again.',
            },
          };
        }
      }
      let emailTwin: Awaited<ReturnType<typeof findEmailEventTwin>>;
      // ADR 0013: if the caller stamped an externalUid, short-circuit on
      // (group, externalUid) match so re-uploading the same .ics is a no-op.
      if (args.externalUid) {
        const dup = await findEventByExternalUid(db, groupId, args.externalUid);
        if (dup) {
          return {
            summary: `event ${args.title} (deduped on externalUid)`,
            data: { eventId: dup.id, deduped: true },
          };
        }
        // Accepted-invite seam: the invite the user accepted in Google syncs
        // in keyed on the same RFC-5545 UID the emailed .ics carries — an
        // owner-scoped ical_uid match means this event already exists.
        if (actorUserId) {
          const synced = await findOwnedEventByIcalUid(db, actorUserId, args.externalUid);
          if (synced) {
            return {
              summary: `event ${args.title} (already on the calendar via invite)`,
              data: { eventId: synced.id, deduped: true },
            };
          }
          // A keyless event Chord made from the plain-email agreement may
          // already hold the slot. It is asked about once this one is in,
          // never taken over (ADR 0344): that deleted Chord's calendar copy
          // and its guests got a cancellation.
          emailTwin = await findEmailEventTwin(
            db,
            actorUserId,
            args.startsAt,
            args.title,
            await emailThreadPeopleOf(db, actorUserId, provenance),
          );
        }
      }
      // Safety net for keyless twins (LLM-extracted vs manually created):
      // same group + title + start within the hour is the same meeting.
      {
        const similar = await findSimilarEvent(db, groupId, args.title, args.startsAt);
        // ADR 0217 — asked again "as a repeat" for an event already there: the
        // existing one becomes the series, rather than a twin beside it.
        if (similar && repeat && !similar.seriesId) {
          const row = await db.selectFrom('events').selectAll().where('id', '=', similar.id).executeTakeFirst();
          if (row) {
            const series = await convertEventToSeries(db, row, repeat);
            for (const copy of await listEventCopies(db, similar.id)) emit(copy.groupId, SSE.eventUpdated, copy);
            return {
              summary:
                `event ${similar.title} already existed · now repeats ${describeRrule(series.rrule)}, ` +
                `from ${localWhen(similar.startsAt, tz)} (describe the repeat using exactly these words)`,
              data: { eventId: similar.id, converted: true, repeats: describeRrule(series.rrule) },
            };
          }
        }
        if (similar) {
          return {
            summary: `event ${args.title} (already exists at that time)`,
            data: { eventId: similar.id, deduped: true },
          };
        }
      }
      // ADR 0151 — the subject is an account member or a managed persona
      // (a kid on the roster). A persona event lands on the managing adult's
      // calendar, so resolve the calendar against them.
      const evTarget = args.assigneeName
        ? await resolveAssigneeTarget(db, groupId, args.assigneeName)
        : undefined;
      const assigneeId = evTarget?.kind === 'user' ? evTarget.id : undefined;
      const assigneePersonaId = evTarget?.kind === 'persona' ? evTarget.id : undefined;
      // ADR 0040/0232 — pick the target calendar: a name from the prompt
      // ("family", "personal", "work") → the user's own default → primary. A
      // named calendar applies to THIS event only; nothing is remembered for
      // the group.
      const calendarOwner =
        assigneeId ?? (evTarget?.kind === 'persona' ? evTarget.managedBy : actorUserId);
      // ADR 0157 — resolve invitees and send Google invitations. A guest whose
      // name has no email on file does NOT block the create: the event stands,
      // the name comes back in `unresolvedInvitees`, and a "pick from Contacts"
      // card is attached so the user can supply the address. Resolved before
      // the calendar is chosen (ADR 0347): "invite Arthur" is evidence of where
      // the meeting belongs once Arthur is an address.
      const inviteRes = await resolveInvitees(
        db,
        actorUserId,
        args.invitees,
        invitePhoneAsker(emit, groupId, actorUserId, input.sourceBinding ? null : input.turnId),
        await addressChecker(db, actorUserId, input.triggeringMessageId, input.turnId),
      );
      let googleCalendarId: string | null = null;
      // ADR 0182 — the tool result states the REAL destination calendar, so
      // the model reports what actually happened instead of echoing back
      // whatever the user asked for. Prod: told "add to personal", the bot
      // replied "added to your personal calendar" while the event actually
      // landed on the group's Family default — the summary never said which
      // calendar was used at all, so the model had nothing but the user's
      // own words to go on.
      let calendarNote = '';
      if (calendarOwner) {
        // ADR 0312 — an event from email goes on the calendar of the mailbox
        // it came to (or the one picked on the card), never the user's
        // default by accident: a work mailbox's meeting does not belong on
        // the family calendar.
        // An accepted invitation claims no calendar (ADR 0103): the mailbox's
        // own client places it.
        const mailboxPick = args.alreadyInGoogle ? null : await emailCalendarPick(db, {
          calendarOwner,
          actorUserId,
          provenance,
          picked: input.calendarId ?? null,
        });
        if (mailboxPick && !mailboxPick.ok) {
          return {
            summary: `create_event: ${mailboxPick.reason}`,
            data: {
              created: false,
              reason: mailboxPick.reason,
              instruction:
                'Do NOT claim the event was created. The email came to a mailbox with no calendar Chord can write to, so the user must pick a calendar on the card.',
            },
          };
        }
        const requestedName = mailboxPick ? null : args.calendar || null;
        // A chat-made event: the calendar comes from the evidence in order -
        // a name, the user's own words, the mailbox they write to these
        // guests from, the kind of call asked for - and with guests and no
        // answer among several mailboxes, the user is asked.
        const said = input.triggeringMessageId ? ((await recentUserText(db, input.triggeringMessageId)) ?? []) : [];
        const choice = mailboxPick
          ? null
          : await chooseEventCalendar(db, {
              userId: calendarOwner,
              requestedName,
              said,
              invitees: [...new Set([...inviteRes.emails, ...(args.invitees ?? [])])],
              callKind: said.length > 0 ? videoCallKindNamed(said[0]!) : null,
            });
        if (choice?.ask?.length) {
          return {
            summary: `create_event: "${args.title}" has guests and could go on ${choice.ask.length} calendars — nothing was created`,
            data: {
              created: false,
              reason: 'which_calendar',
              candidates: choice.ask.map((c) => c.label),
              instruction:
                'Do NOT claim the event was created or anyone invited. The guests will see which address the invitation comes from, so ask which calendar to send it from, listing these verbatim, then call create_event again with `calendar` set to that exact name.',
            },
          };
        }
        const pick: CalendarPick = mailboxPick
          ? { calendarId: mailboxPick.calendarId, source: 'requested' }
          : choice!;
        // ADR 0137 — a name that fits two calendars is a question. Guessing
        // writes the event somewhere the user did not choose AND caches that
        // guess as the group's default, so every later event inherits it.
        if (pick.candidates?.length) {
          return {
            summary: `create_event: calendar "${requestedName}" matched ${pick.candidates.length} calendars`,
            data: {
              created: false,
              reason: 'ambiguous_calendar',
              candidates: pick.candidates.map((c) => c.summary),
              instruction:
                'Do NOT claim the event was created. Ask which of these calendars they mean, listing them verbatim, then call create_event again with that exact name.',
            },
          };
        }
        googleCalendarId = pick.calendarId;
        const label = await calendarLabel(db, calendarOwner, pick.calendarId);
        // The destination is only true if the event can get there. Prod: a
        // user whose Google grant had expired that morning was told the event
        // was added to her calendar; it was saved in Chord and queued, and
        // she went looking for it in Google.
        // ADR 0228 — judged for the calendar the event is headed to, which may
        // be an Outlook one.
        const { provider, state: connection } = await calendarConnection(db, calendarOwner, pick.calendarId);
        if (connection === 'expired' && provider === 'outlook') {
          calendarNote =
            ' · saved in Chord ONLY: the Outlook connection needs to be renewed, so this is NOT on their Outlook or phone calendar yet (tell the user exactly that, and that it will appear there once they reconnect Outlook in Settings > Connected accounts; do NOT say it was added to their calendar)';
        } else if (connection === 'expired') {
          calendarNote =
            ' · saved in Chord ONLY: the Google Calendar connection has expired, so this is NOT on their Google or phone calendar yet (tell the user exactly that, and that it will appear there once they reconnect Google in Settings > Connected accounts; do NOT say it was added to their calendar)';
        } else if (connection === 'never') {
          calendarNote =
            ' · saved in Chord (no Google Calendar is connected, so it is in Chord only; do NOT say it was added to a Google or phone calendar)';
        } else {
          calendarNote = pick.requestedNotFound
            ? ` · could not find a calendar named "${pick.requestedNotFound}" — used your ${label} calendar instead (tell the user this, do NOT say it went to "${pick.requestedNotFound}")`
            : ` · added to your ${label} calendar (state THIS calendar, not whatever the user said, if you mention which calendar)`;
        }
      }
      let event;
      try {
        event = await createEvent(db, {
          groupId,
          createdBy: actorUserId,
          title: args.title,
          startsAt: args.startsAt,
          endsAt: args.endsAt,
          location: args.location,
          assigneeId,
          assigneePersonaId,
          sourceRawContext: provenance,
          externalUid: args.externalUid,
          alreadyInGoogle: args.alreadyInGoogle,
          guestEmails: (args.invitees ?? []).map((t) => t.trim().toLowerCase()).filter((t) => EMAIL_RE.test(t)),
          allDay: allDayForWrite,
          googleCalendarId,
          repeat,
          omitCreatorCopy: input.additionalGroupShare,
        });
      } catch (err) {
        if (err instanceof TrustError && actorUserId) {
          const pr = await requestPermission(db, {
            recipientUserId: err.recipientUserId,
            senderUserId: actorUserId,
            groupId,
            scopes: ['event'],
            reason: `event: ${args.title} @ ${args.startsAt}`,
          });
          return {
            summary: `permission requested: ${args.title} (request ${pr.id})`,
            card: {
              kind: 'event',
              title: args.title,
              subtitle: 'permission requested',
              meta: `awaiting ${args.assigneeName ?? 'recipient'}'s approval`,
            },
            data: { permissionRequestId: pr.id },
          };
        }
        throw err;
      }
      if (emailTwin && actorUserId && event.id !== emailTwin.id) {
        await askAboutEmailTwin(db, {
          userId: actorUserId,
          twin: emailTwin,
          incoming: { title: args.title, startsAt: args.startsAt },
          how: args.alreadyInGoogle ? 'accepted' : 'arrived',
        });
      }
      const { emails: inviteEmails, unresolved: unresolvedInvitees, unverified: unverifiedInvitees } = inviteRes;
      // ADR 0166 — structural reminder so a later plain-text answer ("Karl's
      // email is x@y.com") still resolves this event even when the model
      // doesn't recall its own earlier "still need an email" sentence.
      if (actorUserId && args.invitees?.length) {
        await recordPendingInvitees(db, groupId, actorUserId, event.id, args.title, unresolvedInvitees);
      }
      if (actorUserId && input.turnId) {
        await recordLastEvent(db, groupId, actorUserId, {
          eventId: event.id,
          title: event.title,
          startsAt: event.startsAt,
          invitees: inviteEmails.map((e) => e.toLowerCase()),
          turnId: input.turnId,
        });
      }
      // ADR 0328 — a group event invites the family from the organizer's
      // event. Waited for first: it and a named guest both rewrite the
      // event's guest list, and the second must start from the first.
      const family = db.isTransaction ? null : await waitForFamilyInvites(event.id);
      const familyNote = familyInviteNote(family);
      // A meeting that is already on the calendar (someone else's, at these
      // times, with these people) is not ours to invite anyone to: the
      // organizer sent the invitations. Asking the calendar would only be
      // refused, and before ADR 0223's addendum it was a new event that
      // invited the organizer to their own meeting.
      const guests =
        event.merged === 'covered'
          ? { note: '', invited: [] as string[], data: {} }
          : await applyGuestChange(db, event.id, actorUserId, inviteEmails, []);
      const invited = guests.invited;
      const meetNote =
        actorUserId && (args.videoCall || (await videoCallAskedInTrigger(db, input.triggeringMessageId)))
          ? await videoCallNoteFor(db, input.triggeringMessageId, event.id, actorUserId)
          : '';
      // ADR 0163 — best-effort, fire-and-forget: mine prior correspondence
      // with the invitee(s) for a short "what this is about", once. Never
      // awaited (the context isn't needed until the next briefing, not this
      // reply) and never allowed to fail the create.
      if (invited.length > 0 && actorUserId) {
        storeMeetingContextSoon(db, input, actorUserId, event.id, invited);
      }
      // The same event was already on the calendar, so nothing new was made:
      // no "created" broadcast, and no conflict nudge about an event
      // overlapping itself.
      if (event.merged) {
        if (event.merged === 'updated') {
          for (const copy of await listEventCopies(db, event.id)) {
            emit(copy.groupId, SSE.eventUpdated, copy);
          }
        }
        const what =
          event.merged === 'updated'
            ? 'already on the calendar at that time · added the new details to it'
            : 'already on the calendar at that time · nothing to add';
        return {
          summary: `event ${event.title} (${what}; say it was already there, do NOT say a new event was created)${guests.note}${meetNote}`,
          data: {
            eventId: event.id,
            deduped: true,
            merged: event.merged,
            existingTitle: event.title,
            ...guests.data,
            ...(unresolvedInvitees.length > 0 ? { unresolvedInvitees } : {}),
          },
        };
      }
      // Per-owner SSE: emit one eventCreated per fanned-out copy so each
      // member's client receives its own owner-tagged copy.
      for (const copy of await listEventCopies(db, event.id)) {
        emit(copy.groupId, SSE.eventCreated, copy);
      }
      if (actorUserId) {
        // Best-effort: pull any other gcal-side changes that happened
        // since the last sync, so the user's just-created event lands
        // in a consistent view. Throttled (5 min) + fire-and-forget so
        // we don't slow the tool response.
        syncCalendarSoon(db, input, actorUserId);
        const rsvp = await autoRsvpCreator(db, event.id, actorUserId);
        if (rsvp) emit(groupId, SSE.rsvpUpdated, rsvp);
        if (!suppressEventNudges) {
          // ADR 0012: fire a proactive ancillary-needs nudge into the
          // creator's personal chat. Best-effort; never block the tool result.
          enqueueEventNudge(db, {
            actorUserId,
            sourceGroupId: groupId,
            payload: { kind: 'event', event },
          }).catch((err) => logger.warn('enqueueEventNudge failed', { err }));
        }
      }
      // ADR 0232 — a personal event that names someone from a shared group is
      // OFFERED to that group, never shared on its own. The offer is remembered
      // server-side (pending-fanout) so the user's plain "yes" next turn still
      // knows which event is meant.
      let fanoutSuggestion: { groups: string[]; instruction: string } | undefined;
      if (
        actorUserId &&
        input.turnId &&
        !args.externalUid &&
        !repeat &&
        !assigneeId &&
        !assigneePersonaId &&
        (await isPersonalTurn(db, groupId))
      ) {
        const hits = await suggestFanoutGroups(db, actorUserId, args.title);
        const names = [...new Set(hits.map((h) => h.name))].slice(0, MAX_GROUP_CANDIDATES);
        if (names.length > 0) {
          await recordPendingFanout(db, groupId, actorUserId, {
            kind: 'event',
            entityId: event.id,
            title: args.title,
            groups: names,
          });
          fanoutSuggestion = {
            groups: names,
            instruction:
              'This event is on the asker\'s OWN calendar only. In your reply, ask ONCE, in one short sentence, whether they want it on ' +
              (names.length === 1
                ? `the "${names[0]}" group`
                : `one of these groups (${names.map((n) => `"${n}"`).join(', ')}) — ask which`) +
              ' too, so everyone in it gets it. Do NOT share it unless they say yes, and never say it was shared before then. If they say yes, call share_event.',
          };
        }
      }
      // ADR 0217 — say what was stored, so "weekly" is never claimed for a
      // one-off. A repeat that starts later than asked (the start date did not
      // fit the rule) says so through the day it names.
      const repeatNote = repeat
        ? ` · repeats ${describeRrule(repeat.rrule)}, first on ${localWhen(event.startsAt, tz)} (describe the repeat using exactly these words)`
        : repeatUnasked
          ? // Nobody asked about repeating, so the reply should not bring it up.
            ' · one-off, does not repeat (nothing in the request asked for a repeat, so none was set — do not mention repeating at all)'
          : ' · one-off, does not repeat';
      return {
        summary:
          `event ${args.title} · ${localWhen(event.startsAt, tz)}` +
          ' (if you say when, use THIS day and date)' +
          repeatNote +
          calendarNote +
          familyNote +
          guests.note +
          meetNote +
          phoneInviteeNote(inviteRes) +
          (unresolvedInvitees.length
            ? ` · still need an email for ${unresolvedInvitees.join(', ')} (event created; do NOT` +
              ` say they were invited — ask for the address or point at the "Add from Contacts" card)`
            : '') +
          unverifiedInviteeNote(unverifiedInvitees),
        card: {
          kind: 'event',
          title: args.title,
          subtitle: args.location ?? undefined,
          meta:
            formatDueAt(event.startsAt, tzOffset) +
            (repeat ? ` · repeats ${describeRrule(repeat.rrule)}` : ''),
        },
        cards: unresolvedInvitees.length ? contactPickCards(unresolvedInvitees) : undefined,
        data:
          inviteEmails.length || unresolvedInvitees.length || unverifiedInvitees.length || fanoutSuggestion
            ? {
                ...(inviteEmails.length || unresolvedInvitees.length || unverifiedInvitees.length
                  ? {
                      eventId: event.id,
                      invited,
                      unresolvedInvitees,
                      ...(unverifiedInvitees.length ? { unverifiedInvitees } : {}),
                      ...guests.data,
                    }
                  : {}),
                ...(fanoutSuggestion ? { fanoutSuggestion } : {}),
              }
            : undefined,
      };
    }

    // ADR 0232 — "yes" to the offer above. Re-creates the personal event in the
    // chosen group (where it fans out to every member) and removes the personal
    // original, so the asker is not left with two. Created BEFORE the original
    // is deleted: a failure in the middle leaves the event, not nothing.
    case 'share_event': {
      if (!actorUserId) return { summary: 'share_event: no actor', data: { ok: false, reason: 'no_actor' } };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'share_event: personal chat only', data: { ok: false, reason: 'personal_only' } };
      }
      const args = call.args as { withGroupName?: string };
      const pendingOffer = await getPendingFanout(db, groupId, actorUserId);
      const offer = pendingOffer?.kind === 'event' ? pendingOffer : null;
      if (!offer) {
        return {
          summary: 'share_event: no event is waiting to be shared',
          data: {
            ok: false,
            reason: 'nothing_pending',
            instruction:
              'Nothing was shared. Do NOT claim it was. Ask which event they mean; a new event for a group is made in that group\'s chat.',
          },
        };
      }
      const wanted = args.withGroupName ?? (offer.groups.length === 1 ? offer.groups[0] : undefined);
      if (!wanted) {
        return {
          summary: 'share_event: which group?',
          data: {
            ok: false,
            reason: 'which_group',
            candidates: offer.groups,
            instruction: 'Ask which of these groups, listing the names verbatim, then call share_event again with that exact name.',
          },
        };
      }
      const target = await resolveGroupByName(db, actorUserId, wanted);
      if (!target.ok) {
        return {
          summary: `share_event: group "${wanted}" did not resolve`,
          data: { ok: false, reason: target.reason, candidates: target.candidates },
        };
      }
      const original = await getEvent(db, offer.entityId);
      // Everything the re-create must carry over is read from the row itself:
      // the DTO leaves out the calendar, zone, all-day flag, free/busy, the
      // assignee and the provenance.
      const originalRow = original
        ? await db
            .selectFrom('events')
            .select([
              'ical_uid',
              'series_id',
              'google_calendar_id',
              'description',
              'start_tz',
              'end_tz',
              'all_day',
              'transparency',
              'assignee_id',
              'assignee_persona_id',
              'source_raw_context',
            ])
            .where('id', '=', offer.entityId)
            .executeTakeFirst()
        : undefined;
      if (!original || original.groupId !== groupId || original.ownerUserId !== actorUserId) {
        await clearPendingFanout(db, groupId, actorUserId);
        return {
          summary: 'share_event: that event is gone',
          data: { ok: false, reason: 'event_gone', instruction: 'Nothing was shared. Say the event is no longer there.' },
        };
      }
      // ADR 0328 — move the event itself into the group and invite the
      // members: nothing is re-created, so its calendar, guests and video
      // call stay exactly as they are. Repeats and events for someone else
      // still take the re-create below.
      if (
        env.FAMILY_EVENT_INVITES &&
        originalRow &&
        !originalRow.series_id &&
        !originalRow.assignee_persona_id &&
        (!originalRow.assignee_id || originalRow.assignee_id === actorUserId)
      ) {
        const moved = await moveEventIntoGroup(db, {
          eventId: original.id,
          targetGroupId: target.groupId,
          actorUserId,
        });
        if (moved.ok) {
          await clearPendingFanout(db, groupId, actorUserId);
          emit(groupId, SSE.eventDeleted, { id: original.id, ownerUserId: actorUserId });
          for (const copy of await listEventCopies(db, original.id)) {
            emit(copy.groupId, SSE.eventCreated, copy);
          }
          const family = db.isTransaction ? null : await waitForFamilyInvites(original.id);
          return {
            summary: `share_event: "${original.title}" is now on the ${target.groupName} group${familyInviteNote(family)}`,
            data: { ok: true, group: target.groupName, moved: true },
            card: { kind: 'event', title: original.title, meta: `shared with ${target.groupName}` },
          };
        }
      }
      // Guests and repeats do not survive a re-create. They are rare on an event
      // made seconds ago; refusing is safer than quietly dropping them.
      // Guests live on the calendar (ADR 0295); one we cannot read counts as
      // none, as an event made moments ago almost always has none.
      // One read of the provider copy answers both questions: guests, and
      // whether a video call is on it.
      const onProvider = originalRow ? await providerEventPeople(db, offer.entityId) : undefined;
      const guests = (onProvider?.guests ?? []).length > 0;
      if (originalRow?.series_id || guests) {
        return {
          summary: 'share_event: this event repeats or has guests, so it cannot be moved',
          data: {
            ok: false,
            reason: originalRow?.series_id ? 'repeating' : 'has_guests',
            instruction:
              'Nothing was shared. Tell the user plainly that this one repeats or has invited guests, so it stays on their own calendar; they can ask for a new event on the group instead.',
          },
        };
      }
      // A share moves the event; it must not quietly change it. The calendar
      // is the one the user put it on, while they can still write to it.
      const originalCal = originalRow?.google_calendar_id ?? null;
      const keepCal = !!originalCal && (await isWritableCalendar(db, actorUserId, originalCal));
      const calendarId = keepCal ? originalCal! : (await resolveTargetCalendarId(db, { userId: actorUserId })).calendarId;
      const calendarMoved = !!originalCal && calendarId !== originalCal;
      const persona = originalRow?.assignee_persona_id
        ? await personaInGroup(db, originalRow.assignee_persona_id, target.groupId)
        : null;
      // A member assignee in the 1:1 is the asker ("just for me"): saying yes
      // to the share is them changing their mind, so the group copy fans out.
      // Anyone else stays the assignee if they are in the group.
      const assigneeId =
        originalRow?.assignee_id &&
        originalRow.assignee_id !== actorUserId &&
        (await isMember(db, target.groupId, originalRow.assignee_id))
          ? originalRow.assignee_id
          : null;
      const shared = await createEvent(db, {
        groupId: target.groupId,
        createdBy: actorUserId,
        title: original.title,
        startsAt: original.startsAt,
        endsAt: original.endsAt,
        location: original.location,
        // Passed even when null: undefined would make ADR 0162 build a new
        // excerpt from the provenance instead of keeping the one the event has.
        description: originalRow?.description ?? null,
        sourceRawContext: originalRow?.source_raw_context ?? null,
        allDay: originalRow ? originalRow.all_day === 1 : undefined,
        transparency: originalRow?.transparency,
        startTz: originalRow?.start_tz ?? null,
        endTz: originalRow?.end_tz ?? null,
        assigneeId,
        assigneePersonaId: persona,
        googleCalendarId: calendarId,
        mergeOnlyInGroup: true,
      });
      for (const copy of await listEventCopies(db, shared.id)) {
        emit(copy.groupId, SSE.eventCreated, copy);
      }
      let removedOriginal = true;
      try {
        for (const r of await deleteEvent(db, original.id)) {
          emit(original.groupId, SSE.eventDeleted, { id: r.id, ownerUserId: r.ownerUserId ?? undefined });
        }
      } catch (err) {
        removedOriginal = false;
        logger.warn('share_event: shared copy made but the personal original was not removed', {
          err: String(err),
          eventId: original.id,
        });
      }
      await clearPendingFanout(db, groupId, actorUserId);
      // A video call cannot be carried across: the link belongs to the
      // calendar event that was just deleted. A new one is asked for on the
      // shared copy, and the reply says the old link no longer works.
      let videoNote = '';
      if (onProvider?.videoCallLink) {
        const added = await addVideoCall(db, { eventId: shared.id, actorUserId });
        videoNote =
          videoCallNote(added) +
          ` · the old video link (${onProvider.videoCallLink}) no longer works: tell the user it changed`;
      }
      const calendarNote = calendarMoved
        ? ` · their original calendar can no longer be written to, so it went on their ${await calendarLabel(db, actorUserId, calendarId)} calendar instead (say so)`
        : '';
      const personaNote =
        originalRow?.assignee_persona_id && !persona
          ? ` · ${target.groupName} has no family member matching the one this event was for, so it is not linked to them there (its title still names them)`
          : '';
      return {
        summary: `share_event: "${original.title}" is now on the ${target.groupName} group${calendarNote}${personaNote}${videoNote}`,
        data: {
          ok: true,
          group: target.groupName,
          ...(removedOriginal
            ? {}
            : { warning: 'The personal copy could not be removed, so it may appear twice on the asker\'s own calendar.' }),
        },
        card: {
          kind: 'event',
          title: original.title,
          meta: `shared with ${target.groupName}`,
        },
      };
    }

    // ADR 0233 - "yes" to a trip offer. Moves the personal trip into the chosen
    // group; the legs, stays and reservations follow by trip id.
    case 'share_trip': {
      if (!actorUserId) return { summary: 'share_trip: no actor', data: { ok: false, reason: 'no_actor' } };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'share_trip: personal chat only', data: { ok: false, reason: 'personal_only' } };
      }
      const args = call.args as { withGroupName?: string };
      const pendingOffer = await getPendingFanout(db, groupId, actorUserId);
      const offer = pendingOffer?.kind === 'trip' ? pendingOffer : null;
      if (!offer) {
        return {
          summary: 'share_trip: no trip is waiting to be shared',
          data: {
            ok: false,
            reason: 'nothing_pending',
            instruction:
              'Nothing was shared. Do NOT claim it was. Ask which trip they mean.',
          },
        };
      }
      const wanted = args.withGroupName ?? (offer.groups.length === 1 ? offer.groups[0] : undefined);
      if (!wanted) {
        return {
          summary: 'share_trip: which group?',
          data: {
            ok: false,
            reason: 'which_group',
            candidates: offer.groups,
            instruction: 'Ask which of these groups, listing the names verbatim, then call share_trip again with that exact name.',
          },
        };
      }
      const target = await resolveGroupByName(db, actorUserId, wanted);
      if (!target.ok) {
        return {
          summary: `share_trip: group "${wanted}" did not resolve`,
          data: { ok: false, reason: target.reason, candidates: target.candidates },
        };
      }
      const shared = await shareTripWithGroup(db, {
        tripId: offer.entityId,
        actorUserId,
        targetGroupId: target.groupId,
      });
      if (!shared.ok) {
        await clearPendingFanout(db, groupId, actorUserId);
        return {
          summary: `share_trip: could not share (${shared.reason})`,
          data: {
            ok: false,
            reason: shared.reason,
            instruction: 'Nothing was shared. Say so plainly; do not claim the trip is now visible to the group.',
          },
        };
      }
      emit(shared.previousGroupId, SSE.tripDeleted, { id: shared.trip.id });
      emit(target.groupId, SSE.tripUpdated, shared.trip);
      await clearPendingFanout(db, groupId, actorUserId);
      return {
        summary: `share_trip: "${shared.trip.name}" is now on the ${target.groupName} group`,
        data: { ok: true, group: target.groupName },
        card: {
          kind: 'trip',
          title: shared.trip.name,
          subtitle: shared.trip.destination,
          meta: `shared with ${target.groupName}`,
        },
      };
    }

    // ADR 0234 - a line of text from the user into one of their groups.
    case 'message_group': {
      if (!actorUserId) return { summary: 'message_group: no actor', data: { ok: false, reason: 'no_actor' } };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'message_group: personal chat only', data: { ok: false, reason: 'personal_only' } };
      }
      const args = call.args as { groupName?: string; body: string; groupId?: string; forUserId?: string };
      const target = postTargetFromCard(args, actorUserId, 'message_group');
      if (!target.ok) return target.result;
      const posted = await postToGroup(db, actorUserId, target.groupId, args.body);
      if (!posted.ok) {
        return { summary: `message_group: ${posted.reason}`, data: { ok: false, reason: posted.reason } };
      }
      emit(target.groupId, SSE.message, posted.message);
      return {
        summary: `message_group: posted to ${target.groupName}`,
        data: { ok: true, group: target.groupName },
      };
    }

    // ADR 0234 - an email thread shared into a group as text.
    case 'share_email_with_group': {
      if (!actorUserId) {
        return { summary: 'share_email_with_group: no actor', data: { ok: false, reason: 'no_actor' } };
      }
      if (!(await isPersonalTurn(db, groupId))) {
        return {
          summary: 'share_email_with_group: personal chat only',
          data: { ok: false, reason: 'personal_only' },
        };
      }
      const args = call.args as {
        threadId: string;
        groupName?: string;
        note?: string;
        groupId?: string;
        forUserId?: string;
        messageDate?: string;
      };
      const target = postTargetFromCard(args, actorUserId, 'share_email_with_group');
      if (!target.ok) return target.result;
      const shared = await shareEmailThreadToGroup(db, actorUserId, target.groupId, args.threadId, {
        note: args.note,
        tz,
        messageDate: args.messageDate,
      });
      if (!shared.ok) {
        return {
          summary: `share_email_with_group: ${shared.reason}`,
          data: { ok: false, reason: shared.reason },
        };
      }
      emit(target.groupId, SSE.message, shared.message);
      return {
        summary: `share_email_with_group: shared with ${target.groupName}`,
        data: { ok: true, group: target.groupName },
      };
    }

    // ADR 0328 — the asker answers an invitation to a family member's group
    // event. Same service as the event sheet's Yes / Maybe / No.
    case 'answer_invitation': {
      if (!actorUserId) return { summary: 'answer_invitation: no actor', data: { answered: false, reason: 'no_actor' } };
      const args = call.args as { eventId?: string; eventTitle?: string; response: 'yes' | 'maybe' | 'no' };
      const waiting = await waitingInvitations(db, actorUserId);
      const wanted = args.eventTitle?.trim().toLowerCase();
      const hits = args.eventId
        ? waiting.filter((w) => w.id === args.eventId)
        : wanted
          ? waiting.filter((w) => w.title.toLowerCase().includes(wanted))
          : waiting.length === 1
            ? waiting
            : [];
      if (hits.length !== 1) {
        return {
          summary:
            hits.length === 0
              ? 'answer_invitation: no invitation of yours matches'
              : `answer_invitation: ${hits.length} invitations match`,
          data: {
            answered: false,
            reason: hits.length === 0 ? 'not_found' : 'ambiguous',
            candidates: (hits.length === 0 ? waiting : hits).map((w) => ({
              eventId: w.id,
              title: w.title,
              when: localWhen(w.startsAt, tz),
            })),
            instruction:
              'Nothing was answered. Ask which invitation they mean, listing the candidates by title and time, then call again with its eventId.',
          },
        };
      }
      const hit = hits[0]!;
      const response = ({ yes: 'accepted', maybe: 'tentative', no: 'declined' } as const)[args.response];
      const r = await answerFamilyInvite(db, { eventId: hit.id, userId: actorUserId, response });
      if (!r.ok) {
        const why = {
          not_found: 'that invitation is no longer there',
          not_invited: 'that event is not an invitation to them',
          no_route:
            'neither their calendar nor a connected mailbox can carry the answer (connect the calendar or mailbox they were invited at in Settings)',
          send_failed: 'the calendar or mail refused the answer',
        }[r.reason];
        return {
          summary: `answer_invitation: NOT answered — ${why} (say exactly that; do NOT say it was answered)`,
          data: { answered: false, reason: r.reason },
        };
      }
      if (r.removed) emit(hit.groupId, SSE.eventDeleted, { id: hit.id, ownerUserId: actorUserId });
      const word = { accepted: 'yes', tentative: 'maybe', declined: 'no' }[response];
      return {
        summary:
          `answer_invitation: answered "${word}" to "${hit.title}" (${localWhen(hit.startsAt, tz)}) — ` +
          (r.via === 'calendar' ? 'through their calendar' : 'by a reply email to the organizer') +
          (r.removed ? '; it is off their calendar in Chord now' : ''),
        data: { answered: true, response: word, via: r.via, removed: r.removed },
        card: { kind: 'event', title: hit.title, meta: `you said ${word}` },
      };
    }

    case 'record_rsvp': {
      const args = call.args as {
        eventId?: string;
        displayName: string;
        status: 'yes' | 'no' | 'maybe' | 'pending';
        solo?: boolean;
        dish?: string;
        notes?: string;
      };
      let eventId = args.eventId;
      if (!eventId) {
        // The event coming up (else the one just past) - an RSVP with no
        // event named is about that one. "Latest by start" picked the
        // furthest-future row instead: next year's birthday, the tail of a
        // synced recurring series.
        eventId = (await findNearestEvent(db, groupId, new Date().toISOString(), tz))?.id;
      }
      if (!eventId) return { summary: 'record_rsvp: no event found' };
      if (!(await resolveEventInGroup(db, groupId, eventId))) {
        return { summary: 'record_rsvp: event not in this group' };
      }
      // Attendees are scoped to the event's group, resolved by id — never a
      // free-text name. A name that isn't a current member of this group is
      // refused, so the bot can't record (or be asked about) participants
      // beyond the group (ADR 0004 / 0032).
      const member = await resolveGroupMember(db, groupId, args.displayName);
      if (!member) {
        return {
          summary: `record_rsvp: "${args.displayName}" isn't a member of this group — not recorded`,
        };
      }
      const rsvp = await upsertRsvp(db, {
        eventId,
        userId: member.id,
        displayName: member.displayName,
        status: args.status,
        solo: args.solo,
        dish: args.dish,
        notes: args.notes,
      });
      emit(groupId, SSE.rsvpUpdated, rsvp);
      return {
        summary: `rsvp ${member.displayName} → ${args.status}`,
        card: {
          kind: 'event',
          title: `${member.displayName}: ${args.status}`,
          subtitle: args.dish ?? undefined,
          meta: 'RSVP recorded',
        },
      };
    }

    case 'create_trip': {
      const args = call.args as {
        name: string;
        destination: string;
        startDate: string;
        endDate: string;
        participantNames?: string[];
      };
      const resolvedParticipantIds = await mapConcurrent(
        args.participantNames ?? [],
        5,
        (n) => resolveAssignee(db, groupId, n),
      );
      const participantIds = resolvedParticipantIds.filter((id): id is string => !!id);
      const trip = await createTrip(db, {
        groupId,
        createdBy: actorUserId,
        name: args.name,
        destination: args.destination,
        startDate: args.startDate,
        endDate: args.endDate,
        participantIds,
        sourceRawContext: provenance,
      });
      emit(groupId, SSE.tripUpdated, trip);
      if (actorUserId) {
        // ADR 0012: post-create nudge for trips lands in the creator's
        // personal chat (childcare, hotel, packing, etc.).
        enqueueEventNudge(db, {
          actorUserId,
          sourceGroupId: groupId,
          payload: { kind: 'trip', trip },
        }).catch((err) => logger.warn('enqueueEventNudge failed', { err }));
      }
      const tripOffer = await tripShareOffer(db, { groupId, actorUserId, turnId: input.turnId, tripId: trip.id, tripName: trip.name });
      return {
        summary: `trip ${trip.id} "${trip.name}"`,
        // Carried through by proposals.service so a trip-bundle commit can
        // stamp the newly-created id into child proposals (legs / stays /
        // reservations) instead of rediscovering it by name/destination.
        data: { tripId: trip.id, trip, ...(tripOffer ? { shareSuggestion: tripOffer } : {}) },
        card: {
          kind: 'trip',
          title: trip.name,
          subtitle: trip.destination,
          meta: `${trip.startDate} → ${trip.endDate}`,
        },
      };
    }

    case 'set_event_trip': {
      const args = call.args as {
        eventId?: string;
        titleContains?: string;
        date?: string;
        tripId?: string;
        tripQuery?: string;
        notTravel?: boolean;
      };
      if (!actorUserId) return { summary: 'set_event_trip: no user', data: { updated: false } };
      // The user's own calendar copy: by id, else by title (+ date).
      let event: GroupEvent | null = null;
      if (args.eventId) {
        const found = await getEvent(db, args.eventId);
        if (found && found.ownerUserId === actorUserId) event = found;
      }
      if (!event && args.titleContains) {
        const matches = collapseSeriesMatches(
          await findEventsByTitle(db, { ownerUserId: actorUserId }, args.titleContains, args.date, tz),
        );
        if (matches.length > 1) {
          return {
            summary: `set_event_trip: ${matches.length} entries match "${args.titleContains}" — ask the user which one`,
            data: {
              updated: false,
              instruction: LOCAL_WHEN_INSTRUCTION,
              candidates: matches.map((e) => ({ id: e.id, title: e.title, when: localWhen(e.startsAt, tz) })),
            },
          };
        }
        event = matches[0] ?? null;
      }
      if (!event) return { summary: 'set_event_trip: no matching calendar entry', data: { updated: false } };

      let tripId: string | null = null;
      if (!args.notTravel) {
        if (!args.tripId && !args.tripQuery) {
          return {
            summary: 'set_event_trip: say which trip (tripId/tripQuery), or notTravel: true',
            data: { updated: false },
          };
        }
        // ADR 0096/0032 — from the personal chat, any trip in the user's
        // groups; in a shared chat, that chat's trips only.
        const personal = await isPersonalTurn(db, groupId);
        const trips = await db
          .selectFrom('trips')
          .innerJoin('group_members', 'group_members.group_id', 'trips.group_id')
          .innerJoin('groups', 'groups.id', 'trips.group_id')
          .where('group_members.user_id', '=', actorUserId)
          .where('trips.deleted_at', 'is', null)
          .where('trips.cancelled_at', 'is', null)
          .$if(!personal, (qb) => qb.where('trips.group_id', '=', groupId))
          .select([
            'trips.id',
            'trips.name',
            'trips.destination',
            'trips.start_date',
            'trips.end_date',
            'groups.name as group_name',
          ])
          .execute();
        const q = args.tripQuery?.toLowerCase();
        const candidates = args.tripId
          ? trips.filter((t) => t.id === args.tripId)
          : trips.filter(
              (t) => t.name.toLowerCase().includes(q!) || (t.destination ?? '').toLowerCase().includes(q!),
            );
        if (candidates.length === 0) {
          return { summary: 'set_event_trip: no trip found', data: { updated: false, reason: 'trip_not_found' } };
        }
        if (candidates.length > 1) {
          return {
            summary: `set_event_trip: ${candidates.length} trips match — ask the user which one`,
            data: {
              updated: false,
              candidates: candidates.map((t) => ({
                id: t.id,
                name: t.name,
                destination: t.destination,
                startDate: t.start_date,
                endDate: t.end_date,
                group: t.group_name,
              })),
            },
          };
        }
        tripId = candidates[0]!.id;
      }
      const result = await setEventTrip(db, { eventId: event.id, userId: actorUserId, tripId });
      if (!result.ok) {
        return { summary: `set_event_trip: ${result.reason}`, data: { updated: false, reason: result.reason } };
      }
      const tripName = tripId
        ? (await db.selectFrom('trips').select('name').where('id', '=', tripId).executeTakeFirst())?.name ?? null
        : null;
      return {
        summary: tripName
          ? `set_event_trip: "${event.title}" (${localWhen(event.startsAt, tz)}) is now part of the trip "${tripName}"`
          : `set_event_trip: "${event.title}" (${localWhen(event.startsAt, tz)}) is now the user's own time, not travel`,
        data: { updated: true, eventId: event.id, tripId, tripName },
      };
    }

    case 'update_trip': {
      const args = call.args as {
        tripId?: string;
        tripQuery?: string;
        name?: string;
        destination?: string;
        startDate?: string;
        endDate?: string;
      };
      const resolution = await resolveTripId(db, userId, groupId, args);
      if (!resolution.ok) {
        if (resolution.reason === 'not_found') {
          return { summary: 'update_trip: no trip found', data: { updated: false } };
        }
        return {
          summary: `update_trip: ${resolution.candidates.length} trips match — need disambiguation`,
          data: { updated: false, candidates: resolution.candidates },
        };
      }
      const tripId = resolution.tripId;
      if (!args.name && !args.destination && !args.startDate && !args.endDate) {
        return { summary: 'update_trip: no fields to change', data: { updated: false } };
      }
      let trip: Trip | null;
      try {
        trip = await updateTrip(db, tripId, {
          name: args.name,
          destination: args.destination,
          startDate: args.startDate,
          endDate: args.endDate,
        });
      } catch (err) {
        return {
          summary: `update_trip: ${(err as Error).message}`,
          data: { updated: false },
        };
      }
      if (!trip) return { summary: 'update_trip: trip not found', data: { updated: false } };
      emit(groupId, SSE.tripUpdated, trip);
      return {
        summary: `update_trip: "${trip.name}" now ${trip.startDate} → ${trip.endDate}`,
        data: { updated: true, tripId: trip.id, trip },
        card: {
          kind: 'trip',
          title: trip.name,
          subtitle: trip.destination,
          meta: `${trip.startDate} → ${trip.endDate}`,
        },
      };
    }

    case 'add_travel_leg': {
      const args = call.args as {
        tripId?: string;
        personaName?: string;
        mode?: 'flight' | 'train' | 'car' | 'ferry' | 'other';
        origin: string;
        destination: string;
        departAt: string;
        arriveAt: string;
        carrier?: string;
        flightNo?: string;
        confirmation?: string;
        notes?: string;
        departZone?: string;
        arriveZone?: string;
      };
      // A ticket's times are on the clocks of two different places. The
      // model stamps the asker's offset on every datetime (the system prompt
      // tells it to), so each end is re-anchored to its own airport here.
      const readerOffsetMinutes = offsetMinutesOf(tzOffset ?? '+00:00');
      args.departAt = legDatetime(args.departAt, args.origin, args.departZone, readerOffsetMinutes, tz);
      args.arriveAt = legDatetime(args.arriveAt, args.destination, args.arriveZone, readerOffsetMinutes, tz);
      let tripId = args.tripId;
      if (tripId) {
        const access = await checkTripAccess(db, userId, groupId, tripId);
        if (access === 'forbidden') return { summary: 'add_travel_leg: trip not accessible' };
        if (access === 'missing') tripId = undefined;
      }
      // ADR 0190 — a leg's trip is decided by WHO is on it, never by which
      // dates happen to overlap, EXCEPT for a trip that has nobody's legs on
      // it yet — nothing to misattribute there, so `findTripForTraveler`
      // itself still checks by date+group in that one safe case (e.g. "create
      // a trip to Austin" then a bare "flying ORD→AUS" with no name needed).
      const personaId = args.personaName ? await resolveAssignee(db, groupId, args.personaName) : undefined;
      if (!tripId) {
        const matched = await findTripForTraveler(db, {
          userId,
          personaId: personaId ?? null,
          passengerName: personaId ? null : args.personaName,
          legs: [{ origin: args.origin, destination: args.destination, departAt: args.departAt, arriveAt: args.arriveAt }],
          confirmation: args.confirmation,
          preferGroupId: groupId,
        });
        if (matched) tripId = matched.id;
      }
      // Nothing matched and no traveler was named — the remaining option is
      // guessing among trips that already have OTHER people's legs on them
      // (or creating an unlabeled one), which is exactly the failure mode
      // this replaces. Refuse and ask, the same posture ADR 0100 uses for a
      // past date and ADR 0102 for a failed tool. An explicit tripId is a
      // deliberate override and skips this — the user already said where
      // this goes.
      if (!tripId && !args.personaName) {
        return {
          summary: 'add_travel_leg: need to know who is traveling before this can be added to the right trip',
          data: { created: false, reason: 'needs_passenger' },
        };
      }
      if (!tripId) {
        const created = await createTrip(db, {
          groupId,
          createdBy: actorUserId,
          name: `Trip to ${args.destination}`,
          destination: args.destination,
          startDate: args.departAt.slice(0, 10),
          endDate: args.arriveAt.slice(0, 10),
          participantIds: [],
          sourceRawContext: provenance,
        });
        emit(groupId, SSE.tripUpdated, created);
        tripId = created.id;
      }
      const leg = await addTravelLeg(db, {
        tripId,
        personaId,
        // Store the raw name when we can't resolve to a group member so the
        // passenger is always attributed to the person in the document, not
        // the uploader.
        passengerName: !personaId ? args.personaName : undefined,
        mode: args.mode ?? 'flight',
        origin: args.origin,
        destination: args.destination,
        departAt: args.departAt,
        arriveAt: args.arriveAt,
        carrier: args.carrier,
        flightNo: args.flightNo,
        confirmation: args.confirmation,
        notes: args.notes,
        sourceRawContext: provenance,
      });
      emit(groupId, SSE.travelLegCreated, leg);
      // Broadcast the updated trip so the UI picks up any date-range extension
      // that addTravelLeg applied (e.g. return leg pushed end_date out).
      const updatedTrip = await getTrip(db, tripId);
      if (updatedTrip) emit(groupId, SSE.tripUpdated, updatedTrip);
      const tag = [args.carrier, args.flightNo].filter(Boolean).join(' ');
      // ADR 0190 — a nudge, not a requirement: surface an uncovered night on
      // this trip right when a leg makes one visible, instead of only on an
      // explicit trip_status call. Dismissed by adding ANY accommodation for
      // that span (even a placeholder like "own place") — computeGaps only
      // checks date coverage, never content.
      const status = await getTripStatus(db, tripId);
      const gapNote = status && status.gaps.length > 0
        ? ` — no stay on file for ${status.gaps.map((g) => `${g.start}–${g.end}`).join(', ')}; let me know if that's handled`
        : '';
      const legTripOffer = updatedTrip
        ? await tripShareOffer(db, { groupId, actorUserId, turnId: input.turnId, tripId, tripName: updatedTrip.name })
        : undefined;
      return {
        summary: `leg ${leg.id} ${args.origin}→${args.destination}${gapNote}`,
        ...(legTripOffer ? { data: { shareSuggestion: legTripOffer } } : {}),
        card: {
          kind: 'trip',
          title: `${args.origin} → ${args.destination}`,
          subtitle: tag || `${args.mode ?? 'flight'}`,
          meta: `${args.departAt.slice(0, 10)} · ${args.departAt.slice(11, 16)}`,
        },
      };
    }

    case 'set_leg_passenger': {
      const args = call.args as {
        passengerName: string;
        tripId?: string;
        origin?: string;
        destination?: string;
        flightNo?: string;
        date?: string;
      };
      const matches = await findMatchingLegs(db, {
        groupId,
        userId,
        tripId: args.tripId,
        origin: args.origin,
        destination: args.destination,
        flightNo: args.flightNo,
        date: args.date,
      });
      if (matches.length === 0) {
        return { summary: 'set_leg_passenger: no matching leg', data: { updated: false } };
      }
      if (matches.length > 1) {
        // Ambiguous — hand back the candidates so the bot can ask which leg.
        return {
          summary: `set_leg_passenger: ${matches.length} legs match — need disambiguation`,
          data: {
            updated: false,
            instruction: OWN_WHEN_INSTRUCTION,
            candidates: matches.map((l) => ({
              id: l.id,
              origin: l.origin,
              destination: l.destination,
              departAt: l.departAt,
              departs: ownWhen(l.departAt, tz),
              flightNo: l.flightNo ?? null,
            })),
          },
        };
      }
      // Looked up in the leg's own trip's group, members and family members
      // without an account alike (ADR 0289 addendum).
      const legTrip = await getTrip(db, matches[0].tripId);
      const who = await resolveTripTraveler(db, legTrip?.groupId ?? groupId, args.passengerName);
      const personaId = who?.userId ?? null;
      const leg = await setLegPassenger(db, matches[0].id, {
        personaId: personaId ?? undefined,
        passengerName: personaId ? undefined : args.passengerName,
      });
      const traveler = who ?? travelerByName(args.passengerName);
      if (leg && traveler) await addTripTravelers(db, leg.tripId, [traveler]);
      const trip = leg ? await getTrip(db, leg.tripId) : null;
      if (trip) emit(trip.groupId, SSE.tripUpdated, trip);
      return {
        summary: `set_leg_passenger: ${args.passengerName} on ${matches[0].origin}→${matches[0].destination}`,
        data: { updated: true, legId: matches[0].id },
      };
    }

    case 'set_trip_passengers': {
      const args = call.args as { passengerNames: string[]; tripId?: string; tripQuery?: string };
      const resolution = await resolveTripId(db, userId, groupId, args);
      if (!resolution.ok) {
        if (resolution.reason === 'not_found') {
          return { summary: 'set_trip_passengers: no trip found', data: { updated: false } };
        }
        return {
          summary: `set_trip_passengers: ${resolution.candidates.length} trips match — need disambiguation`,
          data: { updated: false, candidates: resolution.candidates },
        };
      }
      const tripId = resolution.tripId;
      // Names are looked up in the TRIP's group (the question may be answered
      // in the personal chat about a family trip), members and family members
      // without an account alike; anyone else (a friend) is kept by name -
      // a traveller need not be in Chord at all (ADR 0289 addendum).
      const tripGroupId = (await getTrip(db, tripId))?.groupId ?? groupId;
      const resolved = await mapConcurrent(args.passengerNames, 5, (name) =>
        resolveTripTraveler(db, tripGroupId, name),
      );
      await addTripTravelers(
        db,
        tripId,
        args.passengerNames
          .map((name, i) => resolved[i] ?? travelerByName(name))
          .filter((r): r is NonNullable<typeof r> => !!r),
      );
      const passengers = args.passengerNames.map((name, i) => ({
        personaId: resolved[i]?.userId ?? null,
        name,
      }));
      const res = await assignPassengersToTrip(db, tripId, passengers);
      const trip = await getTrip(db, tripId);
      if (trip) emit(trip.groupId, SSE.tripUpdated, trip);
      const byNameOnly = args.passengerNames.filter((_, i) => !resolved[i]);
      // The question was a stand-in for the conflict check; now it can run.
      if (userId && trip && (await answerPendingTripTravelers(db, userId, tripId))) {
        enqueueEventNudge(db, {
          actorUserId: userId,
          sourceGroupId: trip.groupId,
          payload: { kind: 'trip', trip },
        }).catch((err) => logger.warn('enqueueEventNudge failed', { err }));
      }
      return {
        summary:
          `set_trip_passengers: ${args.passengerNames.join(', ')} on "${trip?.name ?? tripId}" (+${res.legsAdded} legs)` +
          (byNameOnly.length > 0
            ? ` · saved by name (not anyone in this chat or family): ${byNameOnly.join(', ')}`
            : ''),
        data: { updated: true, tripId, byNameOnly },
      };
    }

    case 'add_accommodation': {
      const args = call.args as {
        tripId?: string;
        propertyName: string;
        address?: string;
        city?: string;
        checkinDate: string;
        checkoutDate: string;
        roomCount?: number;
        confirmation?: string;
        notes?: string;
      };
      let tripId = args.tripId;
      if (tripId) {
        const access = await checkTripAccess(db, userId, groupId, tripId);
        if (access === 'forbidden') return { summary: 'add_accommodation: trip not accessible' };
        if (access === 'missing') tripId = undefined;
      }
      // ADR 0190 — a stay has no traveler to chain against, so it's matched
      // by place AND dates together against trips already in this group.
      if (!tripId) {
        const cityMatch = await findTripForStay(db, {
          userId,
          groupId,
          city: args.city ?? args.address ?? args.propertyName,
          checkinDate: args.checkinDate,
          checkoutDate: args.checkoutDate,
        });
        if (cityMatch) tripId = cityMatch.id;
      }
      if (!tripId) {
        const created = await createTrip(db, {
          groupId,
          createdBy: actorUserId,
          name: args.propertyName,
          destination: args.address ?? args.propertyName,
          startDate: args.checkinDate,
          endDate: args.checkoutDate,
          participantIds: [],
          sourceRawContext: provenance,
        });
        emit(groupId, SSE.tripUpdated, created);
        tripId = created.id;
      }
      const accom = await addAccommodation(db, {
        tripId,
        propertyName: args.propertyName,
        address: args.address,
        checkinDate: args.checkinDate,
        checkoutDate: args.checkoutDate,
        roomCount: args.roomCount,
        confirmation: args.confirmation,
        notes: args.notes,
        sourceRawContext: provenance,
      });
      emit(groupId, SSE.accommodationCreated, accom);
      return {
        summary: `accom ${accom.id} ${args.propertyName}`,
        card: {
          kind: 'trip',
          title: args.propertyName,
          subtitle: args.address ?? undefined,
          meta: `${args.checkinDate} → ${args.checkoutDate}`,
        },
      };
    }

    case 'add_reservation': {
      const args = call.args as {
        tripId?: string;
        kind: 'restaurant' | 'tour' | 'event' | 'activity' | 'other';
        name: string;
        dateTime?: string;
        address?: string;
        confirmation?: string;
        notes?: string;
      };
      let tripId = args.tripId;
      if (tripId) {
        const access = await checkTripAccess(db, userId, groupId, tripId);
        if (access === 'forbidden') return { summary: 'add_reservation: trip not accessible' };
        if (access === 'missing') tripId = undefined;
      }
      if (!tripId && args.dateTime) {
        const date = args.dateTime.slice(0, 10);
        const dateMatch = await findTripByDateRange(db, userId, date, date, groupId);
        if (dateMatch) tripId = dateMatch.id;
      }
      if (!tripId) {
        return { summary: 'add_reservation: no trip found for those dates; create a trip first' };
      }
      // ADR 0245 - a booking's time is on the clock of where it happens. Its
      // own address was tried where the model's reply came in; when that says
      // nothing, the trip does: the stay it falls within, then the trip's
      // destination. Only on a live turn (a stored reservation's offset is
      // already its own), and only a bare or reader-stamped time is moved.
      let reservationZone = placeTimeZone(args.address);
      if (args.dateTime && !reservationZone && input.turnId) {
        const day = args.dateTime.slice(0, 10);
        const stays = (await listAccommodationsForTrip(db, tripId)).filter(
          (a) => !a.cancelledAt && a.checkinDate <= day && a.checkoutDate >= day,
        );
        const trip = await getTrip(db, tripId);
        for (const place of [...stays.map((a) => a.address), trip?.destination]) {
          const there = placeDatetime(args.dateTime, place, offsetMinutesOf(tzOffset ?? '+00:00'), tz);
          if (!there.zone) continue;
          args.dateTime = there.at;
          reservationZone = there.zone;
          break;
        }
      }
      const reservation = await addReservation(db, {
        tripId,
        kind: args.kind,
        name: args.name,
        dateTime: args.dateTime,
        address: args.address,
        confirmation: args.confirmation,
        notes: args.notes,
        sourceRawContext: provenance ?? undefined,
      });
      emit(groupId, SSE.reservationCreated, reservation);
      return {
        summary: `reservation ${reservation.id} ${args.name}`,
        data: args.dateTime
          ? {
              when: ownWhen(args.dateTime, tz),
              // Whose clock `when` is on. When the place is not one we can
              // put a zone to, the user's own was used, and the model must
              // not call that local time there.
              timeZone: reservationZone ?? null,
              ...(reservationZone
                ? {}
                : {
                    instruction:
                      "The time zone of this place is not known, so the time was recorded on the user's own clock. Say the time without calling it local time there; if the place is in another time zone, ask the user which zone the time is in.",
                  }),
            }
          : undefined,
        card: {
          kind: 'trip',
          title: args.name,
          subtitle: args.kind,
          meta: args.dateTime ? ownWhen(args.dateTime, tz) : undefined,
        },
      };
    }

    case 'get_trip_status': {
      const args = call.args as { tripId?: string; tripQuery?: string; personName?: string };
      let tripId = args.tripId;
      if (tripId && (await checkTripAccess(db, userId, groupId, tripId)) !== 'ok') tripId = undefined;
      if (!tripId && args.tripQuery) {
        const resolution = await resolveTripId(db, userId, groupId, { tripQuery: args.tripQuery });
        if (!resolution.ok) {
          if (resolution.reason === 'not_found') {
            return { summary: 'get_trip_status: no trip found' };
          }
          return {
            summary: `get_trip_status: ${resolution.candidates.length} trips match — need disambiguation`,
            data: { candidates: resolution.candidates },
          };
        }
        tripId = resolution.tripId;
      }
      if (!tripId && args.personName) {
        // Resolve the named person → their trips in this group → pick best
        const personId = await resolveAssignee(db, groupId, args.personName);
        if (personId) {
          const personTrips = await listTripsForPersona(db, groupId, personId);
          const today = dayOf(new Date().toISOString(), tz);
          const current = personTrips.find((t) => t.startDate <= today && t.endDate >= today);
          const upcoming = personTrips.filter((t) => t.startDate > today)
            .sort((a, b) => a.startDate.localeCompare(b.startDate))[0];
          tripId = (current ?? upcoming ?? personTrips[personTrips.length - 1])?.id;
        }
      }
      if (!tripId) {
        const active = await pickActiveTrip(db, groupId, tz);
        tripId = active?.id;
      }
      if (!tripId) return { summary: 'get_trip_status: no trip found' };
      {
        const access = await checkTripAccess(db, userId, groupId, tripId);
        if (access === 'missing') return { summary: 'get_trip_status: no trip found' };
        if (access === 'forbidden') return { summary: 'get_trip_status: trip not accessible' };
      }
      const status = await getTripStatus(db, tripId);
      if (!status) return { summary: 'get_trip_status: not found' };
      const legLine = status.legs.length === 0
        ? 'no legs'
        : `${status.legs.length} leg(s): ${status.legs.map((l) => `${l.origin}→${l.destination} ${ownWhen(l.departAt, tz)}${l.carrier ? ` ${l.carrier}` : ''}${l.flightNo ? l.flightNo : ''}${l.passengers?.length ? ` (${l.passengers.join(', ')})` : ''}`).join(', ')}`;
      const accomLine = status.accommodations.length === 0
        ? 'no accommodation'
        : `${status.accommodations.length} stay(s): ${status.accommodations.map((a) => `${a.propertyName} ${weekdayOf(a.checkinDate)} ${a.checkinDate}–${weekdayOf(a.checkoutDate)} ${a.checkoutDate}`).join(', ')}`;
      const gapLine = status.gaps.length === 0
        ? 'no coverage gaps'
        : `uncovered nights: ${status.gaps.map((g) => `${g.start}–${g.end}`).join(', ')}`;
      const legGapLine = status.legGaps.length === 0
        ? 'no leg gaps'
        : `leg gaps: ${status.legGaps.map((g) => `arrived ${g.arrivedAt} but next leg leaves from ${g.departingFrom}${g.passengerName ? ` (${g.passengerName})` : ''}`).join('; ')}`;
      return {
        summary: `trip_status: ${status.narrative} | ${legLine} | ${accomLine} | ${gapLine} | ${legGapLine}`,
        card: {
          kind: 'trip',
          title: status.trip.name,
          subtitle: status.trip.destination,
          meta: `${status.legs.length} leg${status.legs.length !== 1 ? 's' : ''}${status.accommodations.length > 0 ? ` · ${status.accommodations.length} stay${status.accommodations.length !== 1 ? 's' : ''}` : ''}${status.gaps.length > 0 ? ` · ${status.gaps.length} gap${status.gaps.length !== 1 ? 's' : ''}` : ''}${status.legGaps.length > 0 ? ` · ${status.legGaps.length} leg gap${status.legGaps.length !== 1 ? 's' : ''}` : ''}`,
        },
        data: {
          instruction: OWN_WHEN_INSTRUCTION,
          legs: status.legs.map((l) => ({
            mode: l.mode,
            origin: l.origin,
            destination: l.destination,
            departAt: l.departAt,
            arriveAt: l.arriveAt,
            departs: ownWhen(l.departAt, tz),
            arrives: l.arriveAt ? ownWhen(l.arriveAt, tz) : null,
            carrier: l.carrier ?? null,
            flightNo: l.flightNo ?? null,
            passengerName: l.passengerName ?? null,
            // Everyone on this flight, family members by name - one row per flight.
            passengers: l.passengers ?? [],
          })),
          accommodations: status.accommodations.map((a) => ({
            propertyName: a.propertyName,
            address: a.address ?? null,
            checkinDate: a.checkinDate,
            checkoutDate: a.checkoutDate,
            checkin: `${weekdayOf(a.checkinDate)} ${a.checkinDate}`,
            checkout: `${weekdayOf(a.checkoutDate)} ${a.checkoutDate}`,
          })),
          reservations: status.reservations.map((r) => ({
            kind: r.kind,
            name: r.name,
            dateTime: r.dateTime ?? null,
            when: r.dateTime ? ownWhen(r.dateTime, tz) : null,
          })),
          participants: status.participantNames,
          gaps: status.gaps,
          legGaps: status.legGaps,
        },
      };
    }

    case 'merge_trips': {
      const args = call.args as {
        intoTripId?: string;
        intoTripQuery?: string;
        fromTripId?: string;
        fromTripQuery?: string;
      };
      const intoResolution = await resolveTripId(db, userId, groupId, {
        tripId: args.intoTripId, tripQuery: args.intoTripQuery,
      });
      if (!intoResolution.ok) {
        if (intoResolution.reason === 'not_found') {
          return { summary: 'merge_trips: no trip found to keep', data: { merged: false } };
        }
        return {
          summary: `merge_trips: ${intoResolution.candidates.length} trips match "into" — need disambiguation`,
          data: { merged: false, candidates: intoResolution.candidates },
        };
      }
      const fromResolution = await resolveTripId(db, userId, groupId, {
        tripId: args.fromTripId, tripQuery: args.fromTripQuery,
      });
      if (!fromResolution.ok) {
        if (fromResolution.reason === 'not_found') {
          return { summary: 'merge_trips: no trip found to combine in', data: { merged: false } };
        }
        return {
          summary: `merge_trips: ${fromResolution.candidates.length} trips match "from" — need disambiguation`,
          data: { merged: false, candidates: fromResolution.candidates },
        };
      }
      if (intoResolution.tripId === fromResolution.tripId) {
        return { summary: 'merge_trips: those are the same trip', data: { merged: false } };
      }
      let mergeResult;
      try {
        mergeResult = await mergeTrips(db, groupId, intoResolution.tripId, fromResolution.tripId);
      } catch (err) {
        return { summary: `merge_trips: ${(err as Error).message}`, data: { merged: false } };
      }
      if (!mergeResult) return { summary: 'merge_trips: trip not found', data: { merged: false } };
      emit(groupId, SSE.tripUpdated, mergeResult.status.trip);
      emit(groupId, SSE.tripDeleted, { id: mergeResult.mergedTripId });
      const gapNote = mergeResult.status.gaps.length > 0 || mergeResult.status.legGaps.length > 0
        ? ` — ${mergeResult.status.gaps.length} uncovered night(s), ${mergeResult.status.legGaps.length} leg gap(s)`
        : ' — no gaps';
      return {
        summary: `merge_trips: combined into "${mergeResult.status.trip.name}"${gapNote}`,
        data: {
          merged: true,
          tripId: mergeResult.status.trip.id,
          mergedTripId: mergeResult.mergedTripId,
          gaps: mergeResult.status.gaps,
          legGaps: mergeResult.status.legGaps,
        },
        card: {
          kind: 'trip',
          title: mergeResult.status.trip.name,
          subtitle: mergeResult.status.trip.destination,
          meta: `${mergeResult.status.legs.length} leg${mergeResult.status.legs.length !== 1 ? 's' : ''}${mergeResult.status.accommodations.length > 0 ? ` · ${mergeResult.status.accommodations.length} stay${mergeResult.status.accommodations.length !== 1 ? 's' : ''}` : ''}`,
        },
      };
    }

    case 'move_leg': {
      const args = call.args as {
        tripId?: string;
        origin?: string;
        destination?: string;
        flightNo?: string;
        date?: string;
        targetTripId?: string;
        targetTripQuery?: string;
      };
      const matches = await findMatchingLegs(db, {
        groupId,
        userId,
        tripId: args.tripId,
        origin: args.origin,
        destination: args.destination,
        flightNo: args.flightNo,
        date: args.date,
      });
      if (matches.length === 0) {
        return { summary: 'move_leg: no matching leg', data: { moved: false } };
      }
      if (matches.length > 1) {
        return {
          summary: `move_leg: ${matches.length} legs match — need disambiguation`,
          data: {
            moved: false,
            instruction: OWN_WHEN_INSTRUCTION,
            candidates: matches.map((l) => ({
              id: l.id,
              origin: l.origin,
              destination: l.destination,
              departAt: l.departAt,
              departs: ownWhen(l.departAt, tz),
              flightNo: l.flightNo ?? null,
            })),
          },
        };
      }
      const targetResolution = await resolveTripId(db, userId, groupId, {
        tripId: args.targetTripId,
        tripQuery: args.targetTripQuery,
      });
      if (!targetResolution.ok) {
        if (targetResolution.reason === 'not_found') {
          return { summary: 'move_leg: no target trip found', data: { moved: false } };
        }
        return {
          summary: `move_leg: ${targetResolution.candidates.length} target trips match — need disambiguation`,
          data: { moved: false, candidates: targetResolution.candidates },
        };
      }
      const leg = matches[0]!;
      const result = await moveTravelLeg(db, groupId, leg.id, targetResolution.tripId);
      if (!result) return { summary: 'move_leg: leg or target trip not found', data: { moved: false } };
      if (result.sourceTripDeleted) {
        emit(groupId, SSE.tripDeleted, { id: result.sourceTripId });
      } else {
        const sourceTrip = await getTrip(db, result.sourceTripId);
        if (sourceTrip) emit(groupId, SSE.tripUpdated, sourceTrip);
      }
      const targetTrip = await getTrip(db, targetResolution.tripId);
      if (targetTrip) emit(groupId, SSE.tripUpdated, targetTrip);
      return {
        summary: `move_leg: ${leg.origin}→${leg.destination} moved to "${targetTrip?.name ?? targetResolution.tripId}"`,
        data: { moved: true, legId: leg.id, tripId: targetResolution.tripId },
      };
    }

    case 'move_accommodation': {
      const args = call.args as {
        tripId?: string;
        propertyName?: string;
        checkinDate?: string;
        targetTripId?: string;
        targetTripQuery?: string;
      };
      const matches = await findMatchingAccommodations(db, {
        groupId,
        userId,
        tripId: args.tripId,
        propertyName: args.propertyName,
        checkinDate: args.checkinDate,
      });
      if (matches.length === 0) {
        return { summary: 'move_accommodation: no matching stay', data: { moved: false } };
      }
      if (matches.length > 1) {
        return {
          summary: `move_accommodation: ${matches.length} stays match — need disambiguation`,
          data: {
            moved: false,
            candidates: matches.map((a) => ({
              id: a.id,
              propertyName: a.propertyName,
              checkinDate: a.checkinDate,
              checkoutDate: a.checkoutDate,
            })),
          },
        };
      }
      const targetResolution = await resolveTripId(db, userId, groupId, {
        tripId: args.targetTripId,
        tripQuery: args.targetTripQuery,
      });
      if (!targetResolution.ok) {
        if (targetResolution.reason === 'not_found') {
          return { summary: 'move_accommodation: no target trip found', data: { moved: false } };
        }
        return {
          summary: `move_accommodation: ${targetResolution.candidates.length} target trips match — need disambiguation`,
          data: { moved: false, candidates: targetResolution.candidates },
        };
      }
      const accom = matches[0]!;
      const result = await moveAccommodation(db, groupId, accom.id, targetResolution.tripId);
      if (!result) return { summary: 'move_accommodation: stay or target trip not found', data: { moved: false } };
      if (result.sourceTripDeleted) {
        emit(groupId, SSE.tripDeleted, { id: result.sourceTripId });
      } else {
        const sourceTrip = await getTrip(db, result.sourceTripId);
        if (sourceTrip) emit(groupId, SSE.tripUpdated, sourceTrip);
      }
      const targetTrip = await getTrip(db, targetResolution.tripId);
      if (targetTrip) emit(groupId, SSE.tripUpdated, targetTrip);
      return {
        summary: `move_accommodation: ${accom.propertyName} moved to "${targetTrip?.name ?? targetResolution.tripId}"`,
        data: { moved: true, accommodationId: accom.id, tripId: targetResolution.tripId },
      };
    }

    case 'list_tasks': {
      const args = call.args as {
        status?: 'open' | 'active' | 'done' | 'superseded' | 'archived';
        limit?: number;
      };
      const crossGroup = actorUserId ? await isPersonalTurn(db, groupId) : false;
      const all =
        crossGroup && actorUserId
          ? await listTasksForUser(db, actorUserId)
          : await listTasks(db, groupId);
      const filtered = args.status ? all.filter((t) => t.status === args.status) : all;
      const capped = filtered.slice(0, args.limit ?? 10);
      const taskGroupNames = crossGroup
        ? await groupNamesFor(db, capped.map((t) => t.groupId))
        : new Map<string, string>();
      // ADR 0093 — the server remembers this ordering so the user's "3-4-5-6"
      // in a later turn resolves to ids instead of remembered titles.
      await recordTaskEnumeration(db, groupId, actorUserId, capped.map((t) => t.id));
      const rows = capped.map((t, i) => ({
        n: i + 1,
        id: t.id,
        title: t.title,
        status: t.status,
        // ADR 0285 — why an archived one went, in the words the app uses.
        ...(t.archivedReason ? { archivedBecause: archivedReasonText(t.archivedReason) } : {}),
        dueAt: t.dueAt ?? null,
        due: localWhenOrNull(t.dueAt, tz),
        remindCue: t.remindCue ?? null,
        assigneeId: t.assigneeId ?? null,
        ...(crossGroup ? { group: taskGroupNames.get(t.groupId) ?? 'Unknown group' } : {}),
      }));
      return {
        summary: `list_tasks: ${rows.length} task(s)${args.status ? ` (status=${args.status})` : ''}${
          crossGroup ? ' across all your groups' : ''
        }`,
        data: {
          instruction: LOCAL_WHEN_INSTRUCTION,
          tasks: rows,
          total: filtered.length,
          scope: crossGroup ? 'all-groups' : 'this-group',
        },
      };
    }

    case 'rename_group': {
      const args = call.args as { name: string };
      const result = await renameGroup(db, groupId, args.name);
      if (!result) {
        return {
          summary: `rename_group: nothing to rename (group missing or personal)`,
          data: { renamed: false },
        };
      }
      emit(groupId, SSE.groupRenamed, { groupId: result.id, name: result.name });
      return {
        summary: `rename_group: "${result.name}"`,
        card: { kind: 'task', title: `Renamed to "${result.name}"`, meta: 'group updated' },
        data: { groupId: result.id, name: result.name },
      };
    }

    case 'rename_list': {
      const args = call.args as { currentName: string; newName: string };
      const resolvedRename = resolveListName(await listListNames(db, groupId), args.currentName);
      if (resolvedRename.status !== 'resolved') {
        return {
          summary:
            resolvedRename.status === 'ambiguous'
              ? `rename_list: "${args.currentName}" matches ${resolvedRename.candidates.length} lists`
              : `rename_list: no list named "${args.currentName}" in this group`,
          data: {
            renamed: false,
            reason: resolvedRename.status === 'ambiguous' ? 'ambiguous' : 'not_found',
            ...(resolvedRename.status === 'ambiguous'
              ? { candidates: resolvedRename.candidates.map((l) => l.name) }
              : {}),
          },
        };
      }
      const match = resolvedRename.match;
      const updated = await renameList(db, match.id, args.newName);
      if (!updated) {
        return {
          summary: `rename_list: rename failed for "${args.currentName}"`,
          data: { renamed: false, reason: 'update_failed' },
        };
      }
      const renamed = updated.list;
      emit(groupId, SSE.listUpdated, { listId: renamed.id });
      const mergeNote = updated.merged
        ? ` (merged with the existing "${updated.merged.removedName}" — ${updated.merged.movedItems} item(s) moved over)`
        : '';
      return {
        summary: `rename_list: "${match.name}" → "${renamed.name}"${mergeNote}`,
        card: {
          kind: 'task',
          title: `Renamed list to "${renamed.name}"`,
          meta: updated.merged
            ? `merged with "${updated.merged.removedName}" — ${updated.merged.movedItems} item(s) moved`
            : `was "${match.name}"`,
        },
        data: {
          listId: renamed.id,
          name: renamed.name,
          previousName: match.name,
          ...(updated.merged ? { merged: updated.merged } : {}),
        },
      };
    }

    case 'complete_task': {
      const args = call.args as {
        taskId?: string;
        titleContains?: string;
        ordinals?: number[];
        reopen?: boolean;
        drop?: boolean;
      };
      // reopen wins over drop: "put it back" is unambiguous, and a model that
      // sets both has contradicted itself in the safer direction.
      const targetStatus: 'done' | 'open' | 'archived' = args.reopen
        ? 'open'
        : args.drop
          ? 'archived'
          : 'done';
      // Same scope as `list_tasks` (ADR 0096): from the personal 1:1 the
      // enumeration can contain tasks from any of the user's groups, and a
      // group-scoped lookup here would silently skip them.
      const crossGroupTasks = actorUserId ? await isPersonalTurn(db, groupId) : false;
      const all =
        crossGroupTasks && actorUserId
          ? await listTasksForUser(db, actorUserId)
          : await listTasks(db, groupId);
      // Same scope, for the direct id/title lookups below.
      const taskScope: { groupId: string } | { crossGroupUserId: string } =
        crossGroupTasks && actorUserId ? { crossGroupUserId: actorUserId } : { groupId };

      // ADR 0093 — positions from the list `list_tasks` last showed. The only
      // way to address a SET of tasks, and resolved here rather than by the
      // model, which does not carry task ids between turns.
      if (args.ordinals && args.ordinals.length > 0) {
        const wanted = [...new Set(args.ordinals)];
        const ids = await resolveTaskOrdinals(db, groupId, actorUserId, wanted);
        const unresolved = wanted.filter((_, i) => !ids[i]);
        // All-or-nothing: no reading of "3-4-5-6" makes writing three of them
        // right, and a stale list is exactly when the wrong three get picked.
        if (unresolved.length > 0) {
          return {
            summary: `complete_task: ordinals ${unresolved.join(',')} unresolved — nothing changed`,
            data: {
              matched: false,
              reason: 'stale_enumeration',
              unresolved,
              hint: 'Call list_tasks, renumber your reply from the returned `n`, then retry with those ordinals.',
            },
          };
        }
        const changed: Array<{ ordinal: number; taskId: string; title: string }> = [];
        const alreadySet: Array<{ ordinal: number; taskId: string; title: string }> = [];
        const cards: BotCard[] = [];
        for (let i = 0; i < wanted.length; i++) {
          const task = all.find((t) => t.id === ids[i]);
          if (!task) continue;
          const entry = { ordinal: wanted[i], taskId: task.id, title: task.title };
          if (task.status === targetStatus) {
            alreadySet.push(entry);
            continue;
          }
          const updated = await updateTask(db, task.id, { status: targetStatus });
          if (!updated) continue;
          emit(task.groupId, SSE.taskUpdated, updated);
          changed.push(entry);
          cards.push({
            kind: 'task',
            title: task.title,
            meta: statusVerb(targetStatus),
          });
        }
        return {
          summary: `complete_task: ${changed.length} task(s) → ${targetStatus}${
            alreadySet.length > 0 ? ` (${alreadySet.length} already)` : ''
          }`,
          cards,
          data: { changed, alreadySet, status: targetStatus },
        };
      }

      // Single-task resolution. One per turn — a second means the model is
      // fanning a set out into independent guesses, which is what closed four
      // tasks the user asked to keep (ADR 0093).
      if (!claimLooseTaskMutation(input.turnId)) {
        return {
          summary: 'complete_task: refused — a set of tasks must go through ordinals',
          data: {
            matched: false,
            reason: 'batch_requires_ordinals',
            hint: 'Call list_tasks, then pass every task you mean as `ordinals` in ONE complete_task call.',
          },
        };
      }
      // Direct id/title lookups, not a scan of `all` — see getTaskInScope's
      // and findTasksByTitle's doc comments (tasks.service.ts) for why: `all`
      // is a 200-row, recency-capped page, and an old still-open task (ADR
      // 0092 never auto-archives an undated one) can sit behind 200+ newer
      // tasks of any status.
      let match = args.taskId ? await getTaskInScope(db, args.taskId, taskScope) : undefined;
      if (!match && args.titleContains) {
        const matchStatuses: ('open' | 'active' | 'done')[] =
          targetStatus === 'open' ? ['done'] : ['open', 'active'];
        const candidates = await findTasksByTitle(db, taskScope, args.titleContains, matchStatuses);
        if (candidates.length === 1) {
          match = candidates[0];
        } else if (candidates.length > 1) {
          return {
            summary: `complete_task: ${candidates.length} candidates — ask which`,
            data: {
              candidates: candidates.slice(0, 5).map((t) => ({
                id: t.id,
                title: t.title,
                status: t.status,
              })),
            },
          };
        }
      }
      if (!match) {
        return {
          summary: `complete_task: no matching task`,
          data: { matched: false },
        };
      }
      if (match.status === targetStatus) {
        return {
          summary: `complete_task: ${match.id} already ${targetStatus}`,
          data: { taskId: match.id, status: match.status, noop: true },
        };
      }
      const updated = await updateTask(db, match.id, { status: targetStatus });
      if (updated) emit(match.groupId, SSE.taskUpdated, updated);
      return {
        summary: `complete_task: ${match.id} → ${targetStatus}`,
        card: { kind: 'task', title: match.title, meta: statusVerb(targetStatus) },
        data: { taskId: match.id, status: targetStatus },
      };
    }

    case 'update_task': {
      const args = call.args as {
        taskId?: string;
        titleContains?: string;
        ordinals?: number[];
        title?: string;
        details?: string;
        assigneeName?: string;
        dueAt?: string | null;
        remindAt?: string | null;
        remindCue?: string;
      };

      // Fields the model actually wants changed. Omitted stays omitted
      // (ADR 0095); an explicit null on dueAt/remindAt is a request to clear.
      const wantsChange =
        args.title !== undefined ||
        args.details !== undefined ||
        args.assigneeName !== undefined ||
        args.dueAt !== undefined ||
        args.remindAt !== undefined ||
        args.remindCue !== undefined;
      if (!wantsChange) {
        return {
          summary: 'update_task: no fields to change',
          data: { updated: false, reason: 'no_fields' },
        };
      }

      // Validate the reminder time once — group-independent. A bad explicit
      // time (imminent / unparseable) refuses the whole call rather than
      // silently leaving the old reminder, which would misreport the change.
      let remindPatch: { remindAt?: string | null } = {};
      if (args.remindAt !== undefined) {
        if (args.remindAt === null) {
          remindPatch = { remindAt: null };
        } else {
          const cleaned = sanitizeRemindAt(args.remindAt);
          if (!cleaned) {
            return {
              summary: 'update_task: reminder time rejected — nothing changed',
              data: {
                updated: false,
                reason: 'bad_remind_time',
                hint: 'remindAt must be a specific future time more than 5 minutes out, or null to clear it.',
              },
            };
          }
          remindPatch = { remindAt: cleaned };
        }
      }

      // Same scope as list_tasks / complete_task (ADR 0096): from the personal
      // 1:1 the enumeration can hold tasks from any of the user's groups.
      const crossGroupTasks = actorUserId ? await isPersonalTurn(db, groupId) : false;
      const all =
        crossGroupTasks && actorUserId
          ? await listTasksForUser(db, actorUserId)
          : await listTasks(db, groupId);
      // Same scope, for the direct id/title lookups below.
      const taskScope: { groupId: string } | { crossGroupUserId: string } =
        crossGroupTasks && actorUserId ? { crossGroupUserId: actorUserId } : { groupId };

      // Reassignment goes through the same trust gate create_task uses, and is
      // single-task only — resolved against the target task's own group.
      const buildPatch = async (
        taskGroupId: string,
      ): Promise<
        | { ok: true; patch: UpdateTaskInput }
        | { ok: false; reason: 'assignee_not_found' | 'assignee_untrusted'; recipientUserId?: string }
      > => {
        const patch: UpdateTaskInput = { ...remindPatch };
        if (args.title !== undefined) patch.title = args.title;
        if (args.details !== undefined) patch.details = args.details;
        if (args.remindCue !== undefined) patch.remindCue = args.remindCue;
        if (args.dueAt !== undefined) patch.dueAt = args.dueAt;
        if (args.assigneeName !== undefined) {
          // ADR 0151 — reassign to an account member or a managed persona.
          const resolved = await resolveAssigneeTarget(db, taskGroupId, args.assigneeName);
          if (!resolved) return { ok: false, reason: 'assignee_not_found' };
          if (resolved.kind === 'persona') {
            const { trusted, managedBy } = await isTrustedForPersona(
              db,
              resolved.id,
              actorUserId ?? '',
              'task',
            );
            if (actorUserId && !trusted) {
              return {
                ok: false,
                reason: 'assignee_untrusted',
                recipientUserId: managedBy ?? undefined,
              };
            }
            patch.assigneePersonaId = resolved.id;
          } else {
            if (
              actorUserId &&
              resolved.id !== actorUserId &&
              !(await isTrusted(db, resolved.id, actorUserId, 'task'))
            ) {
              return { ok: false, reason: 'assignee_untrusted', recipientUserId: resolved.id };
            }
            patch.assigneeId = resolved.id;
          }
        }
        return { ok: true, patch };
      };

      // ADR 0093 — positions from the list `list_tasks` last showed. The only
      // way to touch a SET, resolved here, not by the model.
      if (args.ordinals && args.ordinals.length > 0) {
        if (args.assigneeName !== undefined) {
          return {
            summary: 'update_task: reassigning is one task at a time',
            data: {
              updated: false,
              reason: 'reassign_needs_single',
              hint: 'Reassign with taskId or titleContains, one task per call.',
            },
          };
        }
        const wanted = [...new Set(args.ordinals)];
        const ids = await resolveTaskOrdinals(db, groupId, actorUserId, wanted);
        const unresolved = wanted.filter((_, i) => !ids[i]);
        if (unresolved.length > 0) {
          return {
            summary: `update_task: ordinals ${unresolved.join(',')} unresolved — nothing changed`,
            data: {
              updated: false,
              reason: 'stale_enumeration',
              unresolved,
              hint: 'Call list_tasks, renumber your reply from the returned `n`, then retry with those ordinals.',
            },
          };
        }
        const targets = wanted
          .map((_, i) => all.find((t) => t.id === ids[i]))
          .filter((t): t is (typeof all)[number] => Boolean(t));
        const changed: Array<{ ordinal: number; taskId: string; title: string; what: string }> = [];
        const cards: BotCard[] = [];
        for (let i = 0; i < targets.length; i++) {
          const task = targets[i];
          const built = await buildPatch(task.groupId);
          // Only failure here is a bad reassign, already refused above.
          if (!built.ok) continue;
          const updated = await updateTask(db, task.id, built.patch);
          if (!updated) continue;
          emit(task.groupId, SSE.taskUpdated, updated);
          const what = describeTaskPatch(built.patch);
          changed.push({ ordinal: wanted[i], taskId: task.id, title: updated.title, what });
          cards.push({ kind: 'task', title: updated.title, meta: what });
        }
        return {
          summary: `update_task: ${changed.length} task(s) updated`,
          cards,
          data: { changed, status: 'updated' },
        };
      }

      // Single-task resolution. Shares complete_task's one-per-turn budget
      // (ADR 0093) — a set must go through ordinals.
      if (!claimLooseTaskMutation(input.turnId)) {
        return {
          summary: 'update_task: refused — a set of tasks must go through ordinals',
          data: {
            updated: false,
            reason: 'batch_requires_ordinals',
            hint: 'Call list_tasks, then pass every task you mean as `ordinals` in ONE update_task call.',
          },
        };
      }
      // Direct id/title lookups, not a scan of `all` — see getTaskInScope's
      // and findTasksByTitle's doc comments (tasks.service.ts).
      let match = args.taskId ? await getTaskInScope(db, args.taskId, taskScope) : undefined;
      if (!match && args.titleContains) {
        const candidates = await findTasksByTitle(db, taskScope, args.titleContains, ['open', 'active']);
        if (candidates.length === 1) {
          match = candidates[0];
        } else if (candidates.length > 1) {
          return {
            summary: `update_task: ${candidates.length} candidates — ask which`,
            data: {
              updated: false,
              candidates: candidates
                .slice(0, 5)
                .map((t) => ({ id: t.id, title: t.title, status: t.status })),
            },
          };
        }
      }
      if (!match) {
        return { summary: 'update_task: no matching task', data: { updated: false, matched: false } };
      }

      const built = await buildPatch(match.groupId);
      if (!built.ok) {
        if (built.reason === 'assignee_untrusted' && built.recipientUserId && actorUserId) {
          const pr = await requestPermission(db, {
            recipientUserId: built.recipientUserId,
            senderUserId: actorUserId,
            groupId: match.groupId,
            scopes: ['task'],
            reason: `reassign task: ${match.title}`,
          });
          return {
            summary: `update_task: permission requested to reassign "${match.title}" (request ${pr.id})`,
            card: {
              kind: 'task',
              title: match.title,
              subtitle: 'permission requested',
              meta: `awaiting ${args.assigneeName ?? 'recipient'}'s approval`,
            },
            data: { updated: false, reason: 'assignee_untrusted', permissionRequestId: pr.id },
          };
        }
        return {
          summary: `update_task: ${args.assigneeName ?? 'that person'} is not in this group — nothing changed`,
          data: { updated: false, reason: 'assignee_not_found', assigneeName: args.assigneeName },
        };
      }

      const updated = await updateTask(db, match.id, built.patch);
      if (!updated) {
        return { summary: 'update_task: no matching task', data: { updated: false, matched: false } };
      }
      emit(match.groupId, SSE.taskUpdated, updated);
      const what = describeTaskPatch(built.patch);
      return {
        summary: `update_task: ${match.id} — ${what}`,
        card: { kind: 'task', title: updated.title, meta: what },
        data: { updated: true, taskId: match.id, what },
      };
    }

    case 'search_saves': {
      const args = call.args as {
        query?: string;
        tripLabel?: string;
        limit?: number;
      };
      const limit = args.limit ?? 8;
      const q = args.query?.toLowerCase().trim() ?? '';
      // Same tsquery + literal-floor rule as the `search` tool (ADR 0085) —
      // reused, not recomputed, so the two surfaces can't drift on what
      // "matches" means.
      const tsq = q ? toTsQuery(q) : null;
      const useLiteral = q.length > 0 && literalQueryUsable(q);
      const qLike = useLiteral ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : ' nomatch ';

      const savesCrossGroup = actorUserId ? await isPersonalTurn(db, groupId) : false;
      const savesScope: { groupId: string } | { crossGroupUserId: string } =
        savesCrossGroup && actorUserId ? { crossGroupUserId: actorUserId } : { groupId };
      // Direct SQL, bounded by scope + the actual query — not
      // listSaves(ForUser)'s 200-row recency page. See searchSavesScoped's
      // doc comment (saves.service.ts). No query → just browse the scope
      // (`listSavesForUser` is already unbounded; `listSaves` respects the
      // explicit `limit` here rather than its own 200 default).
      const cappedSaves = q
        ? await searchSavesScoped(db, savesScope, { tsq, qLike, tripLabel: args.tripLabel, cap: limit })
        : savesCrossGroup && actorUserId
          ? (await listSavesForUser(db, actorUserId))
              .filter((s) => !args.tripLabel || s.tripLabel === args.tripLabel)
              .slice(0, limit)
          : await listSaves(db, groupId, { tripLabel: args.tripLabel, limit });

      // Lists: scan list names AND list items so prompts like
      // "what restaurants did I want to try" find entries the user
      // dropped into a list ("restaurants to try") in addition to any
      // dedicated saves. Trip-label filter doesn't apply to lists.
      const cappedLists =
        args.tripLabel || !q
          ? []
          : await searchListsScoped(db, savesScope, { tsq, qLike, cap: limit });

      const saveGroupNames = savesCrossGroup
        ? await groupNamesFor(db, [
            ...cappedSaves.map((s) => s.groupId),
            ...cappedLists.map((l) => l.groupId),
          ])
        : new Map<string, string>();
      const whereRow = (r: { groupId: string }) =>
        savesCrossGroup ? { group: saveGroupNames.get(r.groupId) ?? 'Unknown group' } : {};

      const totalHits = cappedSaves.length + cappedLists.length;
      return {
        summary: `search_saves: ${totalHits} hit(s) (${cappedSaves.length} save${cappedSaves.length === 1 ? '' : 's'}, ${cappedLists.length} list${cappedLists.length === 1 ? '' : 's'})${q ? ` for "${q}"` : ''}`,
        data: {
          saves: cappedSaves.map((s) => ({
            id: s.id,
            kind: s.kind,
            title: s.title,
            url: s.url ?? null,
            note: s.note ?? null,
            tags: s.tags,
            tripLabel: s.tripLabel ?? null,
            ...whereRow(s),
          })),
          lists: cappedLists.map((l) => ({
            listId: l.id,
            listName: l.name,
            ...whereRow(l),
            matchedItems: l.items.map((it) => ({ id: it.id, text: it.text, checked: it.checked })),
          })),
          total: totalHits,
          scope: savesCrossGroup ? 'all-groups' : 'this-group',
        },
      };
    }

    case 'get_list': {
      const args = call.args as { listName?: string };
      const listsCrossGroup = actorUserId ? await isPersonalTurn(db, groupId) : false;
      const all =
        listsCrossGroup && actorUserId
          ? await listListsForUser(db, actorUserId)
          : await listLists(db, groupId);
      const listGroupNames = listsCrossGroup
        ? await groupNamesFor(db, all.map((l) => l.groupId))
        : new Map<string, string>();
      const whereList = (l: { groupId: string }) =>
        listsCrossGroup ? { group: listGroupNames.get(l.groupId) ?? 'Unknown group' } : {};
      const q = args.listName?.toLowerCase().trim() ?? '';

      // No name → hand back the index of lists so the model can pick one.
      if (!q) {
        return {
          summary: `get_list: ${all.length} list(s)`,
          data: {
            lists: all.map((l) => ({
              listId: l.id,
              listName: l.name,
              itemCount: l.items.length,
              uncheckedCount: l.items.filter((i) => !i.checked).length,
              ...whereList(l),
            })),
          },
        };
      }

      // Same rule the write path uses (`resolveOrCreateListByName`), down to
      // the oldest-first ordering, so the list enumerated here is exactly the
      // list an add would append to.
      const resolvedList = resolveListName(
        [...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        q,
      );

      if (resolvedList.status !== 'resolved') {
        if (resolvedList.status === 'none') {
          // ADR 0096 — the question is about a KIND of thing, not a container.
          // "What restaurants have I got?" is answered by `save_place` rows as
          // readily as by a list, and the user has no idea which one the bot
          // picked when it filed the thing. Rather than report nothing, look
          // where the same content also lives.
          const savesFallback = (
            listsCrossGroup && actorUserId
              ? await listSavesForUser(db, actorUserId)
              : await listSaves(db, groupId)
          ).filter((s) => {
            const hay = `${s.title} ${s.note ?? ''} ${s.tags.join(' ')}`.toLowerCase();
            return listNameTokens(q).some((t) => hay.includes(t));
          });
          return {
            summary:
              savesFallback.length > 0
                ? `get_list: no list matching "${args.listName}" — ${savesFallback.length} saved item(s) match instead`
                : `get_list: no list matching "${args.listName}"`,
            data: {
              list: null,
              candidates: all.map((l) => l.name),
              // The real count, so "how many restaurants" is not answered
              // from however many rows fit below.
              savesTotal: savesFallback.length,
              saves: savesFallback.slice(0, 50).map((s) => ({
                id: s.id,
                kind: s.kind,
                title: s.title,
                note: s.note ?? null,
                tags: s.tags,
                ...whereList(s),
              })),
            },
          };
        }
        return {
          summary: `get_list: ${resolvedList.candidates.length} lists match "${args.listName}"`,
          data: {
            list: null,
            candidates: resolvedList.candidates.map((l) => ({
              listId: l.id,
              listName: l.name,
              itemCount: l.items.length,
              ...whereList(l),
            })),
          },
        };
      }
      const resolved = resolvedList.match;

      return {
        summary: `get_list: "${resolved.name}" — ${resolved.items.length} item(s)`,
        data: {
          list: {
            listId: resolved.id,
            listName: resolved.name,
            ...whereList(resolved),
            items: resolved.items.map((i) => ({
              id: i.id,
              text: i.text,
              checked: i.checked,
            })),
          },
        },
      };
    }

    case 'move_list_to_saves': {
      const args = call.args as { listName: string; kind?: MovableSaveKind; groupName?: string };
      // Same reach as get_list: every group the user is in from the personal
      // chat, this group only in a shared one.
      const crossGroup = actorUserId ? await isPersonalTurn(db, groupId) : false;
      const reachable =
        crossGroup && actorUserId
          ? await listListsForUser(db, actorUserId)
          : await listLists(db, groupId);
      const names = crossGroup
        ? await groupNamesFor(db, reachable.map((l) => l.groupId))
        : new Map<string, string>();
      const wantGroup = args.groupName?.trim().toLowerCase();
      const all = wantGroup
        ? reachable.filter((l) => names.get(l.groupId)?.trim().toLowerCase() === wantGroup)
        : reachable;
      const resolved = resolveListName(
        [...all].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        args.listName.toLowerCase().trim(),
      );
      // get_list may read the oldest of two same-named lists in different
      // groups; a move deletes, so it asks instead of picking one.
      const twins =
        resolved.status === 'resolved'
          ? all.filter((l) => listNameKey(l.name) === listNameKey(resolved.match.name))
          : [];
      if (resolved.status !== 'resolved' || twins.length > 1) {
        const ambiguous = resolved.status === 'ambiguous' || twins.length > 1;
        const shown = twins.length > 1 ? twins : resolved.status === 'ambiguous' ? resolved.candidates : all;
        return {
          summary: ambiguous
            ? `move_list_to_saves: ${shown.length} lists match "${args.listName}" — nothing moved`
            : `move_list_to_saves: no list matching "${args.listName}" — nothing moved`,
          data: {
            moved: false,
            reason: ambiguous ? 'ambiguous' : 'not_found',
            candidates: shown.map((l) => ({
              listName: l.name,
              itemCount: l.items.length,
              ...(crossGroup ? { group: names.get(l.groupId) ?? 'Unknown group' } : {}),
            })),
          },
        };
      }
      const result = await moveListToSaves(db, {
        listId: resolved.match.id,
        actorUserId,
        kind: args.kind ?? 'place',
      });
      if (!result) {
        return {
          summary: `move_list_to_saves: list "${args.listName}" is gone — nothing moved`,
          data: { moved: false, reason: 'not_found' },
        };
      }
      for (const s of result.created) emit(result.groupId, SSE.saveAdded, s);
      emit(result.groupId, SSE.listUpdated, { listId: result.listId });
      const total = result.moved + result.alreadySaved;
      return {
        summary:
          `moved list "${result.listName}" to Saves: ${result.moved} new, ` +
          `${result.alreadySaved} already saved, tag "${result.tag}"; list deleted`,
        data: {
          moved: true,
          listName: result.listName,
          newSaves: result.moved,
          alreadySaved: result.alreadySaved,
          total,
          tag: result.tag,
          titles: result.saves.map((s) => s.title),
        },
        card: {
          kind: 'save',
          title: `${total} moved to Saves`,
          subtitle: `from "${result.listName}"`,
          meta: result.tag ? `#${result.tag}` : undefined,
        },
      };
    }

    case 'lookup_contact': {
      const args = call.args as { name: string };
      const needle = args.name.trim().toLowerCase();
      // Contacts now live in `saves` (kind='contact'). Match on title.
      const all = await listSaves(db, groupId);
      const contacts = all.filter((s) => s.kind === 'contact');
      const match =
        contacts.find((c) => c.title.toLowerCase() === needle) ??
        contacts.find((c) => c.title.toLowerCase().includes(needle));
      if (!match) {
        return {
          summary: `lookup_contact: no match for "${args.name}"`,
          data: { contact: null },
        };
      }
      return {
        summary: `lookup_contact: ${match.title}`,
        data: {
          contact: {
            id: match.id,
            name: match.title,
            note: match.note ?? null,
            tags: match.tags,
          },
        },
      };
    }

    case 'relay': {
      const args = call.args as { target: string; text: string };
      const target = args.target.trim().toLowerCase();
      if (!target) {
        return { summary: 'relay: empty target' };
      }

      // Resolve the speaker's display name + which surface they spoke
      // from, so we can address them in third-person ("Alice from
      // Telegram asked me to share: …").
      let senderDisplay: string | null = null;
      if (actorUserId) {
        const u = await db
          .selectFrom('users')
          .select(['display_name', 'username'])
          .where('id', '=', actorUserId)
          .executeTakeFirst();
        senderDisplay = u?.display_name ?? u?.username ?? null;
      }
      const speakerLabel = senderDisplay ?? 'someone';
      const sourceLabel = input.sourceBinding
        ? `from ${input.sourceBinding.platform}`
        : 'in Chord';
      const phrased = `${speakerLabel} (${sourceLabel}) asked me to share: ${args.text}`;

      const bindings = await listBindingsForGroup(db, groupId);

      // target='chord' posts a bot-authored message in the native Chord
      // group itself. autoMirror=false stops the outbound publisher from
      // fanning it back out to every bridge (which would defeat the
      // point — and create a loop with the source surface).
      if (target === 'chord') {
        const msg = await postMessage(db, {
          groupId,
          senderId: null,
          kind: 'bot',
          body: phrased,
          chordVisible: 1,
          autoMirror: false,
        });
        emit(groupId, SSE.message, msg);
        return { summary: `relay → chord` };
      }

      // External-bridge targets.
      let targets = bindings;
      if (target === 'all') {
        if (input.sourceBinding) {
          const src = input.sourceBinding;
          targets = bindings.filter(
            (b) =>
              !(
                b.platform === src.platform &&
                b.externalChannelId === src.externalChannelId
              ),
          );
        }
      } else {
        const matched = bindings.find((b) => b.alias === target);
        if (!matched) {
          const known = bindings.map((b) => b.alias).join(', ') || '(none)';
          return {
            summary: `relay: unknown target "${args.target}". Known aliases: ${known} (or 'chord' / 'all')`,
          };
        }
        targets = [matched];
      }

      if (targets.length === 0) {
        return { summary: 'relay: no targets' };
      }

      // Independent sends to different platforms — allSettled so one
      // connector failing doesn't hide the others' results.
      const results = await Promise.allSettled(
        targets.map(async (t) => {
          const conn = connectorRegistry.getForBinding(t.platform, t.botUserId);
          if (!conn) {
            throw new Error('no connector');
          }
          await conn.send({
            externalChannelId: t.externalChannelId,
            body: phrased,
            cards: [],
          });
          return t.alias;
        }),
      );
      const sent: string[] = [];
      const failed: string[] = [];
      targets.forEach((t, i) => {
        const r = results[i];
        if (r.status === 'fulfilled') {
          sent.push(r.value);
          return;
        }
        if (r.reason instanceof Error && r.reason.message === 'no connector') {
          failed.push(`${t.alias}(no connector)`);
          return;
        }
        logger.warn(`relay send failed for ${t.alias}`, { err: r.reason });
        failed.push(t.alias);
      });

      const summary =
        sent.length > 0
          ? `relay → ${sent.join(', ')}${failed.length > 0 ? ` (failed: ${failed.join(', ')})` : ''}`
          : `relay failed: ${failed.join(', ') || 'no deliverable targets'}`;
      return { summary };
    }

    case 'get_event_status': {
      const args = call.args as { eventId?: string };
      let eventId = args.eventId;
      if (!eventId) {
        // Direct-SQL "nearest upcoming, else most recent past" lookup — see
        // findNearestEvent's doc comment. listEvents(db, groupId) used to
        // scan only the oldest 500 events with no lower time bound, so on a
        // long-lived group this could silently return a years-old past
        // event as the "nearest upcoming" one.
        const nearest = await findNearestEvent(db, groupId, new Date().toISOString(), tz);
        if (!nearest) {
          return { summary: 'get_event_status: no events', data: { event: null } };
        }
        eventId = nearest.id;
      }
      const event = await resolveEventInGroup(db, groupId, eventId);
      if (!event) {
        return {
          summary: 'get_event_status: event not in this group',
          data: { event: null },
        };
      }
      const rsvps = await listRsvps(db, event.id);
      const yesCount = rsvps.filter((r) => r.status === 'yes').length;
      return {
        summary: `get_event_status: ${event.title} — ${yesCount}/${rsvps.length} yes`,
        data: {
          instruction: LOCAL_WHEN_INSTRUCTION,
          event: {
            id: event.id,
            title: event.title,
            startsAt: event.startsAt,
            when: localWhen(event.startsAt, tz),
            location: event.location ?? null,
          },
          rsvps: rsvps.map((r) => ({
            displayName: r.displayName,
            status: r.status,
            dish: r.dish ?? null,
            notes: r.notes ?? null,
            solo: r.solo,
          })),
        },
      };
    }

    case 'search': {
      const args = call.args as {
        query?: string;
        categories?: SearchCategory[];
        limit?: number;
        from?: string;
        to?: string;
        after?: string;
        before?: string;
        hasAttachment?: boolean;
        emailAction?: EmailAction[];
        emailKind?: 'receipt' | 'delivery' | 'flight' | 'invite';
      };
      if (!actorUserId) {
        return { summary: 'search: no actor', data: { totalHits: 0 } };
      }
      // ADR 0279 — a mail filter the user never asked for is dropped, not obeyed.
      const guarded = dropUnaskedMailFilters(args, input.userText ?? (await recentUserText(db, input.triggeringMessageId)));
      if (guarded.dropped.length) logger.info('search: dropped unasked filters', { dropped: guarded.dropped });
      Object.assign(args, { from: undefined, to: undefined, after: undefined, before: undefined, hasAttachment: undefined, emailAction: undefined, emailKind: undefined }, guarded.args);
      const query = args.query ?? '';
      // Local calendar days, as instants in the user's zone (ADR 0270).
      const dayAfter = (day: string) => {
        const d = new Date(`${day}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 1);
        return d.toISOString().slice(0, 10);
      };
      const personal = await isPersonalTurn(db, groupId);
      const results = await searchEverything(db, {
        userId: actorUserId,
        groupId,
        crossGroup: personal,
        query,
        categories: args.categories,
        perCategory: args.limit,
        // ADR 0275 — the phone's address book, for a role the server could
        // not place. Personal chat only, like get_contact_info (ADR 0212).
        askPhone: personal
          ? async (asked, terms) => {
              const device = await requestDeviceContact({
                emit,
                groupId,
                userId: actorUserId,
                query: asked,
                role: terms,
                timeoutMs: env.CONTACT_LOOKUP_TIMEOUT_MS,
              });
              return device.status === 'found'
                ? device.matches.map((m) => ({ name: m.name, emails: m.emails, ...(m.company ? { company: m.company } : {}) }))
                : null;
            }
          : undefined,
        mailFilters: {
          from: args.from,
          to: args.to,
          after: args.after ? zonedDayStartUtc(args.after, tz ?? null).toISOString() : undefined,
          before: args.before
            ? new Date(zonedDayStartUtc(dayAfter(args.before), tz ?? null).getTime() - 1).toISOString()
            : undefined,
          hasAttachment: args.hasAttachment,
          actions: args.emailAction,
          kind: args.emailKind,
        },
      });
      const unclear = (results.people ?? []).filter((p) => p.status === 'ambiguous');
      // ADR 0275 — a role found only in the phone's address book: offer to
      // remember it, so the next search finds it without asking the phone.
      const fromPhone = (results.people ?? []).filter((p) => p.via === 'phone' && p.phoneContacts?.length);
      const saveOffer = fromPhone
        .map((p) => {
          const c = p.phoneContacts![0];
          const roleName = p.asked.replace(/^(?:the|my|our)\s+/i, '');
          return `"${p.asked}" was found in the user's phone contacts as ${c.name}${c.company ? ` (${c.company})` : ''} <${c.emails[0]}>. After the results, ask once whether to remember ${c.name} as their ${roleName}; only if they say yes, call add_person { displayName: "${c.name}", email: "${c.emails[0]}", notes: "${roleName}" }.`;
        })
        .join(' ');
      const label = [query, args.from && `from ${args.from}`, args.to && `to ${args.to}`].filter(Boolean).join(' ');
      return {
        summary: `search "${label}": ${results.totalHits} hit(s) across ${results.scope === 'all-groups' ? 'all your groups' : 'this group'}`,
        data: {
          ...results,
          instruction: unclear.length
            ? askWhichPersonInstruction(unclear)
            : saveOffer
              ? `${LOCAL_WHEN_INSTRUCTION} ${saveOffer}`
              : LOCAL_WHEN_INSTRUCTION,
          events: results.events.map((e) => ({ ...e, when: localWhen(e.startsAt, tz) })),
          tasks: results.tasks.map((t) => ({ ...t, due: localWhenOrNull(t.dueAt, tz) })),
          reminders: results.reminders.map((t) => ({
            ...t,
            due: localWhenOrNull(t.dueAt, tz),
            remind: localWhenOrNull(t.remindAt, tz),
          })),
          emails: results.emails.map((m) => ({ ...m, when: localWhen(m.receivedAt, tz) })),
        },
        cards: buildSearchCards(results),
      };
    }

    case 'summarize_email': {
      const args = call.args as { since?: string; until?: string; perSection?: number };
      if (!actorUserId) {
        return { summary: 'summarize_email: no actor', data: { total: 0 } };
      }
      // Personal-only is enforced upstream by PERSONAL_ONLY_TOOL_NAMES; the
      // window is resolved in the USER'S zone inside the service, not here.
      // Once per turn, for send_briefing's reason (ADR 0099): the ADR 0005
      // loop re-streams up to 20 times, and each summary walks the mailbox.
      if (!claimOncePerTurn(input.turnId, 'summarize_email')) {
        return {
          summary: 'summarize_email: already summarised this turn',
          data: { total: 0, reason: 'already_summarised_this_turn' },
        };
      }
      const summary = await summarizeEmailWindow(db, actorUserId, args);
      const wants = summary.sections
        .filter((s) => s.key === 'to_do' || s.key === 'reply_needed')
        .reduce((n, s) => n + s.count, 0);
      const range = summary.since === summary.until ? summary.since : `${summary.since}..${summary.until}`;
      return {
        summary: `summarize_email ${range}: ${summary.total} thread(s), ${wants} wanting something, ${summary.unread} unread`,
        data: summary,
      };
    }

    // Only ever reached through `mode: 'commit'` — i.e. the user tapped Send on
    // the staged draft. The bot's own call takes the propose branch above and
    // never lands here (ADR 0009 + chord_email.md §3.4).
    case 'reply_to_email': {
      const args = call.args as { threadId: string; body: string; to?: string[]; cc?: string[] };
      if (!actorUserId) return { summary: 'reply_to_email: no actor' };
      // Ownership rides on the userId scope inside both helpers: a thread that
      // is not this user's simply does not resolve, and we report not-found
      // rather than leaking that it exists.
      const acctId = await threadAccountId(db, actorUserId, args.threadId);
      // Exactly the addresses the card showed. An empty `to` falls back to the
      // latest non-self sender inside the send path (a plain reply).
      const sendInput = {
        threadRowId: args.threadId,
        // Signed here, not at send (ADR 0260 addendum): the send path takes
        // the body as written.
        body: await signedBody(db, actorUserId, args.body, acctId),
        to: args.to?.length ? args.to : undefined,
        cc: args.cc?.length ? args.cc : undefined,
      };
      const detail = acctId
        ? await sendAccountReply(db, actorUserId, acctId, sendInput)
        : await sendReply(db, actorUserId, sendInput);
      if (!detail) {
        return { summary: 'reply_to_email: thread not found', data: { sent: false } };
      }
      return {
        summary: `reply_to_email: sent on "${detail.thread.subject || '(no subject)'}"`,
        card: {
          kind: 'email',
          title: 'Reply sent',
          subtitle: detail.thread.subject || undefined,
          href: `/email/${args.threadId}`,
        },
        data: { sent: true, threadId: args.threadId },
      };
    }

    // ADR 0306 — the organizer and guests of a calendar event, and a card
    // that opens the composer to them. Reads the user's own copies, so it is
    // personal-only like the other mail tools.
    case 'email_event_guests': {
      const args = call.args as { eventId?: string; titleContains?: string; date?: string };
      if (!actorUserId || !(await isPersonalTurn(db, groupId))) {
        return { summary: 'email_event_guests: personal chat only', data: { recipients: [] } };
      }
      let target: GroupEvent | null = null;
      if (args.eventId) {
        const ev = await getEvent(db, args.eventId);
        if (ev && ev.ownerUserId === actorUserId) target = ev;
      }
      if (!target && args.titleContains) {
        const matches = collapseSeriesMatches(
          await findEventsByTitle(db, { ownerUserId: actorUserId }, args.titleContains, args.date, tz),
        );
        if (matches.length === 1) target = matches[0];
        else if (matches.length > 1) {
          return {
            summary: `email_event_guests: ${matches.length} events match "${args.titleContains}" - ask which`,
            data: {
              recipients: [],
              instruction: LOCAL_WHEN_INSTRUCTION,
              candidates: matches.map((e) => ({ id: e.id, title: e.title, when: localWhen(e.startsAt, tz) })),
            },
          };
        }
      }
      if (!target) {
        return { summary: 'email_event_guests: no matching event', data: { recipients: [], found: false } };
      }
      const people = await providerEventPeople(db, target.id);
      if (people === null) {
        return {
          summary: `email_event_guests: could not read the guests of "${target.title}" from the calendar`,
          data: {
            recipients: [],
            instruction: 'The calendar could not be reached. Say so; do not guess who is on the event.',
          },
        };
      }
      const me = await db.selectFrom('users').select('email').where('id', '=', actorUserId).executeTakeFirst();
      const recipients = eventReplyAllRecipients(people?.guests, people?.organizer, [me?.email]);
      if (recipients.length === 0) {
        return {
          summary: `email_event_guests: "${target.title}" has nobody else on it`,
          data: { recipients: [], title: target.title },
        };
      }
      return {
        summary: `email_event_guests: ${recipients.length} on "${target.title}"`,
        card: {
          kind: 'email',
          title: `Write to everyone on ${target.title}`,
          subtitle: recipients.join(', '),
          meta: localWhen(target.startsAt, tz),
          href: eventComposeHref(recipients, target.title),
        },
        data: { recipients, title: target.title, when: localWhen(target.startsAt, tz) },
      };
    }

    // ADR 0214. Compose + forward are only reached through `mode: 'commit'` —
    // the user tapped Send on the staged card. They go through the composer's
    // own draft + outbox path, so the undo window and the failed-send-returns-
    // to-Drafts behaviour (ADR 0115) apply to chat exactly as to the app.
    case 'compose_email': {
      const args = call.args as {
        to: string[];
        cc?: string[];
        subject: string;
        body: string;
        fromMailbox?: string;
        fromAddress?: string;
      };
      if (!actorUserId) return { summary: 'compose_email: no actor' };
      const out = await queueComposedEmail(db, actorUserId, args);
      if (!out.ok) {
        return {
          summary: `compose_email: ${out.reason}`,
          data: {
            sent: false,
            reason: out.reason,
            instruction:
              out.reason === 'mailbox_unavailable'
                ? `The mailbox this email was to go from (${args.fromAddress ?? 'the one on the card'}) can no longer send — it may need reconnecting in Settings → Connected accounts. Nothing was sent. Say so and offer to send it again. Do NOT claim the email was sent.`
                : 'No mailbox Chord can send from is connected. Say so and point the user to Settings → Connected accounts. Do NOT claim the email was sent.',
          },
        };
      }
      return {
        summary: `compose_email: queued "${args.subject}" to ${args.to.join(', ')}`,
        card: { kind: 'email', title: 'Email sending', subtitle: args.subject },
        data: { sent: true, sendAfter: out.sendAfter, undo: 'Say "unsend that" before sendAfter to stop it.' },
      };
    }

    case 'forward_email': {
      const args = call.args as {
        threadId: string;
        to: string[];
        cc?: string[];
        note?: string;
        includeAttachments?: boolean;
        threadSubject?: string;
        messageId?: string;
      };
      if (!actorUserId) return { summary: 'forward_email: no actor' };
      const out = await queueForwardedEmail(db, actorUserId, args);
      if (!out.ok) {
        return {
          summary: `forward_email: ${out.reason}`,
          data: { sent: false, reason: out.reason },
        };
      }
      return {
        summary: `forward_email: queued "${args.threadSubject ?? args.threadId}" to ${args.to.join(', ')}`,
        card: {
          kind: 'email',
          title: 'Forward sending',
          subtitle: args.threadSubject,
          href: `/email/${args.threadId}`,
        },
        data: { sent: true, sendAfter: out.sendAfter, undo: 'Say "unsend that" before sendAfter to stop it.' },
      };
    }

    case 'cancel_email_send': {
      if (!actorUserId) return { summary: 'cancel_email_send: no actor' };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'cancel_email_send: refused — personal chats only', data: { cancelled: false } };
      }
      const out = await cancelLatestQueuedSend(db, actorUserId);
      return out.cancelled
        ? {
            summary: `cancel_email_send: stopped "${out.subject}"`,
            data: { cancelled: true, subject: out.subject, to: out.to },
          }
        : {
            summary: 'cancel_email_send: nothing waiting — already sent',
            data: { cancelled: false, reason: 'already_sent' },
          };
    }

    case 'read_email': {
      const args = call.args as { threadId: string; maxMessages?: number };
      if (!actorUserId) return { summary: 'read_email: no actor' };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'read_email: refused — personal chats only', data: { found: false } };
      }
      const thread = await readEmailThread(db, actorUserId, args.threadId, args.maxMessages, tz);
      if (!thread) {
        return { summary: 'read_email: thread not found', data: { found: false } };
      }
      return {
        summary: `read_email: "${thread.subject}" (${thread.messages.length} of ${thread.messageCount} message(s))`,
        data: { found: true, ...thread },
      };
    }

    case 'delete_messages': {
      const args = call.args as {
        scope: 'last' | 'all';
        count?: number;
        messageIds?: string[];
        forUserId?: string;
      };
      if (!actorUserId) return { summary: 'delete_messages: no actor' };
      if (args.forUserId && args.forUserId !== actorUserId) {
        return {
          summary: 'delete_messages: only the person who asked can confirm this',
          data: { deleted: 0, reason: 'not_the_asker' },
        };
      }
      const ids =
        args.scope === 'all'
          ? undefined
          : args.messageIds ??
            (await recentDeletableMessageIds(db, {
              groupId,
              userId: actorUserId,
              count: args.count ?? 1,
              exceptId: input.triggeringMessageId ?? null,
            }));
      if (ids && ids.length === 0) {
        return {
          summary: 'delete_messages: there is no message here to delete',
          data: { deleted: 0, reason: 'nothing_to_delete' },
        };
      }
      const out = await deleteMessages(db, {
        groupId,
        userId: actorUserId,
        ids,
        all: args.scope === 'all',
      });
      if (out.forEveryone) {
        for (const batch of deletedIdBatches(out.deletedIds)) {
          emit(groupId, SSE.messagesDeleted, { groupId, ids: batch });
        }
      }
      return {
        summary: out.forEveryone
          ? `delete_messages: deleted ${out.deleted} message(s)`
          : `delete_messages: removed ${out.deleted} message(s) from this user's view only; other members still see them`,
        data: { deleted: out.deleted, forEveryone: out.forEveryone },
      };
    }

    case 'set_email_signature': {
      const args = call.args as {
        text?: string;
        html?: string;
        clear?: boolean;
        mailbox?: string;
        useShared?: boolean;
        pictureFileId?: string;
      };
      if (!actorUserId) return { summary: 'set_email_signature: no actor' };
      // A mailbox only when the conversation named it: models fill optional
      // fields (ADR 0229), and a guessed mailbox would leave the others on the
      // old signature while the bot says it changed.
      const mailboxName = args.mailbox?.trim();
      const named =
        !!mailboxName &&
        (await askedInConversation(db, input.triggeringMessageId, (text) => namesMailbox(text, mailboxName))) !== 'no';
      // ADR 0326 - a picture sent in this chat, added to the signature.
      const pic =
        args.pictureFileId?.trim() && !args.clear && !args.useShared
          ? await signaturePictureFromAttachment(db, {
              attachmentId: args.pictureFileId.trim(),
              groupId,
              userId: actorUserId,
            })
          : null;
      if (pic) {
        // An id that names nothing here, beside text to save, is a filled-in
        // field (ADR 0229): save the text and leave pictures out of it.
        const madeUp = !pic.ok && pic.reason === 'not_found' && !!(args.text?.trim() || args.html?.trim());
        if (!pic.ok && !madeUp) {
          return {
            summary: `set_email_signature: picture ${pic.reason}`,
            data: {
              ok: false,
              reason: `picture_${pic.reason}`,
              instruction:
                pic.reason === 'not_found'
                  ? 'That picture is not one sent in this chat. NOTHING was saved.'
                  : pic.reason === 'not_an_image'
                    ? 'That file is not a picture. NOTHING was saved.'
                    : 'That picture could not be kept. NOTHING was saved.',
            },
          };
        }
      }
      if (pic?.ok) {
        let base: string | null = null;
        if (args.html?.trim()) base = args.html.trim();
        else if (args.text?.trim()) base = plainTextToSignatureHtml(args.text.trim());
        else {
          // No new text: the picture goes under the signature there now.
          const found = named && mailboxName ? await matchMailboxByName(db, actorUserId, mailboxName) : null;
          const now = await mailboxSignatureRow(db, actorUserId, found?.ok ? found.mailbox.accountId : null);
          base = now.email_signature_html?.trim() || (now.email_signature?.trim() ? plainTextToSignatureHtml(now.email_signature.trim()) : null);
        }
        const tag = signaturePictureTag(pic.url);
        args.html = base ? `${base}<br>${tag}` : tag;
        args.text = undefined;
      }
      if (named && mailboxName) {
        if (!args.useShared && !args.clear && args.text === undefined && args.html === undefined) {
          return { summary: 'set_email_signature: nothing to set', data: { ok: false, reason: 'empty' } };
        }
        const out = await setMailboxSignature(
          db,
          actorUserId,
          { name: mailboxName },
          args.useShared
            ? { useShared: true }
            : args.clear
              ? { text: '' }
              : { text: args.text, html: args.html },
        );
        if (!out.ok) {
          return {
            summary: `set_email_signature: mailbox ${out.reason}`,
            data:
              out.reason === 'ambiguous'
                ? { ok: false, reason: out.reason, candidates: out.candidates.map((c) => c.label), instruction: 'Ask which mailbox they mean. NOTHING was saved.' }
                : { ok: false, reason: out.reason, instruction: 'No such mailbox. NOTHING was saved.' },
          };
        }
        return {
          summary: `set_email_signature: ${out.mailbox.label} ${out.own ? (out.signature ? 'has its own signature' : 'sends no signature') : 'uses the shared signature again'}`,
          data: { ok: true, mailbox: out.mailbox.label, address: out.mailbox.address, own: out.own, plainText: out.signature },
        };
      }
      if (!args.clear && !args.text?.trim() && !args.html?.trim()) {
        return { summary: 'set_email_signature: nothing to set', data: { ok: false, reason: 'empty' } };
      }
      const patch = args.clear ? signaturePatch({ text: '', html: '' }) : signaturePatch({ text: args.text, html: args.html });
      await db.updateTable('users').set(patch).where('id', '=', actorUserId).execute();
      const rich = !!patch.email_signature_html;
      return {
        summary: args.clear
          ? 'set_email_signature: signature removed'
          : `set_email_signature: ${rich ? 'rich (HTML)' : 'plain-text'} signature saved`,
        data: {
          ok: true,
          rich,
          plainText: patch.email_signature ?? null,
          cleared: !!args.clear,
          appliesTo: 'every mailbox without a signature of its own',
        },
      };
    }

    case 'leave_group':
    case 'delete_group': {
      const tool = call.name;
      const args = call.args as { groupName: string; groupId?: string; forUserId?: string };
      if (!actorUserId) return { summary: `${tool}: no actor` };
      if (args.forUserId && args.forUserId !== actorUserId) {
        return { summary: `${tool}: only the person who asked can confirm this`, data: { ok: false, reason: 'not_the_asker' } };
      }
      // Only ever reached from a staged card, which carries the id it named.
      if (!args.groupId) return { summary: `${tool}: no chat was chosen`, data: { ok: false, reason: 'needs_confirmation' } };
      const out =
        tool === 'leave_group'
          ? await leaveGroupAs(db, args.groupId, actorUserId)
          : await deleteGroupAs(db, args.groupId, actorUserId);
      if (!out.ok) {
        return { summary: `${tool}: ${out.reason}`, data: { ok: false, reason: out.reason } };
      }
      // The last member leaving deletes the chat, like the route: close open streams.
      if (tool === 'delete_group' || ('deleted' in out && out.deleted)) {
        sseHub.closeChannel(args.groupId, 'group_deleted');
      }
      return {
        summary: tool === 'leave_group' ? `leave_group: left "${args.groupName}"` : `delete_group: deleted "${args.groupName}" for everyone`,
        data: { ok: true, groupName: args.groupName },
      };
    }

    case 'trash_email': {
      const args = call.args as { threadId: string; threadSubject?: string };
      if (!actorUserId) return { summary: 'trash_email: no actor' };
      const out = await trashEmailThread(db, actorUserId, args.threadId);
      if (!out.ok) {
        return {
          summary: `trash_email: ${out.message ?? out.reason}`,
          data: { trashed: false, reason: out.reason, message: out.message },
        };
      }
      return {
        summary: `trash_email: moved "${args.threadSubject ?? args.threadId}" to Trash`,
        data: { trashed: true },
      };
    }

    case 'update_email': {
      const args = call.args as {
        threadIds: string[];
        markRead?: boolean;
        archive?: boolean;
        addLabels?: string[];
        removeLabels?: string[];
      };
      if (!actorUserId) return { summary: 'update_email: no actor' };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'update_email: refused — personal chats only', data: { changed: 0 } };
      }
      if (
        args.markRead === undefined &&
        args.archive === undefined &&
        !args.addLabels?.length &&
        !args.removeLabels?.length
      ) {
        return { summary: 'update_email: nothing to change', data: { changed: 0, reason: 'empty' } };
      }
      const results = await changeEmailThreads(db, actorUserId, args.threadIds, args);
      const ok = results.filter((r) => r.ok);
      const failed = results.length - ok.length;
      return {
        summary: `update_email: changed ${ok.length} of ${results.length} thread(s)${failed ? ` — ${failed} could not be changed` : ''}`,
        data: {
          changed: ok.length,
          results,
          ...(failed
            ? {
                instruction:
                  'Say which emails could not be changed and do not claim they were. not_connected = their Gmail needs reconnecting in Settings; refused = the mailbox cannot do it (repeat `message`); not_found = the id did not match an email, search again.',
              }
            : {}),
        },
      };
    }

    case 'update_emails_matching': {
      const args = call.args as {
        threadIds?: string[];
        forUserId?: string;
        markRead?: boolean;
        archive?: boolean;
        addLabels?: string[];
        removeLabels?: string[];
      };
      if (!actorUserId) return { summary: 'update_emails_matching: no actor' };
      if (args.forUserId && args.forUserId !== actorUserId) {
        return {
          summary: 'update_emails_matching: only the person who asked can confirm this',
          data: { changed: 0, reason: 'not_the_asker' },
        };
      }
      // Only ever reached from a staged card, which carries the emails it counted.
      if (!args.threadIds) {
        return { summary: 'update_emails_matching: no emails were chosen', data: { changed: 0, reason: 'needs_confirmation' } };
      }
      const results = await changeEmailThreads(db, actorUserId, args.threadIds, args);
      const changed = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok);
      return {
        summary: `update_emails_matching: changed ${changed} of ${results.length} email(s)${failed.length ? ` — ${failed.length} could not be changed` : ''}`,
        data: {
          changed,
          failed: failed.length,
          ...(failed.length ? { failedReasons: [...new Set(failed.map((f) => (f.ok ? '' : f.reason)))] } : {}),
        },
      };
    }

    case 'list_subscriptions': {
      const args = call.args as { sinceDays?: number };
      if (!actorUserId) return { summary: 'list_subscriptions: no actor' };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'list_subscriptions: refused — personal chats only', data: { senders: [] } };
      }
      const sinceDays = args.sinceDays ?? 90;
      // 'drop': a list already left is not suggested again unless it kept mailing.
      const senders = await listSubscriptions(db, actorUserId, { sinceDays, left: 'drop' });
      return {
        summary: `list_subscriptions: ${senders.length} mailing list(s) in the last ${sinceDays} days`,
        data: {
          sinceDays,
          senders: senders.map(subscriptionRow),
          instruction:
            'These are mailing lists, not paid subscriptions. Offer to unsubscribe; do not unsubscribe unasked. Lists the user already left are NOT here unless they kept mailing: never repeat an earlier answer from memory, use these rows. A row with stillMailing true was already asked to stop on requestedAt and has sent `messages` since: say so, and offer trash_future_mail instead of unsubscribing again.',
        },
      };
    }

    case 'query_mail_senders': {
      const args = call.args as {
        rank: SenderRank;
        sinceDays?: number;
        quietDays?: number;
        includeBulk?: boolean;
        limit?: number;
      };
      if (!actorUserId) return { summary: 'query_mail_senders: no actor' };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'query_mail_senders: refused — personal chats only', data: { rows: [] } };
      }
      const rows = await senderStats(db, actorUserId, args);
      return {
        summary: `query_mail_senders (${args.rank}): ${rows.length} sender(s)`,
        data: {
          rank: args.rank,
          countMeans: args.rank === 'awaiting_reply' ? 'threads still needing a reply' : 'messages',
          whenMeans: args.rank === 'awaiting_reply' ? 'oldest waiting thread' : 'newest message',
          rows: rows.map((r) => ({
            email: r.email,
            name: r.name,
            count: r.count,
            when: localWhen(r.lastAt, tz),
            inPeople: r.inPeople,
            ...(r.unsubscribedAt ? { unsubscribedAt: r.unsubscribedAt } : {}),
          })),
          instruction:
            'Counts cover the mail Chord has mirrored, not the whole mailbox history. Offer add_person for real people with inPeople false; never add unasked.',
        },
      };
    }

    case 'query_receipts': {
      const args = call.args as {
        merchant?: string;
        after?: string;
        before?: string;
        groupBy?: 'merchant' | 'month';
        recurring?: boolean;
        limit?: number;
      };
      if (!actorUserId) return { summary: 'query_receipts: no actor' };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'query_receipts: refused — personal chats only', data: { count: 0, receipts: [] } };
      }
      // Day bounds are the user's days: "in September" ends at their midnight.
      const after = args.after ? zonedDayStartUtc(args.after, tz ?? null).toISOString() : undefined;
      const before = args.before ? zonedDayEndUtc(args.before, tz ?? null).toISOString() : undefined;
      const { receipts, truncated } = await listReceipts(db, actorUserId, {
        merchant: args.merchant,
        after,
        before,
      });
      const row = (r: Receipt) => ({
        merchant: r.merchant,
        amount: r.amount,
        currency: r.currency,
        when: localWhen(r.at, tz),
        orderNumber: r.orderNumber,
        paidWith: r.paymentMethod,
        mailbox: r.mailbox,
      });
      const coverage =
        'Only purchases whose receipt arrived by email and that Chord has read. Not total spending.';
      if (args.recurring) {
        const recurring = detectRecurring(receipts);
        return {
          summary: `query_receipts: ${recurring.length} repeating charge(s)`,
          data: {
            count: recurring.length,
            recurring: recurring.map((c) => ({
              merchant: c.merchant,
              amount: c.amount,
              currency: c.currency,
              cadence: c.cadence,
              charges: c.charges,
              lastCharge: localWhen(c.lastAt, tz),
              nextExpectedAt: c.nextExpectedAt,
              nextExpected: localWhen(c.nextExpectedAt, tz),
            })),
            truncated,
            coverage: `${coverage} A charge appears here only after it repeated at an even spacing at least 3 times, so the list may be incomplete; nextExpected is a guess from the pattern.`,
          },
          cards: recurring.slice(0, 6).map((c) => ({
            kind: 'email' as const,
            title: c.merchant,
            subtitle: `${formatMoney(c.amount, c.currency)} ${c.cadence}`,
            meta: `last ${c.lastAt.slice(0, 10)}`,
            // ADR 0249 — the email may have been deleted; the card then opens nothing.
            ...(c.threadId ? { href: `/email/${c.threadId}` } : {}),
          })),
        };
      }
      const shown = receipts.slice(0, args.limit ?? 10);
      const groups = args.groupBy
        ? summarizeSpending(receipts, args.groupBy, tz ? (tzToOffsetMinutes(tz) ?? 0) : 0)
        : undefined;
      return {
        summary: `query_receipts: ${receipts.length} receipt(s)${args.merchant ? ` matching "${args.merchant}"` : ''}`,
        data: {
          count: receipts.length,
          totals: summarizeSpending(receipts, 'month')
            .reduce<Array<{ currency: string; total: number }>>((acc, g) => {
              const t = acc.find((a) => a.currency === g.currency);
              if (t) t.total = Math.round((t.total + g.total) * 100) / 100;
              else acc.push({ currency: g.currency, total: g.total });
              return acc;
            }, []),
          receipts: shown.map(row),
          ...(groups
            ? { groups: groups.map((g) => ({ key: g.key, currency: g.currency, total: g.total, count: g.count })) }
            : {}),
          truncated,
          coverage,
        },
        cards: shown.slice(0, 6).map((r) => ({
          kind: 'email' as const,
          title: r.merchant,
          subtitle: formatMoney(r.amount, r.currency),
          meta: r.at.slice(0, 10),
          ...(r.threadId ? { href: `/email/${r.threadId}` } : {}),
        })),
      };
    }

    case 'add_mail_filter': {
      const args = call.args as { from: string; folder: string; alsoExisting?: boolean; matches?: string[]; who?: string };
      if (!actorUserId) return { summary: 'add_mail_filter: no actor' };
      let matches = args.matches ?? [];
      let who = args.who ?? args.from;
      if (!matches.length) {
        const r = await resolveFilterFrom(db, actorUserId, args.from);
        if (!r.ok) {
          return { summary: `add_mail_filter: ${r.reason} "${args.from}"; nothing changed`, data: { ok: false, reason: r.reason } };
        }
        matches = r.matches;
        who = r.who;
      }
      let last: Awaited<ReturnType<typeof addFilingRule>> | null = null;
      for (const m of matches) {
        last = await addFilingRule(db, actorUserId, { from: m, folder: args.folder, alsoExisting: args.alsoExisting });
        if (!last.ok) break;
      }
      if (!last?.ok) {
        return {
          summary: `add_mail_filter: not added (${last?.reason ?? 'no match'})`,
          data: { ok: false, reason: last?.reason ?? 'bad_match' },
        };
      }
      return {
        summary: `add_mail_filter: mail from ${who} now goes to "${last.rule.folder}"`,
        data: {
          ok: true,
          who,
          matches,
          folder: last.rule.folder,
          alsoExisting: args.alsoExisting === true,
          instruction:
            'Say that from now on mail from them goes into that folder on their own mailbox (made there if it was not), ' +
            (args.alsoExisting
              ? 'including what is already in the inbox, which moves over the next few syncs; '
              : 'only new mail, so what is already in the inbox stays put; ') +
            'it happens after each sync, and nothing is deleted. Say they can ask to remove the filter.',
        },
      };
    }

    case 'list_mail_filters': {
      if (!actorUserId) return { summary: 'list_mail_filters: no actor' };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'list_mail_filters: refused — personal chats only', data: { filters: [] } };
      }
      const rules = await listFilingRules(db, actorUserId);
      return {
        summary: `list_mail_filters: ${rules.length} filter(s)`,
        data: {
          filters: rules.map((r) => ({
            from: r.kind === 'domain' ? `anyone at ${r.value}` : r.value,
            folder: r.folder,
            since: Date.parse(r.since) === 0 ? 'all mail' : r.since.slice(0, 10),
          })),
        },
      };
    }

    case 'remove_mail_filter': {
      const args = call.args as { from?: string; folder?: string };
      if (!actorUserId) return { summary: 'remove_mail_filter: no actor' };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'remove_mail_filter: refused — personal chats only', data: { ok: false } };
      }
      const rules = await listFilingRules(db, actorUserId);
      let values: string[] | null = null;
      if (args.from) {
        const r = await resolveFilterFrom(db, actorUserId, args.from);
        values = r.ok ? r.matches : [args.from.trim().toLowerCase()];
      }
      const folderKey = args.folder?.trim().toLowerCase();
      const doomed = rules.filter(
        (r) =>
          (values === null || values.includes(r.value)) &&
          (folderKey === undefined || r.folder.toLowerCase() === folderKey) &&
          (values !== null || folderKey !== undefined),
      );
      if (doomed.length) await removeFilingRules(db, actorUserId, doomed.map((r) => r.id));
      return {
        summary: `remove_mail_filter: removed ${doomed.length}`,
        data: {
          ok: doomed.length > 0,
          removed: doomed.map((r) => ({ from: r.value, folder: r.folder })),
        },
      };
    }

    case 'trash_future_mail': {
      const args = call.args as { senders: string[]; senderEmails?: string[]; senderNames?: string[] };
      if (!actorUserId) return { summary: 'trash_future_mail: no actor' };
      let emails = args.senderEmails ?? [];
      let names = args.senderNames ?? [];
      if (!emails.length) {
        for (const sender of args.senders) {
          const r = await resolveMailSender(db, actorUserId, sender);
          if (!('problem' in r)) {
            emails = [...emails, ...r.emails];
            names = [...names, r.name];
          }
        }
      }
      if (!emails.length) {
        return { summary: 'trash_future_mail: no sender found; nothing changed', data: { ok: false } };
      }
      const { refused } = await setAutoTrash(db, actorUserId, emails, true);
      if (refused.length === emails.length) {
        return {
          summary: 'trash_future_mail: the list of senders sent to Trash is full; nothing changed',
          data: {
            ok: false,
            reason: 'too_many',
            instruction:
              'Say NOTHING was changed: the list of senders whose mail goes to Trash is full. Offer to stop ' +
              'trashing an old sender first.',
          },
        };
      }
      const who = (names.length ? names : emails).join(', ');
      return {
        summary: `trash_future_mail: future mail from ${who} now goes to Trash`,
        data: {
          ok: true,
          senders: names.length ? names : emails,
          ...(refused.length ? { notAdded: refused } : {}),
          instruction:
            'Say that from now on new mail from these senders goes to Trash (not deleted for good), that mail ' +
            'already there was left alone, and that they can say "stop trashing <name>" to undo it.' +
            (refused.length
              ? ' Also say the list was full, so these addresses were NOT added: ' + refused.join(', ') + '.'
              : ''),
        },
      };
    }

    case 'stop_trashing_mail': {
      const args = call.args as { senders: string[] };
      if (!actorUserId) return { summary: 'stop_trashing_mail: no actor' };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'stop_trashing_mail: refused — personal chats only', data: { ok: false } };
      }
      const rules = await listAutoTrash(db, actorUserId);
      const stopped: string[] = [];
      const notFound: string[] = [];
      for (const sender of args.senders) {
        const needle = sender.trim().toLowerCase();
        const exact = rules.find((r) => r.sender === needle);
        const r = exact ? null : await resolveMailSender(db, actorUserId, sender);
        const candidates = exact ? [exact.sender] : r && !('problem' in r) ? r.emails : [];
        const hits = candidates.filter((e) => rules.some((x) => x.sender === e));
        if (hits.length) stopped.push(...hits);
        else notFound.push(sender);
      }
      if (stopped.length) await setAutoTrash(db, actorUserId, stopped, false);
      return {
        summary: `stop_trashing_mail: stopped ${stopped.length}${notFound.length ? `; not trashing ${notFound.join(', ')}` : ''}`,
        data: { ok: stopped.length > 0, stopped, notFound },
      };
    }

    case 'unsubscribe_from_senders': {
      const args = call.args as { senders: string[]; senderEmails?: string[] };
      if (!actorUserId) return { summary: 'unsubscribe_from_senders: no actor' };
      // A confirmed card carries the addresses it showed; a direct call resolves
      // each name the way the card would have.
      let emails = args.senderEmails;
      if (!emails?.length) {
        emails = [];
        for (const sender of args.senders) {
          const m = await resolveSubscriptionSender(db, actorUserId, sender);
          if (m.ok) emails.push(...m.senders.map((s) => s.senderEmail));
        }
      }
      const { results } = await unsubscribeFromSenders(db, actorUserId, emails);
      const line = (r: (typeof results)[number]) => `${r.senderName ?? r.senderEmail}: ${r.message}`;
      const needsYou = results.filter((r) => r.needsYou);
      // One "open their page" card per list Chord could not leave and that has a page.
      const pageCards = needsYou
        .filter((r) => r.url)
        .map((r) => unsubscribeLinkCard(r.senderName ?? r.senderEmail, r.url!));
      return {
        summary: `unsubscribe_from_senders: ${results.map(line).join(' · ')}`,
        data: {
          results: results.map((r) => ({
            sender: r.senderName ?? r.senderEmail,
            senderEmail: r.senderEmail,
            kind: r.kind,
            unsubscribed: r.unsubscribed,
            requested: r.requested ?? false,
            ...(r.skipped ? { skipped: r.skipped } : {}),
            ...(r.needsYou ? { needsYou: true } : {}),
            ...(r.autoTrash ? { autoTrash: true } : {}),
            message: r.message,
          })),
          instruction: needsYou.length
            ? `${UNSUBSCRIBE_OUTCOME_INSTRUCTION} ${UNSUBSCRIBE_NEEDS_YOU_INSTRUCTION}`
            : UNSUBSCRIBE_OUTCOME_INSTRUCTION,
        },
        ...(pageCards.length ? { cards: pageCards } : {}),
      };
    }

    case 'unsubscribe_from_sender': {
      const args = call.args as { sender: string; senderEmail?: string };
      if (!actorUserId) return { summary: 'unsubscribe_from_sender: no actor' };
      // A confirmed card carries the address it showed; a direct call resolves
      // the same way the card would have.
      const match = await resolveSubscriptionSender(db, actorUserId, args.senderEmail ?? args.sender);
      if (!match.ok) {
        return {
          summary: `unsubscribe_from_sender: no single mailing list matches "${args.sender}"`,
          data: {
            unsubscribed: false,
            reason: match.reason,
            candidates: match.candidates.map(subscriptionRow),
          },
        };
      }
      const out = await unsubscribeThread(db, actorUserId, match.sender.threadId);
      const who = match.sender.senderName ?? match.sender.senderEmail;
      const needsYou = !out.unsubscribed && !out.requested;
      return {
        summary: `unsubscribe_from_sender: ${who} — ${out.message}`,
        data: {
          sender: who,
          senderEmail: match.sender.senderEmail,
          kind: out.kind,
          unsubscribed: out.unsubscribed,
          requested: out.requested ?? false,
          ...(needsYou ? { needsYou: true } : {}),
          ...(match.sender.autoTrash ? { autoTrash: true } : {}),
          message: out.message,
          instruction: needsYou
            ? `${UNSUBSCRIBE_OUTCOME_INSTRUCTION} ${UNSUBSCRIBE_NEEDS_YOU_INSTRUCTION}`
            : UNSUBSCRIBE_OUTCOME_INSTRUCTION,
        },
        ...(out.url ? { card: unsubscribeLinkCard(who, out.url) } : {}),
      };
    }

    case 'set_feature_tips': {
      const args = call.args as { enabled?: boolean };
      if (!actorUserId) return { summary: 'set_feature_tips: no actor' };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'set_feature_tips: refused — personal chats only', data: { ok: false } };
      }
      const on = await setFeatureTips(db, actorUserId, args.enabled ?? null);
      return {
        summary: `set_feature_tips: feature tips ${on ? 'on' : 'off'}`,
        data: { ok: true, enabled: on },
      };
    }

    case 'set_email_digest': {
      const args = call.args as { enabled: boolean };
      if (!actorUserId) return { summary: 'set_email_digest: no actor' };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'set_email_digest: refused — personal chats only', data: { ok: false } };
      }
      await setEmailDigestEnabled(db, actorUserId, args.enabled);
      return {
        summary: `set_email_digest: email section ${args.enabled ? 'on' : 'off'}`,
        data: { ok: true, enabled: args.enabled },
      };
    }

    case 'withdraw_ai_consent': {
      if (!actorUserId) return { summary: 'withdraw_ai_consent: no actor' };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'withdraw_ai_consent: refused — personal chats only', data: { ok: false } };
      }
      await setAiConsent(db, actorUserId, {
        decision: 'declined',
        recipient: await aiRecipient(db, actorUserId),
      });
      return {
        summary: 'withdraw_ai_consent: Chord AI is now off for this user',
        data: {
          ok: true,
          instruction:
            'AI is now off for this user. Say so in one line, and that replying AGREE or Settings → AI model turns it back on. This is your last reply until they do.',
        },
      };
    }

    case 'set_briefing_channel': {
      const args = call.args as { muted: boolean; groupName?: string };
      if (!actorUserId) return { summary: 'set_briefing_channel: no actor' };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'set_briefing_channel: refused — personal chats only', data: { ok: false } };
      }
      const out = await setBriefingChannelByName(db, actorUserId, args.muted, args.groupName);
      if (!out.ok) {
        return {
          summary: `set_briefing_channel: ${out.reason}`,
          data: {
            ok: false,
            reason: out.reason,
            channels: out.channels.map((c) => ({ groupName: c.groupName, muted: c.optedOut })),
          },
        };
      }
      return {
        summary: `set_briefing_channel: ${out.channel.groupName} ${args.muted ? 'muted' : 'resumed'}`,
        data: { ok: true, groupName: out.channel.groupName, muted: args.muted },
      };
    }

    case 'find_conflicts': {
      const args = call.args as { startsAt: string; endsAt: string };
      if (!actorUserId) {
        return { summary: 'find_conflicts: no actor', data: { conflicts: [] } };
      }
      await maybeSyncCalendar(db, actorUserId);
      // Deterministic (shared with the event-created nudge via computeConflicts).
      // ONLY block-setting calendars (+ Chord-native) count — informational
      // calendars and free/all-day events are never returned. Scoped to the
      // current group (ADR 0032); exact-interval overlap (1h default for no-end).
      const conflicts = await computeConflicts(db, {
        userId: actorUserId,
        startIso: new Date(args.startsAt).toISOString(),
        endIso: new Date(args.endsAt).toISOString(),
        groupId,
      });
      return {
        summary: `find_conflicts: ${conflicts.length} in ${localWhen(args.startsAt, tz)}…${localWhen(args.endsAt, tz)}`,
        data: {
          instruction: LOCAL_WHEN_INSTRUCTION,
          conflicts: conflicts.map((c) => ({
            ...c,
            when: localWhen(c.startsAt, tz),
            until: localWhenOrNull(c.endsAt, tz),
          })),
        },
      };
    }

    case 'delete_event': {
      const args = call.args as {
        eventId?: string;
        titleContains?: string;
        date?: string;
        scope?: 'this' | 'all';
      };
      let target = args.eventId
        ? await resolveEventInGroup(db, groupId, args.eventId)
        : null;
      // Cross-group fallback for the eventId path: a conflict the bot was asked
      // to resolve may live in another of the user's groups (the conflict nudge
      // is owner-scoped across groups, ADR 0040 §8). Resolving only in-group
      // would silently fail and the bot would claim a drop that never happened.
      // Restrict to the actor's OWN copies — this is the user acting on their
      // own calendar, not a cross-group read of someone else's data (ADR 0032).
      if (!target && args.eventId && actorUserId) {
        const owned = await getEvent(db, args.eventId);
        if (owned && owned.ownerUserId === actorUserId) target = owned;
      }
      if (!target && args.titleContains) {
        // Prefer in-group matches; widen to the user's own copies across groups
        // only when nothing matches here (same owner-scoped conflict-resolution
        // path as the eventId fallback above). findEventsByTitle matches in SQL
        // rather than scanning a chronologically-truncated list, so a title hit
        // is never lost behind a long calendar history (see its doc comment).
        let matches = await findEventsByTitle(db, { groupId }, args.titleContains, args.date, tz);
        if (matches.length === 0 && actorUserId) {
          matches = await findEventsByTitle(db, { ownerUserId: actorUserId }, args.titleContains, args.date, tz);
        }
        matches = collapseSeriesMatches(matches);
        if (matches.length === 1) {
          target = matches[0];
        } else if (matches.length > 1) {
          // Ambiguous — don't guess which one to destroy. Hand the candidates
          // back so the bot can ask the user which one(s) to remove. The bot
          // must surface this to the user, not silently give up.
          return {
            summary: `delete_event: ${matches.length} events match "${args.titleContains}" — ask the user which one(s) to delete`,
            data: {
              deleted: false,
              instruction: LOCAL_WHEN_INSTRUCTION,
              candidates: matches.map((e) => ({
                id: e.id,
                title: e.title,
                startsAt: e.startsAt,
                when: localWhen(e.startsAt, tz),
                location: e.location ?? null,
              })),
            },
          };
        }
      }
      if (!target) {
        return {
          summary: 'delete_event: no matching event in this group',
          data: { deleted: false },
        };
      }
      // ADR 0217 — one occurrence, or the whole series: the user says which.
      if (target.seriesId) {
        if (!args.scope) return scopeRequired('delete_event', target, tz);
        const row = await db.selectFrom('events').selectAll().where('id', '=', target.id).executeTakeFirst();
        if (!row) return { summary: 'delete_event: event vanished', data: { deleted: false } };
        const removed = args.scope === 'all' ? await deleteSeries(db, row) : await deleteOccurrence(db, row);
        for (const r of removed) {
          emit(target.groupId, SSE.eventDeleted, { id: r.id, ownerUserId: r.ownerUserId ?? undefined });
        }
        return {
          summary:
            args.scope === 'all'
              ? `delete_event: removed every occurrence of "${target.title}"`
              : `delete_event: removed only "${target.title}" on ${localWhen(target.startsAt, tz)}; the rest still repeat`,
          data: { deleted: true, id: target.id, title: target.title, scope: args.scope },
        };
      }
      // Per-owner SSE: broadcast each copy actually removed (all siblings for
      // an organizer delete, just one for an attendee). Broadcast on the event's
      // OWN group channel (a fan-out set shares one group_id), not the
      // conversation's — these can differ when resolving a cross-group conflict.
      for (const r of await deleteEvent(db, target.id)) {
        emit(target.groupId, SSE.eventDeleted, { id: r.id, ownerUserId: r.ownerUserId ?? undefined });
      }
      return {
        summary: `delete_event: removed "${target.title}" (${localWhen(target.startsAt, tz)})`,
        data: { deleted: true, id: target.id, title: target.title },
      };
    }

    case 'update_event': {
      const args = call.args as {
        eventId?: string;
        titleContains?: string;
        date?: string;
        title?: string;
        startsAt?: string;
        endsAt?: string;
        location?: string;
        timeZone?: string;
        durationMinutes?: number;
        confirmPast?: boolean;
        invitees?: string[];
        removeInvitees?: string[];
        videoCall?: boolean;
        repeat?: RepeatSpec;
        scope?: 'this' | 'all';
        calendar?: string;
      };
      // Resolve the target event (same shape as delete_event): exact id first,
      // then an owner-scoped cross-group fallback, then titleContains (+date).
      // Ambiguous matches are handed back so the bot asks which one rather than
      // editing the wrong event — or, worse, creating a duplicate.
      let target = args.eventId
        ? await resolveEventInGroup(db, groupId, args.eventId)
        : null;
      if (!target && args.eventId && actorUserId) {
        const owned = await getEvent(db, args.eventId);
        if (owned && owned.ownerUserId === actorUserId) target = owned;
      }
      if (!target && args.titleContains) {
        // findEventsByTitle matches in SQL rather than scanning a
        // chronologically-truncated list, so a title hit is never lost
        // behind a long calendar history (see its doc comment).
        let matches = await findEventsByTitle(db, { groupId }, args.titleContains, args.date, tz);
        if (matches.length === 0 && actorUserId) {
          matches = await findEventsByTitle(db, { ownerUserId: actorUserId }, args.titleContains, args.date, tz);
        }
        matches = collapseSeriesMatches(matches);
        if (matches.length === 1) {
          target = matches[0];
        } else if (matches.length > 1) {
          return {
            summary: `update_event: ${matches.length} events match "${args.titleContains}" — ask the user which one`,
            data: {
              updated: false,
              instruction: LOCAL_WHEN_INSTRUCTION,
              candidates: matches.map((e) => ({
                id: e.id,
                title: e.title,
                startsAt: e.startsAt,
                when: localWhen(e.startsAt, tz),
                location: e.location ?? null,
              })),
            },
          };
        }
      }
      if (!target) {
        return { summary: 'update_event: no matching event in this group', data: { updated: false } };
      }
      // Same rule as create_event: a reschedule onto a day that already went by
      // is a typo until the user says otherwise. Only a supplied `startsAt` can
      // trip it — renaming or relocating an event that is ALREADY past moves
      // nothing and must stay silent.
      if (
        input.turnId &&
        args.startsAt !== undefined &&
        (isPastEventStart(args.startsAt, tzOffset) ||
          (((args.invitees?.length ?? 0) > 0 || args.videoCall === true) && hasStarted(args.startsAt)))
      ) {
        // Same licence as create_event: a `confirmPast` nobody was asked for
        // is a filled-in field, not a confirmation (ADR 0319 addendum).
        const pastDay = localDay(args.startsAt, offsetMinutesOf(tzOffset ?? '+00:00'));
        const confirmed =
          !!args.confirmPast &&
          !!pastDay &&
          (await pastDateWasConfirmed(db, groupId, actorUserId, input.turnId, pastDay));
        if (!confirmed) {
          // ADR 0155 — see create_event above. A past target date read from an
          // uploaded file is history, not a typo to query, and records nothing.
          if (input.triggerFromAttachment) {
            return {
              summary:
                `update_event: moving "${target.title}" to ${localWhen(args.startsAt, tz)} would put it on a date ` +
                'that has already passed — nothing was changed. This date is in an uploaded file, so ' +
                'treat it as historical context: do NOT move the event there and do NOT ask the user ' +
                'about it.',
              data: { updated: false, reason: 'past', fromFile: true, id: target.id, startsAt: args.startsAt },
            };
          }
          if (pastDay) await recordPastDateAsk(db, groupId, actorUserId, input.turnId, pastDay);
          return {
            summary:
              `update_event: moving "${target.title}" to ${localWhen(args.startsAt, tz)} would put it on a date ` +
              'that has already passed — nothing was changed. Read the date back to the user and ' +
              'ask whether they meant it',
            data: { updated: false, reason: 'past', id: target.id, startsAt: args.startsAt },
          };
        }
      }
      // "On the Rudderstack calendar instead": a calendar event lives on one
      // calendar, so moving it is making it there - through create_event, so
      // the calendar, invitations, call and past-time rules are the same ones
      // - and removing the old one, whose guests get a cancellation.
      if (args.calendar && actorUserId && input.call.name === 'update_event') {
        const moved = await moveEventToCalendar(db, input, target, args);
        if (moved) return moved;
      }
      // Build the patch from only the supplied fields. startsAt/endsAt are
      // already tz-normalized by normalizeDatetimes. durationMinutes is a
      // convenience for "make it N long": endsAt = (new or existing) start +
      // duration, so the model never has to know/restate the start time — this
      // is the path that previously forced a duplicate create.
      const patch: {
        title?: string;
        location?: string;
        startsAt?: string;
        endsAt?: string;
        timeZone?: string;
        description?: string;
      } = {};
      if (args.title !== undefined) patch.title = args.title;
      if (args.location !== undefined) patch.location = args.location;
      if (args.timeZone !== undefined && isValidTimeZone(args.timeZone)) patch.timeZone = args.timeZone;
      if (args.startsAt !== undefined) patch.startsAt = args.startsAt;
      if (args.durationMinutes !== undefined) {
        const base = args.startsAt ?? target.startsAt;
        patch.endsAt = addMinutesPreservingOffset(base, args.durationMinutes);
      } else if (args.endsAt !== undefined) {
        patch.endsAt = args.endsAt;
      }
      // ADR 0162's "From chat: …" line describes how the event began; an edit
      // adds its own line, else the description still says 12pm after the
      // event moved to 2pm.
      if (Object.keys(patch).length > 0) {
        const note = await buildEventEditNote(db, actorUserId, provenance);
        if (note) patch.description = appendEditNote(target.description, note);
      }
      // ADR 0217 — repeating events. "This should recur weekly" turns the
      // existing one-off into a series in place; an edit to a series needs
      // the user's "just this one" or "all of them".
      // ADR 0229 — as on create: a `repeat` nobody asked for is ignored, so
      // "move lunch to 1pm" cannot turn a one-off into a series, or rewrite
      // how an existing series repeats. The rest of the edit goes ahead.
      const repeatArg =
        args.repeat && (await repeatWasAsked(db, input.triggeringMessageId)) === 'no'
          ? undefined
          : args.repeat;
      const repeatWords = repeatArg ? await recentUserText(db, input.triggeringMessageId) : null;
      if (repeatArg && !target.seriesId) {
        const zone = await seriesZoneFor(db, actorUserId, tz);
        if (Object.keys(patch).length > 0) await updateEvent(db, target.id, patch);
        const row = await db.selectFrom('events').selectAll().where('id', '=', target.id).executeTakeFirst();
        if (!row) return { summary: 'update_event: event vanished before update', data: { updated: false } };
        let rrule: string;
        try {
          const firstLocal = localWallOf(row.starts_at, zone);
          rrule = buildRrule(trimRepeatToRequest(repeatArg, repeatWords, firstLocal), firstLocal);
        } catch (err) {
          return {
            summary:
              `update_event: cannot repeat that way (${(err as Error).message}) — the event is unchanged and still a one-off`,
            data: {
              updated: false,
              reason: 'bad_repeat',
              message: (err as Error).message,
              instruction: REPEAT_INSTRUCTION,
            },
          };
        }
        const series = await convertEventToSeries(db, row, { rrule, tz: zone });
        for (const copy of await listEventCopies(db, target.id)) emit(copy.groupId, SSE.eventUpdated, copy);
        if (actorUserId) syncCalendarSoon(db, input, actorUserId);
        const repeats = describeRrule(series.rrule);
        return {
          summary:
            `update_event: "${row.title}" now repeats ${repeats}, from ${localWhen(row.starts_at, tz)} ` +
            '(the same event, not a new one; describe the repeat using exactly these words)',
          card: {
            kind: 'event',
            title: row.title,
            subtitle: row.location ?? undefined,
            meta: `${formatDueAt(row.starts_at, tzOffset)} · repeats ${repeats}`,
          },
          data: { updated: true, id: target.id, repeats },
        };
      }
      if (target.seriesId) {
        const changing = Object.keys(patch).length > 0 || !!repeatArg;
        if (changing && !args.scope) return scopeRequired('update_event', target, tz);
        if (args.scope === 'this' && repeatArg) {
          return {
            summary:
              'update_event: how an event repeats belongs to the whole series — nothing was changed. ' +
              'To change the pattern call again with scope "all"',
            data: { updated: false, reason: 'repeat_needs_all' },
          };
        }
        if (changing && args.scope === 'all') {
          const row = await db.selectFrom('events').selectAll().where('id', '=', target.id).executeTakeFirst();
          const series = row?.series_id ? await getSeries(db, row.series_id) : undefined;
          if (!row || !series) return { summary: 'update_event: event vanished before update', data: { updated: false } };
          let rrule: string | undefined;
          if (repeatArg) {
            try {
              const firstLocal = localWallOf(series.starts_at, series.tz);
              rrule = buildRrule(trimRepeatToRequest(repeatArg, repeatWords, firstLocal), firstLocal);
            } catch (err) {
              return {
                summary: `update_event: cannot repeat that way (${(err as Error).message}) — nothing was changed`,
                data: {
                  updated: false,
                  reason: 'bad_repeat',
                  message: (err as Error).message,
                  instruction: REPEAT_INSTRUCTION,
                },
              };
            }
          }
          const out = await updateSeries(db, row, {
            title: patch.title,
            location: patch.location,
            startsAt: patch.startsAt,
            endsAt: patch.endsAt,
            rrule,
            description: patch.description,
          });
          if (!out.ok) {
            return {
              summary: `update_event: ${out.reason} — nothing was changed`,
              data: { updated: false, reason: 'series_edit_unsupported', message: out.reason },
            };
          }
          for (const copy of await listEventCopies(db, target.id)) emit(copy.groupId, SSE.eventUpdated, copy);
          if (actorUserId) syncCalendarSoon(db, input, actorUserId);
          const repeats = describeRrule(out.series.rrule);
          return {
            summary:
              `update_event: changed every occurrence of "${out.series.title}" — repeats ${repeats}, ` +
              `${localWhen(out.series.starts_at, tz)} onward (describe it using exactly these words)`,
            data: { updated: true, id: target.id, scope: 'all', repeats },
          };
        }
      }
      // ADR 0157 — adding guests counts as a change, so an invitees-only call
      // ("also invite Priya") is valid even with an empty field patch.
      const inviteRes = await resolveInvitees(
        db,
        actorUserId,
        args.invitees,
        invitePhoneAsker(emit, groupId, actorUserId, input.sourceBinding ? null : input.turnId),
        await addressChecker(db, actorUserId, input.triggeringMessageId, input.turnId),
      );
      const { emails: inviteEmails, unresolved: unresolvedInvitees, unverified: unverifiedInvitees } = inviteRes;
      // ADR 0166 — same structural reminder as create_event: a call that
      // fully resolves the guest list (empty unresolvedInvitees) clears any
      // reminder left over from an earlier create_event/update_event on the
      // same event.
      if (actorUserId && args.invitees?.length) {
        await recordPendingInvitees(db, groupId, actorUserId, target.id, target.title, unresolvedInvitees);
      }
      // ADR 0295 — taking guests off, by email or a name resolved the same way.
      const { emails: removeEmails, unresolved: unresolvedRemovals } = await resolveInvitees(
        db,
        actorUserId,
        args.removeInvitees,
      );
      if (
        Object.keys(patch).length === 0 &&
        inviteEmails.length === 0 &&
        unresolvedInvitees.length === 0 &&
        unverifiedInvitees.length === 0 &&
        removeEmails.length === 0 &&
        unresolvedRemovals.length === 0 &&
        !args.videoCall
      ) {
        return {
          summary:
            args.repeat && !repeatArg
              ? 'update_event: nothing was changed (nothing in the request asked for a repeat, so the event stays as it is — do not mention repeating)'
              : 'update_event: no fields to change',
          data: { updated: false, id: target.id },
        };
      }
      let updated =
        Object.keys(patch).length > 0 ? await updateEvent(db, target.id, patch) : null;
      if (Object.keys(patch).length > 0 && !updated) {
        return { summary: 'update_event: event vanished before update', data: { updated: false } };
      }
      const guests = await applyGuestChange(db, target.id, actorUserId, inviteEmails, removeEmails);
      const invited = guests.invited;
      const meetNote =
        args.videoCall && actorUserId
          ? await videoCallNoteFor(db, input.triggeringMessageId, target.id, actorUserId)
          : '';
      // ADR 0163 — same fire-and-forget mining as create_event, for guests
      // added to an existing event.
      if (invited.length > 0 && actorUserId) {
        storeMeetingContextSoon(db, input, actorUserId, target.id, invited);
      }
      if (!updated) updated = await getEvent(db, target.id);
      if (!updated) {
        return { summary: 'update_event: event vanished before update', data: { updated: false } };
      }
      // Per-owner SSE: one eventUpdated per fanned-out copy (organizer edits
      // propagate to every member's copy).
      for (const copy of await listEventCopies(db, target.id)) {
        emit(copy.groupId, SSE.eventUpdated, copy);
      }
      if (actorUserId) syncCalendarSoon(db, input, actorUserId);
      return {
        summary:
          `update_event: updated "${updated.title}" (${localWhen(updated.startsAt, tz)}; if you say when, use THIS day and date)` +
          guests.note +
          meetNote +
          phoneInviteeNote(inviteRes) +
          (unresolvedRemovals.length
            ? ` · no email on file for ${unresolvedRemovals.join(', ')}, so they were NOT removed (say so)`
            : '') +
          (unresolvedInvitees.length
            ? ` · still need an email for ${unresolvedInvitees.join(', ')} (do NOT say they were` +
              ` invited — ask for the address or point at the "Add from Contacts" card)`
            : '') +
          unverifiedInviteeNote(unverifiedInvitees),
        card: {
          kind: 'event',
          title: updated.title,
          subtitle: updated.location ?? undefined,
          meta: formatDueAt(updated.startsAt, tzOffset),
        },
        cards: unresolvedInvitees.length ? contactPickCards(unresolvedInvitees) : undefined,
        data: {
          updated: true,
          id: updated.id,
          title: updated.title,
          startsAt: updated.startsAt,
          endsAt: updated.endsAt ?? null,
          ...(inviteEmails.length || unresolvedInvitees.length || removeEmails.length || unverifiedInvitees.length
            ? {
                invited,
                unresolvedInvitees,
                ...(unverifiedInvitees.length ? { unverifiedInvitees } : {}),
                ...guests.data,
              }
            : {}),
        },
      };
    }

    case 'find_events': {
      const args = call.args as {
        startDate: string;
        endDate: string;
        titleContains?: string;
      };
      if (!actorUserId) {
        return { summary: 'find_events: no actor', data: { events: [] } };
      }
      // Throttled gcal pull so the LLM works against fresh data. Throttle
      // is 5 min; a no-op when the user hasn't connected gcal or synced
      // recently.
      await maybeSyncCalendar(db, actorUserId);
      // Inclusive date range, as days in the user's own zone.
      const { lo, hi } = zonedDayRange(args.startDate, args.endDate, tz);
      const startsAt = eventStartInstant(tz);
      // ADR 0032 + 0040 §8 — strict per-group scope, owner-scoped. The bot sees
      // only the actor's OWN copies tagged with the current group; with fan-out
      // (one copy per member) the owner filter both scopes and dedupes (no N
      // duplicate rows). The group_members join still gates against forged group
      // ids in case groupId ever arrives from an untrusted source.
      let q = db
        .selectFrom('events')
        .innerJoin('group_members', 'group_members.group_id', 'events.group_id')
        .where('events.group_id', '=', groupId)
        .where('events.owner_user_id', '=', actorUserId)
        .where('group_members.user_id', '=', actorUserId)
        .where('events.deleted_at', 'is', null)
        .where('events.status', '!=', 'cancelled')
        .where(eventOverlapsRange(tz, lo, hi))
        .selectAll('events')
        .orderBy(startsAt, 'asc')
        .limit(20);
      if (args.titleContains) {
        const pat = likeContains(args.titleContains.toLowerCase());
        q = q.where((eb) =>
          eb.or([
            eb(eb.fn('lower', ['events.title']), 'like', pat),
            eb(eb.fn('lower', ['events.location']), 'like', pat),
          ]),
        );
      }
      const rows = await q.execute();
      return {
        summary: `find_events: ${rows.length} hits ${weekdayOf(args.startDate)} ${args.startDate}…${weekdayOf(args.endDate)} ${args.endDate}`,
        data: {
          instruction:
            "`when` is the event's start in the user's own time zone, weekday included — quote it as is (no UTC, no re-deriving the weekday). Events are in start order; keep that order.",
          events: rows.map((r) => ({
            id: r.id,
            groupId: r.group_id,
            title: r.title,
            when: localWhen(r.starts_at, tz),
            startsAt: r.starts_at,
            location: r.location ?? null,
          })),
        },
      };
    }

    case 'add_person': {
      const args = call.args as {
        displayName: string;
        notes?: string;
        email?: string;
        provisionalPersonId?: string;
      };
      if (!actorUserId) return { summary: 'add_person skipped (no actor)' };
      if (args.email) {
        const check = await addressChecker(db, actorUserId, input.triggeringMessageId, input.turnId);
        const unknown = check ? await check([args.email]) : [];
        if (unknown.length) {
          return {
            summary: `add_person: nothing saved — no source for ${unknown.join(', ')}`,
            data: { reason: 'unknown_address', unknownAddresses: unknown, instruction: unknownAddressInstruction(unknown) },
          };
        }
      }
      // docs/notes/0191 — a card staged from a provisional person: the tap
      // confirms the person AND the facts and relationship attached to it. If
      // the provisional row is already gone (swept), fall through and create
      // the person from name/notes/email like any other add_person.
      if (args.provisionalPersonId) {
        const promoted = await promoteProvisionalPerson(db, actorUserId, args.provisionalPersonId, provenance);
        if (promoted) {
          return {
            summary: promoted.merged
              ? `person "${promoted.person.displayName}" already known; facts added`
              : `added person ${promoted.person.id} "${promoted.person.displayName}"`,
            card: {
              kind: 'task',
              title: promoted.merged ? promoted.person.displayName : `Saved ${promoted.person.displayName}`,
              subtitle: promoted.person.notes ?? undefined,
              meta: promoted.merged ? 'already saved' : 'person added',
            },
          };
        }
      }
      const existing = await findPersonByName(db, actorUserId, args.displayName);
      if (existing) {
        // Backfill the sender anchor onto an already-known person.
        if (args.email && !existing.email) {
          await db
            .updateTable('people')
            .set({ email: args.email.trim().toLowerCase(), updated_at: new Date().toISOString() })
            .where('id', '=', existing.id)
            .execute();
        }
        return {
          summary: `person "${existing.displayName}" already known`,
          card: { kind: 'task', title: existing.displayName, subtitle: existing.notes ?? undefined, meta: 'already saved' },
        };
      }
      const person = await createPerson(db, {
        ownerUserId: actorUserId,
        displayName: args.displayName,
        notes: args.notes,
        email: args.email,
        provenance,
      });
      return {
        summary: `added person ${person.id} "${person.displayName}"`,
        card: { kind: 'task', title: `Saved ${person.displayName}`, subtitle: person.notes ?? undefined, meta: 'person added' },
      };
    }

    // The in-turn counterpart to add_person, for a fact rather than a
    // person — direct-write to confirmed (no proposal round-trip), same
    // reasoning as add_person above: the user stating it in this turn IS
    // the confirmation. Background chat extraction (bot/extraction.ts)
    // stays fire-and-forget/proposed for facts the model infers rather than
    // ones the user handed it directly.
    case 'remember_fact': {
      const args = call.args as { about?: string; key: string; value: string };
      if (!actorUserId) return { summary: 'remember_fact skipped (no actor)' };
      // ADR 0333 — saved for the person it is about, never filed under the
      // speaker because a name was not looked up. ADR 0281's card comes back
      // with it, so Forget works on it too.
      const { memory, ...result } = await rememberFactForTurn(db, {
        groupId,
        userId: actorUserId,
        about: args.about,
        key: args.key,
        value: args.value,
      });
      if (memory) emit(factEventChannel(memory), SSE.memoryCreated, memory);
      return result;
    }

    case 'correct_memory': {
      const args = call.args as { memoryId?: string; match?: string; value: string };
      if (!actorUserId) return { summary: 'correct_memory skipped (no actor)', data: { result: 'not_found' } };
      return correctMemoryForTurn(db, { groupId, userId: actorUserId, ...args });
    }

    case 'forget_memory': {
      const args = call.args as { memoryId?: string; match?: string };
      if (!actorUserId) return { summary: 'forget_memory skipped (no actor)', data: { result: 'not_found' } };
      return forgetMemoryForTurn(db, { groupId, userId: actorUserId, ...args });
    }

    // A REAL external fetch, distinct from suggest_external_action's
    // deep-link-only cards (ADR 0039/0153) — the bot reads the results
    // itself rather than handing the user a link. `getSearchProvider()`
    // returns null when SEARCH_PROVIDER is unset, which the model is told
    // to report honestly (ADR 0102 posture) rather than fabricate.
    case 'search_web': {
      const args = call.args as { query: string };
      const provider = getSearchProvider();
      if (!provider) {
        // No paid search API — the honest, zero-cost fallback is a plain
        // Google search link the user taps themselves, not a dead-end
        // apology. Never fetched by us (ADR 0135/0138's "we render the
        // link, never fetch it" posture): just a URL, no key needed.
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(args.query)}`;
        return {
          summary: `search_web: no live provider — offering a search link for "${args.query}"`,
          data: { ok: false, reason: 'unavailable', searchUrl },
          card: { kind: 'action', title: `Search: ${args.query}`, meta: 'opens in browser', url: searchUrl },
        };
      }
      const results = await provider.search(args.query);
      const top = results[0];
      return {
        summary: `search_web "${args.query}": ${results.length} result(s)`,
        data: {
          ok: true,
          results: results.map((r) => ({ title: r.title, snippet: r.snippet, url: r.url })),
        },
        card: top
          ? { kind: 'action', title: top.title, subtitle: top.snippet || undefined, meta: 'web result', url: top.url }
          : undefined,
      };
    }

    case 'set_email_route': {
      const args = call.args as { pattern: string; groupName: string; remove?: boolean };
      if (!actorUserId) return { summary: 'set_email_route skipped (no actor)' };
      // Exact-name-or-ask (owner decision, 2026-07-19): never fuzzy-route
      // email. Anything but ONE exact case-insensitive match returns the
      // candidate list so the model asks the user and retries verbatim.
      const resolved = await resolveGroupByName(db, actorUserId, args.groupName);
      if (!resolved.ok) {
        return {
          summary: `set_email_route: group name "${args.groupName}" did not resolve exactly`,
          data: { ok: false, reason: resolved.reason, candidates: resolved.candidates },
        };
      }
      const kind = inferRuleKind(args.pattern);
      if (args.remove) {
        const removed = await deleteRoutingRule(db, actorUserId, kind, args.pattern);
        return {
          summary: removed
            ? `email route removed: ${args.pattern} → ${resolved.groupName}`
            : `set_email_route: no rule for "${args.pattern}"`,
          data: { ok: removed, ...(removed ? {} : { reason: 'no_such_rule' }) },
        };
      }
      await setRoutingRule(db, {
        userId: actorUserId,
        kind,
        pattern: args.pattern,
        targetGroupId: resolved.groupId,
      });
      return {
        summary: `email route set: ${args.pattern} (${kind}) → ${resolved.groupName}`,
        data: { ok: true, kind, pattern: args.pattern.trim().toLowerCase(), group: resolved.groupName },
        card: {
          kind: 'task',
          title: `Email rule: ${args.pattern} → ${resolved.groupName}`,
          meta: kind === 'sender_domain' ? 'by sender' : 'by topic',
        },
      };
    }

    case 'list_email_routes': {
      if (!actorUserId) return { summary: 'list_email_routes skipped (no actor)' };
      const rules = await listRoutingRules(db, actorUserId);
      return {
        summary: rules.length
          ? `email routes: ${rules.map((r) => `${r.pattern} → ${r.targetGroupName}`).join('; ')}`
          : 'no email routes set',
        data: {
          routes: rules.map((r) => ({ kind: r.kind, pattern: r.pattern, group: r.targetGroupName })),
        },
      };
    }

    case 'set_briefing_exclusion': {
      const args = call.args as { pattern: string; remove?: boolean };
      if (!actorUserId) return { summary: 'set_briefing_exclusion skipped (no actor)' };
      const resolved = await resolveBriefingPattern(db, actorUserId, args.pattern);
      if (!resolved.ok) {
        return {
          summary: `set_briefing_exclusion: "${args.pattern}" matched more than one sender`,
          data: { ok: false, reason: resolved.reason, candidates: resolved.candidates },
        };
      }
      if (args.remove) {
        const removed = await deleteBriefingRule(db, actorUserId, resolved.kind, resolved.pattern);
        return {
          summary: removed
            ? `briefing exclusion removed: ${resolved.pattern}`
            : `set_briefing_exclusion: no rule for "${args.pattern}"`,
          data: { ok: removed, ...(removed ? {} : { reason: 'no_such_rule' }) },
        };
      }
      await setBriefingRule(db, { userId: actorUserId, kind: resolved.kind, pattern: resolved.pattern });
      return {
        summary: `briefing exclusion set: ${resolved.pattern} (${resolved.kind})`,
        data: { ok: true, kind: resolved.kind, pattern: resolved.pattern },
        card: {
          kind: 'task',
          title: `Briefing: hide ${resolved.pattern}`,
          meta: resolved.kind === 'sender_domain' || resolved.kind === 'sender_email' ? 'by sender' : 'by topic',
        },
      };
    }

    case 'list_briefing_exclusions': {
      if (!actorUserId) return { summary: 'list_briefing_exclusions skipped (no actor)' };
      const rules = await listBriefingRules(db, actorUserId);
      return {
        summary: rules.length
          ? `briefing exclusions: ${rules.map((r) => r.pattern).join('; ')}`
          : 'no briefing exclusions set',
        data: { rules: rules.map((r) => ({ kind: r.kind, pattern: r.pattern })) },
      };
    }

    case 'set_my_name': {
      const args = call.args as {
        preferredName?: string;
        firstName?: string;
        lastName?: string;
        useFirstNameAsPreferred?: boolean;
      };
      if (!actorUserId) return { summary: 'set_my_name skipped (no actor)' };
      const patch: Record<string, string | null> = {};
      if (args.firstName !== undefined) patch.first_name = args.firstName.trim() || null;
      if (args.lastName !== undefined) patch.last_name = args.lastName.trim() || null;
      if (args.preferredName !== undefined) patch.preferred_name = args.preferredName.trim() || null;
      if (args.useFirstNameAsPreferred) {
        // Promote the first name on file (or one provided in this same
        // call) to the preferred name — no need for the LLM to know it.
        const existing = await db
          .selectFrom('users')
          .select(['first_name'])
          .where('id', '=', actorUserId)
          .executeTakeFirst();
        const first =
          (patch.first_name as string | null | undefined) ?? existing?.first_name ?? null;
        patch.preferred_name = first;
      }
      if (Object.keys(patch).length === 0) {
        return { summary: 'set_my_name: nothing to update' };
      }
      await db.updateTable('users').set(patch).where('id', '=', actorUserId).execute();
      const updated = await db
        .selectFrom('users')
        .select(['first_name', 'last_name', 'preferred_name'])
        .where('id', '=', actorUserId)
        .executeTakeFirst();
      const called =
        updated?.preferred_name?.trim() || updated?.first_name?.trim() || 'you';
      return {
        summary: `set_my_name: preferred="${updated?.preferred_name ?? ''}" first="${updated?.first_name ?? ''}"`,
        card: { kind: 'task', title: `I'll call you ${called}`, meta: 'name updated' },
      };
    }

    case 'set_nudge_time': {
      const args = call.args as {
        hour?: number;
        minute?: number;
        enabled?: boolean;
      };
      if (!actorUserId) return { summary: 'set_nudge_time skipped (no actor)' };
      const patch: { nudge_hour?: number; nudge_minute?: number; nudge_enabled?: number } = {};
      if (args.hour !== undefined) {
        patch.nudge_hour = args.hour;
        // A bare hour means "on the hour" unless a minute was also given.
        patch.nudge_minute = args.minute ?? 0;
      } else if (args.minute !== undefined) {
        patch.nudge_minute = args.minute;
      }
      // Naming a time implies the briefing should be on.
      if (args.enabled !== undefined) patch.nudge_enabled = args.enabled ? 1 : 0;
      else if (args.hour !== undefined || args.minute !== undefined) patch.nudge_enabled = 1;
      if (Object.keys(patch).length === 0) {
        return { summary: 'set_nudge_time: nothing to update' };
      }
      await db.updateTable('users').set(patch).where('id', '=', actorUserId).execute();
      await rescheduleDailyScanForUser(db, actorUserId);
      const row = await db
        .selectFrom('users')
        .select(['nudge_hour', 'nudge_minute', 'nudge_enabled'])
        .where('id', '=', actorUserId)
        .executeTakeFirst();
      const on = Number(row?.nudge_enabled ?? 1) === 1;
      const when = formatTimeOfDay(row?.nudge_hour ?? 7, row?.nudge_minute ?? 0);
      return {
        summary: `set_nudge_time: enabled=${on} at ${when}`,
        card: on
          ? { kind: 'task', title: `Morning briefing at ${when}`, meta: 'nudge updated' }
          : { kind: 'task', title: 'Morning briefing turned off', meta: 'nudge updated' },
      };
    }

    // ADR 0091 — an explicit weather location for the briefing, set by voice.
    // Mirrors the Settings PUT /me/weather-location path: the place is geocoded
    // (source becomes 'user', so automatic IP/timezone detection is
    // suppressed), or an empty string clears it back to automatic.
    case 'set_weather_location': {
      const args = call.args as { place?: string; keepCurrent?: boolean };
      if (!actorUserId) return { summary: 'set_weather_location skipped (no actor)' };
      const place = (args.place ?? '').trim();
      if (args.keepCurrent && !place) {
        // "No" to a drift question — keep the stored location, stop asking.
        await declineWeatherDrift(db, actorUserId);
        return {
          summary: 'set_weather_location: kept current, drift prompt dismissed',
          data: { ok: true, kept: true },
        };
      }
      if (!place) {
        await clearUserWeatherLocation(db, actorUserId);
        return {
          summary: 'set_weather_location: cleared explicit choice',
          data: { ok: true, place: null, source: null },
          card: { kind: 'task', title: 'Weather location cleared', meta: 'auto-detect on' },
        };
      }
      const loc = await setUserWeatherLocation(db, actorUserId, place);
      if (!loc) {
        // Null means either no weather provider is configured for this deploy
        // or the place did not geocode. The model must not report success.
        return {
          summary: `set_weather_location: could not resolve "${place}"`,
          data: { ok: false, reason: 'not_found', place },
        };
      }
      return {
        summary: `set_weather_location: ${loc.place} (${loc.lat}, ${loc.lon})`,
        data: { ok: true, place: loc.place, source: loc.source },
        card: { kind: 'task', title: `Weather set to ${loc.place}`, meta: 'location updated' },
      };
    }

    // ADR 0346 phase 5 - the card's "Wait for theirs", in chat.
    case 'wait_for_invite': {
      const args = call.args as { meeting: string };
      if (!actorUserId) return { summary: 'wait_for_invite skipped (no actor)' };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'wait_for_invite: personal chat only', data: { ok: false, reason: 'personal_only' } };
      }
      const r = await waitForTheirInvite(db, actorUserId, { name: args.meeting });
      if (!r.ok) return { summary: `wait_for_invite: ${r.reason}`, data: r };
      return { summary: `wait_for_invite: waiting on ${r.title}`, data: { ok: true, waiting: r.title, held: true } };
    }

    // ADR 0346 phase 4 - the same list and drop as GET / DELETE /me/holds.
    case 'meeting_holds': {
      const args = call.args as { drop?: string };
      if (!actorUserId) return { summary: 'meeting_holds skipped (no actor)' };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'meeting_holds: personal chat only', data: { ok: false, reason: 'personal_only' } };
      }
      if (!args.drop?.trim()) {
        const holds = await activeHolds(db, actorUserId);
        return {
          summary: `meeting_holds: ${holds.length} held`,
          data: {
            ok: true,
            holds: holds.map((h) => ({ title: h.title, with: h.withName, startsAt: h.startsAt, endsAt: h.endsAt })),
          },
        };
      }
      const r = await dropHold(db, actorUserId, { name: args.drop });
      if (!r.ok) return { summary: `meeting_holds: ${r.reason}`, data: r };
      return { summary: `meeting_holds: stopped holding ${r.title}`, data: { ok: true, dropped: r.title } };
    }

    // ADR 0346 - the same answer the card's chips store.
    case 'answer_calendar_question': {
      const args = call.args as { event: string; answer: OverlapAnswer; meeting?: string };
      if (!actorUserId) return { summary: 'answer_calendar_question skipped (no actor)' };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'answer_calendar_question: personal chat only', data: { ok: false, reason: 'personal_only' } };
      }
      const wantsMove = args.answer === 'movable' || args.answer === 'fixed';
      const norm = (s: string) =>
        s.toLowerCase().replace(/\b(?:the|my)\b/g, ' ').replace(/\s+/g, ' ').trim();
      const name = norm(args.event);
      const open = (await openOverlapQuestions(db, actorUserId)).filter(
        (q) =>
          (q.ask === 'movable') === wantsMove &&
          (norm(q.eventTitle).includes(name) || name.includes(norm(q.eventTitle))) &&
          (!args.meeting || norm(q.meetingTitle).includes(norm(args.meeting))),
      );
      const distinct = [...new Map(open.map((q) => [q.eventId, q])).values()];
      if (distinct.length === 0) {
        return { summary: 'answer_calendar_question: not_found', data: { ok: false, reason: 'not_found' } };
      }
      if (distinct.length > 1) {
        return {
          summary: 'answer_calendar_question: ambiguous',
          data: { ok: false, reason: 'ambiguous', candidates: distinct.map((q) => q.eventTitle) },
        };
      }
      let stored = 0;
      for (const q of open) {
        const r = await recordOverlapAnswer(db, actorUserId, q.proposalId, q.eventId, args.answer);
        if (r.ok) stored += 1;
      }
      if (stored === 0) {
        return { summary: 'answer_calendar_question: not stored', data: { ok: false, reason: 'not_found' } };
      }
      const what = distinct[0]!.eventTitle;
      return {
        summary: `answer_calendar_question: ${what} = ${args.answer}`,
        data: { ok: true, event: what, answer: args.answer },
      };
    }

    // ADR 0330 — work hours, read by every surface that suggests times.
    case 'set_work_hours': {
      const args = call.args as { days?: string[]; start?: string; end?: string; observeHolidays?: boolean };
      if (!actorUserId) return { summary: 'set_work_hours skipped (no actor)' };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'set_work_hours: personal chat only', data: { ok: false, reason: 'personal_only' } };
      }
      const nothing =
        args.days === undefined && args.start === undefined && args.end === undefined && args.observeHolidays === undefined;
      if (nothing) {
        const { hours, isDefault } = await getWorkHours(db, actorUserId);
        return {
          summary: `set_work_hours: current ${describeWorkHours(hours)}`,
          data: { ok: true, read: true, workHours: describeWorkHours(hours), isDefault },
        };
      }
      const result = await setWorkHours(db, actorUserId, args);
      if (!result.ok) {
        return { summary: `set_work_hours: ${result.reason}`, data: { ...result, changed: false } };
      }
      const text = describeWorkHours(result.hours);
      return {
        summary: `set_work_hours: ${text}`,
        data: { ok: true, workHours: text },
        card: { kind: 'task', title: `Work hours: ${text}`, meta: 'suggested times stay inside these' },
      };
    }

    // ADR 0256 — the same writer as Settings' PUT /me/calendar/default.
    case 'set_default_calendar': {
      const args = call.args as { calendar?: string };
      if (!actorUserId) return { summary: 'set_default_calendar skipped (no actor)' };
      if (args.calendar === undefined) {
        const current = await getDefaultCalendar(db, actorUserId);
        return {
          summary: `set_default_calendar: current default is ${current.label}`,
          data: { ok: true, read: true, ...current },
        };
      }
      const result = await setDefaultCalendar(db, actorUserId, { name: args.calendar });
      if (!result.ok) {
        return {
          summary: `set_default_calendar: ${result.reason} for "${args.calendar}"`,
          data: result,
        };
      }
      return {
        summary: `set_default_calendar: ${result.label}`,
        data: result,
        card: { kind: 'task', title: `Default calendar: ${result.label}`, meta: 'calendar updated' },
      };
    }

    // ADR 0298 — the same service functions as Settings' /me/blocks routes.
    case 'block_user': {
      const args = call.args as { name: string };
      if (!actorUserId) return { summary: 'block_user skipped (no actor)' };
      const found = await resolveBlockablePerson(db, actorUserId, args.name);
      if (found.kind !== 'one') {
        const reason = found.kind === 'ambiguous' ? 'ambiguous' : 'not_found';
        return {
          summary: `block_user: ${reason} for "${args.name}"`,
          data: { ok: false, reason, candidates: found.candidates.map((c) => c.name) },
        };
      }
      const result = await blockMember(db, actorUserId, found.person.userId);
      if (!result.ok) {
        return { summary: `block_user: ${result.reason}`, data: { ok: false, reason: result.reason } };
      }
      return {
        summary: `block_user: blocked ${result.user.name}`,
        data: { ok: true, name: result.user.name, alreadyBlocked: result.already },
        card: { kind: 'task', title: `Blocked ${result.user.name}`, meta: 'undo in Settings → Blocked people' },
      };
    }

    case 'unblock_user': {
      const args = call.args as { name: string };
      if (!actorUserId) return { summary: 'unblock_user skipped (no actor)' };
      const found = await resolveBlockedPerson(db, actorUserId, args.name);
      if (found.kind !== 'one') {
        const reason = found.kind === 'ambiguous' ? 'ambiguous' : 'not_found';
        const candidates =
          found.kind === 'ambiguous'
            ? found.candidates.map((c) => c.name)
            : (await listBlockedUsers(db, actorUserId)).map((b) => b.name);
        return { summary: `unblock_user: ${reason} for "${args.name}"`, data: { ok: false, reason, candidates } };
      }
      await unblockUser(db, actorUserId, found.person.userId);
      return {
        summary: `unblock_user: unblocked ${found.person.name}`,
        data: { ok: true, name: found.person.name },
      };
    }

    // ADR 0301 — the same reportMessage as the chat's Report item.
    case 'report_message': {
      const args = call.args as { groupName: string; person: string; reason?: string };
      if (!actorUserId) return { summary: 'report_message skipped (no actor)' };
      const group = await resolveGroupByName(db, actorUserId, args.groupName);
      if (!group.ok) {
        const reason = group.reason === 'ambiguous' ? 'group_ambiguous' : 'group_not_found';
        return {
          summary: `report_message: ${reason} for "${args.groupName}"`,
          data: { ok: false, reason, candidates: group.candidates },
        };
      }
      const found = await resolveBlockablePerson(db, actorUserId, args.person, group.groupId);
      if (found.kind !== 'one') {
        const reason = found.kind === 'ambiguous' ? 'person_ambiguous' : 'person_not_found';
        return {
          summary: `report_message: ${reason} for "${args.person}"`,
          data: { ok: false, reason, candidates: found.candidates.map((c) => c.name) },
        };
      }
      const messageId = await newestMessageFrom(db, group.groupId, found.person.userId);
      if (!messageId) {
        return { summary: 'report_message: no_message', data: { ok: false, reason: 'no_message' } };
      }
      const result = await reportMessage(db, { reporterId: actorUserId, messageId, reason: args.reason });
      if (!result.ok) {
        return { summary: `report_message: ${result.reason}`, data: { ok: false, reason: result.reason } };
      }
      return {
        summary: `report_message: reported a message from ${result.reportedName}`,
        data: {
          ok: true,
          name: result.reportedName,
          group: group.groupName,
          alreadyReported: result.alreadyReported,
        },
      };
    }

    case 'list_blocked_users': {
      if (!actorUserId) return { summary: 'list_blocked_users skipped (no actor)' };
      const blocked = await listBlockedUsers(db, actorUserId);
      return {
        summary: `list_blocked_users: ${blocked.length}`,
        data: { ok: true, blocked: blocked.map((b) => ({ name: b.name, blockedAt: b.blockedAt })) },
      };
    }

    // ADR 0278 — the same writer as Settings' PATCH /me/calendar/sources/:id.
    case 'set_calendar_color': {
      const args = call.args as { calendar?: string; color?: string };
      if (!actorUserId) return { summary: 'set_calendar_color skipped (no actor)' };
      const calendars = async () =>
        (await listCalendarSources(db, actorUserId)).map((c) => ({
          calendar: calendarSourceLabel(c),
          color: c.displayColor,
          colorName: calendarColorName(c.displayColor),
          picked: c.colorChoice !== null,
        }));
      if (args.calendar === undefined) {
        const all = await calendars();
        return {
          summary: `set_calendar_color: read ${all.length} calendars`,
          data: { ok: true, read: true, calendars: all },
        };
      }
      const result = await setCalendarColor(db, actorUserId, { name: args.calendar }, args.color ?? null);
      if (!result.ok) {
        return {
          summary: `set_calendar_color: ${result.reason} for "${args.calendar}"`,
          data: result.reason === 'not_found' ? { ...result, calendars: await calendars() } : result,
        };
      }
      const label = calendarSourceLabel(result.calendar);
      const shown = calendarColorName(result.calendar.displayColor) ?? result.calendar.displayColor;
      return {
        summary: `set_calendar_color: ${label} → ${shown}`,
        data: {
          ok: true,
          calendar: label,
          color: result.calendar.displayColor,
          colorName: calendarColorName(result.calendar.displayColor),
          reset: result.calendar.colorChoice === null,
        },
        card: { kind: 'task', title: `${label} calendar: ${shown}`, meta: 'calendar color updated' },
      };
    }

    // ADR 0278 — the same writer as Settings' PUT /me/email/mailbox-color.
    case 'set_mailbox_color': {
      const args = call.args as { mailbox?: string; color?: string };
      if (!actorUserId) return { summary: 'set_mailbox_color skipped (no actor)' };
      if (args.mailbox === undefined) {
        const [boxes, colors] = await Promise.all([
          listMailboxChoices(db, actorUserId),
          mailboxColors(db, actorUserId),
        ]);
        const mailboxes = boxes.map((m) => ({
          mailbox: m.label,
          address: m.address,
          color: colors.colors[m.mailbox],
          colorName: calendarColorName(colors.colors[m.mailbox]),
          picked: m.mailbox in colors.picked,
        }));
        return {
          summary: `set_mailbox_color: read ${mailboxes.length} mailboxes`,
          data: { ok: true, read: true, mailboxes },
        };
      }
      const result = await setMailboxColor(db, actorUserId, { name: args.mailbox }, args.color ?? null);
      if (!result.ok) {
        return { summary: `set_mailbox_color: ${result.reason} for "${args.mailbox}"`, data: result };
      }
      const shown = calendarColorName(result.color) ?? result.color;
      return {
        summary: `set_mailbox_color: ${result.mailbox.label} → ${shown}`,
        data: {
          ok: true,
          mailbox: result.mailbox.label,
          address: result.mailbox.address,
          color: result.color,
          colorName: calendarColorName(result.color),
          reset: !result.picked,
        },
        card: { kind: 'task', title: `${result.mailbox.label} mailbox: ${shown}`, meta: 'mailbox color updated' },
      };
    }

    case 'add_email_sort_rule': {
      const args = call.args as { from?: string; subject?: string; category: string; rule: 'always' | 'never' };
      if (!actorUserId) return { summary: 'add_email_sort_rule skipped (no actor)' };
      const result = await addSortRule(db, actorUserId, args);
      if (!result.ok) return { summary: `add_email_sort_rule: ${result.reason}`, data: result };
      const r = result.rule;
      const who = [r.from ? `from ${r.from}` : '', r.subject ? `"${r.subject}"` : ''].filter(Boolean).join(', ');
      return {
        summary: `add_email_sort_rule: ${r.rule} ${who} -> ${r.category} (${result.requeued} re-sorting)`,
        data: result,
        card: {
          kind: 'task',
          title: r.rule === 'always' ? `Mail ${who} goes in ${r.category}` : `Mail ${who} stays out of ${r.category}`,
          meta: 'email rule saved',
        },
      };
    }

    case 'create_email_category': {
      const args = call.args as { title: string; about?: string };
      if (!actorUserId) return { summary: 'create_email_category skipped (no actor)' };
      const result = await createUserCategory(db, actorUserId, args);
      if (!result.ok) return { summary: `create_email_category: ${result.reason}`, data: result };
      return {
        summary: `create_email_category: ${result.category.title} (${result.requeued} re-sorting)`,
        data: result,
        card: { kind: 'task', title: `New email category: ${result.category.title}`, meta: 'category saved' },
      };
    }

    case 'list_email_sort_rules': {
      if (!actorUserId) return { summary: 'list_email_sort_rules skipped (no actor)' };
      const result = await listSortRules(db, actorUserId);
      return {
        summary: `list_email_sort_rules: ${result.rules.length} rules, ${result.categories.length} categories`,
        data: { ok: true, ...result },
      };
    }

    case 'remove_email_sort_rule': {
      const args = call.args as { from?: string; subject?: string; category?: string };
      if (!actorUserId) return { summary: 'remove_email_sort_rule skipped (no actor)' };
      const result = await removeSortRules(db, actorUserId, args);
      return {
        summary: `remove_email_sort_rule: ${result.removedRules} rules${result.removedCategory ? ', category removed' : ''}`,
        data: result,
      };
    }

    case 'set_email_category_order': {
      const args = call.args as { categories?: string[]; mode?: 'top' | 'replace'; clear?: boolean };
      if (!actorUserId) return { summary: 'set_email_category_order skipped (no actor)' };
      if (args.clear) {
        await setCategoryOrder(db, actorUserId, [], 'replace');
        return {
          summary: 'set_email_category_order: cleared',
          data: { ok: true, order: [] },
          card: { kind: 'task', title: 'Email categories back to the default order', meta: 'order updated' },
        };
      }
      if (!args.categories || args.categories.length === 0) {
        const order = await getCategoryOrder(db, actorUserId);
        return {
          summary: `set_email_category_order: ${order.length ? order.join(', ') : 'default order'}`,
          data: { ok: true, read: true, order, categories: await listCategoryTitles(db, actorUserId) },
        };
      }
      const result = await setCategoryOrder(db, actorUserId, args.categories, args.mode ?? 'top');
      if (!result.ok) {
        return {
          summary: `set_email_category_order: ${result.reason}${result.reason === 'not_found' ? ` for "${result.name}"` : ''}`,
          data: result,
        };
      }
      return {
        summary: `set_email_category_order: ${result.order.join(', ')}`,
        data: result,
        card: { kind: 'task', title: `Email categories first: ${result.order.join(', ')}`, meta: 'order updated' },
      };
    }

    case 'set_default_mailbox': {
      const args = call.args as { mailbox?: string };
      if (!actorUserId) return { summary: 'set_default_mailbox skipped (no actor)' };
      if (args.mailbox === undefined) {
        const { current, chosen } = await getDefaultMailbox(db, actorUserId);
        return {
          summary: `set_default_mailbox: sending from ${current?.address ?? 'nothing'}`,
          data: current
            ? { ok: true, read: true, chosen, label: current.label, address: current.address }
            : { ok: false, reason: 'no_mailbox' },
        };
      }
      const result = await setDefaultMailbox(db, actorUserId, args.mailbox);
      if (!result.ok) {
        return { summary: `set_default_mailbox: ${result.reason} for "${args.mailbox}"`, data: result };
      }
      const m = result.mailbox;
      return {
        summary: `set_default_mailbox: ${m?.address ?? 'no mailbox'}`,
        data: { ok: true, label: m?.label ?? null, address: m?.address ?? null },
        ...(m
          ? { card: { kind: 'task' as const, title: `New mail goes from ${m.address ?? m.label}`, meta: 'mailbox updated' } }
          : {}),
      };
    }

    // ADR 0099 — asking for the briefing runs the real one. The scan posts the
    // briefing itself, so nothing here returns its text: handing it back would
    // invite the model to paraphrase a deterministic artifact.
    case 'send_briefing': {
      if (!actorUserId) return { summary: 'send_briefing skipped (no actor)' };
      // Belt and braces with PERSONAL_ONLY_TOOL_NAMES: a briefing spans every
      // group the asker belongs to, so a shared group must never render one.
      if (!(await isPersonalTurn(db, groupId))) {
        return {
          summary: 'send_briefing: refused — personal chats only',
          data: { ran: false, reason: 'not_personal' },
        };
      }
      // The ADR 0005 loop re-streams up to 20 times and each briefing costs an
      // LLM scan plus a mailbox sync, so the unit is the turn, not the call.
      if (!claimOncePerTurn(input.turnId, 'send_briefing')) {
        return {
          summary: 'send_briefing: already sent this turn',
          data: { ran: false, reason: 'already_sent_this_turn' },
        };
      }
      const posted = await runDailyScanForUserNow(db, actorUserId);
      return {
        summary: posted
          ? 'send_briefing: briefing posted'
          : 'send_briefing: could not run — tell the user plainly, do not summarise for them',
        data: { ran: posted },
      };
    }

    case 'add_important_date': {
      const args = call.args as {
        personName: string;
        kind: ImportantDateKind;
        date: string;
        recurs?: boolean;
      };
      if (!actorUserId) return { summary: 'add_important_date skipped (no actor)' };
      let person = await findPersonByName(db, actorUserId, args.personName);
      if (!person) {
        person = await createPerson(db, {
          ownerUserId: actorUserId,
          displayName: args.personName,
          provenance,
        });
      }
      const recurs = args.recurs ?? true;
      const d = await addImportantDate(db, {
        personId: person.id,
        kind: args.kind,
        date: args.date,
        recurs,
      });
      return {
        summary: `important_date ${d.id}: ${args.kind} for ${person.displayName} on ${args.date}`,
        card: {
          kind: 'task',
          title: `${person.displayName}'s ${args.kind}`,
          subtitle: args.date,
          meta: recurs ? 'recurs annually' : 'one-time',
        },
      };
    }

    case 'list_memories': {
      const args = call.args as { limit?: number; query?: string };
      if (!actorUserId) {
        return { summary: 'list_memories: no actor', data: { memories: [] } };
      }
      // Privacy: queryForTurn already returns only group-scope memories +
      // persona-scope memories belonging to the triggering user. Persona
      // memories of other group members are never included — same rule as
      // the bot's own context block, applied here so the LLM cannot bypass
      // it via tool call. A `query` (ADR 0284) searches that same set.
      const found = args.query
        ? await findMemoriesForTurn(db, { groupId, userId: actorUserId, query: args.query, limit: args.limit ?? 30 })
        : null;
      const rows =
        found?.memories ??
        (await queryMemoriesForTurn(db, {
          groupId,
          triggeringUserId: actorUserId,
          limit: args.limit ?? 30,
        }));
      const labels = found?.labels ?? (await labelMemorySubjects(db, rows));
      return {
        summary: found
          ? `list_memories: ${found.matched ? `${rows.length} match "${args.query}"` : `nothing matches "${args.query}"`}`
          : `list_memories: ${rows.length} memory(ies)`,
        data: {
          ...(found ? { matched: found.matched } : {}),
          memories: rows.map((m) => ({
            id: m.id,
            about: labels.get(m.id) ?? 'Someone',
            scope: m.scope === 'persona' ? 'about-you' : m.scope,
            key: m.key,
            value: m.value,
            confidence: m.confidence,
            source: m.source,
          })),
        },
      };
    }

    case 'get_billing_status': {
      if (!actorUserId) {
        return { summary: 'get_billing_status: no actor', data: null };
      }
      // ADR 0196 — the exact same assembly GET /me/billing uses, so the bot
      // can never answer this differently than the AI Plan Settings screen.
      const status = await getBillingStatus(db, actorUserId);
      return { summary: `get_billing_status: ${status.entitlement ?? 'unknown'}`, data: status };
    }

    // ADR 0335 — the AI apps connected over MCP: the same service the Settings
    // list and its Disconnect button call.
    case 'list_connected_apps': {
      if (!actorUserId || !(await isPersonalTurn(db, groupId))) {
        return { summary: 'list_connected_apps: refused — personal chats only', data: { ok: false } };
      }
      const apps = await listConnectedApps(db, actorUserId);
      return {
        summary: `list_connected_apps: ${apps.length}`,
        data: {
          apps: apps.map((a) => ({ name: a.name, mayDo: a.scopes, connectedAt: a.connectedAt, lastUsedAt: a.lastUsedAt })),
        },
      };
    }

    case 'disconnect_app': {
      if (!actorUserId || !(await isPersonalTurn(db, groupId))) {
        return { summary: 'disconnect_app: refused — personal chats only', data: { ok: false } };
      }
      const want = (call.args as { app: string }).app.trim().toLowerCase();
      const apps = await listConnectedApps(db, actorUserId);
      const exact = apps.filter((a) => a.name.toLowerCase() === want);
      const matches = exact.length ? exact : apps.filter((a) => a.name.toLowerCase().includes(want));
      if (matches.length !== 1) {
        return {
          summary: `disconnect_app: ${matches.length ? 'several apps match' : 'no connected app matches'} "${want}" — nothing disconnected`,
          data: {
            ok: false,
            updated: false,
            reason: matches.length ? 'ambiguous' : 'not_found',
            candidates: (matches.length ? matches : apps).map((a) => a.name),
          },
        };
      }
      await disconnectApp(db, actorUserId, matches[0].id);
      return { summary: `disconnect_app: ${matches[0].name} disconnected`, data: { ok: true, app: matches[0].name } };
    }

    // ADR 0231 — the family plan, said in chat. The same service functions the
    // Settings screen's routes call; nothing is re-derived here. Personal turns
    // only (the tools are also filtered out of shared-group turns; this is the
    // backstop, as for get_billing_status).
    // ADR 0318 — invite by email: the same service the Messages screen calls.
    case 'invite_to_chat': {
      if (!actorUserId) return { summary: 'invite_to_chat: no actor', data: { ok: false, reason: 'no_actor' } };
      const args = call.args as { email: string; groupName?: string; message?: string };
      const check = await addressChecker(db, actorUserId, input.triggeringMessageId, input.turnId);
      const unknown = check ? await check([args.email]) : [];
      if (unknown.length) {
        return {
          summary: `invite_to_chat: nobody invited — no source for ${unknown.join(', ')}`,
          data: { ok: false, reason: 'unknown_address', unknownAddresses: unknown, instruction: unknownAddressInstruction(unknown) },
        };
      }
      let targetGroupId: string | undefined;
      if (!(await isPersonalTurn(db, groupId))) {
        targetGroupId = groupId;
      } else if (args.groupName) {
        const resolved = await resolveGroupByName(db, actorUserId, args.groupName);
        if (!resolved.ok) {
          return {
            summary: `invite_to_chat: chat "${args.groupName}" ${resolved.reason}`,
            data: { ok: false, reason: resolved.reason, candidates: resolved.candidates },
          };
        }
        targetGroupId = resolved.groupId;
      }
      const out = await inviteByEmail(db, actorUserId, { email: args.email, groupId: targetGroupId, message: args.message });
      if (!out.ok) return { summary: `invite_to_chat: ${out.reason}`, data: { ok: false, reason: out.reason } };
      const card: BotCard | undefined =
        out.status === 'emailed'
          ? { kind: 'action', title: 'Open the chat', meta: out.email === 'queued' ? 'invite emailed' : 'invite NOT sent', href: `/groups/${out.groupId}` }
          : out.groupId
            ? { kind: 'action', title: `Open the chat`, meta: out.status === 'added' ? `${out.name} is in` : `waiting for ${out.name}`, href: `/groups/${out.groupId}` }
            : undefined;
      return {
        summary: `invite_to_chat: ${out.status}${out.status === 'emailed' ? ` (email ${out.email})` : ''}`,
        data: { ...out },
        ...(card ? { card } : {}),
      };
    }

    case 'respond_to_chat_invite': {
      if (!actorUserId) return { summary: 'respond_to_chat_invite: no actor', data: { ok: false, reason: 'no_actor' } };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'respond_to_chat_invite: personal chat only', data: { ok: false, reason: 'personal_only' } };
      }
      const args = call.args as { accept: boolean; from?: string };
      const pending = await listPendingInvites(db, actorUserId);
      if (pending.length === 0) return { summary: 'respond_to_chat_invite: none waiting', data: { ok: false, reason: 'none' } };
      const wanted = args.from?.trim().toLowerCase();
      const matches = wanted
        ? pending.filter((p) => p.fromName.toLowerCase().split(/\s+/).includes(wanted) || p.fromName.toLowerCase() === wanted)
        : pending;
      const distinct = new Set(matches.map((p) => p.fromName));
      if (matches.length === 0 || distinct.size > 1 || (matches.length > 1 && !wanted)) {
        return {
          summary: 'respond_to_chat_invite: which one?',
          data: { ok: false, reason: 'ambiguous', candidates: [...new Set(pending.map((p) => p.fromName))] },
        };
      }
      const results = [];
      for (const inv of matches) results.push(await respondToInvite(db, actorUserId, inv.id, args.accept));
      const first = results.find((r) => r.ok);
      if (!first || !first.ok) return { summary: 'respond_to_chat_invite: failed', data: { ok: false, reason: 'gone' } };
      return {
        summary: `respond_to_chat_invite: ${args.accept ? 'accepted' : 'declined'} ${matches[0]!.fromName}`,
        data: { ok: true, accepted: args.accept, from: matches[0]!.fromName, groupId: first.groupId },
        ...(args.accept && first.groupId
          ? { card: { kind: 'action' as const, title: `Chat with ${matches[0]!.fromName}`, meta: 'open', href: `/groups/${first.groupId}` } }
          : {}),
      };
    }

    case 'add_family_member': {
      if (!actorUserId) return { summary: 'add_family_member: no actor', data: { ok: false, reason: 'no_actor' } };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'add_family_member: personal chat only', data: { ok: false, reason: 'personal_only' } };
      }
      const args = call.args as {
        name: string;
        email?: string;
        phone?: string;
        relationship?: string;
        chordinator?: boolean;
        invite?: boolean;
      };
      // An invite emails this address from the owner's mailbox.
      if (args.email) {
        const check = await addressChecker(db, actorUserId, input.triggeringMessageId, input.turnId);
        const unknown = check ? await check([args.email]) : [];
        if (unknown.length) {
          return {
            summary: `add_family_member: nothing added — no source for ${unknown.join(', ')}`,
            data: { ok: false, reason: 'unknown_address', unknownAddresses: unknown, instruction: unknownAddressInstruction(unknown) },
          };
        }
      }
      const out = await addFamilyMember(db, actorUserId, args);
      if (!out.ok) return { summary: `add_family_member: ${out.reason}`, data: { ok: false, reason: out.reason } };
      const data: Record<string, unknown> = { ok: true, member: out.member };
      if (out.invite) {
        data.inviteLink = out.invite.inviteLink;
        data.message = out.invite.message;
        // ADR 0237 — what Chord did vs. what is still the owner's to do.
        data.joined = out.invite.joined === true;
        data.delivery = out.invite.delivery;
      }
      // A text always comes from the owner's phone; Chord only emails.
      const card: BotCard | undefined =
        out.invite && !out.invite.joined && out.member.phone
          ? {
              kind: 'action',
              title: `Text ${out.member.name} the invite`,
              meta: 'opens Messages',
              url: out.invite.inviteLink,
              appUrl: `sms:${out.member.phone}?&body=${encodeURIComponent(out.invite.message)}`,
            }
          : undefined;
      return {
        summary: `add_family_member: ${out.member.name} (${out.member.status})`,
        data,
        ...(card ? { card } : {}),
      };
    }

    case 'remove_family_member': {
      if (!actorUserId) return { summary: 'remove_family_member: no actor', data: { ok: false, reason: 'no_actor' } };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'remove_family_member: personal chat only', data: { ok: false, reason: 'personal_only' } };
      }
      const { name } = call.args as { name: string };
      const hits = await findFamilyMemberByName(db, actorUserId, name);
      if (hits.length !== 1) {
        // Zero: nobody by that name. Several: ask — a wrong removal ends someone's coverage.
        return {
          summary: `remove_family_member: ${hits.length === 0 ? 'not_found' : 'ambiguous'}`,
          data: {
            ok: false,
            reason: hits.length === 0 ? 'not_found' : 'ambiguous',
            candidates: hits.map((m) => m.name),
          },
        };
      }
      const out = await removeFamilyMember(db, actorUserId, hits[0]!.id);
      if (!out.ok) return { summary: `remove_family_member: ${out.reason}`, data: { ok: false, reason: out.reason } };
      return { summary: `remove_family_member: ${out.removed.name}`, data: { ok: true, removed: out.removed.name } };
    }

    case 'list_family_members': {
      if (!actorUserId) return { summary: 'list_family_members: no actor', data: null };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'list_family_members: personal chat only', data: { ok: false, reason: 'personal_only' } };
      }
      const overview = await getFamilyOverview(db, actorUserId);
      return {
        summary: `list_family_members: ${overview.members.length} on the roster, ${overview.seatsUsed}/${overview.seats} seats`,
        data: {
          role: overview.role,
          seats: overview.seats,
          seatsUsed: overview.seatsUsed,
          planActive: overview.planActive,
          ownerName: overview.ownerName,
          // Invite links are for the owner to forward, not for the model to recite.
          members: overview.members.map((m) => ({
            name: m.name,
            relationship: m.relationship,
            status: m.status,
            chordinator: m.chordinator,
            hasEmail: !!m.email,
            hasPhone: !!m.phone,
          })),
        },
      };
    }

    // ADR 0235 - a link, never a claim: the key exists when they finish in the browser.
    case 'connect_openrouter': {
      if (!actorUserId) return { summary: 'connect_openrouter: no actor', data: { ok: false, reason: 'no_actor' } };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'connect_openrouter: personal chat only', data: { ok: false, reason: 'personal_only' } };
      }
      const args = call.args as { model?: string };
      const out = await startOpenRouterConnect(
        db,
        actorUserId,
        { platform: 'web', model: args.model },
        describeSystemLlm(),
      );
      if (!out.ok) {
        return { summary: `connect_openrouter: ${out.reason}`, data: { ok: false, reason: out.reason } };
      }
      return {
        summary: `connect_openrouter: link ready (${out.model})`,
        data: { ok: true, model: out.model },
        card: { kind: 'action', title: 'Connect OpenRouter', meta: `starts on ${out.model}`, url: out.url },
      };
    }

    case 'change_subscription_plan': {
      if (!actorUserId) {
        return { summary: 'change_subscription_plan: no actor', data: { ok: false, reason: 'no_actor' } };
      }
      if (!(await isPersonalTurn(db, groupId))) {
        return {
          summary: 'change_subscription_plan: personal chat only',
          data: { ok: false, reason: 'personal_only' },
        };
      }
      const args = call.args as { plan: 'individual' | 'family'; interval: 'month' | 'year' };
      const out = await changePlan(db, actorUserId, args.plan === 'family' ? 'family' : 'system', args.interval);
      if (!out.ok) {
        return { summary: `change_subscription_plan: ${out.reason}`, data: { ok: false, reason: out.reason } };
      }
      return {
        summary: `change_subscription_plan: ${out.resumed ? 'resumed' : 'switched'} to ${args.plan} ${args.interval}`,
        data: { ok: true, plan: args.plan, interval: args.interval, resumed: out.resumed },
      };
    }

    case 'set_subscription_renewal': {
      if (!actorUserId) {
        return { summary: 'set_subscription_renewal: no actor', data: { ok: false, reason: 'no_actor' } };
      }
      if (!(await isPersonalTurn(db, groupId))) {
        return {
          summary: 'set_subscription_renewal: personal chat only',
          data: { ok: false, reason: 'personal_only' },
        };
      }
      const args = call.args as { renew: boolean };
      const out = await setRenewal(db, actorUserId, args.renew);
      if (!out.ok) {
        return {
          summary: `set_subscription_renewal: ${out.reason}`,
          data: { ok: false, reason: out.reason },
        };
      }
      return {
        summary: out.cancelsAtPeriodEnd
          ? 'set_subscription_renewal: will not renew'
          : 'set_subscription_renewal: renewal back on',
        data: { ok: true, cancelsAtPeriodEnd: out.cancelsAtPeriodEnd, periodEnd: out.periodEnd },
      };
    }

    case 'get_checkout_link': {
      if (!actorUserId) return { summary: 'get_checkout_link: no actor', data: { ok: false, reason: 'no_actor' } };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'get_checkout_link: personal chat only', data: { ok: false, reason: 'personal_only' } };
      }
      const args = call.args as { plan: 'individual' | 'family' | 'base'; interval?: 'month' | 'year'; code?: string };
      const out = await startCheckout(db, actorUserId, {
        plan: args.plan === 'family' ? 'family' : args.plan === 'base' ? 'byok_base' : 'system',
        // The base plan is sold monthly only.
        interval: args.plan === 'base' ? 'month' : args.interval,
        code: args.code,
      });
      if (!out.ok) {
        return {
          summary: `get_checkout_link: ${out.reason}`,
          data: { ok: false, reason: out.reason },
        };
      }
      return {
        summary: `get_checkout_link: ${args.plan} ${args.interval ?? 'month'}${args.code ? ' with a code' : ''}`,
        data: { ok: true },
        card: {
          kind: 'action',
          title:
            args.plan === 'family'
              ? 'Subscribe: Family plan'
              : args.plan === 'base'
                ? 'Subscribe: Base plan (your own AI key)'
                : 'Subscribe: Individual plan',
          meta: args.code ? 'free first month, then charged' : 'opens secure checkout',
          url: out.url,
        },
      };
    }

    // ADR 0299 — the Settings phone check, sayable in chat. The number the code
    // went to is kept on the server, since the reply carrying the code comes in
    // a later turn and may not repeat it.
    case 'verify_phone': {
      const args = call.args as { phone?: string; code?: string };
      if (!actorUserId) return { summary: 'verify_phone: no actor', data: { ok: false, reason: 'no_actor' } };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: 'verify_phone: personal chat only', data: { ok: false, reason: 'personal_only' } };
      }
      const pendingKey = `${groupId}:${actorUserId}`;
      if (!args.code) {
        if (!args.phone) {
          return { summary: 'verify_phone: no number', data: { ok: false, reason: 'invalid_phone', instruction: 'Ask for their mobile number.' } };
        }
        // Typed in chat a number usually has no country code; read it the way
        // a family invite does (ADR 0237) and say back which number it was.
        const asE164 = phoneCandidates(args.phone)[0] ?? args.phone;
        const started = await startPhoneVerification(db, actorUserId, asE164);
        if (!started.ok) return { summary: `verify_phone: ${started.reason}`, data: { ok: false, reason: started.reason } };
        await putPendingState(db, 'phone', pendingKey, { phone: started.phone }, 15 * 60_000);
        return {
          summary: `verify_phone: code sent`,
          data: {
            ok: true,
            sent: true,
            phone: started.phone,
            instruction: `Say the code was texted to ${started.phone} and ask for it. Do not claim the number is verified yet.`,
          },
        };
      }
      const phone = args.phone ?? (await getPendingState<{ phone: string }>(db, 'phone', pendingKey))?.phone;
      if (!phone) {
        return { summary: 'verify_phone: no number for the code', data: { ok: false, reason: 'not_found', instruction: 'Ask for their number again and send a new code.' } };
      }
      const verified = await verifyPhone(db, actorUserId, phone, args.code);
      if (!verified.ok) return { summary: `verify_phone: ${verified.reason}`, data: { ok: false, reason: verified.reason } };
      await deletePendingState(db, 'phone', pendingKey);
      return { summary: 'verify_phone: verified', data: { ok: true, verified: true, phone: verified.phone } };
    }

    // ADR 0299 — guided skills. Progress lives in skill_runs, so the next turn
    // knows which question is open even though this result does not survive.
    case 'start_skill':
    case 'skill_step': {
      if (!actorUserId) return { summary: `${call.name}: no actor`, data: null };
      if (!(await isPersonalTurn(db, groupId))) {
        return { summary: `${call.name}: personal chat only`, data: { ok: false, reason: 'personal_only' } };
      }
      const action = (call.args as { action?: string }).action;
      // Answers are recorded by the server (skills/reply.ts), never by the model.
      if (call.name === 'skill_step' && action !== 'reopen' && action !== 'pause' && action !== 'stop') {
        return {
          summary: 'skill_step: invalid action',
          data: { ok: false, reason: 'invalid_action', instruction: 'The server records answers itself. Only reopen, pause or stop.' },
        };
      }
      const outcome =
        call.name === 'start_skill'
          ? await startSkill(db, {
              userId: actorUserId,
              groupId,
              skillId: (call.args as { skill: string }).skill,
              restart: (call.args as { restart?: boolean }).restart,
            })
          : await stepSkill(db, {
              userId: actorUserId,
              groupId,
              action: action as SkillAction,
            });
      return skillToolResult(call.name, outcome);
    }

    case 'get_my_availability': {
      const args = call.args as { days?: number; dates?: string[] };
      if (!actorUserId) {
        return { summary: 'get_my_availability: no actor', data: null };
      }
      // ADR 0197 — busy blocks are owner-scoped across every group, so a
      // shared group must not read them (the tool is also filtered out of
      // shared-group turns; this is the backstop, as for send_briefing).
      if (!(await isPersonalTurn(db, groupId))) {
        return {
          summary: 'get_my_availability: personal chat only',
          data: { known: false, reason: 'personal_only' },
        };
      }
      await maybeSyncCalendar(db, actorUserId);
      const avail = await userAvailability(db, actorUserId, { days: args.days, alsoDays: args.dates });
      return {
        summary: `get_my_availability: ${avail.days} days, ${avail.known ? 'known' : 'unknown'}`,
        data: avail.awayText
          ? {
              ...avail,
              // ADR 0245 - the trip is a fact about where the user is, and
              // the model must not offer to meet them somewhere they are not.
              instruction:
                'Days marked AWAY: the user is travelling (the city is on the line). Do not offer or confirm an in-person time on an AWAY day unless the meeting is in that city. A call can be offered. If it is not clear the meeting is a call or is in that city, say the user is travelling those days and offer a call then, or in-person times from the day they are back.',
            }
          : avail,
      };
    }

    case 'list_people': {
      const args = call.args as { limit?: number };
      if (!actorUserId) {
        return { summary: 'list_people: no actor', data: { people: [] } };
      }
      // Privacy: people are owner-scoped. Only the triggering user's saved
      // people are ever returned; another member of the same group cannot
      // read this list.
      const all = await listPeopleForUser(db, actorUserId);
      const capped = all.slice(0, args.limit ?? 30);
      return {
        summary: `list_people: ${capped.length} person(s)`,
        data: {
          people: capped.map((p) => ({
            id: p.id,
            displayName: p.displayName,
            notes: p.notes,
            importantDates: p.importantDates.map((d) => ({
              kind: d.kind,
              date: d.date,
              recurs: d.recurs,
            })),
          })),
          total: all.length,
        },
      };
    }

    // docs/notes/0189 — "tell me about X". Belt-and-braces with
    // PERSONAL_ONLY_TOOL_NAMES (ADR 0099's `send_briefing` precedent): this
    // reads the asker's own private people/relationships, so a shared-group
    // turn must never reach it even if the prompt-time filter is bypassed.
    case 'get_person_profile': {
      const args = call.args as { personName: string };
      if (!actorUserId) return { summary: 'get_person_profile: no actor', data: { found: false } };
      if (!(await isPersonalTurn(db, groupId))) {
        return {
          summary: 'get_person_profile: refused — personal chats only',
          data: { found: false, reason: 'not_personal' },
        };
      }
      const match = await findPersonByName(db, actorUserId, args.personName);
      if (!match) {
        return {
          summary: `get_person_profile: no saved person named "${args.personName}"`,
          data: { found: false, reason: 'not_found' },
        };
      }
      const profile = await getPersonProfile(db, actorUserId, match.id);
      return {
        summary: `get_person_profile: ${match.displayName}`,
        data: { found: true, profile },
      };
    }

    // ADR 0212 — the phone's Contacts first (the user keeps them current);
    // saved People is the fallback when the phone can't answer or lacks a field.
    case 'get_contact_info': {
      const args = call.args as { name: string };
      if (!actorUserId) return { summary: 'get_contact_info: no actor', data: { found: false } };
      if (!(await isPersonalTurn(db, groupId))) {
        return {
          summary: 'get_contact_info: refused — personal chats only',
          data: { found: false, reason: 'not_personal' },
        };
      }
      const device = await requestDeviceContact({
        emit,
        groupId,
        userId: actorUserId,
        query: args.name,
        timeoutMs: env.CONTACT_LOOKUP_TIMEOUT_MS,
      });
      // What the phone returns is a real source for this turn's sends and
      // invites, but it is never stored (ADR 0212), so it is held per turn.
      if (device.status === 'found') noteAddressesSeen(input.turnId, device.matches.flatMap((m) => m.emails));
      const saved = await findPersonByName(db, actorUserId, args.name);
      let chord: { displayName: string; email: string | null; phone: string | null; birthday: string | null } | null =
        null;
      if (saved) {
        const bday = await db
          .selectFrom('important_dates')
          .select('date')
          .where('person_id', '=', saved.id)
          .where('kind', '=', 'birthday')
          .executeTakeFirst();
        chord = {
          displayName: saved.displayName,
          email: saved.email,
          phone: saved.phone,
          birthday: bday?.date ?? null,
        };
      }
      return {
        summary: `get_contact_info: device=${device.status} (${device.matches.length}) saved=${chord ? 'yes' : 'no'}`,
        data: {
          device,
          saved: chord,
          instruction:
            'Answer from `device` (the phone\'s Contacts) first. Use `saved` only for a field the phone did not return, or when device.status is not "found".',
        },
      };
    }

    case 'update_person': {
      const args = call.args as {
        personName: string;
        newDisplayName?: string;
        notes?: string;
        email?: string;
        phone?: string;
      };
      if (!actorUserId) return { summary: 'update_person skipped (no actor)' };
      // A saved address becomes a source for later sends and invites, so it
      // needs one itself.
      if (args.email) {
        const check = await addressChecker(db, actorUserId, input.triggeringMessageId, input.turnId);
        const unknown = check ? await check([args.email]) : [];
        if (unknown.length) {
          return {
            summary: `update_person: nothing saved — no source for ${unknown.join(', ')}`,
            data: { reason: 'unknown_address', unknownAddresses: unknown, instruction: unknownAddressInstruction(unknown) },
          };
        }
      }
      const existing = await findPersonByName(db, actorUserId, args.personName);
      const target =
        existing ?? (await createPerson(db, { ownerUserId: actorUserId, displayName: args.personName }));
      const updated = await updatePerson(db, actorUserId, target.id, {
        displayName: args.newDisplayName,
        notes: args.notes,
        email: args.email,
        phone: args.phone,
      });
      if (!updated) return { summary: `update_person: "${args.personName}" not found` };
      const changed = (['newDisplayName', 'notes', 'email', 'phone'] as const).filter(
        (k) => args[k] !== undefined,
      );
      return {
        summary: `update_person ${updated.id} "${updated.displayName}": ${existing ? 'updated' : 'created'} ${changed.join(', ') || 'nothing'}`,
        data: { created: !existing, email: updated.email, phone: updated.phone },
        card: {
          kind: 'task',
          title: updated.displayName,
          subtitle: [updated.email, updated.phone].filter(Boolean).join(' · ') || undefined,
          meta: existing ? 'person updated' : 'person added',
        },
      };
    }

    case 'look_at_attachment': {
      const args = call.args as { attachmentId: string; question?: string };
      const att = await getAttachment(db, args.attachmentId);
      if (!att) {
        return { summary: 'look_at_attachment: attachment not found', data: { answer: null } };
      }
      // Scope: image attachments owned by the current group, or by the
      // asker as a personal upload. The bot must not be able to peer at
      // images that live in a sibling group the asker is in.
      const inGroup = att.scope.kind === 'group' && att.scope.groupId === groupId;
      const ownedByAsker =
        att.scope.kind === 'user' && actorUserId !== null && att.scope.userId === actorUserId;
      if (!inGroup && !ownedByAsker) {
        return { summary: 'look_at_attachment: attachment not visible here', data: { answer: null } };
      }
      if (!att.mimeType.startsWith('image/')) {
        return {
          summary: 'look_at_attachment: attachment is not an image',
          data: { answer: null },
        };
      }
      const source = await readBlob(absolutePathFor(att));
      const normalized = await normalizeImage(source, att.mimeType);
      const question = args.question?.trim() || 'Describe the image again in fresh detail.';
      const llm = await getLlmForUser(db, actorUserId, 'attachment_read');
      let raw: string;
      try {
        raw = await llm.complete(
          [
            {
              role: 'system',
              content:
                'You are re-examining an image the bot already summarized once. ' +
                'Answer the asker\'s question by looking at the image, not the prior summary. ' +
                'Reply with ONLY a single JSON object (no prose, no code fences) with these exact keys: ' +
                '{"answer": string — a concise, direct answer to the question (1-3 sentences); ' +
                '"verbatim": string — verbatim text from the image that supports the answer, empty string if none; ' +
                '"newTags": string[] — 0-3 ADDITIONAL classification tags this fresh look reveals that weren\'t obvious from the original summary (e.g. you now see this is a "coupon" or "boarding-pass" or "school-form"). Lowercase, kebab-case, common search nouns. Empty array if no new tags warranted; existing tags should NOT be repeated; do not include speculative or low-confidence guesses.}',
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: `File: ${att.filename}\nQuestion: ${question}` },
                { type: 'image', mimeType: normalized.mimeType, base64: normalized.buf.toString('base64') },
              ],
            },
          ],
          { maxTokens: 500, temperature: 0.1 },
        );
      } catch (err) {
        logger.warn(`look_at_attachment vision call failed`, { err, attachmentId: att.id });
        return { summary: 'look_at_attachment: vision call failed', data: { answer: null } };
      }
      const parsed = parseJsonObject(raw);
      const answer = parsed && typeof parsed['answer'] === 'string' ? (parsed['answer'] as string).trim() : '';
      const verbatim = parsed && typeof parsed['verbatim'] === 'string' ? (parsed['verbatim'] as string).trim() : '';
      const newTagsRaw = parsed?.['newTags'];
      const newTags = Array.isArray(newTagsRaw)
        ? Array.from(
            new Set(newTagsRaw.map(normalizeImageTag).filter((t): t is string => t !== null)),
          ).slice(0, 5)
        : [];

      // Merge any fresh tags into the persisted set so the next BM25
      // retrieval can find the image. Additive only — we never strip
      // tags the user might have already curated.
      let mergedTags: string[] | null = null;
      if (newTags.length > 0) {
        const existing = att.imageMeta?.tags ?? [];
        const merged = Array.from(new Set([...existing, ...newTags]));
        try {
          await patchAttachmentMeta(db, att.id, { tags: merged });
          mergedTags = merged;
        } catch (err) {
          logger.warn('look_at_attachment: failed to persist new tags', { err, attachmentId: att.id });
        }
      }

      if (!answer) {
        return {
          summary: 'look_at_attachment: no answer extracted',
          data: { answer: null, verbatim: verbatim || null, newTags },
        };
      }
      return {
        summary: `look_at_attachment: answered "${question.slice(0, 60)}"${mergedTags ? ` (+${newTags.length} new tag${newTags.length === 1 ? '' : 's'})` : ''}`,
        data: {
          attachmentId: att.id,
          filename: att.filename,
          question,
          answer,
          verbatim: verbatim || null,
          newTags,
          tags: mergedTags ?? att.imageMeta?.tags ?? [],
        },
      };
    }

    case 'send_file': {
      const args = call.args as { attachmentId: string; note?: string };
      const att = await getAttachment(db, args.attachmentId);
      if (!att) {
        return { summary: 'send_file: attachment not found' };
      }
      // Same scope gate as look_at_attachment: a group file, or one the
      // asker uploaded personally. Never hand back a file from a sibling
      // group the asker happens to share with someone here.
      const inGroup = att.scope.kind === 'group' && att.scope.groupId === groupId;
      const ownedByAsker =
        att.scope.kind === 'user' && actorUserId !== null && att.scope.userId === actorUserId;
      if (!inGroup && !ownedByAsker) {
        return { summary: 'send_file: attachment not visible here' };
      }
      if (att.blobMissing) {
        return {
          summary: `send_file: "${att.filename}" is no longer stored on the server — ask the user to re-upload it`,
        };
      }
      const note = args.note?.trim();
      const msg = await postMessage(db, {
        groupId,
        senderId: null,
        kind: 'file',
        body: note || att.filename,
        attachmentId: att.id,
        chordVisible: 1,
        autoMirror: false,
      });
      emit(groupId, SSE.message, msg);
      return {
        summary: `send_file: posted "${att.filename}"`,
        data: { attachmentId: att.id, messageId: msg.id },
      };
    }

    case 'reference_file': {
      const args = call.args as { attachmentId: string };
      const att = await getAttachment(db, args.attachmentId);
      if (!att) {
        return { summary: 'reference_file: attachment not found', data: { ok: false, reason: 'not_found' } };
      }
      // Same scope gate as send_file/look_at_attachment.
      const inGroup = att.scope.kind === 'group' && att.scope.groupId === groupId;
      const ownedByAsker =
        att.scope.kind === 'user' && actorUserId !== null && att.scope.userId === actorUserId;
      if (!inGroup && !ownedByAsker) {
        return {
          summary: 'reference_file: attachment not visible here',
          data: { ok: false, reason: 'not_visible' },
        };
      }
      if (att.blobMissing) {
        return {
          summary: `reference_file: "${att.filename}" is no longer stored on the server — ask the user to re-upload it`,
          data: { ok: false, reason: 'blob_missing' },
        };
      }
      return {
        summary: `reference_file: attached a card for "${att.filename}"`,
        card: { kind: 'action', title: att.filename, attachmentId: att.id, mimeType: att.mimeType },
        data: { ok: true, attachmentId: att.id },
      };
    }

    case 'start_form_fill': {
      const args = call.args as { attachmentId: string; subjectPersonName?: string };
      if (!actorUserId) return { summary: 'start_form_fill: no actor' };
      const att = await getAttachment(db, args.attachmentId);
      if (!att) return { summary: 'start_form_fill: attachment not found' };
      if (!att.mimeType.includes('pdf')) {
        return { summary: 'start_form_fill: attachment is not a PDF' };
      }
      const buffer = await readBlob(absolutePathFor(att));
      const schema = await extractFormSchema(buffer);
      if (!schema) {
        return {
          summary: 'start_form_fill: no AcroForm fields found',
          data: {
            error:
              'This PDF has no fillable form fields. Tell the user the form must be a fillable PDF (AcroForm) — flat scans aren\'t supported yet.',
          },
        };
      }
      // Resolve subject (kid) — match by name when supplied; otherwise leave
      // null and let the LLM ask the user.
      let subjectPersonId: string | null = null;
      if (args.subjectPersonName) {
        const p = await findPersonByName(db, actorUserId, args.subjectPersonName);
        if (p) subjectPersonId = p.id;
      }
      const filledValues = await extractFilledValues(buffer);
      const knowledge = await gatherKnowledge(db, {
        userId: actorUserId,
        groupId,
        subjectPersonId,
        preFilled: filledValues.byName,
      });
      const resolved = await resolveFields(schema, knowledge, await getLlmForUser(db, actorUserId, 'form_fill'));
      // Pre-filled values from the source PDF override LLM resolution and
      // come back as confirmed without ambiguity.
      const answers: Record<string, string> = {};
      for (const r of resolved) {
        if (r.value != null && r.status !== 'unknown') answers[r.name] = r.value;
      }
      for (const [name, value] of Object.entries(filledValues.byName)) {
        answers[name] = value;
      }
      // Reflect pre-filled values into the resolved list so the UI sees
      // them as confirmed with the right source.
      const resolvedWithPreFilled = resolved.map((r) =>
        filledValues.byName[r.name]
          ? {
              ...r,
              value: filledValues.byName[r.name],
              status: 'confirmed' as const,
              source: 'pre-filled on uploaded PDF',
              confidence: 1,
            }
          : r,
      );
      const form = await createForm(db, {
        groupId,
        title: att.filename,
        sourceAttachmentId: att.id,
        subjectPersonId,
        schema,
        answers,
        createdBy: actorUserId,
      });
      const gaps = resolvedWithPreFilled
        .filter((r) => r.status === 'unknown')
        .map((r) => r.label);
      const crossSubjectInsurance = resolvedWithPreFilled.filter(
        (r) =>
          r.status === 'inferred' &&
          r.source &&
          /from .+'s form/i.test(r.source) &&
          /(insurance|policy|member|group)/i.test(r.label),
      );
      return {
        summary: `start_form_fill: ${resolvedWithPreFilled.length} field(s), ${gaps.length} gap(s)`,
        data: {
          formId: form.id,
          title: att.filename,
          fields: resolvedWithPreFilled.map((r) => ({
            label: r.label,
            section: r.section,
            value: r.value,
            status: r.status,
            source: r.source,
          })),
          gaps,
          // Highlight family-shared values (typically insurance) carried
          // over from another household member's prior form. The bot
          // should confirm these with the user before finalizing rather
          // than silently filling.
          crossSubjectConfirmations: crossSubjectInsurance.map((r) => ({
            label: r.label,
            value: r.value,
            source: r.source,
          })),
          // Tip surfaced once when the user has zero prior forms — primes
          // them on the "upload an old filled-in form" pattern.
          tip:
            knowledge.priorAnswersByLabel.length === 0
              ? 'Tip: if you have a filled-in copy of this form (or a similar one from last year), upload it too. I will reuse those answers.'
              : undefined,
        },
      };
    }

    case 'complete_form_fill': {
      const args = call.args as { formId: string; answers: Record<string, string> };
      const existing = await getForm(db, args.formId);
      if (!existing) return { summary: 'complete_form_fill: form not found' };
      const filled = await finalizeForm(db, args.formId, args.answers);
      if (!filled || !filled.filledAttachmentId) {
        return { summary: 'complete_form_fill: failed to write filled PDF' };
      }
      return {
        summary: `complete_form_fill: form ${filled.id} → attachment ${filled.filledAttachmentId}`,
        card: {
          kind: 'action',
          title: `Filled: ${filled.title}`,
          subtitle: 'Form ready to download',
          meta: `${Object.keys(filled.answers).length} field(s) filled`,
          url: `/api/v1/attachments/${filled.filledAttachmentId}`,
        },
        data: {
          formId: filled.id,
          filledAttachmentId: filled.filledAttachmentId,
        },
      };
    }

    case 'suggest_external_action': {
      const args = call.args as {
        kind: ExternalActionKind;
        label: string;
        query?: ExternalActionQuery;
      };
      let query: ExternalActionQuery = args.query ?? {};
      // "Track Ben's flight": the number comes from the stored leg, not the
      // model - which, left to produce one, handed over a mileage number it
      // had remembered for the user.
      if (args.kind === 'flight_status' && query.passengerName?.trim() && actorUserId) {
        const hit = await findFlightForPassenger(
          db,
          { groupId, userId: actorUserId, isPersonal: await isPersonalTurn(db, groupId) },
          query.passengerName,
        );
        if (!hit) {
          return {
            summary: `external_action flight_status: no upcoming flight for "${query.passengerName.trim()}"`,
            data: {
              ok: false,
              reason: 'no_flight_found',
              instruction:
                'No flight in the last few hours or the next 30 days has that passenger. Say so plainly and ask for the airline and flight number. Do NOT pass a frequent-flyer, mileage, confirmation or ticket number as a flight number, and do NOT claim you produced a card or a link.',
            },
          };
        }
        query = { ...query, flightNumber: hit.flightNumber };
      }
      if (args.kind === 'package_tracking') {
        const resolved = await resolvePackageTracking(
          db,
          { userId: actorUserId ?? null, isPersonal: await isPersonalTurn(db, groupId), tz },
          query,
        );
        if (!resolved.ok) {
          return {
            summary: `external_action package_tracking: ${resolved.reason}`,
            data: {
              ok: false,
              reason: resolved.reason,
              instruction: resolved.instruction,
              ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
            },
          };
        }
        query = resolved.query;
      }
      // ADR 0153 — fill blank fields from the family (roster size, home
      // airport, the live trip, a saved place) before building the URL.
      const enriched = await enrichExternalActionQuery(
        db,
        { groupId, userId: actorUserId },
        args.kind,
        query,
      );
      const built = buildExternalAction(args.kind, enriched);
      // ADR 0138 — a flight whose airline is not in the table has no correct
      // FlightAware URL. No card, and the model is told plainly not to dress
      // that up as one (ADR 0102's posture for a tool that could not act).
      if (!built && args.kind === 'search') {
        return {
          summary: 'external_action search: no search terms',
          data: {
            ok: false,
            reason: 'no_query',
            instruction:
              'A search card needs the terms in query.q. Call again with them, or ask what to look for. Do NOT claim you produced a card or a link.',
          },
        };
      }
      if (!built) {
        return {
          summary: `external_action ${args.kind}: no link could be built`,
          data: {
            ok: false,
            reason: 'unknown_airline',
            instruction:
              'No tracking link exists for that flight. If you are looking for a family member\'s flight, call suggest_external_action again with query.passengerName (their name) instead of a number, and the system finds the flight. Otherwise say you could not find a tracker for it. Never pass a frequent-flyer, mileage, confirmation or ticket number as a flight number. Do NOT write a URL, and do NOT claim you produced a card or a link.',
          },
        };
      }
      return {
        summary: `external_action ${args.kind} → ${built.url}`,
        card: {
          kind: 'action',
          title: args.label,
          subtitle: built.provider,
          meta: built.meta || undefined,
          url: built.url,
          appUrl: built.appUrl,
        },
      };
    }

    case 'import_calendar': {
      const args = call.args as { url?: string; district?: string };
      if (!actorUserId) {
        return {
          summary: 'import_calendar: no actor — cannot import',
          data: { ok: false, reason: 'need_url' },
        };
      }
      // An explicit URL wins; otherwise resolve a known county/school feed.
      let url = args.url?.trim() || undefined;
      let label = args.district?.trim() || 'calendar';
      if (!url && args.district) {
        const hit = resolveDistrictCalendar(args.district);
        if (hit) {
          url = hit.url;
          label = hit.label;
        }
      }
      if (!url) {
        return {
          summary: `import_calendar: nothing to fetch (district="${args.district ?? ''}")`,
          data: { ok: false, reason: 'need_url' },
        };
      }
      let buffer: Buffer;
      try {
        buffer = await fetchIcsBuffer(url);
      } catch (err) {
        if (err instanceof CalendarFetchError) {
          return {
            summary: `import_calendar: fetch failed (${err.reason})`,
            data: { ok: false, reason: err.reason, message: err.message },
          };
        }
        throw err;
      }
      const res = await importIcs(db, {
        groupId,
        uploaderId: actorUserId,
        filename: `${label}.ics`,
        buffer,
        postSummary: false,
      });
      return {
        summary: `import_calendar: ${res.eventsCreated} created, ${res.eventsDeduped} deduped from ${label}`,
        data: {
          ok: true,
          label,
          eventsCreated: res.eventsCreated,
          eventsDeduped: res.eventsDeduped,
          totalVEvents: res.totalVEvents,
        },
      };
    }

    default: {
      logger.warn(`unhandled tool ${(call as ToolCall).name}`);
      return { summary: `unknown tool ${(call as ToolCall).name}` };
    }
  }
}

export const __testing = { formatDueAt, scrubCrossGroupLeak };

