import { z } from 'zod';

import type { UnsubscribeKind } from '../email-unsubscribe';
import type { SenderCheck } from '../sender-check';
import type { IsoDateTime, UserId } from './ids';

/**
 * In-app Gmail reader (ADR 0060). Read-side DTOs the Email tab renders.
 * These are DERIVED from the server's local `email_threads` / `email_messages`
 * mirror of Gmail; the tile shapes are derived from the classifier's landing
 * tables (ADR 0061) but stay decoupled from the raw classifier contract
 * (`email-classification.ts`).
 */

import type { EmailAccountSummary } from './email-accounts';
import type { ByokKeyIssue } from './billing';
import type { EmailAction } from './email-classification';
import type { ProviderLink } from '../email-provider-link';
import type { ProposalCalendarFit, ProposalReplaceOffer } from './proposal';

/** Whether the Gmail source is connected + how far the initial import got.
 *  ADR 0080 — also carries the user's additional mailboxes. */
export interface EmailStatus {
  connected: boolean;
  /** The primary Gmail's own address, when it is known. Not the sign-in
   *  email: a Microsoft or Apple account signs in with another address. */
  gmailAddress?: string | null;
  /** False while the first paged backfill is still running (spans ticks). */
  backfillDone: boolean;
  lastSyncedAt: IsoDateTime | null;
  scopes: string | null;
  /** Additional attached mailboxes (Outlook / IMAP), ADR 0080. */
  accounts?: EmailAccountSummary[];
  /** Microsoft OAuth client id for the client-side connect flow; null when
   *  Outlook is not configured server-side. */
  outlookClientId?: string | null;
  /** ADR 0228 — the Outlook connect should also ask for calendar access. */
  outlookCalendar?: boolean;
  /** True when GMAIL_PROVIDER=mock — the Add-another-Gmail flow skips OAuth. */
  gmailProviderMock?: boolean;
  /** ADR 0115 — seconds a sent message is held. 0 means send immediately,
   *  and the client offers no undo rather than a button that does nothing. */
  undoSeconds?: number;
  /**
   * ADR 0142 — primary Gmail can receive Chord label push (true when Gmail
   * modify scope is held). Attached mailboxes carry the same fields on each
   * `accounts[]` row.
   */
  chordLabelPushSupported?: boolean;
  chordLabelPushEnabled?: boolean;
  /** ADR 0145 — nickname for the primary Gmail; null renders as "Gmail". */
  gmailNickname?: string | null;
  /** ADR 0278 — each mailbox's color, keyed 'primary' or by account id. */
  mailboxColors?: Record<string, string>;
  /** ADR 0278 — only the colors the user picked, same keys. */
  mailboxColorsPicked?: Record<string, string>;
  /** ADR 0252 — the user's own AI key is failing, so the AI passes over this
   *  mailbox are paused. Null/absent when it works or they have no key. */
  aiKeyIssue?: ByokKeyIssue | null;
  /** ADR 0255 — the account new mail leaves from by default (null = the
   *  primary Gmail); absent when nothing can send. Set in chat only. */
  defaultSendAccountId?: string | null;
}

/**
 * One preview line on a tile (ADR 0068 addendum): a pending magic suggestion's
 * title, a newest-unread subject as filler, or — once both are exhausted — the
 * newest thread in the category whatever its state. Tapping deep-links to the
 * thread.
 *
 * ADR 0110 added `recent` because a tile built only from open work goes BLANK
 * the moment you act on it: confirming resolves the proposal and marks the
 * thread read, so it leaves both other sources at once.
 */
export interface EmailTilePreview {
  kind: 'magic' | 'unread' | 'recent';
  /** Magic title, or the thread's subject. */
  text: string;
  /** Local thread row id — deep-link target (`/email/<id>`). */
  threadId: string;
  /** The email's opening lines (its provider preview), for a sentence or two
   *  under the subject. Absent when the provider gave none. */
  snippet?: string;
}

/** Stage 2 render shape for a converted tile (ADR 0087). Null/omitted = snippets. */
export type EmailTileArchetype = 'timeline' | 'state_board' | 'ledger';

export interface EmailTimelineFact {
  title: string;
  /** ISO start; omitted from the payload once past. */
  at: string;
  threadId: string;
  proposalId?: string | null;
}

/** Live (not-yet-landed) shipping / travel status. */
export type EmailStateStatus =
  | 'shipped'
  | 'out_for_delivery'
  | 'in_transit'
  | 'delayed'
  | 'boarding'
  | 'check_in'
  /** ADR 0138 — a flight that is booked and behaving. Distinct from
   *  `in_transit`, which says something is already moving. */
  | 'scheduled'
  | 'cancelled';

export interface EmailStateFact {
  title: string;
  status: EmailStateStatus;
  threadId: string;
  /**
   * ADR 0135 — when it arrives, when the mail said so. Roughly half of
   * delivery mail states this outright, and rendering "shipped" instead was
   * throwing away the only part anyone wanted.
   *
   * A row whose ETA has passed drops off the board, the same rule
   * `dropPastTimeline` applies to dated items: a delivery is interesting
   * until it lands, and Chord is never told that it did.
   */
  etaAt?: string | null;
  /** The carrier's own tracking page. Rendered as a link the user taps —
   *  Chord never fetches it (ADR 0135). */
  tracking?: EmailTrackingRef | null;
  /** ADR 0138 — the flight this row is about, when the mail named one. */
  flight?: EmailFlightRef | null;
}

/** A parcel and the carrier page that knows where it is (ADR 0135). */
export interface EmailTrackingRef {
  carrier: string;
  number: string;
  url: string;
}

