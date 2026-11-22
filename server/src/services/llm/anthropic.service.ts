import Anthropic from '@anthropic-ai/sdk';

import { env } from '../../config/env.js';
import type {
  LlmChunk,
  LlmCompleteOptions,
  LlmContentPart,
  LlmMessage,
  LlmService,
  LlmStreamOptions,
  LlmToolCall,
  LlmToolDef,
} from './types.js';
import { contentToString } from './types.js';

/** Anthropic requires `max_tokens`; OpenAI/Gemini leave it optional. */
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Anthropic (Claude) service. Implements the same `LlmService` contract as the
 * OpenAI and Gemini providers, over the `@anthropic-ai/sdk` Messages API.
 *
 * Two shapes differ from the OpenAI transcript and are handled in
 * `toAnthropicHistory`:
 *   - `system` is a top-level request param, not a message.
 *   - tool *results* are `tool_result` blocks inside a `user` turn (not a
 *     dedicated `tool` role), and tool *calls* are `tool_use` blocks inside the
 *     preceding `assistant` turn.
 */
export class AnthropicLlmService implements LlmService {
  readonly providerName = 'anthropic' as const;
  readonly supportsNativeTools = true;
  readonly defaultModel: string;
  private client: Anthropic;

  constructor(opts?: { apiKey?: string; baseURL?: string; model?: string }) {
    const apiKey = opts?.apiKey ?? env.ANTHROPIC_API_KEY;
    this.client = new Anthropic({
      apiKey: apiKey || 'not-set',
      baseURL: opts?.baseURL ?? (env.ANTHROPIC_BASE_URL || undefined),
    });
    this.defaultModel = opts?.model ?? env.ANTHROPIC_MODEL;
  }

  async complete(messages: LlmMessage[], opts?: LlmCompleteOptions): Promise<string> {
    const { system, convo } = toAnthropicHistory(messages);
    const res = await this.client.messages.create({
      model: opts?.model ?? this.defaultModel,
      max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: opts?.temperature ?? 0.4,
      system: system || undefined,
      messages: convo,
    });
    opts?.onUsage?.({
      promptTokens: res.usage?.input_tokens ?? 0,
      completionTokens: res.usage?.output_tokens ?? 0,
    });
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }

  async *stream(
    messages: LlmMessage[],
    opts?: LlmStreamOptions,
  ): AsyncIterable<LlmChunk> {
    const { system, convo } = toAnthropicHistory(messages);
    const tools = toAnthropicTools(opts?.tools);
    const iter = await this.client.messages.create({
      model: opts?.model ?? this.defaultModel,
      max_tokens: opts?.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: opts?.temperature ?? 0.4,
      system: system || undefined,
      messages: convo,
      tools,
      stream: true,
    });

    // tool_use argument JSON arrives as `input_json_delta` fragments keyed by
    // the content-block index. Accumulate per block, parse + emit on stop.
    const partial = new Map<number, { id: string; name: string; argsText: string }>();
    let stopReason: string | null = null;
    // ADR 0193 — message_start carries the (fixed) input token count;
    // message_delta's usage.output_tokens is cumulative, so the last one
    // seen before the stream ends is the final count.
    let promptTokens = 0;
    let completionTokens = 0;

    for await (const event of iter) {
      switch (event.type) {
        case 'message_start':
          promptTokens = event.message.usage?.input_tokens ?? 0;
          completionTokens = event.message.usage?.output_tokens ?? 0;
          break;
        case 'content_block_start':
          if (event.content_block.type === 'tool_use') {
            partial.set(event.index, {
              id: event.content_block.id,
              name: event.content_block.name,
              argsText: '',
            });
          }
          break;
        case 'content_block_delta':
          if (event.delta.type === 'text_delta') {
            if (event.delta.text) yield { type: 'text', delta: event.delta.text };
          } else if (event.delta.type === 'input_json_delta') {
            const slot = partial.get(event.index);
            if (slot) slot.argsText += event.delta.partial_json;
          }
          break;
        case 'content_block_stop': {
          const slot = partial.get(event.index);
          if (slot) {
            partial.delete(event.index);
            let args: unknown = {};
            try {
              args = slot.argsText ? JSON.parse(slot.argsText) : {};
            } catch {
              args = { __raw: slot.argsText };
            }
            const call: LlmToolCall = { id: slot.id, name: slot.name, args };
            yield { type: 'tool_call', call };
          }
          break;
        }
        case 'message_delta':
          if (event.delta.stop_reason) stopReason = event.delta.stop_reason;
          if (event.usage?.output_tokens) completionTokens = event.usage.output_tokens;
          break;
        default:
          break;
      }
    }

    opts?.onUsage?.({ promptTokens, completionTokens });

    yield {
      type: 'done',
      reason:
        stopReason === 'tool_use'
          ? 'tool_calls'
          : stopReason === 'max_tokens'
            ? 'length'
            : 'stop',
    };
  }
}

/**
 * Anthropic's `input_schema` is JSON Schema, but rejects a couple of meta keys
 * that `zod-to-json-schema` emits (e.g. `$schema`). Strip them recursively.
 */
function sanitizeAnthropicSchema(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sanitizeAnthropicSchema);
  if (typeof v !== 'object' || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k === '$schema' || k === '$ref') continue;
    out[k] = sanitizeAnthropicSchema(val);
  }
  return out;
}

function toAnthropicTools(tools: LlmToolDef[] | undefined): Anthropic.Tool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: sanitizeAnthropicSchema(t.parameters) as Anthropic.Tool.InputSchema,
  }));
}

function toAnthropicContentParts(
  content: string | LlmContentPart[],
): Anthropic.ContentBlockParam[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  return content.map((p): Anthropic.ContentBlockParam => {
    if (p.type === 'text') return { type: 'text', text: p.text };
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: p.mimeType as Anthropic.Base64ImageSource['media_type'],
        data: p.base64,
      },
    };
  });
}

/**
 * Translate the provider-agnostic transcript into Anthropic's request shape.
 * `system` collapses to a top-level string; the rest become alternating
 * user/assistant turns. Consecutive same-role blocks merge into one turn,
 * which lets a `tool_use` (assistant) be answered by `tool_result` (user)
 * blocks that themselves merge across multiple tool results.
 */
function toAnthropicHistory(messages: LlmMessage[]): {
  system: string;
  convo: Anthropic.MessageParam[];
} {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => contentToString(m.content))
    .join('\n\n');

  const convo: Anthropic.MessageParam[] = [];
  const push = (role: 'user' | 'assistant', block: Anthropic.ContentBlockParam): void => {
    const last = convo[convo.length - 1];
    if (last?.role === role && Array.isArray(last.content)) {
      last.content.push(block);
    } else {
      convo.push({ role, content: [block] });
    }
  };

  for (const m of messages) {
    if (m.role === 'system') continue;

    if (m.role === 'tool') {
      push('user', {
        type: 'tool_result',
        tool_use_id: m.toolCallId ?? '',
        content: contentToString(m.content),
      });
      continue;
    }

    if (m.role === 'assistant') {
      const text = contentToString(m.content);
      if (text) push('assistant', { type: 'text', text });
      for (const call of m.toolCalls ?? []) {
        push('assistant', {
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: (call.args ?? {}) as Record<string, unknown>,
        });
      }
      continue;
    }

    // user
    const parts = toAnthropicContentParts(m.content);
    if (parts.length === 0) parts.push({ type: 'text', text: ' ' });
    for (const part of parts) push('user', part);
  }

  return { system, convo };
}
