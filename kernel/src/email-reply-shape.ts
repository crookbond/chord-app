/**
 * What the email being answered asks for, read by a parser (ADR 0337): its
 * separate points, and whether it is about a time. Used to choose the chips
 * that change a drafted reply, and to let a "point by point" reply answer
 * each point in order. No model call.
 */
import { splitQuotedHtml, splitQuotedText } from './email-quote';
import { decodeHtmlEntities } from './html-entities';
import type { EmailMessage } from './types/email';

const MAX_POINTS = 10;
const POINT_MAX_CHARS = 200;

/** Questions that are manners, not something to answer. */
const PLEASANTRY = /^(?:how are (?:you|things)|how have you been|how(?:'s| is) it going|how was your (?:weekend|week|trip)|hope (?:you|all|this|that))/i;

const LIST_ITEM = /^\s*(?:\d{1,2}[.)]|\(?[a-z]\)|[-*•●▪])\s+(.+)$/i;

/** Plain text from an email body, good enough to find its questions. */
export function replyShapeText(html: string | null | undefined, text: string | null | undefined): string {
  if (text && text.trim()) return text;
  if (!html) return '';
  const plain = html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeHtmlEntities(plain).replace(/[ \t\xa0]+/g, ' ');
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > POINT_MAX_CHARS ? `${t.slice(0, POINT_MAX_CHARS - 1)}…` : t;
}

/**
 * The separate things a message asks or lists, in the order written: its
 * numbered or bulleted items when it has two or more, otherwise its real
 * questions (a "How are you?" is not one). Quoted history must already be
 * removed by the caller.
 */
export function emailReplyPoints(visibleText: string): string[] {
  const lines = visibleText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('>'));
  // A signature is not part of what is asked.
  const sigAt = lines.findIndex((l) => l === '--' || l === '-- ');
  const body = sigAt >= 0 ? lines.slice(0, sigAt) : lines;

  const items = body
    .map((l) => LIST_ITEM.exec(l)?.[1]?.trim() ?? '')
    .filter((s) => s.split(/\s+/).length >= 2);
  if (items.length >= 2) return items.slice(0, MAX_POINTS).map(clip);

  const seen = new Set<string>();
  const questions: string[] = [];
  const sentences = body.join(' ').match(/[^.?!]+[?]+/g) ?? [];
  for (const raw of sentences) {
    const q = raw.trim();
    if (q.split(/\s+/).length < 3 || PLEASANTRY.test(q)) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    questions.push(clip(q));
    if (questions.length === MAX_POINTS) break;
  }
  return questions;
}

const TIME_WORDS =
  /\b(?:schedule|reschedul\w*|availability|available|free (?:on|at|to|this|next)|what time|which time|when (?:works|would|are you|can|is good|is best)|works for you|time(?:s)? that work|meet(?:ing)?|call|catch up|get together|calendar|slot)\b/i;

/** Whether the text is about finding or settling a time. */
export function asksAboutTime(text: string): boolean {
  return TIME_WORDS.test(text);
}

/** Whether an instruction asks for each point to be answered in turn. */
export function wantsPointByPoint(instruction: string): boolean {
  return /\b(?:point[- ]by[- ]point|each (?:of (?:their|the|his|her) )?(?:point|question|item)s?|one by one|in order|inline)\b/i.test(
    instruction,
  );
}

/** The message a reply answers: the newest one not sent by the mailbox. */
export function messageBeingAnswered(messages: EmailMessage[]): EmailMessage | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (!messages[i].sent) return messages[i];
  }
  return messages[messages.length - 1] ?? null;
}

/** How many points the message being answered makes, and whether it is about a time. */
export function replyShapeOf(
  messages: EmailMessage[],
  subject = '',
): { points: number; aboutTime: boolean } {
  const m = messageBeingAnswered(messages);
  if (!m) return { points: 0, aboutTime: false };
  // An HTML-only message drops its quote container before it becomes text.
  const html = m.bodyText?.trim() ? null : splitQuotedHtml(m.bodyHtml).visible || m.bodyHtml;
  const full = replyShapeText(html, m.bodyText) || m.snippet || '';
  const visible = splitQuotedText(full).visible || full;
  return {
    points: emailReplyPoints(visible).length,
    aboutTime: asksAboutTime(`${subject}\n${visible}`),
  };
}

export interface ReviseAsk {
  label: string;
  ask: string;
}

export const POINT_BY_POINT_ASK: ReviseAsk = {
  label: 'Point by point',
  ask: 'Reply point by point, answering each of their points in order',
};
export const SUGGEST_TIMES_ASK: ReviseAsk = { label: 'Suggest times', ask: 'Add 2–3 times I am free' };

const STYLE_ASKS: ReviseAsk[] = [
  { label: 'Shorter', ask: 'Make it shorter' },
  { label: 'Longer', ask: 'Make it longer and more complete' },
  { label: 'Warmer', ask: 'Make it warmer' },
  { label: 'More formal', ask: 'Make it more formal' },
];

/**
 * The chips that change a drafted reply: the ones that fit this email
 * first (point by point when it asks two or more things, suggest times when
 * it is about a time), then the style changes every draft can take.
 */
export function reviseReplyAsks(shape: { points: number; aboutTime: boolean }): ReviseAsk[] {
  return [
    ...(shape.points >= 2 ? [POINT_BY_POINT_ASK] : []),
    ...(shape.aboutTime ? [SUGGEST_TIMES_ASK] : []),
    ...STYLE_ASKS,
  ];
}