/**
 * A flight and, when we can name its airline, where to watch it (ADR 0138).
 *
 * `url` is null whenever `ident` is: FlightAware addresses a flight by ICAO
 * ident, so an airline we cannot resolve has no correct URL — and a wrong one
 * looks like an answer. The number still renders, as text.
 */
export interface EmailFlightRef {
  iata: string;
  number: string;
  airline: string | null;
  ident: string | null;
  url: string | null;
}

export interface EmailLedgerFact {
  merchant: string;
  /** Major-currency units already parsed; never guessed. Always the MAGNITUDE —
   *  `direction` carries the sign, so ranking by size stays a plain compare. */
  amount: number;
  /**
   * Which way the money went. `credit` is a refund or statement credit — money
   * coming back — and must never be rendered like something owed: a `-$119.90`
   * merchant credit was showing in the Finance tile as `American Express
   * $119.90`, indistinguishable from a bill.
   *
   * `paid` (ADR 0160) is a receipt: a purchase already settled in full, no
   * balance either way — distinct from `debit` (still owed) and `credit`
   * (coming back), since a receipt is neither.
   *
   * Optional so a stored fact from before this existed still parses; absent
   * reads as `debit`, which is what those older facts were.
   */
  direction?: 'debit' | 'credit' | 'paid';
  dueAt?: string | null;
  threadId: string;
}

export type EmailTileFacts =
  | { kind: 'timeline'; items: EmailTimelineFact[] }
  | { kind: 'state_board'; items: EmailStateFact[] }
  | { kind: 'ledger'; items: EmailLedgerFact[] };

/** One category node in the AI tile view, with its rolled-up thread count. */
export interface EmailTile {
  id: string;
  title: string;
  /** Thread count for this node's whole subtree (own + descendants). */
  count: number;
  /**
   * Threads in the subtree needing attention: unread, or carrying a pending
   * email-magic suggestion (ADR 0068). Drives tile AREA in the nested map.
   */
  attention: number;
  /** Pending email-magic suggestions (ADR 0063 proposals) in the subtree. */
  magicCount: number;
  /** Unread threads in the subtree. Unlike `attention`, read mail with a
   *  pending suggestion is not counted. */
  unread?: number;
  /** When the newest thread in the subtree arrived; null when it holds none. */
  lastMessageAt?: string | null;
  /** True when this node has child categories to drill into. */
  hasChildren: boolean;
  depth: number;
  /** Optional tile tint the classifier assigned (hex). */
  color?: string | null;
  /** Optional icon name/emoji the classifier assigned. */
  icon?: string | null;
  /**
   * Up to 3 subtree preview lines: pending magics first (newest first), then
   * newest-unread subjects. Present only when the subtree has any.
   */
  preview?: EmailTilePreview[];
  /**
   * ADR 0087 — converted tiles carry a typed current-answer payload. Omitted
   * when the path is unconverted or extract produced nothing (fail closed).
   */
  archetype?: EmailTileArchetype | null;
  facts?: EmailTileFacts;
  /** Child tiles, populated when the level is requested with `deep=1`. */
  children?: EmailTile[];
}

/**
 * An email-magic suggestion (ADR 0063 proposal) surfaced beside its source
 * thread (ADR 0068). Confirm/reject via the standard proposal routes.
 *
 * Usually pending, but ADR 0187 also surfaces an already-`confirmed` one when
 * docked on its own thread (not on the digest/briefing surfaces, which stay
 * pending-only by construction) — the card then renders "already added"
 * instead of Confirm/Dismiss, so re-opening an email you've already acted on
 * doesn't invite a duplicate.
 */
export interface EmailMagicSuggestion {
  proposalId: string;
  /** `change` (ADR 0248): the email changes something the user already has
   *  (removes or moves an event, marks a to-do done). `title` is the whole
   *  label ("Move: Squash Singles 3"), `detail` the time it is about, if any.
   *  Shown beside that email only. */
  kind: 'event' | 'list' | 'task' | 'change';
  /** ADR 0248 — for a `change`: a few words from the email saying why. */
  changeNote?: string;
  /** Event title, the list item text, or the task title. */
  title: string;
  /** ISO start instant for events; list name for list items; ISO due
   *  date for a task, or null when it has no deadline. */
  detail: string | null;
  /** Group the confirm executes in (ADR 0063 routing), null = personal. */
  targetGroupId: string | null;
  /** ADR 0077 — that group's name, so the card can show "→ Doe Family"
   *  before the user taps confirm. Null when the suggestion is personal. */
  targetGroupName?: string | null;
  /** ADR 0187 — 'confirmed' when the user already acted on this suggestion.
   *  Absent/'pending' everywhere else (digest, decisions queue), which are
   *  pending-only by construction. */
  status?: 'pending' | 'confirmed';
  /** ADR 0104 — this event is someone else's invitation: the card asks
   *  Yes / Maybe / No and the organizer hears the answer. */
  isInvite?: boolean;
  /** ADR 0315 addendum — who confirming this event will send a calendar
   *  invitation to, taken from the email's From / To / Cc. Shown on the card
   *  so the user sees it before tapping. */
  invitees?: string[];
  /** ADR 0343 — the event this one may replace; the card asks Move it / Add as new. */
  replaces?: ProposalReplaceOffer;
  /** ADR 0346 - how it sits on the calendar (conflict, already there, a question). */
  fit?: ProposalCalendarFit;
  /** ADR 0346 phase 5 - nobody said who sends the invite: the card asks
   *  "Send an invite, or wait for theirs?". */
  whoSends?: 'ask';
  /** A line for the card ("Rob's invite never came"). */
  note?: string;
}

