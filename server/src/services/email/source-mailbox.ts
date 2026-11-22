/**
 * ADR 0312 — the mailbox an email came to decides which calendar its events
 * go on and which account answers its invitations. Nothing produced from one
 * mailbox's mail may land on, or be sent from, another's.
 */
import type { Kysely } from 'kysely';

import type { Proposal, ProposalCalendarChoice } from '@chord/kernel';

import type { DB } from '../../db/schema.js';
import { hasCalendarWriteScope } from '../google/calendar-write.service.js';
import { calendarsOn } from '../outlook-calendar/enabled.js';
import { gmailCalendarsOn } from '../gmail-calendar/enabled.js';

export type SourceMailbox =
  | { kind: 'primary' }
  | { kind: 'account'; accountId: string; provider: 'gmail' | 'outlook' | 'imap' };

/** Where a mailbox's calendar items go: a calendar id, or ask the user. */
export type MailboxCalendar =
  | { kind: 'auto'; calendarId: string }
  | { kind: 'ask'; reason: 'no_calendar' };

const GMAIL_PREFIX = 'gmail:';

/**
 * The mailbox behind a `gmail:<threadId>` provenance, or null when the
 * provenance is not an email. The thread row answers first; when the mail is
 * already gone, an attached mailbox's thread id still carries its account id
 * as a prefix (`scopedId`). A thread id that names no attached mailbox of this
 * user is the primary Gmail's.
 */
export async function mailboxOfProvenance(
  db: Kysely<DB>,
  userId: string,
  provenance: string | null | undefined,
): Promise<SourceMailbox | null> {
  const threadId = threadIdOf(provenance);
  if (!threadId) return null;
  const thread = await db
    .selectFrom('email_threads')
    .select('account_id')
    .where('user_id', '=', userId)
    .where('gmail_thread_id', '=', threadId)
    .executeTakeFirst();
  return resolveMailbox(threadId, thread, async (accountId) =>
    db
      .selectFrom('email_accounts')
      .select(['id', 'provider'])
      .where('id', '=', accountId)
      .where('user_id', '=', userId)
      .executeTakeFirst(),
  );
}

function threadIdOf(provenance: string | null | undefined): string | null {
  if (!provenance?.startsWith(GMAIL_PREFIX)) return null;
  return provenance.slice(GMAIL_PREFIX.length) || null;
}

async function resolveMailbox(
  threadId: string,
  thread: { account_id: string | null } | undefined,
  loadAccount: (accountId: string) => Promise<{ id: string; provider: string } | undefined>,
): Promise<SourceMailbox> {
  let accountId: string | null = thread ? (thread.account_id ?? null) : null;
  if (!thread) {
    const sep = threadId.indexOf(':');
    accountId = sep > 0 ? threadId.slice(0, sep) : null;
  }
  if (!accountId) return { kind: 'primary' };

  const account = await loadAccount(accountId);
  // A prefix that names no mailbox of this user: either the mailbox was
  // disconnected, or the id merely contains a colon. Neither may borrow the
  // primary's calendar for mail it did not receive, so ask.
  if (!account) {
    return thread
      ? { kind: 'primary' }
      : { kind: 'account', accountId, provider: 'imap' };
  }
  return { kind: 'account', accountId: account.id, provider: account.provider as 'gmail' | 'outlook' | 'imap' };
}

function mailboxKey(m: SourceMailbox): string {
  return m.kind === 'primary' ? 'primary' : `${m.provider}:${m.accountId}`;
}

/**
 * The calendar a mailbox's events go on (table in ADR 0312). A user with no
 * writable calendar anywhere has nothing to leak into and nothing to pick,
 * so their events are saved in Chord as before rather than refused.
 */
export async function mailboxCalendar(
  db: Kysely<DB>,
  userId: string,
  mailbox: SourceMailbox,
): Promise<MailboxCalendar> {
  const own = await ownMailboxCalendar(db, userId, mailbox);
  if (own.kind === 'ask' && (await writableCalendarOptions(db, userId)).length === 0) {
    return { kind: 'auto', calendarId: 'primary' };
  }
  return own;
}

