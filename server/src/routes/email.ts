/**
 * In-app Gmail reader routes (ADR 0060/0061/0062). Reads hit the local mirror
 * (fast); sync / thread-body / reply / modify call the Gmail service. All routes
 * require a session; the whole surface 404s when GMAIL_ENABLED is off (the scope
 * is restricted and gated until Google verification — see ADR 0062). Mutating
 * routes translate a dead token into 409 { needsReconnect } like calendar sync.
 */
import { timingSafeEqual } from 'node:crypto';

import { Router } from 'express';

import {
  API,
  CLASSIFIER_TOKEN_HEADER,
  EMAIL_ACTIONS,
  EMAIL_FOLDERS,
  ConnectGmailAccountRequest,
  ConnectImapRequest,
  ConnectOutlookRequest,
  EmailClassificationSnapshot,
  EmailModifyRequest,
  EmailDraftRequest,
  EmailForwardRequest,
  EmailImageSenderRequest,
  EmailBulkModifyRequest,
  EmailSnoozeRequest,
  EmailRouteRequest,
  EmailVacationRequest,
  EmailQueueRequest,
  type EmailQueuedResult,
  EmailReplyRequest,
  EmailComposeNewRequest,
  type EmailComposeNewResult,
  EmailComposeReplyRequest,
  type EmailComposeReplyResult,
  type EmailCategoryOrder,
  EmailCategoryOrderRequest,
  type EmailReplyAsksResult,
  type EmailSummarizeResult,
  FindingsChatRequest,
  type FindingsChatResult,
  EMAIL_DRAFT_KINDS,
  EmailSendRequest,
  type EmailSendResult,
  JunkRescueRequest,
  normalizeMailboxNickname,
  SetEmailAccountPrefsRequest,
  SetEmailPrefsRequest,
  SetMailboxColorRequest,
  SetMailboxSignatureRequest,
  UploadSignatureImageRequest,
  type EmailAction,
  type EmailBulkModifyResult,
  type EmailFolder,
  type EmailMailingList,
  EmailUnsubscribeManyRequest,
  EmailAutoTrashRequest,
  AddEmailFilingRuleRequest,
  type EmailFilingRule,
  type EmailStatus,
  type EmailSyncResult,
} from '@chord/kernel';

import { env } from '../config/env.js';
import { logger } from '../config/logging.js';
import {
  AttachmentRejected,
  loadOutgoingAttachments,
} from '../services/email/outgoing-attachments.js';
import { resolveSendMailbox, type MailboxPreread } from '../services/email/default-mailbox.js';
import { fillPrimaryGmailAddress, primaryGmailAddressFromRow } from '../services/email/primary-gmail-address.js';
import { getGmailApi } from '../services/google/gmail-api.js';
import { mailboxColors, setMailboxColor } from '../services/email/mailbox-colors.service.js';
import { forwardPreview, forwardThread } from '../services/email/forward.service.js';
import { getByokKeyIssue } from '../services/llm/key-health.js';
import { setMailboxSignature, signaturePatch } from '../services/email/signature.js';
import {
  signatureImageBase,
  signatureImageUrl,
  storeSignatureImage,
} from '../services/email/signature-images.js';
import { suggestRecipients } from '../services/email/recipients.service.js';
import { receiptsOverview } from '../services/email/receipts.service.js';
import { threadTrackables } from '../services/email/trackables.js';
import { threadIdForProvenance } from '../services/email/source-thread.js';
import {
  allowImagesFrom,
  autoLoadsImages,
  blockImagesFrom,
  imagesAllowedFor,
  listImageSenders,
} from '../services/email/image-senders.js';
import {
  TRANSPARENT_GIF,
  fetchRemoteImage,
  parseImageUrl,
} from '../services/email/image-proxy.js';
import { readPreloadedImage } from '../services/email/image-preload.js';
import { readImageToken, tryMintImageToken } from '../services/email/image-token.js';
import { fetchInlineImage } from '../services/email/inline-image.js';
import {
  ComposeFailedError,
  ComposeUnavailableError,
  NO_AI_CONSENT,
  NO_AI_CONSENT_MESSAGE,
  composeNew,
  composeReply,
} from '../services/email/compose-reply.service.js';
import { summarizeThread } from '../services/email/thread-summary.service.js';
import { suggestReplyAsks } from '../services/email/reply-asks.service.js';
import { findingsChat } from '../services/email/findings-chat.service.js';
import { getCategoryOrder, setCategoryOrder } from '../services/email/category-order.service.js';
import { cancelQueuedSend, queueSend } from '../services/email/outbox.service.js';
import {
  listSubscriptions,
  resolveThreadUnsubscribe,
  unsubscribeFromSenders,
  unsubscribeThread,
} from '../services/email/unsubscribe.service.js';
import { getVacation, setVacation } from '../services/email/vacation.service.js';
import { setAutoTrash } from '../services/email/auto-trash.service.js';
import { addFilingRule, listFilingRules, removeFilingRules } from '../services/email/filing.service.js';
import { listBrowsableLabels } from '../services/email/labels.js';
import { providerModifyRequested } from '../services/email/chord-labels.js';
import { assertSendAsAllowed, listSendAsAddresses } from '../services/email/send-as.js';
import {
  deleteRoutingRuleById,
  inferRuleKind,
  listRoutingRules,
  setRoutingRule,
} from '../services/email/routing-rules.service.js';
import {
  deleteDraft,
  getDraft,
  getThreadDraft,
  listDrafts,
  saveDraft,
} from '../services/email/drafts.service.js';
import { requireSession } from '../middleware/auth.js';
import { idempotent } from '../middleware/idempotency.js';
import {
  AccountAuthError,
  MailboxWriteUnsupportedError,
  AccountValidationError,
  accountToSummary,
  listAccounts,
} from '../services/email-accounts/account-utils.js';
import {
  applyAccountThreadModify,
  connectGmailAccount,
  connectImapAccount,
  connectOutlookAccount,
  disconnectAccount,
  getAccountThread,
  listAccountSummaries,
  retryAccount,
  setAccountPrefs,
  sendAccountNew,
  sendAccountReply,
  syncAccount,
  syncAllAccounts,
  syncAllUserMail,
  providerFor,
  threadAccountId,
  threadProviderLink,
} from '../services/email-accounts/accounts.service.js';
import { getAccount } from '../services/email-accounts/account-utils.js';
import { isTransientProviderFailure } from '../services/email-accounts/imap-api.js';
import { listJunkMail, rescueJunkMail } from '../services/email-accounts/junk.service.js';
import { fetchEmailAttachmentData } from '../services/email-accounts/attachment-fetch.js';
import {
  categorySubtreeIds,
  getTiles,
  ingestClassification,
} from '../services/email/classification.service.js';
import {
  pendingSuggestionsForThreads,
  listEmailDecisions,
  preprocessReadTimeMagics,
  prefetchReadTimeMagics,
  runReadTimeEmailMagics,
} from '../services/email/magics.service.js';
import { GoogleAuthError } from '../services/google/oauth.service.js';
import {
  applyThreadModify,
  snoozeThread,
  disconnectGmail,
  getThread,
  hasGmailScope,
  listThreads,
  scopesCoverGmail,
  sendNewMessage,
  sendReply,
  syncGmailIncremental,
  emitEmailThreadUpdated,
  withMirrorSyncThenAi,
} from '../services/google/gmail.service.js';
import {
  forgetRemovedFolders,
  isChordProviderLabel,
  mailboxKeyOf,
} from '../services/email/mailbox-folder-memory.js';
import { runInBackground } from '../utils/background.js';
import { mapConcurrent } from '../utils/concurrency.js';
import { safeFileHeaders } from '../utils/content-disposition.js';

export const emailRouter = Router();

const BULK_MODIFY_CONCURRENCY = 4;

// The router is mounted app-wide (no path prefix), so this middleware sees
// every request — scope the feature gate to the email subtree and let all other
// paths fall through untouched.
const EMAIL_PATH_PREFIX = '/api/v1/me/email';

