/**
 * Who may be auto-replied to (ADR 0124).
 *
 * RFC 3834 is mostly a list of things an auto-responder must NOT answer,
 * because every one of them is a way to start a loop or to spray a mailing
 * list with "I'm on holiday". The rules live here, tested, rather than inside
 * the sync pass that calls them.
 */

export interface AutoReplyCandidate {
  fromEmail: string | null;
  /** Everyone the message was addressed to, so we can tell mail TO us from
   *  mail that merely reached us. */
  toEmails?: string[];
  ccEmails?: string[];
  subject?: string | null;
  /** Raw header values, when the provider gave them to us. */
  listUnsubscribe?: string | null;
  autoSubmitted?: string | null;
  precedence?: string | null;
  /** ADR 0109's derived signal, which already folds several of these in. */
  bulk?: boolean;
}

export type AutoReplySkip =
  | 'no_sender'
  | 'self'
  | 'bulk'
  | 'auto_submitted'
  | 'no_reply_address'
  | 'not_addressed_to_me'
  | 'already_replied';

/** A sender no human reads, so a reply is noise at best. */
const NO_REPLY = /(^|[.\-_])(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounce)/i;

/** An address no human reads (`noreply@`, `mailer-daemon@`, ...). */
export function isNoReplyAddress(address: string): boolean {
  const a = address.trim().toLowerCase();
  return NO_REPLY.test(a.split('@')[0] ?? '') || NO_REPLY.test(a);
}

/**
 * Should we send a vacation reply to this message?
 *
 * Returns the reason for refusing rather than a bare false: the caller logs
 * it, and "why did nobody get my auto-reply" is otherwise unanswerable.
 */
export function autoReplySkipReason(
  msg: AutoReplyCandidate,
  ctx: { myEmails: string[]; repliedSenders: Set<string> },
): AutoReplySkip | null {
  const from = (msg.fromEmail ?? '').trim().toLowerCase();
  if (!from || !from.includes('@')) return 'no_sender';

  const mine = ctx.myEmails.map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (mine.includes(from)) return 'self';

  // RFC 3834 §2: never respond to anything already automatic. Only an explicit
  // "no" clears it; the header's absence is the normal case for human mail.
  const auto = (msg.autoSubmitted ?? '').trim().toLowerCase();
  if (auto && auto !== 'no') return 'auto_submitted';

  const prec = (msg.precedence ?? '').trim().toLowerCase();
  if (prec === 'bulk' || prec === 'list' || prec === 'junk') return 'bulk';

  if (msg.bulk || msg.listUnsubscribe?.trim()) return 'bulk';

  if (isNoReplyAddress(from)) return 'no_reply_address';

  // Mail that arrived via a list or a bcc was not addressed to us, and
  // answering it tells a room full of strangers about our holiday.
  const addressed = [...(msg.toEmails ?? []), ...(msg.ccEmails ?? [])].map((e) =>
    e.trim().toLowerCase(),
  );
  if (addressed.length > 0 && !addressed.some((e) => mine.includes(e))) {
    return 'not_addressed_to_me';
  }

  // RFC 3834 §2: at most one response per sender per vacation period.
  if (ctx.repliedSenders.has(from)) return 'already_replied';

  return null;
}

/** Is the responder on right now? Absent dates mean "until turned off". */
export function vacationActive(
  v: { enabled: boolean; startsAt?: string | null; endsAt?: string | null },
  nowIso: string,
): boolean {
  if (!v.enabled) return false;
  const now = Date.parse(nowIso);
  if (v.startsAt && Date.parse(v.startsAt) > now) return false;
  if (v.endsAt && Date.parse(v.endsAt) < now) return false;
  return true;
}

/** "Re: " exactly once, however many the sender already stacked up. */
export function autoReplySubject(original: string | null | undefined): string {
  const base = (original ?? '').replace(/^(\s*(re|fwd?)\s*:\s*)+/i, '').trim();
  return base ? `Re: ${base}` : 'Re: your message';
}