/**
 * ADR 0180 — a caution the read-time pass found worth telling the reader,
 * when nothing about the message was actionable but the message ITSELF is
 * the concern (a phishing/spoofing/scam tell). Never a proposal — there is
 * nothing to confirm about a warning.
 */
export interface EmailReadAdvisory {
  note: string;
  severity: 'info' | 'caution';
}

/**
 * One open email decision for the AI shell (ADR 0083). Extends the docked
 * magic card with category join fields so the map, urgent strip, and Unsorted
 * row share one payload. `categoryId: null` = unsorted (unclassified or
 * archived source) — never silently drop a pending proposal from Email.
 */
export interface EmailDecision extends EmailMagicSuggestion {
  /** Leaf category id; null when the source thread is unclassified/missing. */
  categoryId: string | null;
  categoryTitle: string | null;
  /** Local `email_threads.id`; null if the source thread is not mirrored. */
  threadRowId: string | null;
  /** Parsed `create_event` startsAt; null for list items. */
  dueAt: string | null;
  /** True when the source thread is archived (proposal kept per ADR 0073). */
  archivedSource: boolean;
}

/** AI shell decision queue + honesty coverage (ADR 0083). */
export interface EmailDecisionsResponse {
  decisions: EmailDecision[];
  coverage: {
    /** Proposals this user confirmed today, in their own zone (`last_tz`). */
    handledToday: number;
    /** Live (non-archived) threads with no category assignment. */
    unreadable: number;
    /**
     * Threads whose suggestion timed out (ADR 0009's 72h TTL) with nobody
     * deciding, and which are still unread — "expired, still owed" (bug 9,
     * owner decision 2026-08-24). The badge legitimately drops when a
     * proposal expires; letting the thread go silent WITH it is the failure
     * decision counts replaced unread to prevent, so the obligation is
     * reported here instead of vanishing.
     */
    stillOwed: number;
    /**
     * ADR 0136 — the threads BEHIND `handledToday` and `stillOwed`, so each
     * count is somewhere you can go rather than a number you can only read.
     *
     * Ids, not summaries: the client already has a thread list that knows how
     * to render a row. Both sets come from proposals joined back by
     * `gmail:<id>` provenance, which the client cannot compute — and neither
     * set is reliably inside the newest page of threads, which is why filtering
     * what is already loaded (how `unreadable` does it) does not work here.
     *
     * Capped: the counts above stay true even when these lists are clipped.
     */
    handledThreadIds: string[];
    owedThreadIds: string[];
  };
}

/**
 * A level of the tile tree: the tiles at `parent` (root when null) plus the
 * count of threads assigned directly to `parent` itself (so the UI can decide
 * tile-vs-list at the leaf threshold).
 */
export interface EmailTileLevel {
  parent: EmailTile | null;
  tiles: EmailTile[];
  /** Threads assigned to `parent` directly (not to a child). */
  directThreadCount: number;
}

/** Mailbox folders Chord can browse (ADR 0108). Each is a PREDICATE over the
 *  label set the mirror already holds — not a column, and not a second
 *  sync. Drafts and Trash are deliberately absent; see the ADR. */
export const EMAIL_FOLDERS = ['inbox', 'sent', 'archive', 'snoozed'] as const;
export type EmailFolder = (typeof EMAIL_FOLDERS)[number];

/** A thread row in the Traditional list / a category's flipped email list. */
export interface EmailThreadSummary {
  id: string;
  subject: string;
  snippet: string;
  fromName: string | null;
  fromEmail: string | null;
  lastMessageAt: IsoDateTime;
  messageCount: number;
  isUnread: boolean;
  isArchived: boolean;
  /** Gmail label ids currently on the thread (raw). */
  labelIds: string[];
  /**
   * ADR 0141 — Chord-owned labels (display names). Distinct from `labelIds`
   * because `recomputeThread` owns the provider column.
   */
  chordLabelIds?: string[];
  /** Leaf category id the thread is assigned to, if classified. */
  categoryId: string | null;
  /** What the thread wants from you - the axis orthogonal to `categoryId`.
   *  Null until the thread has been classified. */
  action: EmailAction | null;
  /** Pending magic suggestions for this thread (list + detail reads only). */
  magics?: EmailMagicSuggestion[];
  /** Which mailbox this arrived at (ADR 0119). Null = the primary Gmail.
   *  Only meaningful to a client that has more than one attached. */
  accountId?: string | null;
  /** That mailbox's address, so a row can be labelled without the client
   *  holding a second lookup table. */
  accountEmail?: string | null;
  /** A message in the thread carries a downloadable file (not an inline image). */
  hasAttachments?: boolean;
  /** The thread's files, newest email first, for the list row to show and
   *  open (list reads only; inline images left out; at most 20). */
  files?: EmailThreadFile[];
  /** ADR 0338 - an unsent reply or forward is waiting in this thread (list
   *  reads only). */
  hasDraft?: boolean;
}

