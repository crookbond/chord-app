/**
 * Telegram renderer — HTML body + inline-keyboard buttons for action
 * cards.
 *
 * Design choices:
 *   - `parse_mode: 'HTML'` gives bold/italic/link without the escape-
 *     storm of MarkdownV2 (MarkdownV2 requires escaping `_*[]()~`#+-=|{}.!`
 *     literally everywhere, including inside titles, which is brittle).
 *   - Action cards (kind === 'action') with a URL become inline-keyboard
 *     buttons under the message. These read as tappable native UI
 *     instead of a raw URL the user has to long-press.
 *   - Non-action cards (save / task / event / list / trip) get HTML
 *     lines appended to the body, similar to the plain renderer but
 *     with the title in <b> and the URL wrapped in <a href>.
 *   - `disable_web_page_preview` is always true: Telegram's auto-
 *     fetched link preview cards are visually noisy and often duplicate
 *     an action card we've already attached as a button.
 *   - The `text` slot still carries the assistant prose + non-action
 *     card lines in HTML form. Telegram requires a non-empty text
 *     field even when using `reply_markup`.
 *
 * Fallback: if there's no card content at all, this renderer produces
 * the same `text` as plain (just the body), no `telegram` slot — the
 * connector will skip the HTML parse_mode and ship plain text.
 */
import type { BotCard } from '@chord/kernel';

import type { TgInlineKeyboardMarkup } from '../telegram/telegram.api';

import { cardWithoutTapHint } from './proposal-answer';
import { TELEGRAM_LIMIT, clipForPlatform } from './truncate';
import type { RenderInput, RenderedMessage } from './types';

export interface TelegramRender {
  /** HTML-safe text for the message body, ready to ship with parse_mode='HTML'. */
  html: string;
  /** Inline-keyboard markup. Omitted when there are no action cards. */
  replyMarkup?: TgInlineKeyboardMarkup;
  /** Whether to suppress the auto-link preview. */
  disableWebPagePreview: boolean;
}

export interface TelegramRenderedMessage extends RenderedMessage {
  telegram: TelegramRender;
}

