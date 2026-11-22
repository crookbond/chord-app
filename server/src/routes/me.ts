import { Router } from 'express';
import {
  AddImportantDateRequest,
  API,
  SESSION_COOKIE,
  BlockUserRequest,
  type BlockedUser,
  ReportMessageRequest,
  type ReportMessageResponse,
  type CalendarSource,
  CreatePersonRequest,
  DeviceCalendarSyncRequest,
  DeviceContactLookupResponse,
  UpdatePersonRequest,
  UpdateCalendarSourceRequest,
  SetDefaultCalendarRequest,
  type DefaultCalendar,
  type ImportantDate,
  type ImportantDateId,
  type ImportantDateKind,
  type ImportantDay,
  type ListeningMode,
  type MeSettings,
  type ModelProvider,
  type PendingPersonSuggestion,
  type PersonId,
  type PersonWithDates,
  SetMyNameRequest,
  type CatchupEntityType,
  type CatchupFolder,
  type CatchupFolderContents,
  MoveCatchupAssignmentRequest,
  SetListeningModeRequest,
  LinkSignupRefRequest,
  SetModelKeyRequest,
  SetNudgeRequest,
  SetTimezoneRequest,
  SetDeviceLocationRequest,
  SetWeatherLocationRequest,
  SetBriefingChannelRequest,
  SetNotificationPrefsRequest,
  RegisterPushTokenRequest,
  UnregisterPushTokenRequest,
  SearchRequest,
  StartPhoneVerificationRequest,
  VerifyPhoneRequest,
  ResolveContactsRequest,
  type CheckoutSessionRequest,
  type BillingPortalResponse,
  type SetRenewalResponse,
  type ChangePlanResponse,
  type CheckoutSessionResponse,
  type PhoneStatus,
  type ResolveContactsResponse,
  type StartPhoneVerificationResponse,
  type User,
  type UserId,
  type AiConsentStatus,
  SetAiConsentRequest,
  sharedSignature,
} from '@chord/kernel';
import { getAiConsent, setAiConsent } from '../services/ai-consent.service.js';
import { maybeStartOnboarding } from '../services/bot/skills/auto-start.js';
import { aiRecipient } from '../services/llm/ai-recipient.js';

import { logger } from '../config/logging.js';
import { blockMember, listBlockedUsers, unblockUser } from '../services/blocks.service.js';
import { reportMessage } from '../services/reports.service.js';
import { deleteAccount, PlanNotCancelledError } from '../services/account.service.js';
import { searchHits, parseSearchTypes } from '../services/search.service.js';
import { ensurePersonalGroup } from '../services/groups.service.js';
import {
  listBriefingChannels,
  setBriefingChannelMuted,
} from '../services/connectors/briefing-channels.js';
import {
  applyDeviceLocation,
  clearDeviceLocation,
  clearUserWeatherLocation,
  seedLocationFromIp,
  setUserWeatherLocation,
  stashIpObservation,
} from '../services/geo/location.js';
import { consumeSignupIntent } from '../services/connectors/signup-intents.service.js';
import {
  recordUserTimezone,
  rescheduleDailyScanForUser,
} from '../services/proactive.service.js';
import { loadSession, requireSession } from '../middleware/auth.js';
import { sessionCookieOptions } from '../utils/session-expiry.js';
import { hasAnyCalendar, hasCalendarScope } from '../services/google/calendar.service.js';
import { outlookCalendarAccounts } from '../services/outlook-calendar/enabled.js';
import { parseOutlookCalendarKey } from '../services/outlook-calendar/ids.js';
import { GoogleAuthError } from '../services/google/oauth.service.js';
import { syncTwoWay } from '../services/google/two-way-sync.service.js';
import { forgetDeviceCalendar, syncDeviceCalendar } from '../services/device-calendar.service.js';
import {
  getDefaultCalendar,
  listCalendarSources,
  setCalendarColor,
  setCalendarSourceOverride,
  setDefaultCalendar,
  type CalendarSourceRow,
} from '../services/calendar-sources.service.js';
import { hasCalendarWriteScope } from '../services/google/calendar-write.service.js';
import {
  addImportantDate,
  createPerson,
  deleteImportantDate,
  deletePerson,
  learnedFactsForPeople,
  listPendingPersonSuggestions,
  listPeopleForUser,
  updatePerson,
} from '../services/people.service.js';
import { answerDeviceContactLookup } from '../services/bot/device-contact-lookup.js';
import {
  listFolderContents,
  listFoldersForUser,
  moveAssignment,
} from '../services/catchup/folders.service.js';
import { saveModelKey } from '../services/model-key.service.js';
import { describeSystemLlm } from '../services/llm/system-llm.js';
import { getBillingStatus } from '../services/billing-status.service.js';
import { createBillingPortalSession } from '../services/stripe.service.js';
import { changePlan, setRenewal } from '../services/subscription-renewal.service.js';
import { startCheckout } from '../services/checkout.service.js';
import {
  getPhoneStatus,
  releasePhone,
  startPhoneVerification,
  verifyPhone,
} from '../services/phone/phone.service.js';
import { publicWhatsappNumber } from '../services/phone/normalize.js';
import {
  listContactLinks,
  resolveContacts,
} from '../services/contacts/contacts.service.js';
import { env } from '../config/env.js';
import { mailboxSignatures } from '../services/email/signature.js';
import {
  listGrantsByRecipient,
  listIncomingRequests,
  listOutgoingRequests,
  listTrustCandidates,
  respondToRequest,
  setGrant,
  type TrustScope,
} from '../services/trust.service.js';

const CATCHUP_ENTITY_TYPES: ReadonlySet<CatchupEntityType> = new Set([
  'task',
  'list',
  'save',
  'trip',
]);

export const meRouter = Router();
meRouter.use(loadSession);

meRouter.get(API.me, requireSession, async (req, res, next) => {
  try {
    const row = await req.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', req.userId!)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: 'user missing' });
      return;
    }
    const user: User = {
      id: row.id,
      username: row.username,
      displayName: row.display_name ?? undefined,
      firstName: row.first_name ?? undefined,
      lastName: row.last_name ?? undefined,
      preferredName: row.preferred_name ?? undefined,
      email: row.email ?? undefined,
      createdAt: row.created_at,
    };
    res.json(user);
  } catch (err) {
    next(err);
  }
});