/** One downloadable file of a thread, with the message it came on. */
export interface EmailThreadFile {
  messageId: string;
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** One downloadable attachment on a message (receipts, statements, …).
 *  `id` is provider-shaped and only meaningful to the download route. */
export interface EmailAttachmentRef {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Normalized Content-ID (`normalizeContentId`) when the part has one — how
   *  a body's `<img src="cid:…">` finds it. */
  contentId?: string;
}

/** A single message inside an opened thread (bodies lazy-fetched). */
export interface EmailMessage {
  id: string;
  gmailMessageId: string;
  fromName: string | null;
  fromEmail: string | null;
  toEmails: string[];
  ccEmails: string[];
  subject: string;
  snippet: string;
  /** Plain-text body; may be null until the thread is opened. */
  bodyText: string | null;
  /** Sanitized-on-client HTML body; may be null. */
  bodyHtml: string | null;
  internalDate: IsoDateTime;
  isUnread: boolean;
  /** The mailbox's own message (the provider's SENT label), so a reply is
   *  never addressed back to the person writing it. */
  sent?: boolean;
  /** Populated on thread open (may lag the first render by one fetch). */
  attachments?: EmailAttachmentRef[];
  /** Where a reply would go, when it is not the sender (ADR 0294). */
  replyTo?: string | null;
  /** Is the sender who they say they are (ADR 0294). Set on thread open. */
  senderCheck?: SenderCheck;
}

/** Allow this sender's remote images from now on (ADR 0120). */
export const EmailImageSenderRequest = z.object({
  email: z.string().trim().email().max(320),
  /** False removes the permission again. */
  allow: z.boolean().optional(),
});
export type EmailImageSenderRequest = z.infer<typeof EmailImageSenderRequest>;

/**
 * A user-declared routing rule (ADR 0077), as Settings shows it (ADR 0123).
 * `kind` is inferred from the pattern rather than chosen, so the editor
 * displays it instead of asking.
 */
export interface EmailRoutingRuleDto {
  id: string;
  kind: 'sender_domain' | 'category';
  pattern: string;
  targetGroupId: string;
  targetGroupName: string;
}

export const EmailRouteRequest = z.object({
  /** A domain ("lcps.org") or a keyword matched against the category title. */
  pattern: z.string().trim().min(2).max(200),
  targetGroupId: z.string().min(1),
});
export type EmailRouteRequest = z.infer<typeof EmailRouteRequest>;

/**
 * The vacation responder (ADR 0124). Chord's own, not the provider's, so it
 * reads the same on a Gmail, an Outlook and an IMAP mailbox.
 */
export interface EmailVacationSettings {
  enabled: boolean;
  /** Null uses "Re: <their subject>", which is what a reply normally says. */
  subject: string | null;
  body: string | null;
  /** ISO. Null on either side means "from now" / "until I turn it off". */
  startsAt: string | null;
  endsAt: string | null;
}

export const EmailVacationRequest = z.object({
  enabled: z.boolean(),
  subject: z.string().trim().max(200).nullable().optional(),
  body: z.string().trim().max(4000).nullable().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
});
export type EmailVacationRequest = z.infer<typeof EmailVacationRequest>;

/**
 * A label you can browse (ADR 0125). Derived from the mirror, so a provider
 * that gives us no user labels honestly reports none rather than erroring.
 */
/**
 * An address the user may send from (ADR 0130). Only verified ones appear:
 * Gmail rewrites an unverified From and reports success, so offering one would
 * promise something that does not happen.
 */
export interface EmailSendAsAddress {
  email: string;
  displayName?: string;
  isPrimary: boolean;
}

export interface EmailLabelSummary {
  /** Opaque for provider labels (Gmail id); for Chord labels, the display name. */
  id: string;
  name: string;
  threads: number;
  /** ADR 0141 — where the label lives. */
  scope: 'provider' | 'chord';
}

export interface EmailThreadDetail {
  thread: EmailThreadSummary;
  messages: EmailMessage[];
  /** The address of the mailbox this thread lives in - the attached account's,
   *  else the login's. "My address" for reply recipients is this one. */
  mailboxEmail?: string | null;
  /** Where to open this thread in the provider (ADR 0107). Null when we
   *  cannot name a destination - the client then shows no button. */
  providerLink?: ProviderLink | null;
  /** ADR 0120 — true when the reader has already agreed to load this
   *  sender's remote images. Absent/false means the body renders with them
   *  blocked and the banner offers to show them.
   *
   *  ADR 0136 — also true when the reader loads images by default, which is
   *  the default. One field rather than two so the client keeps one rule. */
  imagesAllowed?: boolean;
  /** ADR 0136 — short-lived capability for the image proxy, minted per thread
   *  open. Absent when the route is disabled deployment-wide, in which case
   *  the reader falls back to ADR 0120's blocking. */
  imageToken?: string | null;
  /**
   * ADR 0138 / 0135 — the flight or parcel this thread is about, when the
   * magics pass found one. Resolved server-side so the URL is rebuilt from the
   * stored identity rather than the client holding a template that can rot.
   */
  flight?: EmailFlightRef | null;
  tracking?: EmailTrackingRef | null;
  /** ADR 0122 — what this sender's List-Unsubscribe headers allow, if
   *  anything. `kind` decides what the reader is promised: only `one_click`
   *  can end with "Unsubscribed". */
  unsubscribe?: {
    kind: UnsubscribeKind;
    /** ISO time this user last asked this sender to stop. */
    requestedAt?: string;
  } | null;
  /** ADR 0180 — set by the interactive read-time pass, when opening this
   *  thread found something worth a caution rather than an action. Null when
   *  there is nothing to say (the ordinary case) or the pass hasn't run yet. */
  readAdvisory?: EmailReadAdvisory | null;
  /** The mailbox was too slow to hand over every message in time; some are
   *  shown without their text and `email.thread.updated` follows when they
   *  arrive. A copy like this is not kept on the device. */
  bodiesPending?: boolean;
}

/** One purchase whose receipt arrived by email (ADR 0160/0246). */
export interface EmailReceipt {
  /** The email it came from, or null once that email was deleted (ADR 0249). */
  threadId: string | null;
  merchant: string;
  amount: number;
  /** ISO 4217, or "unspecified" when the email named none. */
  currency: string;
  /** When it was bought if the email said, else when the email arrived. */
  at: string;
  orderNumber: string | null;
  /** ADR 0249 — "Visa ••1234", "PayPal"; never a full card number. */
  paymentMethod: string | null;
  /** The mailbox it arrived in (an address). */
  mailbox: string | null;
}

export interface EmailSpendingMonth {
  /** `YYYY-MM` in the user's timezone. */
  month: string;
  currency: string;
  total: number;
  count: number;
}

export interface EmailRecurringCharge {
  merchant: string;
  currency: string;
  amount: number;
  cadence: 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  charges: number;
  lastAt: string;
  /** Last charge plus one period: a guess from the pattern, not a bill. */
  nextExpectedAt: string;
  threadId: string | null;
}

/**
 * The Finance tab's data. Partial by construction: only purchases whose
 * receipt came by email and that Chord has read, so no caller may present a
 * total here as what the user spent.
 */
export interface EmailReceiptsOverview {
  receipts: EmailReceipt[];
  months: EmailSpendingMonth[];
  recurring: EmailRecurringCharge[];
  /** Older receipts were left out of the totals. */
  truncated: boolean;
}

export interface EmailUnsubscribeResult {
  kind: UnsubscribeKind;
  /** True ONLY for a completed RFC 8058 one-click. */
  unsubscribed: boolean;
  /** True when a request went out that we cannot confirm was honoured. */
  requested?: boolean;
  /** For `link`: the page the reader has to finish themselves. */
  url?: string;
  /** Already phrased for the reader, and never claims more than happened. */
  message: string;
}

/** Leave several mailing lists at once, named by sender address. */
export const EmailUnsubscribeManyRequest = z.object({
  senderEmails: z.array(z.string().trim().min(3).max(320)).min(1).max(50),
});
export type EmailUnsubscribeManyRequest = z.infer<typeof EmailUnsubscribeManyRequest>;

/** One line per list: each one unsubscribes its own way, so each says what really happened. */
export interface EmailUnsubscribeManyResult {
  results: Array<
    EmailUnsubscribeResult & {
      senderEmail: string;
      senderName: string | null;
      /** Set when nothing was attempted: not a list any more, or already asked. */
      skipped?: 'not_a_list' | 'already_requested';
      /** Chord could not leave this list for the user: they finish on the
       *  sender's page (`url`, when there is one) or send its future mail to
       *  Trash (`autoTrash`). */
      needsYou?: boolean;
      /** Its future mail already goes to Trash. */
      autoTrash?: boolean;
    }
  >;
}

/** ADR 0309 — a filing rule: mail from a sender or a domain goes into a folder on the mailbox. */
export interface EmailFilingRule {
  id: string;
  kind: 'sender' | 'domain';
  value: string;
  folder: string;
  /** ISO time from which mail is filed; the epoch means existing mail too. */
  since: string;
}

export const AddEmailFilingRuleRequest = z.object({
  /** An email address or a domain. */
  from: z.string().trim().min(3).max(320),
  folder: z.string().trim().min(1).max(100),
  alsoExisting: z.boolean().optional(),
});
export type AddEmailFilingRuleRequest = z.infer<typeof AddEmailFilingRuleRequest>;

/** Send a sender's future mail to Trash, or stop (POST). */
export const EmailAutoTrashRequest = z.object({
  senderEmails: z.array(z.string().trim().min(3).max(320)).min(1).max(50),
  on: z.boolean(),
});
export type EmailAutoTrashRequest = z.infer<typeof EmailAutoTrashRequest>;

/** One mailing list the user is on: a sender whose mail says how to leave it. */
export interface EmailMailingList {
  senderEmail: string;
  senderName: string | null;
  /** Emails from it in the window (90 days). */
  messages: number;
  /** How many of those the user opened. */
  opened: number;
  lastReceivedAt: string;
  /** What Unsubscribe can do for it; null = its header is unusable. */
  kind: UnsubscribeKind | null;
  /** When the user already asked it to stop. */
  requestedAt?: string;
  /** The newest thread carrying the header: what Unsubscribe acts on. */
  threadId: string;
  /** Its future mail goes to Trash (a list Chord could not leave). */
  autoTrash?: boolean;
}

const recipientList = z
  .array(z.string().trim().email().max(320))
  .max(50)
  .optional();

/**
 * Files to send, as Chord attachment ids (ADR 0111). Ids, never bytes: the
 * file is already on the server, and a device pick uploads through the normal
 * attachment route first, so one wire shape covers both.
 *
 * Capped at 10 because a mail provider will refuse a large message anyway, and
 * a refusal after the send button is worse than a limit before it.
 */
const attachmentIdList = z.array(z.string().min(1).max(64)).max(10).optional();

/**
 * ADR 0339 - how the composer wrote a message. `rich`: `bodyHtml` is what the
 * editor holds (signature included) and `body` its text; `plain`: `body` only,
 * sent as text. Absent: an app from before the switch.
 */
export const EMAIL_BODY_FORMATS = ['plain', 'rich'] as const;
export type EmailBodyFormat = (typeof EMAIL_BODY_FORMATS)[number];
/** The most HTML a composed body may carry. */
export const EMAIL_BODY_HTML_MAX = 200_000;
const composedFormat = {
  format: z.enum(EMAIL_BODY_FORMATS).optional(),
  bodyHtml: z.string().max(EMAIL_BODY_HTML_MAX).nullish(),
};

/**
 * POST body to reply to a thread. Recipients are optional — omitted `to`
 * falls back to the latest sender (plain "Reply"); the client computes
 * reply-all/cc/bcc prefills from the message it is replying to. The server
 * appends the user's signature (Settings) and sends text + HTML alternatives.
 */
export const EmailReplyRequest = z.object({
  body: z.string().min(1).max(50_000),
  ...composedFormat,
  to: recipientList,
  cc: recipientList,
  bcc: recipientList,
  attachmentIds: attachmentIdList,
  /** The message in the thread being answered. Omitted: the newest one that
   *  is not the user's own. */
  messageId: z.string().min(1).max(128).optional(),
  /** The draft this message was written in, cleared once it is actually sent.
   *  Server-side rather than a client delete: a send that succeeds and a
   *  cleanup that fails would leave a draft of a message already gone. */
  draftId: z.string().min(1).max(64).optional(),
});
export type EmailReplyRequest = z.infer<typeof EmailReplyRequest>;

/**
 * ADR 0197 — "compose a reply for me". The instruction is what the user typed
 * into the reply box's AI block; `draft` is what is already in the reply box,
 * so a second ask revises rather than starts over. Nothing is sent.
 */
/**
 * ADR 0266 — the user's own order for the AI view's categories: these first,
 * in this order; the rest keep the default order. Empty = no order of theirs.
 */
export const EmailCategoryOrderRequest = z.object({
  titles: z.array(z.string().trim().min(1).max(120)).max(40),
});
export type EmailCategoryOrderRequest = z.infer<typeof EmailCategoryOrderRequest>;

export interface EmailCategoryOrder {
  titles: string[];
}

/** ADR 0278 — color one mailbox ('primary' or an account id); null = default. */
export const SetMailboxColorRequest = z.object({
  mailbox: z.string().min(1).max(64),
  color: z.string().max(32).nullable(),
});
export type SetMailboxColorRequest = z.infer<typeof SetMailboxColorRequest>;

export const EmailComposeReplyRequest = z.object({
  instruction: z.string().trim().min(1).max(1000),
  draft: z.string().max(50_000).optional(),
});
export type EmailComposeReplyRequest = z.infer<typeof EmailComposeReplyRequest>;

export interface EmailComposeReplyResult {
  body: string;
}

/**
 * ADR 0261 — "Summarize" on an open email. A few lines on what the thread
 * says and what it asks of the reader; nothing is stored or sent.
 */
export interface EmailSummarizeResult {
  summary: string;
}

/**
 * ADR 0197 addendum — the reply ask bar's chips, read off the email being
 * answered. `ask` is the instruction sent to the composer when tapped.
 */
export interface EmailReplyAsk {
  label: string;
  ask: string;
}

export interface EmailReplyAsksResult {
  asks: EmailReplyAsk[];
}

/**
 * ADR 0277 — the Findings tab's own chat about the user's mail. The client
 * holds the conversation and sends it whole each turn; the server stores
 * nothing, so it never mixes with the personal chat.
 */
export const FindingsChatRequest = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        text: z.string().trim().min(1).max(4000),
      }),
    )
    .min(1)
    .max(40)
    .refine((m) => m[m.length - 1].role === 'user', 'the last message must be the question'),
  tz: z.string().max(64).optional(),
});
export type FindingsChatRequest = z.infer<typeof FindingsChatRequest>;

