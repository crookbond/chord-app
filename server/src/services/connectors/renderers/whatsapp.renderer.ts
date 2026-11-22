/**
 * WhatsApp renderer (ADR 0053 §7).
 *
 * When the bot's reply carries **callback** action cards (proposals: confirm /
 * reject), emit a `quickReply` slot the connector sends via the Twilio Content
 * API (`twilio/quick-reply`). The button `id` is the same `verb:id` payload
 * Telegram puts in `callback_data`, echoed back as `ButtonPayload` on tap — so
 * the inbound tap routes through the shared callback handler.
 *
 * ADR 0139 — a turn carrying exactly ONE url and no callbacks becomes a
 * `cta_url` button instead. Meta takes that as an ordinary in-session service
 * message, no template. Two rules follow from `cta_url` permitting a single
 * button: callbacks win when both are present (a confirm/reject is only doable
 * as a button, while a URL survives as a tappable link in the text either
 * way), and two or more URLs stay as text rather than promoting one and
 * dropping the rest.
 *
 * Everything else (prose, non-callback cards, several URL cards) falls back to
 * plain text — WhatsApp auto-linkifies bare URLs, so a URL card stays tappable
 * without buttons. Quick-reply degrades to text too when there are 0 callback
 * buttons or more than 3 (the in-session cap); a proposal that lost its
 * buttons that way gets a "Reply YES … or NO" line instead, which
 * `connectors/reply-answer.ts` honours.
 *
 * Cards carry the app's "tap to confirm" hint; it is dropped here, because
 * what the reader does on WhatsApp is press a button or type a reply.
 */
import type { BotCard } from '@chord/kernel';

import { formatCardLine, renderPlain } from './plain.renderer';
import { cardWithoutTapHint, proposalIdsIn, replyInstruction } from './proposal-answer';
import { WHATSAPP_LIMIT, clipForPlatform } from './truncate';
import type { RenderInput, RenderedMessage } from './types';

/** WhatsApp quick-reply button title cap (WhatsApp truncates beyond ~20). */
const TITLE_MAX = 20;
/** Max quick-reply buttons sendable in-session without an approved template. */
const QUICK_REPLY_MAX = 3;
/** WhatsApp's cap on an interactive message's body — lower than a plain one. */
const INTERACTIVE_BODY_MAX = 1024;

export function renderWhatsApp(raw: RenderInput): RenderedMessage {
  const input = { ...raw, cards: raw.cards.map(cardWithoutTapHint) };
  const rendered = renderPlain(input);
  // Twilio rejects a body over 1600 outright (error 21617) rather than
  // truncating, so a long briefing is not a degraded send — it is no send.
  // Meta allows 4096; the connector says which transport it is (ADR 0140).
  const limit = input.textLimit ?? WHATSAPP_LIMIT;
  const plain = {
    ...rendered,
    text: clipForPlatform(rendered.text, limit, input.moreUrl),
  };
  const buttons = collectCallbackButtons(input.cards);

  if (buttons.length === 0) {
    const link = soleUrlTarget(input.cards);
    if (!link) return plain;
    return {
      // `text` keeps the appended URL lines on purpose: the Twilio connector
      // reads only `quickReply`, so it lands here — and stripping the URL
      // would lose the link entirely on that path.
      text: plain.text,
      whatsapp: {
        ctaUrl: {
          body: interactiveBody(input, 'Open the link below:'),
          displayText: clip(link.label),
          url: link.url,
        },
      },
    };
  }

  if (buttons.length > QUICK_REPLY_MAX) {
    // Too many for in-session → plain text. URL action cards already surface
    // as bare, tappable links in `plain.text`. A proposal still needs an
    // answer, so say how to give one — and keep that line out of the clip.
    const proposals = proposalIdsIn(input.cards).length;
    if (proposals === 0) return plain;
    const line = replyInstruction(proposals);
    return {
      text: `${clipForPlatform(rendered.text, limit - line.length - 2, input.moreUrl)}\n\n${line}`,
    };
  }

  return {
    text: plain.text,
    whatsapp: {
      quickReply: {
        body: interactiveBody(input, 'Please choose:', { withCards: true }),
        buttons,
      },
    },
  };
}

/**
 * The body shown above an interactive message's buttons.
 *
 * Meta and Twilio both reject an empty body, so a card-only turn with no prose
 * falls back to `ifEmpty`. An interactive body has a tighter cap than a plain
 * one, so it gets its own clip.
 *
 * `withCards` keeps what a proposal card says (the draft, the chat being left)
 * above its buttons — without it the reader is asked to confirm something they
 * cannot see. A bare action card is skipped: its title is already its button.
 */
function interactiveBody(
  input: RenderInput,
  ifEmpty: string,
  opts: { withCards?: boolean } = {},
): string {
  const prefixed = input.senderName
    ? input.body
      ? `${input.senderName}: ${input.body}`
      : `${input.senderName}:`
    : input.body;
  const lines = opts.withCards
    ? input.cards
        .filter((c) => !isBareButtonCard(c))
        .map(formatCardLine)
        .filter((s): s is string => !!s)
    : [];
  const text = [prefixed?.trim(), lines.join('\n')].filter(Boolean).join('\n\n');
  return clipForPlatform(text || ifEmpty, INTERACTIVE_BODY_MAX, input.moreUrl);
}

function isBareButtonCard(c: BotCard): boolean {
  return c.kind === 'action' && !c.subtitle && !c.meta && !c.url;
}

/**
 * The one link in this turn, or null when there is not exactly one.
 *
 * `cta_url` carries a single button, so promoting one of several URLs would
 * silently drop the others — worse than leaving them all as text, where
 * WhatsApp linkifies every one. Button URLs count too: nothing emits them
 * today, but the card type allows them and a future producer should not lose
 * its link to a rule that only looked at `card.url`.
 */
function soleUrlTarget(cards: BotCard[]): { label: string; url: string } | null {
  const found: { label: string; url: string }[] = [];
  for (const c of cards) {
    if (c.url) found.push({ label: c.title || c.subtitle || 'Open', url: c.url });
    for (const b of c.buttons ?? []) {
      if (b.url) found.push({ label: b.label, url: b.url });
    }
    if (found.length > 1) return null;
  }
  return found.length === 1 ? found[0] : null;
}

/**
 * Flatten cards' callback buttons into quick-reply buttons, preserving the
 * `verb:id` payload encoding the callback handler expects. Any card kind may
 * carry them — a proposed email is an `email` card with Send / Cancel. Only
 * **callback** buttons become quick-replies; URL buttons can't be
 * quick-replies (they'd need the CTA content type) and stay in the plain-text
 * fallback.
 */
function collectCallbackButtons(
  cards: BotCard[],
): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  for (const c of cards) {
    if (c.buttons && c.buttons.length > 0) {
      for (const b of c.buttons) {
        if (b.callback) {
          out.push({ id: encode(b.callback), title: clip(b.label) });
        }
      }
    } else if (c.callback) {
      out.push({ id: encode(c.callback), title: clip(c.title || c.subtitle || 'OK') });
    }
  }
  return out;
}

function encode(cb: { verb: string; id: string }): string {
  return `${cb.verb}:${cb.id}`;
}

function clip(s: string): string {
  const t = s.trim();
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}