/** ADR 0283 — the AI consent decision and who would receive the data. */
meRouter.get(API.meAiConsent, requireSession, async (req, res, next) => {
  try {
    const status: AiConsentStatus = {
      consent: await getAiConsent(req.db, req.userId!),
      recipient: await aiRecipient(req.db, req.userId!),
      required: env.AI_CONSENT_REQUIRED,
    };
    res.json(status);
  } catch (err) {
    next(err);
  }
});

meRouter.put(API.meAiConsent, requireSession, async (req, res, next) => {
  try {
    const parsed = SetAiConsentRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    const recipient = await aiRecipient(req.db, req.userId!);
    const r = await setAiConsent(req.db, req.userId!, { ...parsed.data, recipient });
    if (!r.ok) {
      res.status(400).json({ error: 'Please confirm you are 18 or older, or that a parent or guardian agreed.' });
      return;
    }
    // ADR 0299 — agreeing is a new user's first use: onboarding opens in their chat.
    if (r.consent.decision === 'granted') {
      await maybeStartOnboarding(req.db, req.userId!, { post: true }).catch((err) =>
        logger.warn('onboarding auto-start failed', { err }),
      );
    }
    const status: AiConsentStatus = { consent: r.consent, recipient, required: env.AI_CONSENT_REQUIRED };
    res.json(status);
  } catch (err) {
    next(err);
  }
});

/**
 * Link a welcome-DM referrer token to the already-signed-in user (ADR
 * 0031 / 0053). The fresh-sign-in path consumes `signupRef` on
 * `authGoogle`; a *returning* user who clicks the welcome link is already
 * authenticated and never re-runs OAuth, so without this the WhatsApp
 * taster shadow (or Telegram identity) would never merge into their
 * account. Best-effort: a stale/unknown/consumed token returns
 * `linked: false` rather than erroring.
 */
meRouter.post(API.meLinkSignupRef, requireSession, async (req, res, next) => {
  try {
    const parsed = LinkSignupRefRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    const me = await req.db
      .selectFrom('users')
      .select(['email', 'display_name'])
      .where('id', '=', req.userId!)
      .executeTakeFirst();
    if (!me) {
      res.status(404).json({ error: 'user missing' });
      return;
    }
    const result = await consumeSignupIntent(req.db, {
      token: parsed.data.signupRef,
      ownerUserId: req.userId!,
      ownerEmail: me.email ?? '',
      ownerDisplay: me.display_name ?? null,
    });
    if (!result.ok) {
      logger.info('link-signup-ref skipped', {
        userId: req.userId,
        reason: result.reason,
      });
    }
    res.json({ ok: true, linked: result.ok });
  } catch (err) {
    next(err);
  }
});

/**
 * Permanently delete the authenticated user's account (ADR 0043). Wipes the
 * user, their personal/solo groups and all content within, their personal
 * files, calendar connection, people, and trust grants; revokes the Google
 * authorization at Google; and anonymizes their footprint in shared groups
 * (those survive for the remaining members). Irreversible. The user-row delete
 * cascades the caller's sessions, so their token is invalid after this returns.
 */
meRouter.delete(API.me, requireSession, async (req, res, next) => {
  try {
    const summary = await deleteAccount(req.db, req.userId!);
    // The session row went with the user; the browser's cookie goes too.
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions());
    res.json({ ok: true, ...summary });
  } catch (err) {
    if (err instanceof PlanNotCancelledError) {
      logger.error('account deletion refused: plan not cancelled', { userId: req.userId, err: err.message });
      res.status(502).json({
        error: 'Your plan could not be cancelled, so your account was not deleted. Please try again.',
      });
      return;
    }
    logger.error('account deletion failed', { err, userId: req.userId });
    next(err);
  }
});

meRouter.get(API.meCalendarStatus, requireSession, async (req, res, next) => {
  try {
    const row = await req.db
      .selectFrom('users')
      .select(['google_calendar_synced_at', 'refresh_token_scopes'])
      .where('id', '=', req.userId!)
      .executeTakeFirst();
    const connected = await hasCalendarScope(req.db, req.userId!);
    const writeEnabled = await hasCalendarWriteScope(req.db, req.userId!);
    res.json({
      connected,
      writeEnabled,
      // ADR 0228 — an Outlook mailbox's calendar is being synced.
      outlookConnected: (await outlookCalendarAccounts(req.db, req.userId!)).length > 0,
      lastSyncedAt: row?.google_calendar_synced_at ?? null,
      scopes: row?.refresh_token_scopes ?? null,
    });
  } catch (err) {
    next(err);
  }
});

function rowToCalendarSource(
  r: CalendarSourceRow,
  emailByAccount: Map<string, string> = new Map(),
): CalendarSource {
  const account = parseOutlookCalendarKey(r.googleCalendarId)?.accountId;
  return {
    id: r.id,
    provider: r.provider,
    ...(account ? { accountEmail: emailByAccount.get(account) ?? null } : {}),
    color: r.color,
    colorChoice: r.colorChoice,
    displayColor: r.displayColor,
    googleCalendarId: r.googleCalendarId,
    summary: r.summary,
    accessRole: r.accessRole,
    isPrimary: r.isPrimary,
    selectedInGoogle: r.selectedInGoogle,
    countsForBusyAuto: r.countsForBusyAuto,
    countsForBusyOverride: r.countsForBusyOverride,
    countsForBusyEffective: r.countsForBusyEffective,
  };
}

meRouter.get(API.meCalendarSources, requireSession, async (req, res, next) => {
  try {
    const rows = await listCalendarSources(req.db, req.userId!);
    const accounts = rows.some((r) => r.provider === 'outlook')
      ? await req.db
          .selectFrom('email_accounts')
          .select(['id', 'email_address'])
          .where('user_id', '=', req.userId!)
          .execute()
      : [];
    const emailByAccount = new Map(accounts.map((a) => [a.id, a.email_address]));
    res.json(rows.map((r) => rowToCalendarSource(r, emailByAccount)));
  } catch (err) {
    next(err);
  }
});