export interface FindingsChatResult {
  reply: string;
  /** Tappable results (an email, a receipt) the answer came with. */
  cards: Array<{ title: string; subtitle?: string; meta?: string; href?: string; url?: string }>;
  /**
   * The user asked for a change this read-only chat cannot make. The app
   * SHOWS `message` word for word and posts it to the personal chat as the
   * user only when they tap Send (the bot there acts on it at once); never
   * post it unasked - it is drafted by a model that read mail. Written to
   * stand alone: it names the sender, email, date or amount it is about.
   */
  handoff?: { message: string };
}

/**
 * The same ask on a NEW message, which has no thread to read. The recipients
 * and subject typed so far are context only - loosely validated, since a
 * half-typed address must not refuse the ask.
 */
export const EmailComposeNewRequest = z.object({
  instruction: z.string().trim().min(1).max(1000),
  draft: z.string().max(50_000).optional(),
  to: z.array(z.string().max(320)).max(50).optional(),
  subject: z.string().max(500).optional(),
});
export type EmailComposeNewRequest = z.infer<typeof EmailComposeNewRequest>;

export interface EmailComposeNewResult {
  body: string;
  /** Present only when the request carried no subject. */
  subject?: string;
}

/**
 * Compose a NEW message (ADR 0107 - answering is ours, filing is the
 * provider's). Distinct from EmailReplyRequest because there is no thread to
 * inherit a subject or threading headers from, and because the sender picks
 * which of their mailboxes it leaves from.
 */