export function renderTelegram(input: RenderInput): TelegramRenderedMessage {
  const { body, senderName } = input;
  // The app's "tap to confirm" hint describes the app; here the button is
  // right under the message, so the hint is noise.
  const cards = input.cards.map(cardWithoutTapHint);
  // Telegram bot API can only post as the bot. Prefix the human sender's
  // name so users on the TG side can tell who actually spoke. Bold via
  // <b> works under parse_mode='HTML' without escape gymnastics.
  const namePrefixHtml = senderName ? `<b>${escapeHtml(senderName)}:</b> ` : '';
  const namePrefixText = senderName ? `${senderName}: ` : '';
  // Action cards can be URL buttons (legacy `suggest_external_action`),
  // callback buttons, or multi-button rows (ADR 0029). A card without
  // any actionable button is dropped. Any other card that carries buttons (a
  // proposed email's Send / Cancel) keeps its text line AND gets a row.
  const action = cards.filter(
    (c) =>
      (c.buttons && c.buttons.length > 0) ||
      (c.kind === 'action' && (c.url || c.callback)),
  );
  // A proposed "Leave Soccer" is an action card whose buttons say only
  // Confirm / Cancel, so it needs its text too; a bare one ("✓ Costco list")
  // is already its own button label.
  const inline = cards.filter(
    (c) => c.kind !== 'action' || (!!c.buttons?.length && !!(c.subtitle || c.meta)),
  );

  const bodyHtml = body ? `${namePrefixHtml}${escapeHtml(body)}` : namePrefixHtml.trim();
  const bodyText = body ? `${namePrefixText}${body}` : namePrefixText.trim();

  const lines: string[] = [];
  if (bodyHtml) lines.push(bodyHtml);
  for (const c of inline) {
    const line = formatInlineHtmlLine(c);
    if (line) lines.push(line);
  }
  // Inline cards are joined with a blank line *after* the prose, then
  // one line each — mirrors the plain renderer's spacing but with HTML
  // marks. When there's no prose, the first card sits flush at the top.
  const html =
    lines.length === 0
      ? ''
      : bodyHtml
        ? [bodyHtml, inline.map(formatInlineHtmlLine).filter(Boolean).join('\n')]
            .filter(Boolean)
            .join('\n\n')
        : inline
            .map(formatInlineHtmlLine)
            .filter((s): s is string => !!s)
            .join('\n');

  // Plain-text fallback for the `text` slot. We rebuild it from the
  // same card list so a Telegram client that fails to parse HTML still
  // sees readable text. (We can't simply re-use the plain renderer
  // because action cards have moved to buttons here.)
  const fallback =
    bodyText && inline.length === 0
      ? bodyText
      : bodyText
        ? `${bodyText}\n\n${inline.map(formatInlinePlainLine).filter(Boolean).join('\n')}`
        : inline.map(formatInlinePlainLine).filter(Boolean).join('\n');

  const replyMarkup: TgInlineKeyboardMarkup | undefined =
    action.length > 0
      ? {
          inline_keyboard: action.map((c) => {
            // Multi-button row (e.g. proposal confirm + reject). One
            // inline_keyboard row, N buttons in it.
            if (c.buttons && c.buttons.length > 0) {
              return c.buttons.map((b) => {
                if (b.callback) {
                  return {
                    text: b.label,
                    callback_data: `${b.callback.verb}:${b.callback.id}`,
                  };
                }
                return { text: b.label, url: b.url! };
              });
            }
            // Single-button card (legacy + signup URL).
            if (c.callback) {
              return [
                {
                  text: buttonLabel(c),
                  callback_data: `${c.callback.verb}:${c.callback.id}`,
                },
              ];
            }
            return [{ text: buttonLabel(c), url: c.url! }];
          }),
        }
      : undefined;

  // Never let Telegram render its auto web-page preview cards — they're
  // visually noisy and often duplicate an action card we've already
  // attached as a button.
  const disableWebPagePreview = true;

  // Telegram requires `text` to be non-empty even when reply_markup is
  // set. When the renderer would otherwise emit nothing (action-card-
  // only turn with no prose), fall back to the button label as the
  // body so the message has something to attach the keyboard to.
  const buttonHint = action.length > 0 ? buttonLabel(action[0]) : '';
  const safeHtml = html || fallback || (buttonHint ? escapeHtml(buttonHint) : '');
  const safeText = fallback || buttonHint;

  // Telegram rejects anything past 4096 outright, so a long briefing has to be
  // clipped. The HTML slot is NOT clipped in place: cutting the markup would
  // land mid-tag and Telegram would reject the send for unparseable entities.
  // When it is over, drop to the escaped plain text instead — losing bold on
  // one oversized message beats losing the message.
  const clippedText = clipForPlatform(safeText, TELEGRAM_LIMIT, input.moreUrl);
  const clippedHtml =
    safeHtml.length <= TELEGRAM_LIMIT ? safeHtml : escapeHtml(clippedText);

  return {
    text: clippedText,
    telegram: {
      html: clippedHtml,
      replyMarkup,
      disableWebPagePreview,
    },
  };
}

function buttonLabel(c: BotCard): string {
  // Action cards typically have a directive title like "Open in Maps"
  // or "Book on OpenTable" — exactly what we want on the button. Fall
  // back to subtitle / a generic if title is somehow empty.
  return c.title || c.subtitle || 'Open';
}

function formatInlineHtmlLine(c: BotCard): string | null {
  const title = c.title?.trim();
  const sub = c.subtitle?.trim();
  const meta = c.meta?.trim();
  const url = c.url?.trim();
  const parts: string[] = [];
  if (title) parts.push(`<b>${escapeHtml(title)}</b>`);
  if (sub) parts.push(`— ${escapeHtml(sub)}`);
  if (meta) parts.push(`(${escapeHtml(meta)})`);
  const head = parts.join(' ').trim();
  if (url) {
    return head ? `${head}: <a href="${escapeAttr(url)}">${escapeHtml(url)}</a>` : `<a href="${escapeAttr(url)}">${escapeHtml(url)}</a>`;
  }
  return head || null;
}

function formatInlinePlainLine(c: BotCard): string | null {
  const parts: string[] = [];
  if (c.title) parts.push(c.title);
  if (c.subtitle) parts.push(`— ${c.subtitle}`);
  if (c.meta) parts.push(`(${c.meta})`);
  const head = parts.join(' ').trim();
  if (c.url) return head ? `${head}: ${c.url}` : c.url;
  return head || null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
