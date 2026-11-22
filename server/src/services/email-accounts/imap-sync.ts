/**
 * Pure IMAP helpers (ADR 0080) — no sockets, unit-testable. IMAP has no
 * server-side thread ids, so threads are derived from the References /
 * In-Reply-To chain root, falling back to a normalized subject + counterpart.
 * Native message ids are `u<uid>` (stable within a UIDVALIDITY generation).
 */

/** First message-id token in a raw References header. */
export function firstReference(references: string | null | undefined): string | null {
  if (!references) return null;
  const m = references.match(/<[^>]+>/);
  return m ? m[0] : null;
}

/** Strip Re:/Fwd: prefixes + collapse whitespace, lowercased. */
export function normalizeSubject(subject: string | null | undefined): string {
  return (subject ?? '')
    .replace(/^\s*((re|fwd?|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export interface ImapThreadKeyInput {
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  subject: string | null;
  fromEmail: string | null;
}

/**
 * Provider-native thread key. Chain-rooted when any threading header exists
 * (the root's own Message-ID equals its replies' References[0]); otherwise a
 * normalized-subject bucket so subjectless chains still group predictably.
 */
export function imapThreadNativeId(msg: ImapThreadKeyInput): string {
  const root = firstReference(msg.references) ?? msg.inReplyTo ?? msg.messageId;
  if (root) return `ref:${root}`;
  const subj = normalizeSubject(msg.subject);
  return `subj:${subj || msg.fromEmail || 'unknown'}`;
}

/** `u<uid>` — the stored native message id for an INBOX message. */
export function imapNativeMessageId(uid: number): string {
  return `u${uid}`;
}

/** `s<uid>` — a Sent-mailbox message. UIDs are numbered per mailbox, so Sent
 *  UID 7 and INBOX UID 7 are different messages and need different keys. */
export function imapSentNativeMessageId(uid: number): string {
  return `s${uid}`;
}

/** Cursor version since Sent got its own key; older cursors heal on next sync. */
export const IMAP_KEY_VERSION = 2;

/** Recover the INBOX UID from a stored native message id; null for Sent
 *  messages and synthesized ids. */
export function uidFromNativeMessageId(native: string): number | null {
  const m = native.match(/^u(\d+)$/);
  return m ? Number(m[1]) : null;
}

/** The mailboxes a mirrored IMAP message can live in; UIDs are per mailbox. */
export type ImapFolder = 'inbox' | 'sent';

/** Which mailbox a stored native id belongs to, and its UID there. */
export function imapLocationFromNativeMessageId(
  native: string,
): { folder: ImapFolder; uid: number } | null {
  const m = native.match(/^([us])(\d+)$/);
  if (!m) return null;
  return { folder: m[1] === 's' ? 'sent' : 'inbox', uid: Number(m[2]) };
}

/** IMAP flags → the synthesized label set the shared mirror understands. */
export function imapFlagsToLabels(flags: string[], opts: { inInbox?: boolean } = {}): string[] {
  const labels: string[] = [];
  if (opts.inInbox !== false) labels.push('INBOX');
  if (!flags.includes('\\Seen')) labels.push('UNREAD');
  return labels;
}

export interface ImapSyncCursor {
  uidValidity: string;
  lastUid: number;
  /** The Sent mailbox's own position (ADR 0116). UIDs are per-mailbox, so
   *  Sent cannot share the inbox's — it needs its own validity and high-water
   *  mark. Absent on a cursor written before that ADR. */
  sentUidValidity?: string;
  sentLastUid?: number;
  /** IMAP_KEY_VERSION the mirror was written under; absent = Sent keyed `u`. */
  keys?: number;
}

export function parseImapCursor(raw: string | null): ImapSyncCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ImapSyncCursor>;
    if (typeof parsed.uidValidity === 'string' && typeof parsed.lastUid === 'number') {
      return {
        uidValidity: parsed.uidValidity,
        lastUid: parsed.lastUid,
        // Absent on a cursor written before ADR 0116: the Sent stream simply
        // starts from scratch on the next tick, which is what we want.
        sentUidValidity: typeof parsed.sentUidValidity === 'string' ? parsed.sentUidValidity : undefined,
        sentLastUid: typeof parsed.sentLastUid === 'number' ? parsed.sentLastUid : undefined,
        keys: typeof parsed.keys === 'number' ? parsed.keys : undefined,
      };
    }
  } catch {
    /* corrupt cursor → treat as never-synced */
  }
  return null;
}