export const EmailSendRequest = z.object({
  /** At least one recipient - a message with nowhere to go is a draft, and
   *  drafts are not built yet. Validated like every other recipient list. */
  to: z.array(z.string().trim().email().max(320)).min(1).max(50),
  cc: recipientList,
  bcc: recipientList,
  subject: z.string().max(500),
  body: z.string().min(1).max(50_000),
  ...composedFormat,
  /** Which mailbox to send from. Omit for the primary Gmail on the user row. */
  accountId: z.string().min(1).optional(),
  /** ADR 0130 - one of this mailbox's verified send-as addresses. Re-checked
   *  server-side: the client picked from a list we gave it, but a From header
   *  is exactly the field worth being strict about. */
  from: z.string().trim().email().max(320).optional(),
  attachmentIds: attachmentIdList,
  /** The draft this message was written in, cleared once it is actually sent.
   *  Server-side rather than a client delete: a send that succeeds and a
   *  cleanup that fails would leave a draft of a message already gone. */
  draftId: z.string().min(1).max(64).optional(),
});
export type EmailSendRequest = z.infer<typeof EmailSendRequest>;

/**
 * Forward a thread onward (ADR 0112). Separate from reply because the audience
 * is new: no threading headers, and the original is quoted rather than
 * answered.
 *
 * `body` is optional and often empty — "here, look at this" is the whole
 * message most of the time, and forcing a note to send one would be a lie about
 * what forwarding is.
 */
