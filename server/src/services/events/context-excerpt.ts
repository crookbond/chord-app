/**
 * ADR 0162 — a calendar event remembers what made it, not just "X is on your
 * calendar". Generalizes ADR 0158's `buildLegEventDescription` (travel legs
 * only) to every event: given an event's `sourceRawContext` provenance
 * pointer, compose a short, deterministic, server-side excerpt of the
 * email/chat message that led to it — never model-authored (ADR 0102's
 * posture: the model must never write what it cannot know).
 *
 * `gmail:<threadId>` → the thread's own subject/snippet plus a one-tap link
 * back to it (`emailThreadLinkFromProvenance`, already provider-agnostic).
 * `chat:<messageId>` → the triggering message's own text plus its sender.
 * Anything else (or the flag off) → null, and the caller leaves `description`
 * exactly as given.
 */
import type { Kysely } from 'kysely';

import { env } from '../../config/env.js';
import type { DB } from '../../db/schema.js';
import { emailThreadLinkFromProvenance } from '../email/thread-link.js';

const CHAT_EXCERPT_MAX_CHARS = 200;

const CREATED = { chat: 'From chat', email: 'From' };
const CHANGED = { chat: 'Changed from chat', email: 'Changed by email' };
type Labels = typeof CREATED;

async function buildFromEmailProvenance(
  db: Kysely<DB>,
  userId: string,
  provenance: string,
  labels: Labels,
): Promise<string | null> {
  const gmailThreadId = provenance.slice('gmail:'.length);
  const thread = await db
    .selectFrom('email_threads')
    .select(['subject', 'snippet'])
    .where('user_id', '=', userId)
    .where('gmail_thread_id', '=', gmailThreadId)
    .executeTakeFirst();
  const link = await emailThreadLinkFromProvenance(db, userId, provenance);

  const lines: string[] = [];
  if (thread?.subject) lines.push(`${labels.email}: ${thread.subject}`);
  if (thread?.snippet) lines.push(thread.snippet);
  if (link) lines.push(`${link.label}: ${link.url}`);
  return lines.length > 0 ? lines.join('\n') : null;
}

async function buildFromChatProvenance(
  db: Kysely<DB>,
  provenance: string,
  labels: Labels,
): Promise<string | null> {
  const messageId = provenance.slice('chat:'.length);
  const message = await db
    .selectFrom('messages')
    .leftJoin('users', 'users.id', 'messages.sender_id')
    .select(['messages.body as body', 'messages.created_at as createdAt', 'users.display_name as senderName'])
    .where('messages.id', '=', messageId)
    .executeTakeFirst();
  if (!message?.body?.trim()) return null;
  const excerpt =
    message.body.trim().length > CHAT_EXCERPT_MAX_CHARS
      ? `${message.body.trim().slice(0, CHAT_EXCERPT_MAX_CHARS)}…`
      : message.body.trim();
  const who = message.senderName?.trim();
  return who ? `${labels.chat}: "${excerpt}" — ${who}` : `${labels.chat}: "${excerpt}"`;
}

async function buildFromProvenance(
  db: Kysely<DB>,
  userId: string | null,
  sourceRawContext: string | null | undefined,
  labels: Labels,
): Promise<string | null> {
  if (!env.EVENT_CONTEXT_EXCERPT_ENABLED) return null;
  if (!userId || !sourceRawContext) return null;
  try {
    if (sourceRawContext.startsWith('gmail:')) {
      return await buildFromEmailProvenance(db, userId, sourceRawContext, labels);
    }
    if (sourceRawContext.startsWith('chat:')) {
      return await buildFromChatProvenance(db, sourceRawContext, labels);
    }
  } catch {
    // Best-effort — a broken excerpt must never block the event write.
    return null;
  }
  return null;
}

/**
 * Compose a context excerpt for `sourceRawContext`, or null when there's
 * nothing to say (no provenance, an unrecognized shape, the source row is
 * gone, or the feature is off).
 */
export async function buildEventContextExcerpt(
  db: Kysely<DB>,
  userId: string | null,
  sourceRawContext: string | null | undefined,
): Promise<string | null> {
  return buildFromProvenance(db, userId, sourceRawContext, CREATED);
}

/**
 * The same excerpt for an EDIT ("Changed from chat: …"), so an event moved or
 * renamed after it was made does not keep describing only how it began.
 */
export async function buildEventEditNote(
  db: Kysely<DB>,
  userId: string | null,
  sourceRawContext: string | null | undefined,
): Promise<string | null> {
  return buildFromProvenance(db, userId, sourceRawContext, CHANGED);
}

/**
 * `description` with `note` added on its own line. Unchanged when the note is
 * already there, so two edits from one message (the tool loop can call twice)
 * leave one line.
 */
export function appendEditNote(description: string | null | undefined, note: string): string {
  const current = description?.trim() ?? '';
  if (!current) return note;
  if (current.includes(note)) return current;
  return `${current}\n${note}`;
}