async function ownMailboxCalendar(
  db: Kysely<DB>,
  userId: string,
  mailbox: SourceMailbox,
): Promise<MailboxCalendar> {
  const user = await db
    .selectFrom('users')
    .select('default_calendar_id')
    .where('id', '=', userId)
    .executeTakeFirst();
  const userDefault = user?.default_calendar_id ?? null;

  if (mailbox.kind === 'primary') {
    if (!(await hasCalendarWriteScope(db, userId))) return { kind: 'ask', reason: 'no_calendar' };
    if (userDefault && (await isWritableCalendar(db, userId, userDefault, 'google'))) {
      return { kind: 'auto', calendarId: userDefault };
    }
    return { kind: 'auto', calendarId: 'primary' };
  }

  if (mailbox.provider === 'outlook' && calendarsOn()) {
    const account = await db
      .selectFrom('email_accounts')
      .select(['calendar_enabled', 'calendar_default_id', 'status'])
      .where('id', '=', mailbox.accountId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    // Outlook mail goes on that Outlook calendar, whatever the user default —
    // while the mailbox can still write it. A mailbox waiting to be reconnected
    // cannot push, so naming its calendar would promise an event nobody sees.
    if (
      account &&
      account.status === 'ok' &&
      Number(account.calendar_enabled) === 1 &&
      account.calendar_default_id
    ) {
      return { kind: 'auto', calendarId: account.calendar_default_id };
    }
  }

  // ADR 0313 — an attached Gmail's mail goes on that Google account's own
  // calendar (its primary, named by the first calendar sync after connect).
  if (mailbox.provider === 'gmail' && gmailCalendarsOn()) {
    const account = await db
      .selectFrom('email_accounts')
      .select(['calendar_enabled', 'calendar_default_id', 'status'])
      .where('id', '=', mailbox.accountId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (
      account &&
      account.status === 'ok' &&
      Number(account.calendar_enabled) === 1 &&
      account.calendar_default_id
    ) {
      return { kind: 'auto', calendarId: account.calendar_default_id };
    }
  }
  return { kind: 'ask', reason: 'no_calendar' };
}

/**
 * Can this user put an event on this calendar? Stricter than the push-side
 * check: a choice made on a card must name a calendar we know they can
 * write, never an id we have not seen.
 */
export async function isWritableCalendar(
  db: Kysely<DB>,
  userId: string,
  calendarId: string,
  provider?: 'google' | 'outlook',
): Promise<boolean> {
  if (calendarId === 'primary') {
    return provider !== 'outlook' && (await hasCalendarWriteScope(db, userId));
  }
  let q = db
    .selectFrom('calendar_sources')
    .select('id')
    .where('user_id', '=', userId)
    .where('google_calendar_id', '=', calendarId)
    .where('access_role', 'in', ['owner', 'writer']);
  q = provider ? q.where('provider', '=', provider) : q.where('provider', 'in', ['google', 'outlook']);
  return !!(await q.executeTakeFirst());
}

/** One call for the executor: the mailbox and its calendar, or null for non-email work. */
export async function calendarForProvenance(
  db: Kysely<DB>,
  userId: string,
  provenance: string | null | undefined,
): Promise<{ mailbox: SourceMailbox; calendar: MailboxCalendar } | null> {
  const mailbox = await mailboxOfProvenance(db, userId, provenance);
  if (!mailbox) return null;
  return { mailbox, calendar: await mailboxCalendar(db, userId, mailbox) };
}

/** Every calendar the user can put an event on, for the card's picker. */
async function writableCalendarOptions(
  db: Kysely<DB>,
  userId: string,
): Promise<{ calendarId: string; label: string }[]> {
  const { calendarLabel } = await import('../calendar-sources.service.js');
  const rows = await db
    .selectFrom('calendar_sources')
    .select(['google_calendar_id', 'provider', 'is_primary'])
    .where('user_id', '=', userId)
    .where('provider', 'in', ['google', 'outlook'])
    .where('access_role', 'in', ['owner', 'writer'])
    .orderBy('is_primary', 'desc')
    .orderBy('summary', 'asc')
    .execute();
  const ids = rows.map((r) => r.google_calendar_id);
  const hasGooglePrimaryRow = rows.some((r) => r.provider === 'google' && Number(r.is_primary) === 1);
  if (!hasGooglePrimaryRow && (await hasCalendarWriteScope(db, userId))) ids.unshift('primary');
  return Promise.all(
    ids.map(async (calendarId) => ({ calendarId, label: await calendarLabel(db, userId, calendarId) })),
  );
}

/**
 * Where each email event on a card will go (ADR 0312), so the card can say
 * it before the tap — or ask. Invitations claim no calendar and get nothing.
 */
export async function attachCalendarChoices(
  db: Kysely<DB>,
  userId: string,
  proposals: Proposal[],
): Promise<Proposal[]> {
  const wanted = proposals.filter((p) => {
    if (p.toolName !== 'create_event' || p.status !== 'pending' || !threadIdOf(p.provenance)) return false;
    try {
      return (JSON.parse(p.argsJson) as { alreadyInGoogle?: boolean }).alreadyInGoogle !== true;
    } catch {
      return true; // A broken row shows as it is; confirm re-validates.
    }
  });
  if (wanted.length === 0) return proposals;

  // The list shows many cards from few mailboxes: read every thread and
  // mailbox once, and work each mailbox's calendar out once, rather than
  // a handful of queries per card.
  const { calendarLabel } = await import('../calendar-sources.service.js');
  const threadIds = [...new Set(wanted.map((p) => threadIdOf(p.provenance)!))];
  const [threadRows, accountRows] = await Promise.all([
    db
      .selectFrom('email_threads')
      .select(['gmail_thread_id', 'account_id'])
      .where('user_id', '=', userId)
      .where('gmail_thread_id', 'in', threadIds)
      .execute(),
    db.selectFrom('email_accounts').select(['id', 'provider']).where('user_id', '=', userId).execute(),
  ]);
  const threads = new Map(threadRows.map((t) => [t.gmail_thread_id, t]));
  const accounts = new Map(accountRows.map((a) => [a.id, a]));
  const calendars = new Map<string, Promise<MailboxCalendar>>();
  const labels = new Map<string, Promise<string>>();
  let options: Promise<{ calendarId: string; label: string }[]> | null = null;

  const choiceFor = async (p: Proposal): Promise<ProposalCalendarChoice> => {
    const threadId = threadIdOf(p.provenance)!;
    const mailbox = await resolveMailbox(threadId, threads.get(threadId), async (id) => accounts.get(id));
    const key = mailboxKey(mailbox);
    let calendar = calendars.get(key);
    if (!calendar) {
      calendar = mailboxCalendar(db, userId, mailbox);
      calendars.set(key, calendar);
    }
    const c = await calendar;
    if (c.kind === 'auto') {
      let label = labels.get(c.calendarId);
      if (!label) {
        label = calendarLabel(db, userId, c.calendarId);
        labels.set(c.calendarId, label);
      }
      return { kind: 'auto', calendarId: c.calendarId, label: await label };
    }
    options ??= writableCalendarOptions(db, userId);
    return { kind: 'ask', options: await options };
  };

  const wantedIds = new Set(wanted.map((p) => p.id));
  const out: Proposal[] = [];
  for (const p of proposals) {
    out.push(wantedIds.has(p.id) ? { ...p, calendarChoice: await choiceFor(p) } : p);
  }
  return out;
}

/**
 * The calendar for a travel booking's event: its mailbox's own calendar, or
 * null when it did not come by email or its mailbox has no calendar (the
 * caller then uses the user's default — the one case the owner allows a
 * mailbox's item onto another calendar). A booking filed from an email
 * attachment names the attachment, which names the email.
 */
export async function calendarForBooking(
  db: Kysely<DB>,
  userId: string,
  sourceRawContext: string | null,
  sourceDocId: string | null,
): Promise<string | null> {
  let provenance = sourceRawContext?.startsWith(GMAIL_PREFIX) ? sourceRawContext : null;
  if (!provenance && sourceDocId) {
    const thread = await db
      .selectFrom('attachments')
      .innerJoin('email_threads', 'email_threads.id', 'attachments.origin_email_thread_id')
      .select('email_threads.gmail_thread_id')
      .where('attachments.id', '=', sourceDocId)
      .where('email_threads.user_id', '=', userId)
      .executeTakeFirst();
    if (thread) provenance = `${GMAIL_PREFIX}${thread.gmail_thread_id}`;
  }
  const routed = await calendarForProvenance(db, userId, provenance);
  return routed?.calendar.kind === 'auto' ? routed.calendar.calendarId : null;
}

export type EmailCalendarPick =
  | { ok: true; calendarId: string }
  | { ok: false; reason: 'calendar_required' | 'calendar_not_writable' };

/**
 * The executor's question: where does this event go, given its provenance and
 * any calendar picked on the card? Null = not an email event, so the ordinary
 * chat rule (ADR 0232) applies. A calendar NAMED in the call does not move an
 * email event off its mailbox; only a pick on the card does.
 */
export async function emailCalendarPick(
  db: Kysely<DB>,
  opts: {
    calendarOwner: string;
    actorUserId: string | null;
    provenance: string | null;
    picked: string | null;
  },
): Promise<EmailCalendarPick | null> {
  if (opts.picked) {
    return (await isWritableCalendar(db, opts.calendarOwner, opts.picked))
      ? { ok: true, calendarId: opts.picked }
      : { ok: false, reason: 'calendar_not_writable' };
  }
  // A persona's or another member's event goes on their calendar; the
  // mailbox belongs to the person who confirmed.
  if (!opts.actorUserId || opts.calendarOwner !== opts.actorUserId) return null;
  const routed = await calendarForProvenance(db, opts.actorUserId, opts.provenance);
  if (!routed) return null;
  return routed.calendar.kind === 'auto'
    ? { ok: true, calendarId: routed.calendar.calendarId }
    : { ok: false, reason: 'calendar_required' };
}
