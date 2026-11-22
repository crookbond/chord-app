/**
 * Formatting a message someone wrote (ADR 0131).
 *
 * A deliberately small markdown subset, because the alternative to "small" is
 * not "richer" but "wrong": every marker added is a character that also occurs
 * in ordinary prose, and mangling what someone typed is worse than not
 * formatting it.
 *
 * The plain-text part of the message keeps the markers as typed, which is the
 * point of markdown — it reads fine unrendered.
 */

const SAFE_LINK = /^(https?:|mailto:)/i;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Bare URLs, so a pasted link is clickable without anyone typing brackets. */
function autolink(s: string): string {
  return s.replace(/(^|[\s(])(https?:\/\/[^\s<>"')]+)/gi, (_m, lead: string, url: string) => {
    return `${lead}<a href="${url}">${url}</a>`;
  });
}

/**
 * `[text](url)`, but only for schemes a mail client should follow.
 *
 * An unsafe scheme keeps its literal text rather than becoming a link: a
 * `javascript:` href in outgoing mail is something we would be authoring, not
 * merely relaying.
 */
function links(s: string): string {
  return s.replace(
    /\[([^\]\n]+)\]\(([^)\s]+)\)/g,
    (whole, text: string, url: string) => (SAFE_LINK.test(url) ? `<a href="${url}">${text}</a>` : whole),
  );
}

/**
 * Bold only, and only with a doubled marker.
 *
 * Single-`*` italics are deliberately absent: `*` turns up in prose, in maths
 * and in footnotes, so it produces false positives on text nobody meant as
 * formatting. `**` does not occur by accident.
 */
function bold(s: string): string {
  return s.replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, '<strong>$1</strong>');
}

interface Block {
  kind: 'ul' | 'ol' | 'p';
  lines: string[];
}

/** Group consecutive list lines so a run of bullets becomes one list. */
function blocks(lines: string[]): Block[] {
  const out: Block[] = [];
  for (const line of lines) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const kind: Block['kind'] = bullet ? 'ul' : numbered ? 'ol' : 'p';
    const text = bullet?.[1] ?? numbered?.[1] ?? line;
    const last = out[out.length - 1];
    if (last && last.kind === kind && kind !== 'p') last.lines.push(text);
    else out.push({ kind, lines: [text] });
  }
  return out;
}

/**
 * Render a user-authored body to the html half of the message.
 *
 * Escaping happens FIRST, so markup someone typed stays text and only our own
 * markers become tags.
 */
export function markdownToHtml(text: string): string {
  // `links` before `autolink`: otherwise the bare-url pass consumes the url
  // inside `[text](url)` and leaves the brackets stranded around it. Once the
  // anchors exist, their hrefs are preceded by a quote rather than whitespace,
  // so the autolinker cannot match them again.
  const inline = (s: string) => bold(autolink(links(escapeHtml(s))));

  const html = blocks(text.split(/\r?\n/))
    .map((b) => {
      if (b.kind === 'p') {
        return b.lines.map((l) => (l.trim() === '' ? '<br>' : `<div>${inline(l)}</div>`)).join('');
      }
      const items = b.lines.map((l) => `<li>${inline(l)}</li>`).join('');
      return `<${b.kind}>${items}</${b.kind}>`;
    })
    .join('');

  return `<div>${html}</div>`;
}

/** Does this body use any formatting at all? Lets a caller skip the work. */
export function hasMarkdown(text: string): boolean {
  return /\*\*\S|\[[^\]\n]+\]\((https?:|mailto:)|^\s*([-*]|\d+[.)])\s+/im.test(text);
}