/** Gate the email subtree behind the master flag. */
emailRouter.use((req, res, next) => {
  if (!req.path.startsWith(EMAIL_PATH_PREFIX)) {
    next();
    return;
  }
  if (!env.GMAIL_ENABLED) {
    res.status(404).json({ error: 'gmail reader not enabled' });
    return;
  }
  next();
});

/** Map a dead-token error to 409 { needsReconnect }, else defer. */
function handleGmailError(err: unknown, res: import('express').Response, next: import('express').NextFunction): void {
  if (err instanceof GoogleAuthError && err.needsReconnect) {
    res.status(409).json({ error: 'gmail disconnected — reconnect required', needsReconnect: true });
    return;
  }
  if (err instanceof AccountAuthError && err.needsReconnect) {
    res.status(409).json({ error: 'mailbox disconnected — reconnect required', needsReconnect: true });
    return;
  }
  // ADR 0107 — the provider could not perform this write, so say so rather
  // than returning the success a local-mirror-only write used to imply.
  if (err instanceof MailboxWriteUnsupportedError) {
    res.status(422).json({ error: err.message, unsupported: true });
    return;
  }
  // ADR 0111 — the file was refused BEFORE anything was sent, and its message
  // is written for the sender. Nothing went out, which is the point: a message
  // that leaves without its attachment has quietly failed.
  if (err instanceof AttachmentRejected) {
    res.status(400).json({ error: err.message });
    return;
  }
  // The mailbox provider is momentarily refusing us — Yahoo throttling the
  // login rate is the one seen in prod. Not our fault and not a lost mailbox,
  // so 503 (the ADR 0064 `unavailable` posture) rather than a 500 that reads
  // as a Chord bug and gives the client nothing to retry on.
  if (isTransientProviderFailure(err)) {
    logger.info('mailbox provider temporarily unavailable', {
      err: (err as Error).message,
    });
    res.status(503).json({ error: 'mailbox temporarily unavailable — try again shortly', retryable: true });
    return;
  }
  next(err);
}

/** ADR 0266 — the user's own category order for the AI view. */
emailRouter.get(API.meEmailCategoryOrder, requireSession, async (req, res, next) => {
  try {
    const result: EmailCategoryOrder = { titles: await getCategoryOrder(req.db, req.userId!) };
    res.json(result);
  } catch (err) {
    next(err);
  }
});

emailRouter.put(API.meEmailCategoryOrder, requireSession, async (req, res, next) => {
  const parsed = EmailCategoryOrderRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
    return;
  }
  try {
    const out = await setCategoryOrder(req.db, req.userId!, parsed.data.titles, 'replace');
    if (!out.ok) {
      res.status(400).json({
        error: out.reason === 'too_many' ? 'Too many categories to pin.' : `No category named "${out.name}".`,
      });
      return;
    }
    const result: EmailCategoryOrder = { titles: out.order };
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ADR 0278 — the same writer as the `set_mailbox_color` bot tool.
emailRouter.put(API.meEmailMailboxColor, requireSession, async (req, res, next) => {
  const parsed = SetMailboxColorRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
    return;
  }
  try {
    const out = await setMailboxColor(req.db, req.userId!, { mailbox: parsed.data.mailbox }, parsed.data.color);
    if (!out.ok) {
      res.status(out.reason === 'bad_color' ? 400 : 404).json({ error: out.reason });
      return;
    }
    res.json(await mailboxColors(req.db, req.userId!));
  } catch (err) {
    next(err);
  }
});

// ADR 0260 addendum - one mailbox's own signature (same writer as the bot tool).
emailRouter.put(API.meEmailMailboxSignature, requireSession, async (req, res, next) => {
  const parsed = SetMailboxSignatureRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
    return;
  }
  try {
    const { mailbox, ...input } = parsed.data;
    const out = await setMailboxSignature(req.db, req.userId!, { mailbox }, input);
    if (!out.ok) {
      res.status(404).json({ error: out.reason });
      return;
    }
    res.json({ mailbox: out.mailbox.mailbox, signature: out.signature, own: out.own });
  } catch (err) {
    next(err);
  }
});

// ADR 0326 - a picture from a pasted signature. Answers the public link the
// signature uses; the same picture twice answers the same link.
emailRouter.post(API.meEmailSignatureImages, requireSession, async (req, res, next) => {
  const parsed = UploadSignatureImageRequest.safeParse(req.body);
  if (!parsed.success && typeof req.body?.data === 'string' && req.body.data.length > 1_000_000) {
    res.status(413).json({ error: 'That picture is too large to keep. Use a smaller one.', reason: 'too_large' });
    return;
  }
  if (!parsed.success) {
    res.status(400).json({ error: 'send the picture as base64' });
    return;
  }
  try {
    const raw = parsed.data.data.replace(/^data:[^,]*;base64,/i, '');
    const bytes = Buffer.from(raw, 'base64');
    const out = await storeSignatureImage(req.db, req.userId!, bytes);
    if (!out.ok) {
      const error =
        out.reason === 'too_large'
          ? 'That picture is too large to keep. Use a smaller one.'
          : out.reason === 'too_many'
            ? 'You have kept 100 signature pictures, the most Chord keeps.'
            : 'That is not a PNG, JPEG, GIF or WebP picture.';
      res.status(out.reason === 'too_large' ? 413 : 400).json({ error, reason: out.reason });
      return;
    }
    const origin = `${req.protocol}://${req.get('host')}`;
    res.json({ url: signatureImageUrl(out.id, signatureImageBase(origin)) });
  } catch (err) {
    next(err);
  }
});

