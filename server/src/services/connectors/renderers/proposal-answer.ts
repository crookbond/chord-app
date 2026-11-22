/**
 * How a chat-app reader answers a proposal card.
 *
 * Cards are written for the Chord app, where "tap to confirm" is true. On
 * WhatsApp and Telegram the answer is a button the renderer adds — or, when
 * WhatsApp cannot carry the buttons, a typed YES / NO
 * (`connectors/reply-answer.ts`). Either way the app's tap hint is wrong
 * there, so the IM renderers drop it and say what actually works.
 */
import type { BotCard } from '@chord/kernel';

/** `"Soccer · tap to confirm"` → `"Soccer"`; a hint-only meta → undefined. */
export function withoutTapHint(meta: string | undefined): string | undefined {
  if (!meta) return meta;
  const kept = meta
    .split(' · ')
    .filter((part) => !/^\s*tap\b/i.test(part));
  const joined = kept.join(' · ').trim();
  return joined || undefined;
}

export function cardWithoutTapHint(c: BotCard): BotCard {
  return c.meta ? { ...c, meta: withoutTapHint(c.meta) } : c;
}

/** Distinct proposals these cards ask the reader to confirm. */
export function proposalIdsIn(cards: BotCard[]): string[] {
  const ids = new Set<string>();
  for (const c of cards) {
    if (c.callback?.verb === 'p+') ids.add(c.callback.id);
    for (const b of c.buttons ?? []) {
      if (b.callback?.verb === 'p+') ids.add(b.callback.id);
    }
  }
  return [...ids];
}

/** The line that replaces buttons WhatsApp could not send. */
export function replyInstruction(proposalCount: number): string {
  return proposalCount > 1
    ? 'Reply YES to confirm all of these, or NO to cancel them.'
    : 'Reply YES to confirm, or NO to cancel.';
}