export const EmailForwardRequest = z.object({
  to: z.array(z.string().trim().email().max(320)).min(1).max(50),
  cc: recipientList,
  bcc: recipientList,
  body: z.string().max(50_000).optional(),
  ...composedFormat,
  /** Carry the original's files. Default true: a forward that drops them is
   *  the thing the recipient will notice and the sender will not. */
  includeAttachments: z.boolean().optional(),
  /** Extra files of the sender's own, alongside the original's. */
  attachmentIds: attachmentIdList,
  /** The message to forward: the one selected in the reader (ADR 0112
   *  addendum). Omitted = the thread's newest. */
  messageId: z.string().min(1).max(128).optional(),
  /** The draft this message was written in, cleared once it is actually sent.
   *  Server-side rather than a client delete: a send that succeeds and a
   *  cleanup that fails would leave a draft of a message already gone. */
  draftId: z.string().min(1).max(64).optional(),
});
export type EmailForwardRequest = z.infer<typeof EmailForwardRequest>;

/**
 * What a forward will quote under the sender's note (ADR 0112 addendum): the
 * selected message (else the newest), built by the same header and body rule the send uses, so
 * the composer shows exactly what goes.
 */
export interface EmailForwardPreview {
  messageId: string;
  /** Marker line first, then From / Date / Subject / To. */
  header: string[];
  /** The quoted body as sent: the message's visible text. */
  body: string;
  /** The original's files, carried unless `includeAttachments` is false. */
  attachments: EmailAttachmentRef[];
  /** The mailbox the forward leaves from (null = the primary Gmail), so the
   *  note opens with that mailbox's signature. */
  accountId?: string | null;
  /** ADR 0339: the original was written in HTML, so the note opens Rich. */
  originalIsHtml?: boolean;
}

/**
 * Unsent mail (ADR 0113). A draft is an unfinished ANSWER, which ADR 0107 puts
 * on Chord's side of the line, so these are ours and not the provider's.
 *
 * Every field is optional because a draft is by definition incomplete — the
 * point is to keep whatever exists at the moment the user walks away.
 */
export const EMAIL_DRAFT_KINDS = ['new', 'reply', 'forward'] as const;
export type EmailDraftKind = (typeof EMAIL_DRAFT_KINDS)[number];

export const EmailDraftRequest = z.object({
  /** Present when updating one Chord already knows about. */
  id: z.string().min(1).max(64).optional(),
  kind: z.enum(EMAIL_DRAFT_KINDS),
  /** The thread a reply or forward belongs to; absent for a new message. */
  threadId: z.string().min(1).max(64).nullish(),
  accountId: z.string().min(1).max(64).nullish(),
  to: recipientList,
  cc: recipientList,
  bcc: recipientList,
  subject: z.string().max(500).optional(),
  body: z.string().max(50_000).optional(),
  ...composedFormat,
  attachmentIds: attachmentIdList,
  /** Forward only: the message being passed on (ADR 0112 addendum). Omitted
   *  leaves what is stored; null = the thread's newest. */
  forwardMessageId: z.string().min(1).max(128).nullish(),
});
export type EmailDraftRequest = z.infer<typeof EmailDraftRequest>;

/**
 * Queue a message that is already saved as a draft (ADR 0115). The draft
 * carries the content; this only says "send it, after the undo window".
 */
export const EmailQueueRequest = z.object({
  draftId: z.string().min(1).max(64),
  /** Forward only: carry the original's files. */
  includeAttachments: z.boolean().optional(),
});
export type EmailQueueRequest = z.infer<typeof EmailQueueRequest>;

export interface EmailQueuedResult {
  queued: true;
  draftId: string;
  /** When it actually goes, so the client can size its own countdown. */
  sendAfter: IsoDateTime;
}

/**
 * One address the composer can offer (ADR 0114). Drawn only from the user's own
 * mail and their own people rows — never a global directory.
 */
export interface EmailRecipientSuggestion {
  email: string;
  name: string | null;
  /** `person` = someone in the family graph; `correspondent` = someone this
   *  mailbox has actually exchanged mail with; `contacts` = this phone's
   *  address book, matched on the device and never sent to the server. */
  source: 'person' | 'correspondent' | 'contacts';
}

export interface EmailDraft {
  id: string;
  kind: EmailDraftKind;
  threadId: string | null;
  accountId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  /** ADR 0339 - how it was written; absent on a draft from before the switch. */
  format?: EmailBodyFormat;
  /** Rich only: what the editor held. */
  bodyHtml?: string | null;
  attachmentIds: string[];
  /** Names and sizes for `attachmentIds`, so a resumed draft can show its
   *  files. Only on a single-draft read, and only files the user can read. */
  attachments?: Array<{ id: string; filename: string; size: number }>;
  updatedAt: IsoDateTime;
  /** What the list row shows: the subject, or the first line of the body when
   *  there is no subject yet, or a placeholder. Computed server-side so the
   *  three clients cannot disagree about what an empty draft looks like. */
  preview: string;
  /** ADR 0115 — why the last send attempt did not go, if one did not. */
  lastError?: string | null;
  /** Forward only: the message being passed on; null = the thread's newest. */
  forwardMessageId?: string | null;
}