emailRouter.get(API.meEmailStatus, requireSession, async (req, res, next) => {
  try {
    // One read of the user row and one of their mailboxes, shared by every
    // part of the answer instead of each helper reading them again.
    const [row, accountRows] = await Promise.all([
      req.db
        .selectFrom('users')
        .select([
          'email',
          'gmail_synced_at',
          'gmail_backfill_done',
          'refresh_token_scopes',
          'chord_label_push_enabled',
          'gmail_nickname',
          'default_send_mailbox',
          'apple_sub',
          'microsoft_sub',
          'defaults',
        ])
        .where('id', '=', req.userId!)
        .executeTakeFirst(),
      listAccounts(req.db, req.userId!),
    ]);
    const pre: MailboxPreread = { user: row, accounts: accountRows };
    const connected = scopesCoverGmail(row?.refresh_token_scopes);
    // A Gmail connected before its address was recorded, on an account made
    // with Microsoft or Apple: ask Gmail once.
    let gmailAddress = connected ? primaryGmailAddressFromRow(row) : null;
    if (connected && !gmailAddress) {
      gmailAddress = await fillPrimaryGmailAddress(req.db, req.userId!, async () =>
        (await getGmailApi(req.db, req.userId!)).getProfile(),
      );
    }
    const [sendFrom, boxColors, aiKeyIssue] = await Promise.all([
      resolveSendMailbox(req.db, req.userId!, pre),
      mailboxColors(req.db, req.userId!, pre),
      getByokKeyIssue(req.db, req.userId!),
    ]);
    const body: EmailStatus = {
      mailboxColors: boxColors.colors,
      mailboxColorsPicked: boxColors.picked,
      ...(sendFrom ? { defaultSendAccountId: sendFrom.accountId } : {}),
      connected,
      backfillDone: (row?.gmail_backfill_done ?? 0) === 1,
      lastSyncedAt: row?.gmail_synced_at ?? null,
      scopes: row?.refresh_token_scopes ?? null,
      accounts: accountRows.map(accountToSummary),
      outlookClientId: env.OUTLOOK_PROVIDER === 'mock' ? 'mock' : env.MS_CLIENT_ID || null,
      outlookCalendar: env.OUTLOOK_CALENDAR_ENABLED && env.OUTLOOK_PROVIDER !== 'mock',
      undoSeconds: env.EMAIL_UNDO_SECONDS,
      gmailProviderMock: env.GMAIL_PROVIDER === 'mock',
      chordLabelPushSupported: connected,
      chordLabelPushEnabled: Number(row?.chord_label_push_enabled ?? 0) === 1,
      gmailNickname: row?.gmail_nickname ?? null,
      gmailAddress,
      aiKeyIssue,
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

emailRouter.post(API.meEmailSync, requireSession, async (req, res, next) => {
  try {
    // ?scope=primary → just the primary Gmail (the Settings per-row chip);
    // default syncs every connected source (Email tab, background refresh).
    const primaryOnly = req.query.scope === 'primary';
    const gmail = await hasGmailScope(req.db, req.userId!);
    const accounts = primaryOnly ? [] : await listAccountSummaries(req.db, req.userId!);
    if (!gmail && accounts.length === 0) {
      res.status(403).json({ error: 'no mailbox connected' });
      return;
    }
    // The mirror is what the request waits for; the AI passes follow and the
    // client is told to refetch when they finish.
    const totals = await withMirrorSyncThenAi(req.db, req.userId!, async () => {
      const t: EmailSyncResult = { inserted: 0, updated: 0, deleted: 0, backfillDone: true };
      // Side by side, and neither stops the other: a Gmail quota error used to
      // leave every attached mailbox unsynced. The first failure is still
      // reported once both have run.
      const outcomes = await Promise.allSettled([
        gmail ? syncGmailIncremental(req.db, req.userId!) : null,
        accounts.length > 0 ? syncAllAccounts(req.db, req.userId!, 'mirror') : null,
      ]);
      for (const o of outcomes) {
        if (o.status === 'rejected') throw o.reason;
      }
      for (const o of outcomes) {
        const r = o.status === 'fulfilled' ? o.value : null;
        if (!r) continue;
        t.inserted += r.inserted;
        t.updated += r.updated;
        t.deleted += r.deleted;
        t.backfillDone = t.backfillDone && r.backfillDone;
      }
      return t;
    });
    res.json(totals);
  } catch (err) {
    handleGmailError(err, res, next);
  }
});

emailRouter.post(API.meEmailDisconnect, requireSession, async (req, res, next) => {
  try {
    await disconnectGmail(req.db, req.userId!);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

emailRouter.get(API.meEmailThreads, requireSession, async (req, res, next) => {
  try {
    const mode = req.query.mode === 'category' ? 'category' : 'traditional';
    const categoryId = typeof req.query.category === 'string' ? req.query.category : undefined;
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    // In category mode, expand to the category's whole subtree so a non-leaf
    // node's list still surfaces threads assigned to its descendants.
    const categoryIds =
      mode === 'category' && categoryId
        ? await categorySubtreeIds(req.db, req.userId!, categoryId)
        : undefined;
    // ?action=to_do,reply_needed — the axis orthogonal to category, so it
    // composes with both modes. Unknown values are dropped rather than 400ing,
    // so a stale client filter degrades to "no filter" instead of an error.
    const actions =
      typeof req.query.action === 'string'
        ? req.query.action
            .split(',')
            .map((s) => s.trim())
            .filter((s): s is EmailAction => EMAIL_ACTIONS.includes(s as EmailAction))
        : undefined;
    const unreadOnly = req.query.unread === '1';
    // ?folder=sent|archive — same posture as ?action above: an unknown
    // value falls back to the inbox rather than 400ing, so a stale client asking
    // for a folder we removed still shows the user their mail.
    const folder = EMAIL_FOLDERS.includes(req.query.folder as EmailFolder)
      ? (req.query.folder as EmailFolder)
      : 'inbox';
    // ?account=<id>|primary (ADR 0119). Unknown values are not rejected: the
    // filter simply matches nothing, which reads as an empty mailbox rather
    // than an error page over a stale client's saved filter.
    const accountId = typeof req.query.account === 'string' ? req.query.account : undefined;
    // ?label=<id> (ADR 0125). Same posture again: an id nothing carries
    // matches nothing, which reads as an empty label rather than an error.
    const labelId = typeof req.query.label === 'string' ? req.query.label : undefined;
    // ADR 0136 — ?ids=a,b,c returns exactly those threads. The coverage
    // footer's counts come from proposals joined back by provenance, so the
    // client cannot derive the set, and neither set is reliably inside the
    // newest page. Ids are the user's own by construction (listThreads is
    // user-scoped), so an id belonging to someone else simply matches nothing.
    const ids =
      typeof req.query.ids === 'string'
        ? req.query.ids.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200)
        : undefined;
    const threads = await listThreads(req.db, req.userId!, {
      mode,
      categoryIds,
      actions,
      unreadOnly,
      folder,
      accountId,
      labelId,
      cursor,
      ids,
    });
    // ADR 0068 — dock pending magic suggestions beside their rows.
    const magics = await pendingSuggestionsForThreads(
      req.db,
      req.userId!,
      threads.map((t) => t.id),
    );
    res.json(threads.map((t) => ({ ...t, magics: magics.get(t.id) ?? [] })));
    // ONE round across every mailbox (ADR 0137): these were two floating
    // promises, so a Gmail-plus-Yahoo user paid two AI pipelines per view
    // and the two could overlap each other. Only for the first page of a
    // view: scrolling, and a lookup of named threads, ask for nothing newer.
    if (!cursor && !ids) runInBackground(syncAllUserMail(req.db, req.userId!).catch(() => {}));
  } catch (err) {
    next(err);
  }
});

/** AI tile level (ADR 0061): children of `?parent=<catId>` (root when absent),
 *  each with subtree-rolled-up counts. `?deep=1` nests the whole subtree into
 *  `children` for the one-rectangle map (ADR 0068). */
emailRouter.get(API.meEmailTiles, requireSession, async (req, res, next) => {
  try {
    const parent = typeof req.query.parent === 'string' ? req.query.parent : null;
    const deep = req.query.deep === '1' || req.query.deep === 'true';
    const level = await getTiles(req.db, req.userId!, parent, { deep });
    res.json(level);
    // ONE round across every mailbox (ADR 0137): these were two floating
    // promises, so a Gmail-plus-Yahoo user paid two AI pipelines per view
    // and the two could overlap each other.
    void syncAllUserMail(req.db, req.userId!).catch(() => {});
  } catch (err) {
    next(err);
  }
});

/** Open email decisions for the AI shell (ADR 0083). */
emailRouter.get(API.meEmailDecisions, requireSession, async (req, res, next) => {
  try {
    res.json(await listEmailDecisions(req.db, req.userId!));
  } catch (err) {
    next(err);
  }
});

/**
 * Classifier ingest (ADR 0061 Mode B / ADR 0066). Session OR service token.
 * Token path: header `x-chord-classifier-token` must match
 * EMAIL_CLASSIFIER_SERVICE_TOKEN; snapshot.userId is the target user.
 */
function classifierTokenOk(header: string | undefined): boolean {
  const expected = env.EMAIL_CLASSIFIER_SERVICE_TOKEN;
  if (!expected || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

emailRouter.post(API.meEmailClassification, async (req, res, next) => {
  try {
    const parsed = EmailClassificationSnapshot.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid snapshot' });
      return;
    }

    const tokenAuth = classifierTokenOk(req.header(CLASSIFIER_TOKEN_HEADER) ?? undefined);
    const userId = req.userId ?? (tokenAuth ? parsed.data.userId : undefined);
    if (!userId) {
      res.status(401).json({ error: 'not signed in' });
      return;
    }

    const result = await ingestClassification(req.db, userId, parsed.data);
    if ('ok' in result) {
      res.status(422).json({ error: result.error });
      return;
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/** Partial patch for digest + sync-tiles-to-labels prefs. */
emailRouter.put(API.meEmailPrefs, requireSession, async (req, res, next) => {
  try {
    const parsed = SetEmailPrefsRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const d = parsed.data;
    const patch: {
      email_digest_enabled?: number;
      gmail_sync_labels_enabled?: number;
      chord_label_push_enabled?: number;
      email_signature?: string | null;
      email_signature_html?: string | null;
      email_images_auto?: number;
      email_swipe_action?: string;
      email_after_remove?: string;
      gmail_nickname?: string | null;
    } = {};
    if (d.emailDigestEnabled !== undefined) patch.email_digest_enabled = d.emailDigestEnabled ? 1 : 0;
    if (d.gmailSyncLabelsEnabled !== undefined) {
      patch.gmail_sync_labels_enabled = d.gmailSyncLabelsEnabled ? 1 : 0;
    }
    if (d.chordLabelPushEnabled !== undefined) {
      patch.chord_label_push_enabled = d.chordLabelPushEnabled ? 1 : 0;
    }
    // ADR 0260 - one rule for what a signature write means, shared with the bot.
    Object.assign(patch, signaturePatch({ text: d.emailSignature, html: d.emailSignatureHtml }));
    if (d.emailImagesAuto !== undefined) patch.email_images_auto = d.emailImagesAuto ? 1 : 0;
    if (d.emailSwipeAction !== undefined) patch.email_swipe_action = d.emailSwipeAction;
    if (d.emailAfterRemove !== undefined) patch.email_after_remove = d.emailAfterRemove;
    if (d.gmailNickname !== undefined) {
      patch.gmail_nickname = normalizeMailboxNickname(d.gmailNickname);
    }
    await req.db.updateTable('users').set(patch).where('id', '=', req.userId!).execute();
    // Switching label push or label sync on is asking for Chord's labels in
    // Gmail again: ones deleted there may be made anew (ADR 0303 addendum).
    if (d.gmailSyncLabelsEnabled === true || d.chordLabelPushEnabled === true) {
      await forgetRemovedFolders(req.db, req.userId!, isChordProviderLabel, mailboxKeyOf(null));
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

emailRouter.get(API.meEmailSendAs, requireSession, async (req, res, next) => {
  try {
    res.json(await listSendAsAddresses(req.db, req.userId!));
  } catch (err) {
    next(err);
  }
});

emailRouter.get(API.meEmailLabels, requireSession, async (req, res, next) => {
  try {
    res.json(await listBrowsableLabels(req.db, req.userId!));
  } catch (err) {
    next(err);
  }
});

emailRouter.get(API.meEmailVacation, requireSession, async (req, res, next) => {
  try {
    res.json(await getVacation(req.db, req.userId!));
  } catch (err) {
    next(err);
  }
});

emailRouter.put(API.meEmailVacation, requireSession, async (req, res, next) => {
  try {
    const parsed = EmailVacationRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid vacation settings', detail: parsed.error.flatten() });
      return;
    }
    // Nothing to say is not a holiday: an empty body would send blank mail.
    if (parsed.data.enabled && !parsed.data.body?.trim()) {
      res.status(400).json({ error: 'a vacation reply needs a message' });
      return;
    }
    res.json(
      await setVacation(req.db, req.userId!, {
        enabled: parsed.data.enabled,
        subject: parsed.data.subject ?? null,
        body: parsed.data.body ?? null,
        startsAt: parsed.data.startsAt ?? null,
        endsAt: parsed.data.endsAt ?? null,
      }),
    );
  } catch (err) {
    next(err);
  }
});

emailRouter.get(API.meEmailRoutes, requireSession, async (req, res, next) => {
  try {
    res.json(await listRoutingRules(req.db, req.userId!));
  } catch (err) {
    next(err);
  }
});

emailRouter.post(API.meEmailRoutes, requireSession, async (req, res, next) => {
  try {
    const parsed = EmailRouteRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid route', detail: parsed.error.flatten() });
      return;
    }
    // ADR 0077 enforces membership at write AND at match; a client-supplied
    // group id is exactly the case the write-side check exists for.
    const member = await req.db
      .selectFrom('group_members')
      .select('user_id')
      .where('group_id', '=', parsed.data.targetGroupId)
      .where('user_id', '=', req.userId!)
      .executeTakeFirst();
    if (!member) {
      res.status(403).json({ error: 'not a member of that group' });
      return;
    }
    await setRoutingRule(req.db, {
      userId: req.userId!,
      kind: inferRuleKind(parsed.data.pattern),
      pattern: parsed.data.pattern,
      targetGroupId: parsed.data.targetGroupId,
    });
    res.json(await listRoutingRules(req.db, req.userId!));
  } catch (err) {
    next(err);
  }
});

emailRouter.delete(API.meEmailRoute(':id'), requireSession, async (req, res, next) => {
  try {
    await deleteRoutingRuleById(req.db, req.userId!, req.params.id);
    // Idempotent: a rule already gone is the state the caller asked for.
    res.json(await listRoutingRules(req.db, req.userId!));
  } catch (err) {
    next(err);
  }
});

emailRouter.get(API.meEmailSourceThread, requireSession, async (req, res, next) => {
  try {
    const raw = typeof req.query.provenance === 'string' ? req.query.provenance : '';
    const threadId = await threadIdForProvenance(req.db, req.userId!, raw);
    if (!threadId) {
      res.status(404).json({ error: 'that email is no longer in your mailbox' });
      return;
    }
    res.json({ threadId });
  } catch (err) {
    next(err);
  }
});

emailRouter.get(API.meEmailThread(':id'), requireSession, async (req, res, next) => {
  // Where an open spends its time, one line per open: the thread read, the
  // wait for the one-time check, and everything after it.
  const started = Date.now();
  const marks: Record<string, number> = {};
  const mark = (name: string) => {
    marks[name] = Date.now() - started;
  };
  try {
    const acctId = await threadAccountId(req.db, req.userId!, req.params.id);
    const detail = acctId
      ? await getAccountThread(req.db, req.userId!, acctId, req.params.id)
      : await getThread(req.db, req.userId!, req.params.id);
    if (!detail) {
      res.status(404).json({ error: 'thread not found' });
      return;
    }
    mark('thread');
    // ADR 0180 — opening a thread runs its own extraction pass, regardless of
    // whether the background sweep's gates would have skipped it. Awaited
    // (same latency shape as the on-demand summarize_email tool) but never
    // fails the thread open — best-effort inside the function itself.
    // Waited for, but only so long. The pass is an LLM call (seconds with a real
    // model) and the first open of every thread pays it; past
    // EMAIL_READ_TIME_WAIT_MS the email is shown and the pass finishes behind
    // it, then the open screen is told to reload (it re-serves the stored
    // advisory and any staged suggestions). The reason to wait at all is the
    // caution banner: on a phishing-shaped message it should be there before
    // the first tap, so the common fast case still has it.
    // ADR 0218 — `?prefetch=1` is the reader warming the NEXT email, which the
    // user has not opened: it skips the read-time pass (ADR 0180 spends that
    // on an email someone is actually reading) and the real open runs it.
    // ADR 0302 - `?prefetch=cache` is the phone filling its two-week store in
    // the background: the same answer, but no early check either, since doing
    // that for every stored email would be a model call per email nobody opened.
    const prefetch = req.query.prefetch === '1' || req.query.prefetch === 'cache';
    const forDeviceStore = req.query.prefetch === 'cache';
    type ReadTime = Awaited<ReturnType<typeof runReadTimeEmailMagics>>;
    const passRun: Promise<ReadTime | null> = prefetch
      ? Promise.resolve(null)
      : runReadTimeEmailMagics(req.db, req.userId!, detail.thread.id);
    // Everything the response needs that does not depend on the check runs
    // DURING the wait, not after it: done one after another they added most
    // of a second to every open on top of the wait itself.
    const lookups = Promise.all([
      // ADR 0107 — managing the mail happens in the provider, so the way there
      // rides on the thread rather than being something the user has to go find.
      threadProviderLink(req.db, req.userId!, req.params.id),
      // ADR 0120 — resolved here rather than by the client, so the decision is
      // the same on every device the reader opens the thread on. ADR 0136 folds
      // the default in here too: one boolean, so the client keeps one rule.
      (async () =>
        (await autoLoadsImages(req.db, req.userId!)) ||
        (await imagesAllowedFor(req.db, req.userId!, detail.thread.fromEmail)))(),
      // ADR 0122 - the kind travels with the thread so the button can say what
      // tapping it will actually do, before it is tapped.
      resolveThreadUnsubscribe(req.db, req.userId!, req.params.id),
      // ADR 0138 / 0135 — the same flight or parcel the tile board shows, for
      // the one thread being read. Resolved here so the URL is rebuilt from the
      // stored identity and the client never holds a template.
      threadTrackables(req.db, req.userId!, detail.thread.id),
    ]);
    // Awaited below; this only stops a failure that lands while the wait is
    // still running from counting as unhandled.
    lookups.catch(() => {});
    let readTimePass: Pick<ReadTime, 'advisory'> = { advisory: null };
    let waited: ReadTime | null | 'timeout';
    let timer: NodeJS.Timeout | undefined;
    try {
      // The limit counts from when the open ARRIVED, not from after the thread
      // was read: the reader waits for the whole request, so a limit started
      // late is a limit plus whatever came before it.
      const remaining = Math.max(0, started + env.EMAIL_READ_TIME_WAIT_MS - Date.now());
      waited = await Promise.race([
        passRun,
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    mark('wait');
    if (waited === 'timeout') {
      const summary = detail.thread;
      const userId = req.userId!;
      void passRun
        .then(() => emitEmailThreadUpdated(userId, summary))
        .catch((err) => logger.warn('read-time pass failed after the open', { userId, err: (err as Error).message }));
    } else if (waited) {
      readTimePass = waited;
    }
    // After the wait: a check that finished in time may have staged cards.
    const magics = await pendingSuggestionsForThreads(req.db, req.userId!, [detail.thread.id]);
    const [providerLink, imagesAllowed, unsub, trackables] = await lookups;
    mark('rest');
    logger.info('email thread opened', {
      userId: req.userId!,
      threadId: detail.thread.id,
      prefetch,
      check: waited === 'timeout' ? 'still running' : waited ? 'done' : 'skipped',
      ms: Date.now() - started,
      ...marks,
    });
    res.json({
      ...detail,
      ...trackables,
      providerLink,
      imagesAllowed,
      // ADR 0136 — minted per open so the capability is short-lived, and only
      // when there is something to render with it.
      imageToken: env.EMAIL_IMAGE_PROXY ? tryMintImageToken(req.userId!) : null,
      unsubscribe: unsub
        ? { kind: unsub.kind, ...(unsub.requestedAt ? { requestedAt: unsub.requestedAt } : {}) }
        : null,
      readAdvisory: readTimePass.advisory,
      thread: { ...detail.thread, magics: magics.get(detail.thread.id) ?? [] },
    });
    // A real open (never a prefetch, which is warming mail nobody has asked
    // for yet) opportunistically tops up the preprocessed window - a no-op
    // query when the front is already warm, or the next batch once the
    // reader has read/scrolled past what sync already warmed.
    // The reader is pre-loading this email ahead of the tap: start its check
    // now, so the real open finds it done (or joins it) instead of waiting.
    if (prefetch && !forDeviceStore) {
      runInBackground(prefetchReadTimeMagics(req.db, req.userId!, detail.thread.id));
    }
    if (!prefetch) {
      void preprocessReadTimeMagics(req.db, req.userId!).catch((err) =>
        logger.warn('read-time preprocess top-up failed', {
          userId: req.userId!,
          err: (err as Error).message,
        }),
      );
    }
  } catch (err) {
    handleGmailError(err, res, next);
  }
});

emailRouter.get(API.meEmailSubscriptions, requireSession, async (req, res, next) => {
  try {
    const lists: EmailMailingList[] = await listSubscriptions(req.db, req.userId!, { sinceDays: 90, limit: 200 });
    res.json(lists);
  } catch (err) {
    next(err);
  }
});

emailRouter.post(API.meEmailSubscriptionsUnsubscribe, requireSession, async (req, res, next) => {
  const parsed = EmailUnsubscribeManyRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
    return;
  }
  try {
    res.json(await unsubscribeFromSenders(req.db, req.userId!, parsed.data.senderEmails));
  } catch (err) {
    next(err);
  }
});

emailRouter.get(API.meEmailFilters, requireSession, async (req, res, next) => {
  try {
    const rules: EmailFilingRule[] = await listFilingRules(req.db, req.userId!);
    res.json(rules);
  } catch (err) {
    next(err);
  }
});

emailRouter.post(API.meEmailFilters, requireSession, async (req, res, next) => {
  const parsed = AddEmailFilingRuleRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
    return;
  }
  try {
    const out = await addFilingRule(req.db, req.userId!, parsed.data);
    if (!out.ok) {
      const message = {
        bad_match: 'Enter an email address or a domain, like school.org.',
        bad_folder: 'That folder name cannot be used.',
        reserved_folder: 'Pick a folder other than Inbox, Trash, Spam, Sent, Drafts or Archive.',
        too_many: 'You have the most filters Chord keeps; remove one first.',
      }[out.reason];
      res.status(400).json({ error: message, reason: out.reason });
      return;
    }
    res.json(out.rules);
  } catch (err) {
    next(err);
  }
});

emailRouter.delete(API.meEmailFilter(':id'), requireSession, async (req, res, next) => {
  try {
    res.json(await removeFilingRules(req.db, req.userId!, [req.params.id]));
  } catch (err) {
    next(err);
  }
});

emailRouter.post(API.meEmailAutoTrash, requireSession, async (req, res, next) => {
  const parsed = EmailAutoTrashRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
    return;
  }
  try {
    const { rules, refused } = await setAutoTrash(req.db, req.userId!, parsed.data.senderEmails, parsed.data.on);
    res.json({ senders: rules.map((r) => r.sender), ...(refused.length ? { refused } : {}) });
  } catch (err) {
    next(err);
  }
});

emailRouter.post(API.meEmailThreadUnsubscribe(':id'), requireSession, async (req, res, next) => {
  try {
    const result = await unsubscribeThread(req.db, req.userId!, req.params.id);
    res.json(result);
  } catch (err) {
    handleGmailError(err, res, next);
  }
});

/**
 * ADR 0197 — write a reply for the user to review. Sends nothing; the reply
 * box's AI block posts here and puts the result in the reply box.
 */
emailRouter.post(API.meEmailThreadCompose(':id'), requireSession, async (req, res, next) => {
  const parsed = EmailComposeReplyRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
    return;
  }
  try {
    const out = await composeReply(req.db, req.userId!, req.params.id, parsed.data);
    if (!out) {
      res.status(404).json({ error: 'thread not found' });
      return;
    }
    const result: EmailComposeReplyResult = out;
    res.json(result);
  } catch (err) {
    if (err instanceof ComposeUnavailableError) {
      if (err.reason === NO_AI_CONSENT) {
        res.status(403).json({ error: NO_AI_CONSENT_MESSAGE });
        return;
      }
      res.status(402).json({ error: 'Writing replies needs an active AI plan (Settings → AI Plan).' });
      return;
    }
    if (err instanceof ComposeFailedError) {
      res.status(502).json({ error: err.message });
      return;
    }
    handleGmailError(err, res, next);
  }
});

/** ADR 0261 — "Summarize" on an open email. Stores and sends nothing. */
emailRouter.post(API.meEmailThreadSummarize(':id'), requireSession, async (req, res, next) => {
  try {
    const out = await summarizeThread(req.db, req.userId!, req.params.id);
    if (!out) {
      res.status(404).json({ error: 'thread not found' });
      return;
    }
    const result: EmailSummarizeResult = out;
    res.json(result);
  } catch (err) {
    if (err instanceof ComposeUnavailableError) {
      if (err.reason === NO_AI_CONSENT) {
        res.status(403).json({ error: NO_AI_CONSENT_MESSAGE });
        return;
      }
      res.status(402).json({ error: 'Summaries need an active AI plan (Settings → AI Plan).' });
      return;
    }
    if (err instanceof ComposeFailedError) {
      res.status(502).json({ error: err.message });
      return;
    }
    handleGmailError(err, res, next);
  }
});

/** ADR 0197 addendum — the reply ask bar's chips for this email. Sends nothing. */
emailRouter.post(API.meEmailThreadReplyAsks(':id'), requireSession, async (req, res, next) => {
  try {
    const out = await suggestReplyAsks(req.db, req.userId!, req.params.id);
    if (!out) {
      res.status(404).json({ error: 'thread not found' });
      return;
    }
    const result: EmailReplyAsksResult = out;
    res.json(result);
  } catch (err) {
    if (err instanceof ComposeUnavailableError) {
      res.status(err.reason === NO_AI_CONSENT ? 403 : 402).json({
        error: err.reason === NO_AI_CONSENT ? NO_AI_CONSENT_MESSAGE : 'Suggestions need an active AI plan.',
      });
      return;
    }
    if (err instanceof ComposeFailedError) {
      res.status(502).json({ error: err.message });
      return;
    }
    handleGmailError(err, res, next);
  }
});

/**
 * The same ask bar on the New message screen, where there is no thread to
 * read. Sends nothing.
 */
emailRouter.post(API.meEmailCompose, requireSession, async (req, res, next) => {
  const parsed = EmailComposeNewRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
    return;
  }
  try {
    const result: EmailComposeNewResult = await composeNew(req.db, req.userId!, parsed.data);
    res.json(result);
  } catch (err) {
    if (err instanceof ComposeUnavailableError) {
      if (err.reason === NO_AI_CONSENT) {
        res.status(403).json({ error: NO_AI_CONSENT_MESSAGE });
        return;
      }
      res.status(402).json({ error: 'Writing messages needs an active AI plan (Settings → AI Plan).' });
      return;
    }
    if (err instanceof ComposeFailedError) {
      res.status(502).json({ error: err.message });
      return;
    }
    next(err);
  }
});

/**
 * The reply or forward draft this thread already has, or null. A composer
 * opened again starts from it instead of from an empty box.
 */
emailRouter.get(API.meEmailThreadDraft(':id'), requireSession, async (req, res, next) => {
  try {
    const kind = EMAIL_DRAFT_KINDS.find((k) => k === req.query.kind);
    if (!kind || kind === 'new') {
      res.status(400).json({ error: 'kind must be reply or forward' });
      return;
    }
    res.json(await getThreadDraft(req.db, req.userId!, kind, req.params.id));
  } catch (err) {
    next(err);
  }
});

emailRouter.post(API.meEmailThreadReply(':id'), requireSession, idempotent, async (req, res, next) => {
  try {
    const acctId = await threadAccountId(req.db, req.userId!, req.params.id);
    if (!acctId && !(await hasGmailScope(req.db, req.userId!))) {
      res.status(403).json({ error: 'gmail scope not granted' });
      return;
    }
    const parsed = EmailReplyRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    const input = {
      threadRowId: req.params.id,
      body: parsed.data.body,
      format: parsed.data.format,
      bodyHtml: parsed.data.bodyHtml,
      to: parsed.data.to,
      cc: parsed.data.cc,
      bcc: parsed.data.bcc,
      messageId: parsed.data.messageId,
      // Resolved against the SENDING mailbox, so a size refusal can name the
      // provider that will actually refuse it (ADR 0111).
      attachments: await loadOutgoingAttachments(
        req.db,
        req.userId!,
        parsed.data.attachmentIds,
        await providerFor(req.db, req.userId!, acctId),
      ),
    };
    const detail = acctId
      ? await sendAccountReply(req.db, req.userId!, acctId, input)
      : await sendReply(req.db, req.userId!, input);
    if (!detail) {
      res.status(404).json({ error: 'thread not found' });
      return;
    }
    // Only once the provider actually took it (ADR 0113).
    if (parsed.data.draftId) await deleteDraft(req.db, req.userId!, parsed.data.draftId);
    res.json({
      ...detail,
      providerLink: await threadProviderLink(req.db, req.userId!, req.params.id),
    });
  } catch (err) {
    logger.warn('email reply failed', { err });
    handleGmailError(err, res, next);
  }
});

/**
 * Compose a new message (ADR 0107). Separate from the reply route because
 * there is no thread to inherit from and the sender picks the mailbox.
 */
emailRouter.post(API.meEmailOutbox, requireSession, async (req, res, next) => {
  try {
    const parsed = EmailQueueRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    const queued = await queueSend(req.db, req.userId!, parsed.data.draftId, {
      includeAttachments: parsed.data.includeAttachments,
    });
    if (!queued) {
      res.status(404).json({ error: 'draft not found' });
      return;
    }
    const result: EmailQueuedResult = { queued: true, ...queued };
    res.json(result);
  } catch (err) {
    next(err);
  }
});

emailRouter.delete(API.meEmailOutboxItem(':id'), requireSession, async (req, res, next) => {
  try {
    // 409, not 404: the message existed and has gone. The client says "already
    // sent" rather than implying the undo worked (ADR 0115).
    const stopped = await cancelQueuedSend(req.db, req.userId!, req.params.id);
    if (!stopped) {
      res.status(409).json({ error: 'already sent' });
      return;
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

emailRouter.get(API.meEmailImageSenders, requireSession, async (req, res, next) => {
  try {
    res.json(await listImageSenders(req.db, req.userId!));
  } catch (err) {
    next(err);
  }
});

emailRouter.post(API.meEmailImageSenders, requireSession, async (req, res, next) => {
  try {
    const parsed = EmailImageSenderRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    // One route both ways: "stop showing these" is the same decision reversed,
    // and a reader who changes their mind should not need a different verb.
    if (parsed.data.allow === false) {
      await blockImagesFrom(req.db, req.userId!, parsed.data.email);
    } else {
      await allowImagesFrom(req.db, req.userId!, parsed.data.email);
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * An inline `cid:` image — a part of the message itself — for the reader's
 * own message. Same token as the remote proxy below, for the same reason (an
 * <img> cannot send the session header); the message row is user-scoped by
 * the id the token unseals, so a token cannot reach anyone else's mail.
 */
emailRouter.get(API.meEmailInlineImage, async (req, res) => {
  const pixel = (): void => {
    res.setHeader('content-type', 'image/gif');
    res.setHeader('cache-control', 'private, max-age=300');
    res.status(200).end(TRANSPARENT_GIF);
  };
  const userId = readImageToken(typeof req.query.k === 'string' ? req.query.k : undefined);
  if (!userId) {
    res.status(403).json({ error: 'invalid image token' });
    return;
  }
  const messageId = typeof req.query.m === 'string' ? req.query.m : '';
  const cid = typeof req.query.c === 'string' ? req.query.c : '';
  if (!messageId || !cid) {
    pixel();
    return;
  }
  try {
    const image = await fetchInlineImage(req.db, userId, messageId, cid);
    if (!image) {
      pixel();
      return;
    }
    res.setHeader('content-type', image.mimeType);
    res.setHeader('cache-control', 'private, max-age=86400');
    res.setHeader('content-security-policy', "default-src 'none'; sandbox");
    res.setHeader('x-content-type-options', 'nosniff');
    res.status(200).end(image.buffer);
  } catch (err) {
    logger.warn('email inline image failed', { err, messageId });
    pixel();
  }
});

/**
 * ADR 0136 — fetch a remote image so the reader's device never does.
 *
 * Deliberately NOT behind `requireSession`: an <img> in a rendered email body
 * cannot send the session header, which is the whole reason the token exists.
 * `?k=` is a sealed, expiring capability that unlocks this route and nothing
 * else — see image-token.ts.
 */
emailRouter.get(API.meEmailImageProxy, async (req, res) => {
  const pixel = (): void => {
    // Every failure looks the same to the reader, and none of them is worth a
    // broken-image glyph in the middle of their mail.
    res.setHeader('content-type', 'image/gif');
    res.setHeader('cache-control', 'private, max-age=300');
    res.status(200).end(TRANSPARENT_GIF);
  };
  if (!env.EMAIL_IMAGE_PROXY) {
    pixel();
    return;
  }
  const userId = readImageToken(typeof req.query.k === 'string' ? req.query.k : undefined);
  if (!userId) {
    res.status(403).json({ error: 'invalid image token' });
    return;
  }
  const url = parseImageUrl(typeof req.query.u === 'string' ? req.query.u : undefined);
  if (!url) {
    pixel();
    return;
  }
  try {
    // ADR 0225 — the copy fetched when the mail arrived, when there is one, so
    // this request sends the sender nothing. Otherwise fetch it now.
    const image = (await readPreloadedImage(req.db, userId, url)) ?? (await fetchRemoteImage(url));
    if (!image) {
      pixel();
      return;
    }
    res.setHeader('content-type', image.contentType);
    // Cached so a second read of the same mail sends the sender nothing. Private
    // because the URL is per-recipient and must not sit in a shared cache.
    res.setHeader('cache-control', 'private, max-age=86400');
    res.setHeader('content-security-policy', "default-src 'none'; sandbox");
    res.setHeader('x-content-type-options', 'nosniff');
    res.status(200).end(image.body);
  } catch (err) {
    logger.warn('email image proxy failed', { err, host: url.hostname });
    pixel();
  }
});

emailRouter.get(API.meEmailRecipients, requireSession, async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    res.json(await suggestRecipients(req.db, req.userId!, q));
  } catch (err) {
    next(err);
  }
});

emailRouter.get(API.meEmailReceipts, requireSession, async (req, res, next) => {
  try {
    res.json(await receiptsOverview(req.db, req.userId!));
  } catch (err) {
    next(err);
  }
});

/** ADR 0277 — the Findings tab's own chat about mail. Stores and posts nothing. */
emailRouter.post(API.meFindingsChat, requireSession, async (req, res, next) => {
  const parsed = FindingsChatRequest.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
    return;
  }
  try {
    const result: FindingsChatResult = await findingsChat(req.db, req.userId!, parsed.data);
    res.json(result);
  } catch (err) {
    if (err instanceof ComposeUnavailableError) {
      if (err.reason === NO_AI_CONSENT) {
        res.status(403).json({ error: NO_AI_CONSENT_MESSAGE });
        return;
      }
      res.status(402).json({ error: 'Answers need an active AI plan (Settings → AI Plan).' });
      return;
    }
    if (err instanceof ComposeFailedError) {
      res.status(502).json({ error: err.message });
      return;
    }
    next(err);
  }
});

emailRouter.get(API.meEmailDrafts, requireSession, async (req, res, next) => {
  try {
    res.json(await listDrafts(req.db, req.userId!));
  } catch (err) {
    next(err);
  }
});

emailRouter.post(API.meEmailDrafts, requireSession, async (req, res, next) => {
  try {
    const parsed = EmailDraftRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    res.json(await saveDraft(req.db, req.userId!, parsed.data));
  } catch (err) {
    next(err);
  }
});

emailRouter.get(API.meEmailDraft(':id'), requireSession, async (req, res, next) => {
  try {
    const draft = await getDraft(req.db, req.userId!, req.params.id);
    if (!draft) {
      res.status(404).json({ error: 'draft not found' });
      return;
    }
    res.json(draft);
  } catch (err) {
    next(err);
  }
});

emailRouter.delete(API.meEmailDraft(':id'), requireSession, async (req, res, next) => {
  try {
    await deleteDraft(req.db, req.userId!, req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/** What a forward of this thread will quote (ADR 0112 addendum). Reads the mirror only. */
emailRouter.get(API.meEmailThreadForwardPreview(':id'), requireSession, async (req, res, next) => {
  try {
    const messageId = typeof req.query.messageId === 'string' ? req.query.messageId : undefined;
    const preview = await forwardPreview(req.db, req.userId!, req.params.id, messageId);
    if (!preview) {
      res.status(404).json({ error: 'thread not found' });
      return;
    }
    res.json(preview);
  } catch (err) {
    next(err);
  }
});

emailRouter.post(API.meEmailThreadForward(':id'), requireSession, idempotent, async (req, res, next) => {
  try {
    const acctId = await threadAccountId(req.db, req.userId!, req.params.id);
    if (!acctId && !(await hasGmailScope(req.db, req.userId!))) {
      res.status(403).json({ error: 'gmail scope not granted' });
      return;
    }
    const parsed = EmailForwardRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    const out = await forwardThread(req.db, req.userId!, req.params.id, parsed.data);
    if (!out) {
      res.status(404).json({ error: 'thread not found' });
      return;
    }
    if (parsed.data.draftId) await deleteDraft(req.db, req.userId!, parsed.data.draftId);
    const result: EmailSendResult = { sent: true, fromEmail: out.fromEmail };
    res.json(result);
  } catch (err) {
    logger.warn('email forward failed', { err });
    handleGmailError(err, res, next);
  }
});

emailRouter.post(API.meEmailSend, requireSession, idempotent, async (req, res, next) => {
  try {
    const parsed = EmailSendRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    const { accountId, attachmentIds, draftId, from, ...message } = parsed.data;
    if (!accountId && !(await hasGmailScope(req.db, req.userId!))) {
      res.status(403).json({ error: 'gmail scope not granted' });
      return;
    }
    // ADR 0130. An alias is only offered on the primary Gmail, and an address
    // we cannot verify is REFUSED rather than quietly replaced with the
    // mailbox's own - sending from the wrong address while reporting success
    // is the failure this whole surface keeps being written against.
    let sendAs: string | null = null;
    if (from) {
      sendAs = accountId ? null : await assertSendAsAllowed(req.db, req.userId!, from);
      if (!sendAs) {
        res.status(400).json({ error: `Your mailbox cannot send as ${from}.` });
        return;
      }
    }
    const withFiles = {
      ...message,
      attachments: await loadOutgoingAttachments(
        req.db,
        req.userId!,
        attachmentIds,
        await providerFor(req.db, req.userId!, accountId ?? null),
      ),
    };
    const out = accountId
      ? await sendAccountNew(req.db, req.userId!, accountId, withFiles)
      : await sendNewMessage(req.db, req.userId!, { ...withFiles, ...(sendAs ? { from: sendAs } : {}) });
    if (draftId) await deleteDraft(req.db, req.userId!, draftId);
    const result: EmailSendResult = { sent: true, fromEmail: out.fromEmail };
    res.json(result);
  } catch (err) {
    logger.warn('email send failed', { err });
    handleGmailError(err, res, next);
  }
});

/**
 * ADR 0128 — triage several threads in one request. Deliberately a loop over
 * the same per-thread path rather than a second write path: each thread is its
 * own provider call (when the patch needs one), and a batch endpoint that
 * pretended otherwise would be lying about what it did. Chord-label-only
 * patches (ADR 0141) stay local UPDATEs; the 100-id cap is request-size
 * sanity for both, not the provider-quota reason from 0128.
 */
emailRouter.post(API.meEmailThreadsModify, requireSession, async (req, res, next) => {
  try {
    const parsed = EmailBulkModifyRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    const { ids, ...patch } = parsed.data;
    const ok = new Set<string>();
    // Still one provider write per thread (ADR 0128), but not one after the
    // other: a 20-thread Trash took 20 round trips in a row. Mailboxes run side
    // by side; within one, a few at a time — except IMAP, where every write is
    // its own login and Yahoo throttles on login rate (ADR 0080).
    const byMailbox = new Map<string, string[]>();
    const owners =
      ids.length === 0
        ? []
        : await req.db
            .selectFrom('email_threads')
            .select(['id', 'account_id'])
            .where('user_id', '=', req.userId!)
            .where('id', 'in', ids)
            .execute();
    const accountOf = new Map(owners.map((r) => [r.id, r.account_id ?? '']));
    for (const id of ids) {
      // Not this user's (or gone): grouped with the primary, as before, where
      // the write finds nothing and reports it failed.
      const acctId = accountOf.get(id) ?? '';
      byMailbox.set(acctId, [...(byMailbox.get(acctId) ?? []), id]);
    }
    await Promise.all(
      [...byMailbox.entries()].map(async ([acctId, group]) => {
        const account = acctId ? await getAccount(req.db, req.userId!, acctId) : undefined;
        const limit = account?.provider === 'imap' ? 1 : BULK_MODIFY_CONCURRENCY;
        await mapConcurrent(group, limit, async (id) => {
          try {
            const summary = acctId
              ? await applyAccountThreadModify(req.db, req.userId!, acctId, id, patch)
              : await applyThreadModify(req.db, req.userId!, id, patch);
            // A null summary is a thread that is not this user's, or is gone.
            if (summary) ok.add(id);
          } catch (err) {
            // One bad thread must not fail the batch, and must not vanish either.
            logger.warn('bulk modify: thread failed', { id, err: (err as Error).message });
          }
        });
      }),
    );
    // Reported in request order, whatever order the writes finished in.
    const result: EmailBulkModifyResult = {
      updated: ids.filter((id) => ok.has(id)),
      failed: ids.filter((id) => !ok.has(id)),
    };
    res.json(result);
  } catch (err) {
    handleGmailError(err, res, next);
  }
});

emailRouter.post(API.meEmailThreadSnooze(':id'), requireSession, async (req, res, next) => {
  try {
    const parsed = EmailSnoozeRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    const summary = await snoozeThread(req.db, req.userId!, req.params.id, parsed.data.until);
    if (!summary) {
      res.status(404).json({ error: 'thread not found' });
      return;
    }
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

emailRouter.post(API.meEmailThreadModify(':id'), requireSession, async (req, res, next) => {
  try {
    const parsed = EmailModifyRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    const acctId = await threadAccountId(req.db, req.userId!, req.params.id);
    // ADR 0141 — Chord labels are local on every mailbox; a chord-only patch
    // does not need the Gmail scope that provider label/archive writes do.
    if (
      !acctId &&
      providerModifyRequested(parsed.data) &&
      !(await hasGmailScope(req.db, req.userId!))
    ) {
      res.status(403).json({ error: 'gmail scope not granted' });
      return;
    }
    const summary = acctId
      ? await applyAccountThreadModify(req.db, req.userId!, acctId, req.params.id, parsed.data)
      : await applyThreadModify(req.db, req.userId!, req.params.id, parsed.data);
    if (!summary) {
      res.status(404).json({ error: 'thread not found' });
      return;
    }
    res.json(summary);
  } catch (err) {
    handleGmailError(err, res, next);
  }
});

// ── Additional mailboxes (ADR 0080) ───────────────────────────────────
emailRouter.get(API.meEmailAccounts, requireSession, async (req, res, next) => {
  try {
    res.json(await listAccountSummaries(req.db, req.userId!));
  } catch (err) {
    next(err);
  }
});

emailRouter.post(API.meEmailAccountsOutlook, requireSession, async (req, res, next) => {
  try {
    if (env.OUTLOOK_PROVIDER !== 'mock' && !env.MS_CLIENT_ID) {
      res.status(503).json({ error: 'outlook not configured' });
      return;
    }
    const parsed = ConnectOutlookRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    res.json(await connectOutlookAccount(req.db, req.userId!, parsed.data));
  } catch (err) {
    handleGmailError(err, res, next);
  }
});

emailRouter.post(API.meEmailAccountsGmail, requireSession, async (req, res, next) => {
  try {
    if (env.GMAIL_PROVIDER !== 'mock' && !env.GOOGLE_CLIENT_ID) {
      res.status(503).json({ error: 'google oauth not configured' });
      return;
    }
    const parsed = ConnectGmailAccountRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    res.json(await connectGmailAccount(req.db, req.userId!, parsed.data));
  } catch (err) {
    if (err instanceof AccountValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    handleGmailError(err, res, next);
  }
});

emailRouter.post(API.meEmailAccountsImap, requireSession, async (req, res, next) => {
  try {
    const parsed = ConnectImapRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    res.json(await connectImapAccount(req.db, req.userId!, parsed.data));
  } catch (err) {
    if (err instanceof AccountAuthError) {
      res.status(401).json({ error: 'mailbox sign-in failed — check the app password' });
      return;
    }
    next(err);
  }
});

emailRouter.delete(API.meEmailAccount(':id'), requireSession, async (req, res, next) => {
  try {
    const ok = await disconnectAccount(req.db, req.userId!, req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'account not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Per-mailbox prefs: ADR 0142 label push, ADR 0145 nickname. */
emailRouter.patch(API.meEmailAccount(':id'), requireSession, async (req, res, next) => {
  try {
    const parsed = SetEmailAccountPrefsRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    const summary = await setAccountPrefs(req.db, req.userId!, req.params.id, parsed.data);
    if (!summary) {
      res.status(404).json({ error: 'account not found' });
      return;
    }
    res.json(summary);
  } catch (err) {
    if (err instanceof AccountValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    next(err);
  }
});

/** Stream one attachment from the owning mailbox's provider (never stored). */
emailRouter.get(
  // Written out, not built with API.meEmailMessageAttachment: that helper
  // encodes the attachment id, which turned this placeholder into the literal
  // `%3AattId`, so the route matched no request and every download got
  // Express's own 404. Express decodes the id in req.params.
  '/api/v1/me/email/messages/:messageId/attachments/:attId',
  requireSession,
  async (req, res, next) => {
    try {
      const data = await fetchEmailAttachmentData(
        req.db,
        req.userId!,
        req.params.messageId,
        req.params.attId,
      );
      if (!data) {
        res.status(404).json({ error: 'attachment not found' });
        return;
      }
      // ADR 0269 — the type is whatever the sender wrote. Only images and PDF
      // open in place; an HTML/SVG attachment downloads as bytes instead of
      // rendering as a page on our origin.
      for (const [k, v] of Object.entries(safeFileHeaders(data.mimeType, data.filename, { inline: true }))) {
        res.setHeader(k, v);
      }
      res.send(data.buffer);
    } catch (err) {
      handleGmailError(err, res, next);
    }
  },
);

// ── Junk peek (never mirrored) — codes/password-resets stay reachable ──
emailRouter.get(API.meEmailJunk, requireSession, async (req, res, next) => {
  try {
    res.json(await listJunkMail(req.db, req.userId!));
  } catch (err) {
    handleGmailError(err, res, next);
  }
});

emailRouter.post(API.meEmailJunkRescue, requireSession, async (req, res, next) => {
  try {
    const parsed = JunkRescueRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid request' });
      return;
    }
    const ok = await rescueJunkMail(req.db, req.userId!, parsed.data.key);
    if (!ok) {
      res.status(404).json({ error: 'junk message not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    handleGmailError(err, res, next);
  }
});

emailRouter.post(API.meEmailAccountSync(':id'), requireSession, async (req, res, next) => {
  try {
    const account = await getAccount(req.db, req.userId!, req.params.id);
    if (!account) {
      res.status(404).json({ error: 'account not found' });
      return;
    }
    res.json(await withMirrorSyncThenAi(req.db, req.userId!, () => syncAccount(req.db, account)));
  } catch (err) {
    handleGmailError(err, res, next);
  }
});

emailRouter.post(API.meEmailAccountReconnect(':id'), requireSession, async (req, res, next) => {
  try {
    const account = await getAccount(req.db, req.userId!, req.params.id);
    if (!account) {
      res.status(404).json({ error: 'account not found' });
      return;
    }
    // 200 either way: "your stored password is genuinely dead" is a result the
    // client acts on, not a transport error.
    res.json(await retryAccount(req.db, account));
  } catch (err) {
    handleGmailError(err, res, next);
  }
});
