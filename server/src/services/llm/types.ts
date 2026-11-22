/**
 * Minimal LLM contract for the Chord bot. Both OpenAI-compatible and Gemini
 * providers implement this.
 *
 * `stream()` yields a tagged-union of chunks — text tokens, resolved tool
 * calls, and a final `done` marker with the reason the stream ended. This is
 * the shape that makes iterative tool-calling possible (ADR 0005). Providers
 * without native tool support only ever emit `text` + `done`, and the bot
 * service falls back to the text-fence protocol from ADR 0003.
 */

/** A single part of a multi-modal message (text or inline image). */
export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; base64: string };

/** Coerce content to plain text — used by providers that don't support vision. */
export function contentToString(content: string | LlmContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<LlmContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | LlmContentPart[];
  /** Populated on assistant turns that invoked tools; ignored on other roles. */
  toolCalls?: LlmToolCall[];
  /** Populated on role='tool' messages — the call this result belongs to. */
  toolCallId?: string;
  /** Populated on role='tool' messages — name of the tool that produced it. */
  toolName?: string;
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** Parsed arguments. Providers stream JSON fragments; we reassemble here. */
  args: unknown;
}

export interface LlmToolDef {
  name: string;
  description?: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

/** What a provider reports it actually consumed. */
export interface LlmTokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens read from the provider's cache (included in promptTokens). */
  cachedTokens?: number;
  /** What the call cost, in US dollars, as the provider billed it (OpenRouter
   *  reports this). Absent when the provider does not say. Recorded, never
   *  counted against an allowance (ADR 0332). */
  costUsd?: number;
}

/** Adds one model call's usage to a running total. Cost and cached counts
 *  stay absent unless some call reported them, and a cost becomes unknown
 *  once any call in the total did not report one (a partial sum would read
 *  as the whole). */
export function addUsage(total: LlmTokenUsage | null, u: LlmTokenUsage): LlmTokenUsage {
  if (!total) return { ...u };
  const cached =
    total.cachedTokens === undefined && u.cachedTokens === undefined
      ? undefined
      : (total.cachedTokens ?? 0) + (u.cachedTokens ?? 0);
  const cost =
    total.costUsd === undefined || u.costUsd === undefined ? undefined : total.costUsd + u.costUsd;
  return {
    promptTokens: total.promptTokens + u.promptTokens,
    completionTokens: total.completionTokens + u.completionTokens,
    ...(cached === undefined ? {} : { cachedTokens: cached }),
    ...(cost === undefined ? {} : { costUsd: cost }),
  };
}

export interface LlmCompleteOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /**
   * Called with the provider's own token counts when it reports them.
   *
   * A callback rather than a widened return type: every existing caller wants
   * the text and nothing else, and a provider that reports no usage (mock, an
   * OpenAI-compatible shim that omits it) simply never calls this — so
   * "unknown" stays distinguishable from "zero" without anyone checking.
   */
  onUsage?: (usage: LlmTokenUsage) => void;
}

export interface LlmStreamOptions extends LlmCompleteOptions {
  /** If omitted, providers that support native function-calling must not emit tool_call chunks. */
  tools?: LlmToolDef[];
}

export type LlmChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: LlmToolCall }
  | { type: 'done'; reason: 'stop' | 'tool_calls' | 'length' | 'error' };

export interface LlmService {
  readonly providerName: 'openai' | 'gemini' | 'anthropic' | 'mock';
  readonly defaultModel: string;
  /** Whether this provider knows how to turn `LlmStreamOptions.tools` into native function calls. */
  readonly supportsNativeTools: boolean;
  complete(messages: LlmMessage[], opts?: LlmCompleteOptions): Promise<string>;
  stream(
    messages: LlmMessage[],
    opts?: LlmStreamOptions,
  ): AsyncIterable<LlmChunk>;
}
