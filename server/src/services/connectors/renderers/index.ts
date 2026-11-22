/**
 * Render-dispatcher entry point. Callers pass the platform they're
 * rendering for and a RenderInput; they get back a RenderedMessage with
 * `text` always populated and platform-specific slots when a renderer
 * has been implemented for that platform.
 *
 * Commit A wires only the plain renderer — every platform falls through
 * to plain text. Subsequent commits add `chord.renderer.ts` (Commit B)
 * and `telegram.renderer.ts` (Commit C); when those land, this
 * dispatcher routes to them.
 */
import { renderChord } from './chord.renderer';
import { renderPlain } from './plain.renderer';
import { renderTelegram } from './telegram.renderer';
import { renderWhatsApp } from './whatsapp.renderer';
import type { RenderInput, RenderPlatform, RenderedMessage } from './types';

export function renderFor(
  platform: RenderPlatform,
  input: RenderInput,
): RenderedMessage {
  switch (platform) {
    case 'chord':
      return renderChord(input);
    case 'telegram':
      return renderTelegram(input);
    case 'whatsapp':
      return renderWhatsApp(input);
    case 'slack':
    case 'discord':
    case 'plain':
      return renderPlain(input);
  }
}

export { renderChord } from './chord.renderer';
export { renderPlain } from './plain.renderer';
export { renderTelegram } from './telegram.renderer';
export { renderWhatsApp } from './whatsapp.renderer';
export { formatCardLine, appendCardLines } from './plain.renderer';
export type {
  RenderInput,
  RenderedMessage,
  RenderPlatform,
  TelegramRenderSlot,
  WhatsAppRenderSlot,
} from './types';