// ADR 0256 — the calendar an event goes on when none is named. The same
// `setDefaultCalendar` the `set_default_calendar` bot tool calls.
meRouter.get(API.meDefaultCalendar, requireSession, async (req, res, next) => {
  try {
    const body: DefaultCalendar = await getDefaultCalendar(req.db, req.userId!);
    res.json(body);
  } catch (err) {
    next(err);
  }
});

meRouter.put(API.meDefaultCalendar, requireSession, async (req, res, next) => {
  try {
    const parse = SetDefaultCalendarRequest.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: 'invalid_body', detail: parse.error.flatten() });
      return;
    }
    const result = await setDefaultCalendar(req.db, req.userId!, { calendarId: parse.data.calendarId });
    if (!result.ok) {
      res.status(400).json({ error: result.reason });
      return;
    }
    const body: DefaultCalendar = { calendarId: result.calendarId, label: result.label };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// ADR 0298 — the user-level block. The same `blockMember` / `unblockUser` /
// `listBlockedUsers` the block_user / unblock_user / list_blocked_users bot
// tools call.
meRouter.get(API.meBlocks, requireSession, async (req, res, next) => {
  try {
    const body: BlockedUser[] = await listBlockedUsers(req.db, req.userId!);
    res.json(body);
  } catch (err) {
    next(err);
  }
});

meRouter.post(API.meBlocks, requireSession, async (req, res, next) => {
  try {
    const parse = BlockUserRequest.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: 'invalid_body', detail: parse.error.flatten() });
      return;
    }
    const result = await blockMember(req.db, req.userId!, parse.data.userId);
    if (!result.ok) {
      res.status(result.reason === 'self' ? 400 : 404).json({ error: result.reason });
      return;
    }
    const body: BlockedUser = result.user;
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// ADR 0301 — report a message another member posted in a shared chat. The
// same `reportMessage` the report_message bot tool calls.
meRouter.post(API.meReports, requireSession, async (req, res, next) => {
  try {
    const parse = ReportMessageRequest.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: 'invalid_body', detail: parse.error.flatten() });
      return;
    }
    const result = await reportMessage(req.db, {
      reporterId: req.userId!,
      messageId: parse.data.messageId,
      reason: parse.data.reason,
    });
    if (!result.ok) {
      res.status(result.reason === 'not_found' ? 404 : 400).json({ error: result.reason });
      return;
    }
    const body: ReportMessageResponse = { reportId: result.reportId, alreadyReported: result.alreadyReported };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

