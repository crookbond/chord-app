/**
 * Re-export shim. The actual implementation moved to
 * `connectors/renderers/plain.renderer.ts` in Commit A of the
 * multi-surface refactor; this module exists so existing imports
 * (`import { appendCardLines } from './card-text.js'`) continue to
 * resolve without a coordinated rewrite. Prefer importing from
 * `services/connectors/renderers` directly in new code.
 */
export {
  formatCardLine,
  appendCardLines,
} from '../connectors/renderers/plain.renderer.js';
