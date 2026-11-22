import OpenAI from 'openai';

import { env } from '../../config/env.js';
import type {
  LlmChunk,
  LlmCompleteOptions,
  LlmContentPart,
  LlmMessage,
  LlmService,
  LlmStreamOptions,
  LlmTokenUsage,
  LlmToolCall,
} from './types.js';

/**
 * ADR 0332 — the usage block, including what OpenRouter adds to it: `cost`
 * (dollars billed for this call) and `prompt_tokens_details.cached_tokens`
 * (prompt tokens read from cache, billed far below fresh input). OpenAI itself
 * sends the cached count but no cost; Ollama/vLLM send neither.
 */
export function usageFromResponse(usage: unknown): LlmTokenUsage {
  const u = (usage ?? {}) as {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown } | null;
  };
  const out: LlmTokenUsage = {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
  };
  const cached = u.prompt_tokens_details?.cached_tokens;
  if (typeof cached === 'number' && Number.isFinite(cached) && cached >= 0) out.cachedTokens = cached;
  if (typeof u.cost === 'number' && Number.isFinite(u.cost) && u.cost >= 0) out.costUsd = u.cost;
  return out;
}

/**
 * OpenAI-compatible service. Also works with Ollama (`/v1` endpoint) and vLLM
 * — just set OPENAI_BASE_URL + OPENAI_MODEL appropriately.
 */
export class OpenAICompatService implements LlmService {
  readonly providerName = 'openai' as const;
  readonly supportsNativeTools = true;
  readonly defaultModel: string;
  private client: OpenAI;

  constructor(opts?: {
    apiKey?: string;
    baseURL?: string;
    model?: string;
    /** Overrides the HTTP client — a BYOK endpoint passes a host-screening one. */
    fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  }) {
    const apiKey = opts?.apiKey ?? env.OPENAI_API_KEY;
    const baseURL = opts?.baseURL ?? env.OPENAI_BASE_URL;
    if (!apiKey && baseURL === 'https://api.openai.com/v1') {
      // Intentionally not throwing — allows boot; fails only on first call.
    }
    this.client = new OpenAI({
      apiKey: apiKey || 'not-set',
      baseURL,
      ...(opts?.fetch ? { fetch: opts.fetch as unknown as NonNullable<ConstructorParameters<typeof OpenAI>[0]>['fetch'] } : {}),
    });
    this.defaultModel = opts?.model ?? env.OPENAI_MODEL;
  }

  async complete(messages: LlmMessage[], opts?: LlmCompleteOptions): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: opts?.model ?? this.defaultModel,
      temperature: opts?.temperature ?? 0.4,
      max_tokens: opts?.maxTokens,
      messages: messages.map(toOpenAIMessage),
    });
    if (res.usage) {
      opts?.onUsage?.(usageFromResponse(res.usage));
    }
    return res.choices[0]?.message?.content ?? '';
  }

  async *stream(
    messages: LlmMessage[],
    opts?: LlmStreamOptions,
  ): AsyncIterable<LlmChunk> {
    const tools = opts?.tools?.length
      ? opts.tools.map((t) => ({
          type: 'function' as const,
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        }))
      : undefined;
    const iter = await this.client.chat.completions.create({
      model: opts?.model ?? this.defaultModel,
      temperature: opts?.temperature ?? 0.4,
      max_tokens: opts?.maxTokens,
      stream: true,
      // ADR 0193 — without this, streamed responses never carry a usage
      // field at all (only complete() does by default); the usage-bearing
      // chunk arrives last, with an empty `choices` array.
      stream_options: opts?.onUsage ? { include_usage: true } : undefined,
      messages: messages.map(toOpenAIMessage),
      tools,
      tool_choice: tools ? 'auto' : undefined,
    });

    // Argument fragments arrive keyed by tool_call index. We accumulate them
    // until finish_reason fires, then parse + emit one tool_call chunk per
    // completed call.
    const partial = new Map<
      number,
      { id: string; name: string; argsText: string }
    >();
    let finishReason: string | null = null;

    for await (const chunk of iter) {
      // The include_usage final chunk has empty `choices` and only `usage`.
      if (chunk.usage) {
        opts?.onUsage?.(usageFromResponse(chunk.usage));
      }
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta?.content ?? '';
      if (delta) yield { type: 'text', delta };

      for (const tc of choice.delta?.tool_calls ?? []) {
        if (typeof tc.index !== 'number') continue;
        const slot = partial.get(tc.index) ?? { id: '', name: '', argsText: '' };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.argsText += tc.function.arguments;
        partial.set(tc.index, slot);
      }

      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    for (const slot of partial.values()) {
      if (!slot.name) continue;
      let args: unknown = {};
      try {
        args = slot.argsText ? JSON.parse(slot.argsText) : {};
      } catch {
        args = { __raw: slot.argsText };
      }
      const call: LlmToolCall = { id: slot.id, name: slot.name, args };
      yield { type: 'tool_call', call };
    }

    yield {
      type: 'done',
      reason:
        finishReason === 'tool_calls'
          ? 'tool_calls'
          : finishReason === 'length'
            ? 'length'
            : 'stop',
    };
  }
}

type OpenAIChatMessage = Parameters<
  OpenAI['chat']['completions']['create']
>[0]['messages'][number];

function serializeContent(content: string | LlmContentPart[]) {
  if (typeof content === 'string') return content;
  return content.map((p) => {
    if (p.type === 'text') return { type: 'text' as const, text: p.text };
    return {
      type: 'image_url' as const,
      image_url: { url: `data:${p.mimeType};base64,${p.base64}`, detail: 'high' as const },
    };
  });
}

function toOpenAIMessage(m: LlmMessage): OpenAIChatMessage {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: m.toolCallId ?? '',
      content: typeof m.content === 'string' ? m.content : '',
    };
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: typeof m.content === 'string' ? (m.content || null) : null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: {
          name: c.name,
          arguments: JSON.stringify(c.args ?? {}),
        },
      })),
    };
  }
  return { role: m.role, content: serializeContent(m.content) } as OpenAIChatMessage;
}