export interface EmailSendResult {
  sent: true;
  /** The address it actually left from, so the client can say so. */
  fromEmail: string;
}

/** PATCH-style body to change read/archive/label state on a thread. */
export const EmailModifyRequest = z
  .object({
    markRead: z.boolean().optional(),
    archive: z.boolean().optional(),
    /** ADR 0215 - move the thread to the mailbox's own Trash. There is no
     *  `false`: taking mail back out of Trash happens in the provider. */
    trash: z.literal(true).optional(),
    addLabelIds: z.array(z.string().min(1).max(128)).max(50).optional(),
    removeLabelIds: z.array(z.string().min(1).max(128)).max(50).optional(),
    /** Apply a `Chord/<category>` Gmail label from the thread's classifier category. */
    applyCategoryLabel: z.boolean().optional(),
    /**
     * ADR 0141 — local Chord labels (display names). Never touch the provider;
     * applied before any provider dispatch.
     */
    addChordLabels: z.array(z.string().min(1).max(80)).max(20).optional(),
    removeChordLabels: z.array(z.string().min(1).max(80)).max(20).optional(),
    /**
     * Mark only these messages (row ids) read, not the whole thread - the
     * reader marks each message as it scrolls into view. Only with
     * `markRead: true` and nothing else.
     */
    messageIds: z.array(z.string().min(1).max(128)).min(1).max(100).optional(),
  })
  .refine(
    (v) =>
      v.messageIds === undefined ||
      (v.markRead === true &&
        v.archive === undefined &&
        v.trash === undefined &&
        v.applyCategoryLabel === undefined &&
        !v.addLabelIds?.length &&
        !v.removeLabelIds?.length &&
        !v.addChordLabels?.length &&
        !v.removeChordLabels?.length),
    { message: 'messageIds goes only with markRead: true' },
  )
  .refine(
    (v) =>
      v.markRead !== undefined ||
      v.archive !== undefined ||
      v.trash === true ||
      v.applyCategoryLabel === true ||
      (v.addLabelIds?.length ?? 0) > 0 ||
      (v.removeLabelIds?.length ?? 0) > 0 ||
      (v.addChordLabels?.length ?? 0) > 0 ||
      (v.removeChordLabels?.length ?? 0) > 0,
    {
      message:
        'no-op modify: provide markRead, archive, trash, applyCategoryLabel, label, or chord-label changes',
    },
  );
export type EmailModifyRequest = z.infer<typeof EmailModifyRequest>;

/**
 * Triage several threads at once (ADR 0128). Archive/read are N provider
 * writes. Chord labels (ADR 0141) are one local UPDATE each — the 100-id cap
 * is request-size sanity for both, not the provider-quota reason from 0128.
 */
export const EmailBulkModifyRequest = z
  .object({
    ids: z.array(z.string().min(1).max(64)).min(1).max(100),
    markRead: z.boolean().optional(),
    archive: z.boolean().optional(),
    trash: z.literal(true).optional(),
    addChordLabels: z.array(z.string().min(1).max(80)).max(20).optional(),
    removeChordLabels: z.array(z.string().min(1).max(80)).max(20).optional(),
  })
  .refine(
    (v) =>
      v.markRead !== undefined ||
      v.archive !== undefined ||
      v.trash === true ||
      (v.addChordLabels?.length ?? 0) > 0 ||
      (v.removeChordLabels?.length ?? 0) > 0,
    { message: 'nothing to change' },
  );
export type EmailBulkModifyRequest = z.infer<typeof EmailBulkModifyRequest>;

export interface EmailBulkModifyResult {
  /** Threads the provider accepted. */
  updated: string[];
  /**
   * Threads that did not change. Reported rather than swallowed: a batch that
   * half-worked must not read as a success (ADR 0107).
   */
  failed: string[];
}

/**
 * Put a thread aside until a moment (ADR 0129). `until: null` wakes it now.
 */
export const EmailSnoozeRequest = z.object({
  until: z.string().datetime().nullable(),
});
export type EmailSnoozeRequest = z.infer<typeof EmailSnoozeRequest>;

/**
 * One junk/spam message, live-read from the provider on demand (ADR 0080
 * addendum). Never mirrored, never classified — a read-only peek so codes
 * and password resets that land in junk stay reachable. `key` is opaque
 * ("primary:<id>" or "<accountId>:<nativeId>") and drives the rescue action.
 */
export interface JunkMessage {
  key: string;
  /** Which mailbox it lives in — the address, or "Gmail" for the primary. */
  mailbox: string;
  fromName: string | null;
  fromEmail: string | null;
  subject: string;
  snippet: string;
  /** Plain-text body when cheaply available (codes are usually here). */
  bodyText: string | null;
  date: IsoDateTime;
}

/** POST body for the not-junk rescue (moves the message to the inbox). */
export const JunkRescueRequest = z.object({ key: z.string().min(1).max(512) });
export type JunkRescueRequest = z.infer<typeof JunkRescueRequest>;

/** Result of a sync tick surfaced to the client + SSE. */
export interface EmailSyncResult {
  inserted: number;
  updated: number;
  deleted: number;
  backfillDone: boolean;
}

/** SSE payload when a thread's read/archive/label state changes. */
export interface EmailThreadUpdatedEvent {
  userId: UserId;
  threadId: string;
  isUnread: boolean;
  isArchived: boolean;
  labelIds: string[];
}
