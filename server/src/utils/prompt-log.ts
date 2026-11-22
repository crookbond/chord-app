import type { LlmMessage } from '../services/llm/types.js';

export type PromptLogMode = 'off' | 'meta' | 'full';

/**
 * `full` writes every prompt (system text, email subjects, attachment
 * excerpts) to disk, so it is refused in production and falls back to `meta`.
 */
export function resolvePromptLogMode(raw: string, nodeEnv: string): PromptLogMode {
  const v = raw.trim().toLowerCase();
  if (v === 'off') return 'off';
  if (v === 'full') return nodeEnv === 'production' ? 'meta' : 'full';
  return 'meta';
}

export function promptLogMessages(messages: LlmMessage[], mode: PromptLogMode): unknown {
  if (mode === 'full') return messages;
  return messages.map((m) => ({
    role: m.role,
    chars:
      typeof m.content === 'string'
        ? m.content.length
        : m.content.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 0), 0),
    parts: typeof m.content === 'string' ? 1 : m.content.length,
    toolCalls: m.toolCalls?.map((c) => c.name),
    toolName: m.toolName,
  }));
}

/**
 * Operator scripts print threads to a terminal (and scrollback, and shell
 * logs). Unless the operator passes `--show-content`, a subject is reduced to
 * its size and a sender to its domain: enough to tell rows apart, not enough
 * to read someone's mail.
 */
export function maskSubject(subject: string | null | undefined, show: boolean): string {
  if (show) return subject ?? '';
  return `<subject hidden, ${(subject ?? '').length} chars>`;
}

export function maskSender(email: string | null | undefined, show: boolean): string {
  if (show) return email ?? '?';
  const at = (email ?? '').lastIndexOf('@');
  return at >= 0 ? `*@${email!.slice(at + 1)}` : '?';
}

/**
 * Model replies can echo email or attachment text (a vision reply is OCR of
 * the file), so a raw excerpt is only logged outside production.
 */
export function debugSnippet(raw: string, max: number, nodeEnv: string): string | undefined {
  return nodeEnv === 'production' ? undefined : raw.slice(0, max);
}
