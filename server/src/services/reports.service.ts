/**
 * ADR 0301 — reporting a message someone else posted in a shared chat.
 *
 * A report is saved first and emailed to the support address after, in the
 * background; a send that fails is retried by the proactive tick. Without an
 * SMTP URL the report is saved and logged, never lost.
 */
import nodemailer from 'nodemailer';
import { sql, type Kysely } from 'kysely';

import { fullName } from '@chord/kernel';
import { env } from '../config/env.js';
import { logger } from '../config/logging.js';
import type { DB } from '../db/schema.js';
import { runInBackground } from '../utils/background.js';
import { newId } from '../utils/ids.js';

const BODY_CAP = 2000;
const MAX_ATTEMPTS = 8;
const RETRY_GAP_MS = 10 * 60 * 1000;
const RETRY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

export type ReportResult =
  | { ok: true; reportId: string; alreadyReported: boolean; reportedUserId: string; reportedName: string }
  | { ok: false; reason: 'not_found' | 'own_message' | 'personal_chat' | 'bot_message' };

function nameOf(r: {
  username: string;
  display_name: string | null;
  first_name?: string | null;
  last_name?: string | null;
}): string {
  return fullName({
    username: r.username,
    displayName: r.display_name ?? undefined,
    firstName: r.first_name ?? undefined,
    lastName: r.last_name ?? undefined,
  });
}

/**
 * Report one message. It must be a visible message in a shared chat the
 * reporter belongs to, posted by another member. Anything else the reporter
 * cannot see answers `not_found`, so ids cannot be probed.
 */
export async function reportMessage(
  db: Kysely<DB>,
  input: { reporterId: string; messageId: string; reason?: string | null },
): Promise<ReportResult> {
  const msg = await db
    .selectFrom('messages')
    .innerJoin('groups', 'groups.id', 'messages.group_id')
    .innerJoin('group_members as gm', (j) =>
      j.onRef('gm.group_id', '=', 'messages.group_id').on('gm.user_id', '=', input.reporterId),
    )
    .leftJoin('attachments', 'attachments.id', 'messages.attachment_id')
    .leftJoin('users as sender', 'sender.id', 'messages.sender_id')
    .select([
      'messages.id',
      'messages.group_id',
      'messages.sender_id',
      'messages.body',
      'messages.kind as messageKind',
      'groups.kind',
      'attachments.filename',
      'sender.username',
      'sender.display_name',
      'sender.first_name',
      'sender.last_name',
    ])
    .where('messages.id', '=', input.messageId)
    .where('messages.chord_visible', '=', 1)
    .executeTakeFirst();
  if (!msg) return { ok: false, reason: 'not_found' };
  if (msg.kind === 'personal') return { ok: false, reason: 'personal_chat' };
  if (msg.messageKind === 'bot' || msg.messageKind === 'system' || !msg.sender_id || !msg.username) return { ok: false, reason: 'bot_message' };
  if (msg.sender_id === input.reporterId) return { ok: false, reason: 'own_message' };

  const reportedName = nameOf({
    username: msg.username,
    display_name: msg.display_name,
    first_name: msg.first_name,
    last_name: msg.last_name,
  });
  const existing = await db
    .selectFrom('content_reports')
    .select('id')
    .where('reporter_user_id', '=', input.reporterId)
    .where('message_id', '=', msg.id)
    .executeTakeFirst();
  if (existing) {
    return { ok: true, reportId: existing.id, alreadyReported: true, reportedUserId: msg.sender_id, reportedName };
  }

  const id = newId('rpt');
  const inserted = await db
    .insertInto('content_reports')
    .values({
      id,
      reporter_user_id: input.reporterId,
      reported_user_id: msg.sender_id,
      group_id: msg.group_id,
      message_id: msg.id,
      message_body: msg.body.slice(0, BODY_CAP),
      attachment_name: msg.filename ?? null,
      reason: input.reason?.trim() ? input.reason.trim().slice(0, 1000) : null,
      created_at: new Date().toISOString(),
    })
    .onConflict((oc) => oc.columns(['reporter_user_id', 'message_id']).doNothing())
    .returning('id')
    .executeTakeFirst();
  if (!inserted) {
    // A second tap raced the first; the first one's row stands.
    const row = await db
      .selectFrom('content_reports')
      .select('id')
      .where('reporter_user_id', '=', input.reporterId)
      .where('message_id', '=', msg.id)
      .executeTakeFirstOrThrow();
    return { ok: true, reportId: row.id, alreadyReported: true, reportedUserId: msg.sender_id, reportedName };
  }
  logger.warn('content reported', { reportId: id, groupId: msg.group_id, messageId: msg.id });
  runInBackground(sendReportEmail(db, id));
  return { ok: true, reportId: id, alreadyReported: false, reportedUserId: msg.sender_id, reportedName };
}

export interface ReportMail {
  to: string;
  subject: string;
  text: string;
}

export type ReportMailer = (mail: ReportMail) => Promise<void>;

let mailerOverride: ReportMailer | null = null;

/** Tests replace the SMTP sender; `null` restores it. */
export function setReportMailer(fn: ReportMailer | null): void {
  mailerOverride = fn;
}

