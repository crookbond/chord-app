/**
 * Reading the List-Unsubscribe headers (ADR 0122).
 *
 * RFC 2369 gives the addresses; RFC 8058 says which of them can be used
 * without the reader leaving for a web page. The distinction matters because
 * it decides what we are allowed to TELL the reader afterwards.
 */

export type UnsubscribeKind =
  /** RFC 8058: POST to the https URI and it is done. */
  | 'one_click'
  /** RFC 2369 mailto: we can send the request, but not confirm the outcome. */
  | 'mailto'
  /** A page for a human to finish. We can only open it. */
  | 'link';

export interface UnsubscribeOption {
  kind: UnsubscribeKind;
  /** https URL for `one_click` and `link`; the mailto address for `mailto`. */
  target: string;
  /** Present on `mailto` when the sender asked for a particular subject. */
  subject?: string;
}

const ONE_CLICK = /List-Unsubscribe\s*=\s*One-Click/i;

/** Pull the <...> entries out of a List-Unsubscribe header value. */
function entries(header: string): string[] {
  const out: string[] = [];
  const re = /<([^>]+)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) {
    const v = m[1].trim();
    if (v) out.push(v);
  }
  // Some senders omit the angle brackets the RFC requires.
  if (out.length === 0) {
    const bare = header.trim();
    if (/^(https?:|mailto:)/i.test(bare)) out.push(bare);
  }
  return out;
}

function splitMailto(uri: string): { address: string; subject?: string } | null {
  const rest = uri.slice('mailto:'.length);
  const [addr, query] = rest.split('?');
  const address = decodeURIComponent(addr).trim();
  if (!address.includes('@')) return null;
  const subject = new URLSearchParams(query ?? '').get('subject');
  return subject ? { address, subject } : { address };
}

/**
 * What the reader can be offered for this message.
 *
 * `one_click` requires BOTH headers: an https URI here and RFC 8058's
 * `List-Unsubscribe-Post` on the message. Without the second header a POST is
 * a guess about someone else's endpoint, and the honest offer is the link.
 */
export function parseUnsubscribe(
  listUnsubscribe: string | null | undefined,
  listUnsubscribePost?: string | null,
): UnsubscribeOption | null {
  if (!listUnsubscribe?.trim()) return null;

  const uris = entries(listUnsubscribe);
  const https = uris.find((u) => /^https:\/\//i.test(u));
  const http = uris.find((u) => /^http:\/\//i.test(u));
  const mailto = uris.find((u) => /^mailto:/i.test(u));

  if (https && listUnsubscribePost && ONE_CLICK.test(listUnsubscribePost)) {
    return { kind: 'one_click', target: https };
  }
  // A mailto we can actually send beats a page the reader has to finish.
  if (mailto) {
    const parsed = splitMailto(mailto);
    if (parsed) {
      return parsed.subject
        ? { kind: 'mailto', target: parsed.address, subject: parsed.subject }
        : { kind: 'mailto', target: parsed.address };
    }
  }
  const web = https ?? http;
  return web ? { kind: 'link', target: web } : null;
}
