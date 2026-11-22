/**
 * Chord (in-app) renderer.
 *
 * The Chord mobile + web clients consume cards STRUCTURALLY via the
 * `SSE.botCard` event — they don't need the cards flattened into the
 * message body. So this renderer's `text` slot is the assistant's prose
 * UNCHANGED, with no card lines appended. That's the key behavioral
 * difference from the plain renderer: in-app users see clean prose plus
 * native card UI, while bridge users see prose + bridge-flattened lines.
 *
 * Commit B introduces this slot only for the `text` output (used when a
 * Chord-app message gets persisted as the `body`). Future commits may
 * add a structured `chord` slot if the renderer ever needs to do more
 * than pass prose through.
 */
import type { RenderInput, RenderedMessage } from './types';

export function renderChord(input: RenderInput): RenderedMessage {
  return { text: input.body };
}
