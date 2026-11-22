/**
 * Plain-text renderer. Universal fallback for every surface and the
 * baseline that snapshot tests pin so future platform renderers can be
 * proven to match (or intentionally diverge from) the original
 * behavior.
 *
 * Format per card:   "Title — subtitle (meta): https://link"
 * Falls back to omitting any missing part. Returns null for a card
 * that carries no useful text at all.
 *
 * Historical note: this code originally lived at
 * `server/src/services/bot/card-text.ts`. It was lifted into the
 * renderers/ folder in Commit A of the multi-surface refactor; the old
 * module is preserved as a thin re-export to avoid a coordinated import
 * rewrite in the same change.
 */
import type { BotCard } from '@chord/kernel';

import type { RenderInput, RenderedMessage } from './types';

export function formatCardLine(c: BotCard): string | null {
  const parts: string[] = [];
  if (c.title) parts.push(c.title);
  if (c.subtitle) parts.push(`— ${c.subtitle}`);
  if (c.meta) parts.push(`(${c.meta})`);
  const head = parts.join(' ').trim();
  if (c.url) return head ? `${head}: ${c.url}` : c.url;
  return head || null;
}

export function appendCardLines(body: string, cards: BotCard[]): string {
  if (cards.length === 0) return body;
  const lines = cards
    .map(formatCardLine)
    .filter((s): s is string => !!s);
  if (lines.length === 0) return body;
  return body ? `${body}\n\n${lines.join('\n')}` : lines.join('\n');
}

export function renderPlain(input: RenderInput): RenderedMessage {
  const prefixed = input.senderName
    ? input.body
      ? `${input.senderName}: ${input.body}`
      : `${input.senderName}:`
    : input.body;
  return { text: appendCardLines(prefixed, input.cards) };
}
