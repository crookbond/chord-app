/**
 * The quoted original under a forward (ADR 0112 and its addendum).
 *
 * One builder for both ends: the server quotes the message with it when it
 * sends, and the forward preview the composer shows is the same output, so
 * what the sender sees under their note is what goes.
 */

export const FORWARD_MARKER = '---------- Forwarded message ----------';

export interface ForwardOriginal {
  fromName: string | null;
  fromEmail: string | null;
  /** Already formatted for a reader (`forwardDateLabel`). */
  date: string;
  subject: string;
  to: string[];
  body: string | null;
}

/** The header block, marker first, in the shape every mail client uses. */
export function forwardHeaderLines(o: ForwardOriginal): string[] {
  const from = o.fromName
    ? `${o.fromName} <${o.fromEmail ?? ''}>`
    : o.fromEmail ?? '(unknown sender)';
  return [
    FORWARD_MARKER,
    `From: ${from}`,
    `Date: ${o.date}`,
    `Subject: ${o.subject}`,
    ...(o.to.length ? [`To: ${o.to.join(', ')}`] : []),
  ];
}

/** The quoted original alone: header, blank line, body. */
export function forwardQuote(o: ForwardOriginal): string {
  return `${forwardHeaderLines(o).join('\n')}\n\n${o.body ?? ''}`;
}

/** The whole forward body: the sender's note (if any) above the quote. */
export function buildForwardBody(note: string | undefined, o: ForwardOriginal): string {
  const quoted = forwardQuote(o);
  return note?.trim() ? `${note.trim()}\n\n${quoted}` : quoted;
}

/**
 * "Tue, Oct 27, 2026 at 10:03 AM" in the forwarder's zone. The stored date is
 * an ISO instant, which is unreadable in a quoted header. An unparseable value
 * is returned as stored; an unknown zone falls back to UTC.
 */
export function forwardDateLabel(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  };
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', { ...opts, timeZone }).formatToParts(d);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).formatToParts(d);
  }
  const p = (t: Intl.DateTimeFormatPartTypes) => parts.find((x) => x.type === t)?.value ?? '';
  return `${p('weekday')}, ${p('month')} ${p('day')}, ${p('year')} at ${p('hour')}:${p('minute')} ${p('dayPeriod')}`;
}