meRouter.delete(API.meBlock(':userId'), requireSession, async (req, res, next) => {
  try {
    await unblockUser(req.db, req.userId!, String(req.params.userId));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ADR 0063/0194/0196 — token balance + the model tier the user's turns run
// on. The same assembly the `get_billing_status` bot tool uses
// (`billing-status.service.ts`) — one place, so Settings and the bot can
// never disagree about a user's own billing status.
meRouter.get(API.meBilling, requireSession, async (req, res, next) => {
  try {
    const status = await getBillingStatus(req.db, req.userId!);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

// ADR 0075/0195 — start a Stripe subscription Checkout session, for either
// the system-key plan or the BYOK base plan.
meRouter.post(API.meBillingCheckout, requireSession, async (req, res, next) => {
  try {
    const { plan, interval, platform, code } = (req.body ?? {}) as Partial<CheckoutSessionRequest>;
    if (plan !== 'system' && plan !== 'family' && plan !== 'byok_base') {
      res.status(400).json({ error: 'invalid_plan' });
      return;
    }
    if (interval !== undefined && interval !== 'month' && interval !== 'year') {
      res.status(400).json({ error: 'invalid_interval' });
      return;
    }
    const out = await startCheckout(req.db, req.userId!, { plan, interval, platform, code });
    if (out.ok) {
      const body: CheckoutSessionResponse = { url: out.url };
      res.json(body);
    } else if (out.reason === 'billing_unavailable') {
      res.status(503).json({ error: out.reason });
    } else if (out.reason === 'already_subscribed') {
      res.status(409).json({ error: out.reason, source: out.source, plan: out.plan });
    } else {
      res.status(400).json({ error: out.reason });
    }
  } catch (err) {
    next(err);
  }
});

// ADR 0231 — Stripe's hosted page for changing plan, updating the card or
// cancelling. Only a Stripe-sold subscription has one; an App Store
// subscription is managed in the device's own subscription settings.
meRouter.post(API.meBillingPortal, requireSession, async (req, res, next) => {
  try {
    const { platform } = (req.body ?? {}) as { platform?: 'web' | 'native' };
    const row = await req.db
      .selectFrom('users')
      .select(['stripe_customer_id', 'subscription_source'])
      .where('id', '=', req.userId!)
      .executeTakeFirst();
    if (!env.STRIPE_SECRET_KEY || !row?.stripe_customer_id || row.subscription_source === 'apple') {
      res.status(404).json({ error: 'no_portal', source: row?.subscription_source ?? null });
      return;
    }
    const { url } = await createBillingPortalSession(row.stripe_customer_id, platform === 'native' ? 'native' : 'web');
    const body: BillingPortalResponse = { url };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// ADR 0236 — one-click cancel (and resume) of a Stripe subscription's renewal.
// The plan keeps working until the paid period ends.
meRouter.post(API.meBillingRenewal, requireSession, async (req, res, next) => {
  try {
    const { renew } = (req.body ?? {}) as { renew?: unknown };
    if (typeof renew !== 'boolean') {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const out = await setRenewal(req.db, req.userId!, renew);
    if (out.ok) {
      const body: SetRenewalResponse = { cancelsAtPeriodEnd: out.cancelsAtPeriodEnd, periodEnd: out.periodEnd };
      res.json(body);
    } else if (out.reason === 'apple') {
      res.status(409).json({ error: out.reason, source: out.source });
    } else if (out.reason === 'no_subscription') {
      res.status(404).json({ error: out.reason });
    } else if (out.reason === 'billing_unavailable') {
      res.status(503).json({ error: out.reason });
    } else {
      res.status(502).json({ error: out.reason });
    }
  } catch (err) {
    next(err);
  }
});

// ADR 0236 — switch a Stripe subscription to another plan/interval in place.
meRouter.post(API.meBillingPlan, requireSession, async (req, res, next) => {
  try {
    const { plan, interval } = (req.body ?? {}) as { plan?: unknown; interval?: unknown };
    if ((plan !== 'system' && plan !== 'family') || (interval !== 'month' && interval !== 'year')) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const out = await changePlan(req.db, req.userId!, plan, interval);
    if (out.ok) {
      const body: ChangePlanResponse = { plan: out.plan as 'system' | 'family', interval: out.interval };
      res.json(body);
    } else if (out.reason === 'apple') {
      res.status(409).json({ error: out.reason, source: out.source });
    } else if (out.reason === 'no_subscription') {
      res.status(404).json({ error: out.reason });
    } else if (out.reason === 'same_plan' || out.reason === 'not_switchable') {
      res.status(400).json({ error: out.reason });
    } else if (out.reason === 'payment_failed') {
      res.status(402).json({ error: out.reason });
    } else if (out.reason === 'billing_unavailable') {
      res.status(503).json({ error: out.reason });
    } else {
      res.status(502).json({ error: out.reason });
    }
  } catch (err) {
    next(err);
  }
});

// ADR 0062 — global search across every group the user belongs to.
meRouter.get(API.meSearch, requireSession, async (req, res, next) => {
  try {
    const parsed = SearchRequest.safeParse({
      q: req.query.q,
      types: parseSearchTypes(req.query.types),
      limit: req.query.limit,
    });
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_query', detail: parsed.error.flatten() });
      return;
    }
    const personal = await ensurePersonalGroup(req.db, req.userId!);
    const out = await searchHits(req.db, {
      userId: req.userId!,
      groupId: personal.id,
      crossGroup: true,
      query: parsed.data.q,
      types: parsed.data.types,
      limit: parsed.data.limit,
    });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// ─── Phone identity (ADR 0064) ────────────────────────────────────────

meRouter.get(API.mePhone, requireSession, async (req, res, next) => {
  try {
    const status: PhoneStatus = await getPhoneStatus(req.db, req.userId!);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

/**
 * `unavailable` is a 503, not a 400: the caller's request was fine, the
 * deploy simply has no Twilio Verify credentials. It used to be impossible —
 * a missing config silently fell through to the fixed-code mock instead.
 */
function phoneErrorStatus(reason: string): number {
  if (reason === 'unavailable') return 503;
  if (reason === 'taken') return 409;
  if (reason === 'too_many_attempts') return 429;
  return 400;
}

meRouter.post(API.mePhoneStart, requireSession, async (req, res, next) => {
  try {
    const parsed = StartPhoneVerificationRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    const result = await startPhoneVerification(req.db, req.userId!, parsed.data.phone);
    if (!result.ok) {
      res.status(phoneErrorStatus(result.reason)).json({ error: result.reason });
      return;
    }
    const body: StartPhoneVerificationResponse = { phone: result.phone };
    res.json(body);
  } catch (err) {
    logger.warn('phone verification start failed', { err });
    next(err);
  }
});

meRouter.post(API.mePhoneVerify, requireSession, async (req, res, next) => {
  try {
    const parsed = VerifyPhoneRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    const result = await verifyPhone(req.db, req.userId!, parsed.data.phone, parsed.data.code);
    if (!result.ok) {
      res.status(phoneErrorStatus(result.reason)).json({ error: result.reason });
      return;
    }
    const body: PhoneStatus = await getPhoneStatus(req.db, req.userId!);
    res.json(body);
  } catch (err) {
    logger.warn('phone verification failed', { err });
    next(err);
  }
});

meRouter.delete(API.mePhone, requireSession, async (req, res, next) => {
  try {
    await releasePhone(req.db, req.userId!);
    const body: PhoneStatus = await getPhoneStatus(req.db, req.userId!);
    res.json(body);
  } catch (err) {
    logger.warn('phone release failed', { err });
    next(err);
  }
});

// ─── Contact discovery (ADR 0065) ─────────────────────────────────────

meRouter.get(API.meContacts, requireSession, async (req, res, next) => {
  try {
    const resolved = await listContactLinks(req.db, req.userId!);
    const body: ResolveContactsResponse = { resolved };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

meRouter.post(API.meContactsResolve, requireSession, async (req, res, next) => {
  try {
    const parsed = ResolveContactsRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_body', detail: parsed.error.flatten() });
      return;
    }
    const resolved = await resolveContacts(req.db, req.userId!, parsed.data.contacts);
    const body: ResolveContactsResponse = { resolved };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

meRouter.patch(API.meCalendarSource(':id'), requireSession, async (req, res, next) => {
  try {
    const parse = UpdateCalendarSourceRequest.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ error: 'invalid_body', detail: parse.error.flatten() });
      return;
    }
    let updated: CalendarSourceRow | null = null;
    // ADR 0278 — the same writer as the `set_calendar_color` bot tool.
    if (parse.data.colorChoice !== undefined) {
      const result = await setCalendarColor(req.db, req.userId!, { id: req.params.id }, parse.data.colorChoice);
      if (!result.ok) {
        res.status(result.reason === 'bad_color' ? 400 : 404).json({ error: result.reason });
        return;
      }
      updated = result.calendar;
    }
    if (parse.data.countsForBusyOverride !== undefined) {
      updated = await setCalendarSourceOverride(
        req.db,
        req.userId!,
        req.params.id,
        parse.data.countsForBusyOverride,
      );
    }
    if (!updated) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json(rowToCalendarSource(updated));
  } catch (err) {
    next(err);
  }
});

meRouter.get(API.mePeople, requireSession, async (req, res, next) => {
  try {
    const people = await listPeopleForUser(req.db, req.userId!);
    // ADR 0078 — attach what Chord has learned (confirmed memories only).
    const facts = await learnedFactsForPeople(req.db, req.userId!, people);
    const out: PersonWithDates[] = people.map((p) => ({
      id: p.id as PersonId,
      ownerUserId: p.ownerUserId as UserId,
      displayName: p.displayName,
      notes: p.notes,
      email: p.email,
      phone: p.phone,
      facts: facts.get(p.id) ?? [],
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      importantDates: p.importantDates.map((d) => ({
        id: d.id as ImportantDateId,
        personId: d.personId as PersonId,
        kind: d.kind as ImportantDateKind,
        date: d.date,
        recurs: d.recurs,
      })),
    }));
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// ADR 0078 — staged person/birthday proposals for the People screen strip.
meRouter.get(API.mePeoplePending, requireSession, async (req, res, next) => {
  try {
    const pending: PendingPersonSuggestion[] = await listPendingPersonSuggestions(
      req.db,
      req.userId!,
    );
    res.json(pending);
  } catch (err) {
    next(err);
  }
});

meRouter.post(API.mePeople, requireSession, async (req, res, next) => {
  try {
    const parsed = CreatePersonRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const person = await createPerson(req.db, {
      ownerUserId: req.userId!,
      displayName: parsed.data.displayName,
      notes: parsed.data.notes,
    });
    res.status(201).json({
      id: person.id,
      ownerUserId: person.ownerUserId,
      displayName: person.displayName,
      notes: person.notes,
      createdAt: person.createdAt,
      updatedAt: person.updatedAt,
      importantDates: [],
    });
  } catch (err) {
    next(err);
  }
});

// ADR 0212 — edit a saved person; the bot's `update_person` calls the same service.
meRouter.patch('/api/v1/me/people/:id', requireSession, async (req, res, next) => {
  try {
    const parsed = UpdatePersonRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const person = await updatePerson(req.db, req.userId!, req.params.id!, parsed.data);
    if (!person) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(person);
  } catch (err) {
    next(err);
  }
});

// ADR 0212 — the phone's answer to a `contact.lookup` the bot is waiting on.
meRouter.post('/api/v1/me/contact-lookups/:id', requireSession, (req, res) => {
  const parsed = DeviceContactLookupResponse.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  const accepted = answerDeviceContactLookup(req.userId!, req.params.id!, parsed.data);
  // 404 covers expired, already-answered and someone else's request alike —
  // when no other web copy could hold it (ADR 0280); a forwarded answer is 204.
  res.status(accepted ? 204 : 404).end();
});

meRouter.delete('/api/v1/me/people/:id', requireSession, async (req, res, next) => {
  try {
    const ok = await deletePerson(req.db, req.userId!, req.params.id!);
    if (!ok) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

meRouter.post(
  '/api/v1/me/people/:id/important-dates',
  requireSession,
  async (req, res, next) => {
    try {
      const parsed = AddImportantDateRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.message });
        return;
      }
      // Ownership check: the person must belong to the caller.
      const owner = await req.db
        .selectFrom('people')
        .select(['owner_user_id'])
        .where('id', '=', req.params.id!)
        .executeTakeFirst();
      if (!owner || owner.owner_user_id !== req.userId) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const d = await addImportantDate(req.db, {
        personId: req.params.id!,
        kind: parsed.data.kind,
        date: parsed.data.date,
        recurs: parsed.data.recurs ?? true,
      });
      const out: ImportantDate = {
        id: d.id as ImportantDateId,
        personId: d.personId as PersonId,
        kind: d.kind,
        date: d.date,
        recurs: d.recurs,
      };
      res.status(201).json(out);
    } catch (err) {
      next(err);
    }
  },
);

meRouter.delete('/api/v1/me/important-dates/:id', requireSession, async (req, res, next) => {
  try {
    const ok = await deleteImportantDate(req.db, req.userId!, req.params.id!);
    if (!ok) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

meRouter.get(API.meImportantDays, requireSession, async (req, res, next) => {
  try {
    const rows = await req.db
      .selectFrom('important_dates as d')
      .innerJoin('people as p', 'p.id', 'd.person_id')
      .select([
        'd.id as id',
        'd.person_id as personId',
        'p.display_name as personName',
        'd.kind as kind',
        'd.date as date',
        'd.recurs as recurs',
      ])
      .where('p.owner_user_id', '=', req.userId!)
      .execute();
    const out: ImportantDay[] = rows.map((r) => ({
      id: r.id as ImportantDateId,
      personId: r.personId as PersonId,
      personName: r.personName,
      kind: r.kind as ImportantDateKind,
      date: r.date,
      recurs: Number(r.recurs) === 1,
    }));
    res.json(out);
  } catch (err) {
    next(err);
  }
});

meRouter.post(API.meCalendarSync, requireSession, async (req, res, next) => {
  try {
    if (!(await hasAnyCalendar(req.db, req.userId!))) {
      res.status(403).json({ error: 'calendar scope not granted' });
      return;
    }
    // ADR 0040 — two-way reconcile. Response keeps inserted/deleted/calendars
    // for client compatibility with the old SyncResult, plus a push summary.
    const result = await syncTwoWay(req.db, req.userId!);
    const pulls = Object.values(result.pull);
    res.json({
      inserted: pulls.reduce((n, p) => n + p.inserted, 0),
      deleted: pulls.reduce((n, p) => n + p.deleted, 0),
      calendars: pulls.length,
      pushed: result.push.created + result.push.updated + result.push.deleted,
      raw: result,
    });
  } catch (err) {
    // The refresh token was dead — getAccessToken already cleared it, so the
    // calendar is now disconnected. Tell the client to reconnect rather than
    // returning a generic 500.
    if (err instanceof GoogleAuthError && err.needsReconnect) {
      logger.info('calendar sync: refresh token dead, cleared — reconnect required', {
        userId: req.userId,
      });
      res.status(409).json({
        error: 'google calendar disconnected — reconnect required',
        needsReconnect: true,
      });
      return;
    }
    logger.warn('calendar sync failed', { err });
    next(err);
  }
});

/**
 * ADR 0057 — device calendar read-up. The client posts its selected device
 * calendars + events for the −30/+60 window; we mirror them into the user's
 * personal calendar (never group-shared). No Google scope required — this is the
 * path for users who haven't connected Google at all.
 */
meRouter.post(API.meDeviceCalendarSync, requireSession, async (req, res, next) => {
  try {
    const parsed = DeviceCalendarSyncRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    const result = await syncDeviceCalendar(req.db, req.userId!, parsed.data);
    res.json(result);
  } catch (err) {
    logger.warn('device calendar sync failed', { err });
    next(err);
  }
});

// Mirror switched off on the phone: its copies leave Chord now, not after the
// 30-day sweep. Scoped to the caller's own rows, so a calendar id from another
// account removes nothing.
// Literal path: API.meDeviceCalendar encodes its argument, which would turn
// the `:` of a route parameter into `%3A`.
meRouter.delete('/api/v1/me/device-calendar/:deviceCalendarId', requireSession, async (req, res, next) => {
  try {
    const id = String(req.params.deviceCalendarId ?? '');
    if (!id) {
      res.status(400).json({ error: 'calendar id required' });
      return;
    }
    const out = await forgetDeviceCalendar(req.db, req.userId!, id);
    res.json({ ok: true, ...out });
  } catch (err) {
    next(err);
  }
});

/**
 * Forget the stored Google refresh token + scopes + cached calendar id so
 * the next "Connect Calendar" tap goes through the full consent flow.
 * Used when the user originally granted readonly and wants to upgrade to
 * write — Google won't re-prompt for scope unless we drop the token.
 *
 * Imported gcal events are left in place: they're scoped to the personal
 * group and the user may still want to see them. They'll resync on the
 * next connect if Google still has them.
 */
meRouter.post(API.meCalendarDisconnect, requireSession, async (req, res, next) => {
  try {
    await req.db
      .updateTable('users')
      .set({
        refresh_token_ciphertext: null,
        refresh_token_iv: null,
        refresh_token_tag: null,
        refresh_token_scopes: null,
        refresh_token_client_id: null,
        google_calendar_id: null,
        google_calendar_synced_at: null,
        // Intentional disconnect: forget we were ever connected so the
        // proactive reconnect nudge (which keys off google_connected_at)
        // never fires for a user who chose to disconnect.
        google_connected_at: null,
        calendar_reconnect_nudged_at: null,
      })
      .where('id', '=', req.userId!)
      .execute();
    logger.info('calendar disconnected', { userId: req.userId });
    res.json({ ok: true });
  } catch (err) {
    logger.warn('calendar disconnect failed', { err });
    next(err);
  }
});

// ─── Settings (PR-D) ──────────────────────────────────────────────────

meRouter.get(API.meSettings, requireSession, async (req, res, next) => {
  try {
    const row = await req.db
      .selectFrom('users')
      .select([
        'listening_mode',
        'model_provider',
        'model_name',
        'model_base_url',
        'model_key_ciphertext',
        'nudge_hour',
        'nudge_minute',
        'nudge_enabled',
        'notify_messages',
        'notify_email',
        'notify_bot',
        'notify_briefing',
        'quiet_enabled',
        'quiet_start_hour',
        'quiet_start_minute',
        'quiet_end_hour',
        'quiet_end_minute',
        'email_digest_enabled',
        'gmail_sync_labels_enabled',
        'chord_label_push_enabled',
        'email_images_auto',
        'email_swipe_action',
        'email_after_remove',
        'email_signature',
        'email_signature_html',
        'weather_place',
        'weather_place_source',
      ])
      .where('id', '=', req.userId!)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: 'user missing' });
      return;
    }
    const body: MeSettings = {
      listeningMode: (row.listening_mode ?? 'invocation') as ListeningMode,
      modelProvider: (row.model_provider ?? null) as ModelProvider | null,
      modelName: row.model_name ?? null,
      modelBaseUrl: row.model_base_url ?? null,
      hasModelKey: row.model_key_ciphertext !== null && row.model_key_ciphertext !== undefined,
      whatsappNumber: publicWhatsappNumber(),
      systemLlm: describeSystemLlm(),
      nudgeHour: row.nudge_hour ?? 7,
      nudgeMinute: row.nudge_minute ?? 0,
      nudgeEnabled: Number(row.nudge_enabled ?? 1) === 1,
      notifyMessages: Number(row.notify_messages ?? 1) === 1,
      notifyEmail: Number(row.notify_email ?? 1) === 1,
      notifyBot: Number(row.notify_bot ?? 1) === 1,
      notifyBriefing: Number(row.notify_briefing ?? 1) === 1,
      quietEnabled: Number(row.quiet_enabled ?? 0) === 1,
      quietStartHour: row.quiet_start_hour ?? 22,
      quietStartMinute: row.quiet_start_minute ?? 0,
      quietEndHour: row.quiet_end_hour ?? 7,
      quietEndMinute: row.quiet_end_minute ?? 0,
      emailDigestEnabled: Number(row.email_digest_enabled ?? 1) === 1,
      gmailSyncLabelsEnabled: Number(row.gmail_sync_labels_enabled ?? 0) === 1,
      chordLabelPushEnabled: Number(row.chord_label_push_enabled ?? 0) === 1,
      emailImagesAuto: Number(row.email_images_auto ?? 1) === 1,
      emailSwipeAction: row.email_swipe_action === 'trash' ? 'trash' : 'archive',
      emailAfterRemove: row.email_after_remove === 'list' ? 'list' : 'next',
      // Never set reads as the Chord default (ADR 0260 addendum); '' is none.
      emailSignature: sharedSignature(row.email_signature) || null,
      emailSignatureHtml: row.email_signature_html ?? null,
      mailboxSignatures: (await mailboxSignatures.get(req.db, req.userId!)) ?? {},
      weatherPlace: row.weather_place ?? null,
      weatherPlaceSource:
        (row.weather_place_source as MeSettings['weatherPlaceSource']) ?? null,
      briefingChannels: await listBriefingChannels(req.db, req.userId!),
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

meRouter.put(API.meListeningMode, requireSession, async (req, res, next) => {
  try {
    const parsed = SetListeningModeRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    await req.db
      .updateTable('users')
      .set({ listening_mode: parsed.data.mode })
      .where('id', '=', req.userId!)
      .execute();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

meRouter.put(API.meName, requireSession, async (req, res, next) => {
  try {
    const parsed = SetMyNameRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    // Empty string clears a field; an omitted field is left untouched.
    const toCol = (v: string | undefined) =>
      v === undefined ? undefined : v.length === 0 ? null : v;
    const patch: Record<string, string | null> = {};
    const first = toCol(parsed.data.firstName);
    const last = toCol(parsed.data.lastName);
    const preferred = toCol(parsed.data.preferredName);
    if (first !== undefined) patch.first_name = first;
    if (last !== undefined) patch.last_name = last;
    if (preferred !== undefined) patch.preferred_name = preferred;

    const row =
      Object.keys(patch).length > 0
        ? await req.db
            .updateTable('users')
            .set(patch)
            .where('id', '=', req.userId!)
            .returningAll()
            .executeTakeFirst()
        : await req.db
            .selectFrom('users')
            .selectAll()
            .where('id', '=', req.userId!)
            .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: 'user missing' });
      return;
    }
    const user: User = {
      id: row.id,
      username: row.username,
      displayName: row.display_name ?? undefined,
      firstName: row.first_name ?? undefined,
      lastName: row.last_name ?? undefined,
      preferredName: row.preferred_name ?? undefined,
      email: row.email ?? undefined,
      createdAt: row.created_at,
    };
    res.json(user);
  } catch (err) {
    next(err);
  }
});

meRouter.put(API.meModelKey, requireSession, async (req, res, next) => {
  try {
    const parsed = SetModelKeyRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    // ADR 0044: the key is validated with one minimal call before it is
    // stored (shared with the OpenRouter connect flow, ADR 0235).
    const saved = await saveModelKey(req.db, req.userId!, parsed.data);
    if (!saved.ok) {
      res.status(400).json({ error: saved.message });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    logger.warn('model key save failed', { err });
    next(err);
  }
});

meRouter.put(API.meNudge, requireSession, async (req, res, next) => {
  try {
    const parsed = SetNudgeRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const patch: { nudge_hour?: number; nudge_minute?: number; nudge_enabled?: number } = {};
    if (parsed.data.hour !== undefined) patch.nudge_hour = parsed.data.hour;
    if (parsed.data.minute !== undefined) patch.nudge_minute = parsed.data.minute;
    if (parsed.data.enabled !== undefined) patch.nudge_enabled = parsed.data.enabled ? 1 : 0;
    await req.db.updateTable('users').set(patch).where('id', '=', req.userId!).execute();
    // Re-queue today's pending scan at the new time (or drop it if turned off).
    await rescheduleDailyScanForUser(req.db, req.userId!);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Report the device's current IANA zone. Called on launch and on every
// foreground, so the briefing follows a traveller even when they never post a
// chat message — which used to be the only way the server learned the zone.
// A changed zone re-times the pending briefing inside `recordUserTimezone`.
meRouter.put(API.meTimezone, requireSession, async (req, res, next) => {
  try {
    const parsed = SetTimezoneRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    // These three touch disjoint columns on the same user row (last_tz vs.
    // weather_place*/weather_ip*) and none reads a value the others write, so
    // they run concurrently rather than as three sequential round trips.
    const [changed] = await Promise.all([
      recordUserTimezone(req.db, req.userId!, parsed.data.tz),
      // ADR 0091 — the client calls this on launch and on every foreground, so
      // it is the natural moment to derive a weather location from the request
      // address. The IP is resolved against a local GeoLite2 file and then
      // dropped; only the city it produced is stored. Best-effort by design.
      seedLocationFromIp(req.db, req.userId!, req.ip),
      // ADR 0148 — also stash the IP-derived city (independent of whether a
      // location is already set) so the daily scan, which has no request IP,
      // can notice a stored location that has gone stale and ask about it.
      stashIpObservation(req.db, req.userId!, req.ip),
    ]);
    res.json({ ok: true, changed });
  } catch (err) {
    next(err);
  }
});

// ADR 0258 — the phone reports where it is, after the user allowed location.
// Becomes the weather location unless they chose one themselves.
meRouter.put(API.meLocation, requireSession, async (req, res, next) => {
  try {
    const parsed = SetDeviceLocationRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const out = await applyDeviceLocation(req.db, req.userId!, parsed.data);
    res.json({ ok: true, applied: out.applied, place: out.location?.place ?? null, source: out.location?.source ?? null });
  } catch (err) {
    next(err);
  }
});

// ...and the user turned it off (or revoked it in the OS).
meRouter.delete(API.meLocation, requireSession, async (req, res, next) => {
  try {
    await clearDeviceLocation(req.db, req.userId!);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ADR 0091 — an explicit weather location for the briefing. The place is
// geocoded here rather than stored raw, so what Settings shows back is what
// the forecast will actually be measured at. An empty string clears the
// override and lets the automatic IP/timezone tiers take over again.
meRouter.put(API.meWeatherLocation, requireSession, async (req, res, next) => {
  try {
    const parsed = SetWeatherLocationRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const place = parsed.data.place.trim();
    if (!place) {
      await clearUserWeatherLocation(req.db, req.userId!);
      res.json({ place: null, source: null });
      return;
    }
    const loc = await setUserWeatherLocation(req.db, req.userId!, place);
    // A place we cannot geocode is a 400, not a silent no-op — otherwise the
    // user sees their typo accepted and the old location quietly retained.
    if (!loc) {
      res.status(400).json({ error: `Couldn't find "${place}".` });
      return;
    }
    res.json({ place: loc.place, source: loc.source });
  } catch (err) {
    next(err);
  }
});

// ADR 0091 — mute/unmute the briefing on one external channel. This is the
// in-app way back from ADR 0089's "Stop these" button, which until now could
// only be undone by re-binding the channel.
meRouter.put(API.meBriefingChannel(':id'), requireSession, async (req, res, next) => {
  try {
    const parsed = SetBriefingChannelRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const outcome = await setBriefingChannelMuted(
      req.db,
      req.userId!,
      req.params.id,
      parsed.data.optedOut,
    );
    if (outcome === 'not_found') {
      res.status(404).json({ error: 'channel not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Register / refresh a device's Expo push token. Upsert keyed on the token so
// the same device re-registering (or moving to a new account) doesn't pile up
// rows; `last_seen_at` refreshes on every call.
meRouter.post(API.mePushToken, requireSession, async (req, res, next) => {
  try {
    const parsed = RegisterPushTokenRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const now = new Date().toISOString();
    await req.db
      .insertInto('push_tokens')
      .values({
        token: parsed.data.token,
        user_id: req.userId!,
        platform: parsed.data.platform ?? null,
        created_at: now,
        last_seen_at: now,
      })
      .onConflict((oc) =>
        oc.column('token').doUpdateSet({
          user_id: req.userId!,
          platform: parsed.data.platform ?? null,
          last_seen_at: now,
        }),
      )
      .execute();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Unregister: token given → drop just that device; omitted → drop all of this
// user's tokens (logout / disable everywhere).
meRouter.delete(API.mePushToken, requireSession, async (req, res, next) => {
  try {
    const parsed = UnregisterPushTokenRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    let query = req.db.deleteFrom('push_tokens').where('user_id', '=', req.userId!);
    if (parsed.data.token) query = query.where('token', '=', parsed.data.token);
    await query.execute();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Push preferences: per-category toggles + quiet-hours window. Partial patch —
// only the provided fields change (mirrors PUT /me/nudge).
meRouter.put(API.meNotificationPrefs, requireSession, async (req, res, next) => {
  try {
    const parsed = SetNotificationPrefsRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const d = parsed.data;
    const patch: {
      notify_messages?: number;
      notify_email?: number;
      notify_bot?: number;
      notify_briefing?: number;
      quiet_enabled?: number;
      quiet_start_hour?: number;
      quiet_start_minute?: number;
      quiet_end_hour?: number;
      quiet_end_minute?: number;
    } = {};
    if (d.notifyMessages !== undefined) patch.notify_messages = d.notifyMessages ? 1 : 0;
    if (d.notifyEmail !== undefined) patch.notify_email = d.notifyEmail ? 1 : 0;
    if (d.notifyBot !== undefined) patch.notify_bot = d.notifyBot ? 1 : 0;
    if (d.notifyBriefing !== undefined) patch.notify_briefing = d.notifyBriefing ? 1 : 0;
    if (d.quietEnabled !== undefined) patch.quiet_enabled = d.quietEnabled ? 1 : 0;
    if (d.quietStartHour !== undefined) patch.quiet_start_hour = d.quietStartHour;
    if (d.quietStartMinute !== undefined) patch.quiet_start_minute = d.quietStartMinute;
    if (d.quietEndHour !== undefined) patch.quiet_end_hour = d.quietEndHour;
    if (d.quietEndMinute !== undefined) patch.quiet_end_minute = d.quietEndMinute;

    await req.db.updateTable('users').set(patch).where('id', '=', req.userId!).execute();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

meRouter.get(API.meCatchupFolders, requireSession, async (req, res, next) => {
  try {
    const folders = (await listFoldersForUser(req.db, req.userId!)) satisfies CatchupFolder[];
    res.json(folders);
  } catch (err) {
    next(err);
  }
});

meRouter.get('/api/v1/me/catchup/folders/:id/contents', requireSession, async (req, res, next) => {
  try {
    const contents = (await listFolderContents(
      req.db,
      req.userId!,
      req.params.id,
    )) satisfies CatchupFolderContents;
    res.json(contents);
  } catch (err) {
    next(err);
  }
});

meRouter.put(
  '/api/v1/me/catchup/assignments/:type/:id',
  requireSession,
  async (req, res, next) => {
    try {
      const parsed = MoveCatchupAssignmentRequest.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.message });
        return;
      }
      const type = req.params.type as CatchupEntityType;
      if (!CATCHUP_ENTITY_TYPES.has(type)) {
        res.status(400).json({ error: 'invalid entity type' });
        return;
      }
      await moveAssignment(req.db, req.userId!, type, req.params.id, parsed.data.folderId);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

meRouter.delete(API.meModelKey, requireSession, async (req, res, next) => {
  try {
    await req.db
      .updateTable('users')
      .set({
        model_provider: null,
        model_name: null,
        model_base_url: null,
        model_key_ciphertext: null,
        model_key_iv: null,
        model_key_tag: null,
        byok_key_issue: null,
        byok_key_issue_at: null,
        byok_key_nudged_at: null,
      })
      .where('id', '=', req.userId!)
      .execute();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Trust list + permission requests ───────────────────────────────

function parseTrustScopes(raw: unknown): TrustScope[] {
  if (!Array.isArray(raw)) return [];
  const out: TrustScope[] = [];
  for (const s of raw) {
    if (s === 'task' || s === 'event') out.push(s);
  }
  return out;
}

meRouter.get(API.meTrust, requireSession, async (req, res, next) => {
  try {
    const grants = await listGrantsByRecipient(req.db, req.userId!);
    res.json({ grants });
  } catch (err) {
    next(err);
  }
});

meRouter.post(API.meTrust, requireSession, async (req, res, next) => {
  try {
    const body = req.body as { senderUserId?: unknown; scopes?: unknown };
    if (typeof body.senderUserId !== 'string') {
      res.status(400).json({ error: 'senderUserId required' });
      return;
    }
    const scopes = parseTrustScopes(body.scopes);
    const grant = await setGrant(req.db, req.userId!, body.senderUserId, scopes);
    res.json({ grant });
  } catch (err) {
    next(err);
  }
});

meRouter.get(API.meTrustCandidates, requireSession, async (req, res, next) => {
  try {
    const candidates = await listTrustCandidates(req.db, req.userId!);
    res.json({ candidates });
  } catch (err) {
    next(err);
  }
});

meRouter.delete(API.meTrustSender(':senderId'), requireSession, async (req, res, next) => {
  try {
    await setGrant(req.db, req.userId!, req.params.senderId, []);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

meRouter.get(API.mePermissionRequests, requireSession, async (req, res, next) => {
  try {
    const incoming = await listIncomingRequests(req.db, req.userId!, 'pending');
    const outgoing = await listOutgoingRequests(req.db, req.userId!);
    res.json({ incoming, outgoing });
  } catch (err) {
    next(err);
  }
});

meRouter.post(
  API.mePermissionRequestRespond(':id'),
  requireSession,
  async (req, res, next) => {
    try {
      const body = req.body as { decision?: unknown };
      if (body.decision !== 'approve' && body.decision !== 'deny') {
        res.status(400).json({ error: 'decision must be approve or deny' });
        return;
      }
      const result = await respondToRequest(req.db, {
        requestId: req.params.id,
        recipientUserId: req.userId!,
        decision: body.decision,
      });
      res.json({ request: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'request not found') {
        res.status(404).json({ error: msg });
        return;
      }
      if (msg === 'not the recipient of this request' || msg === 'request already resolved') {
        res.status(400).json({ error: msg });
        return;
      }
      next(err);
    }
  },
);