function smtpMailer(): ReportMailer | null {
  if (!env.REPORTS_SMTP_URL) return null;
  const transport = nodemailer.createTransport(env.REPORTS_SMTP_URL);
  const from = env.REPORTS_EMAIL_FROM || decodeURIComponent(new URL(env.REPORTS_SMTP_URL).username);
  return async (mail) => {
    await transport.sendMail({ from, to: mail.to, subject: mail.subject, text: mail.text });
  };
}

/** The email for one report. Exported for the test. */
export async function buildReportMail(db: Kysely<DB>, reportId: string): Promise<ReportMail | null> {
  const r = await db
    .selectFrom('content_reports as r')
    .innerJoin('users as reporter', 'reporter.id', 'r.reporter_user_id')
    .leftJoin('users as reported', 'reported.id', 'r.reported_user_id')
    .leftJoin('groups', 'groups.id', 'r.group_id')
    .select([
      'r.id',
      'r.message_id',
      'r.message_body',
      'r.attachment_name',
      'r.reason',
      'r.created_at',
      'r.reporter_user_id',
      'r.reported_user_id',
      'r.group_id',
      'reporter.username as reporterUsername',
      'reporter.display_name as reporterDisplay',
      'reporter.email as reporterEmail',
      'reported.username as reportedUsername',
      'reported.display_name as reportedDisplay',
      'groups.name as groupName',
    ])
    .where('r.id', '=', reportId)
    .executeTakeFirst();
  if (!r) return null;
  const reporter = nameOf({ username: r.reporterUsername, display_name: r.reporterDisplay });
  const reported = r.reportedUsername
    ? nameOf({ username: r.reportedUsername, display_name: r.reportedDisplay })
    : '(account deleted)';
  const lines = [
    `A message was reported in Chord.`,
    ``,
    `Reported by: ${reporter} (${r.reporter_user_id}${r.reporterEmail ? `, ${r.reporterEmail}` : ''})`,
    `Posted by:   ${reported}${r.reported_user_id ? ` (${r.reported_user_id})` : ''}`,
    `Chat:        ${r.groupName ?? '(deleted)'}${r.group_id ? ` (${r.group_id})` : ''}`,
    `Message id:  ${r.message_id}`,
    `Reported at: ${r.created_at}`,
    `Report id:   ${r.id}`,
    `Reason:      ${r.reason ?? '(none given)'}`,
  ];
  if (r.attachment_name) lines.push(`File:        ${r.attachment_name}`);
  lines.push('', 'Message:', r.message_body || '(no text)');
  return {
    to: env.REPORTS_EMAIL_TO,
    subject: `Chord report: message from ${reported} in ${r.groupName ?? 'a chat'}`,
    text: lines.join('\n'),
  };
}

/** Email one report; records the outcome. Never throws. */
export async function sendReportEmail(db: Kysely<DB>, reportId: string): Promise<boolean> {
  const mailer = mailerOverride ?? smtpMailer();
  if (!mailer) {
    logger.warn('report not emailed: REPORTS_SMTP_URL is not set', { reportId });
    return false;
  }
  const now = new Date().toISOString();
  try {
    const mail = await buildReportMail(db, reportId);
    if (!mail) return false;
    await mailer(mail);
    await db
      .updateTable('content_reports')
      .set({ emailed_at: now, last_attempt_at: now, last_error: null, email_attempts: sql`email_attempts + 1` })
      .where('id', '=', reportId)
      .execute();
    return true;
  } catch (err) {
    const message = (err as Error).message.slice(0, 500);
    logger.error('report email failed', { reportId, err: message });
    await db
      .updateTable('content_reports')
      .set({ last_attempt_at: now, last_error: message, email_attempts: sql`email_attempts + 1` })
      .where('id', '=', reportId)
      .execute()
      .catch(() => {});
    return false;
  }
}

/** Retry reports whose email has not gone yet. Called from the proactive tick. */
export async function sweepReportEmails(db: Kysely<DB>, now: Date = new Date()): Promise<number> {
  if (!mailerOverride && !env.REPORTS_SMTP_URL) return 0;
  const due = await db
    .selectFrom('content_reports')
    .select('id')
    .where('emailed_at', 'is', null)
    .where('email_attempts', '<', MAX_ATTEMPTS)
    .where('created_at', '>=', new Date(now.getTime() - RETRY_WINDOW_MS).toISOString())
    .where((eb) =>
      eb.or([
        eb('last_attempt_at', 'is', null),
        eb('last_attempt_at', '<=', new Date(now.getTime() - RETRY_GAP_MS).toISOString()),
      ]),
    )
    .orderBy('created_at')
    .limit(20)
    .execute();
  let sent = 0;
  for (const r of due) {
    if (await sendReportEmail(db, r.id)) sent += 1;
  }
  return sent;
}

/**
 * The newest message one member posted in a chat, for `report_message`
 * ("report what Sam just said in Family"). Returns its id or null.
 */
export async function newestMessageFrom(
  db: Kysely<DB>,
  groupId: string,
  senderId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom('messages')
    .select('id')
    .where('group_id', '=', groupId)
    .where('sender_id', '=', senderId)
    .where('chord_visible', '=', 1)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.id ?? null;
}
