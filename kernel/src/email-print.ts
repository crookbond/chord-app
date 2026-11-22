/**
 * Rendering a thread for print and for share (ADR 0121).
 *
 * The html builder takes bodies that are ALREADY sanitized - it does no
 * escaping of them and cannot, since its whole job is to pass markup through.
 * Every caller must hand it the sanitizer's output, never a raw email body.
 */

export interface PrintableMessage {
  from: string;
  dateLabel: string;
  to?: string[];
  cc?: string[];
  /** Sanitized html, or null to fall back to `text`. */
  sanitizedHtml?: string | null;
  text?: string | null;
}

export interface PrintableThread {
  subject: string;
  messages: PrintableMessage[];
}

/** Escapes text that is about to sit inside markup. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const PRINT_CSS = `
  body { font-family: -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
         font-size: 12pt; color: #111; margin: 24px; }
  h1 { font-size: 16pt; margin: 0 0 16px; }
  .msg { border-top: 1px solid #ccc; padding-top: 10px; margin-top: 16px; }
  .from { font-weight: 600; }
  .meta { color: #555; font-size: 10pt; margin-bottom: 8px; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  pre { white-space: pre-wrap; font-family: inherit; }
  @media print { .msg { break-inside: avoid-page; } }
`;

function metaLine(m: PrintableMessage): string {
  const parts: string[] = [m.dateLabel];
  if (m.to?.length) parts.push(`To: ${m.to.join(', ')}`);
  if (m.cc?.length) parts.push(`Cc: ${m.cc.join(', ')}`);
  return escapeHtml(parts.join('  ·  '));
}

/**
 * A standalone document for the browser's print dialog. Nothing here loads
 * from the network, so printing cannot become the request that image blocking
 * just prevented: the caller passes the same sanitized html it is displaying.
 */
export function printableThreadHtml(thread: PrintableThread): string {
  const body = thread.messages
    .map((m) => {
      const content =
        m.sanitizedHtml && m.sanitizedHtml.trim().length > 0
          ? m.sanitizedHtml
          : `<pre>${escapeHtml(m.text ?? '')}</pre>`;
      return (
        '<div class="msg">' +
        `<div class="from">${escapeHtml(m.from)}</div>` +
        `<div class="meta">${metaLine(m)}</div>` +
        content +
        '</div>'
      );
    })
    .join('\n');

  return (
    '<!DOCTYPE html><html><head><meta charset="utf-8"/>' +
    `<title>${escapeHtml(thread.subject || '(no subject)')}</title>` +
    `<style>${PRINT_CSS}</style></head><body>` +
    `<h1>${escapeHtml(thread.subject || '(no subject)')}</h1>` +
    body +
    '</body></html>'
  );
}

/** The same thread as text, for a share sheet that takes no markup. */
export function threadToPlainText(thread: PrintableThread): string {
  const head = thread.subject || '(no subject)';
  const parts = thread.messages.map((m) => {
    const lines = [`${m.from}  ${m.dateLabel}`];
    if (m.to?.length) lines.push(`To: ${m.to.join(', ')}`);
    if (m.cc?.length) lines.push(`Cc: ${m.cc.join(', ')}`);
    lines.push('', (m.text ?? '').trim());
    return lines.join('\n').trim();
  });
  return [head, '', parts.join('\n\n----\n\n')].join('\n').trim();
}
