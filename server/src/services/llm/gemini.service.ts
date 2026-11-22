import {
  GoogleGenerativeAI,
  type Content,
  type FunctionDeclaration,
  type FunctionDeclarationSchema,
  type Part,
  type Tool,
} from '@google/generative-ai';

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

function toGeminiParts(content: string | LlmContentPart[]): Part[] {
  if (typeof content === 'string') {
    return content ? [{ text: content }] : [];
  }
  return content.map((p) => {
    if (p.type === 'text') return { text: p.text };
    return { inlineData: { mimeType: p.mimeType, data: p.base64 } };
  });
}

/**
 * Gemini's function-calling endpoint accepts a schema close to JSON Schema
 * but rejects a handful of keys. Strip those recursively. `exclusiveMinimum`
 * and `exclusiveMaximum` come from zod's `.positive()` / `.gt()` /
 * `.lt()` constraints and survive the upstream OpenAI sanitizer; Gemini
 * 400s with "Unknown name 'exclusiveMinimum'" so we drop them here.
 */
function sanitizeGeminiSchema(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sanitizeGeminiSchema);
  if (typeof v !== 'object' || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (
      k === 'additionalProperties' ||
      k === 'default' ||
      k === 'examples' ||
      k === '$schema' ||
      k === '$ref' ||
      k === 'exclusiveMinimum' ||
      k === 'exclusiveMaximum'
    ) {
      continue;
    }
    out[k] = sanitizeGeminiSchema(val);
  }
  return out;
}

function toGeminiTools(tools: LlmToolDef[] | undefined): Tool[] | undefined {
  if (!tools?.length) return undefined;
  const decls: FunctionDeclaration[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: sanitizeGeminiSchema(t.parameters) as FunctionDeclarationSchema,
  }));
  return [{ functionDeclarations: decls }];
}

/**
 * Translate the provider-agnostic transcript into Gemini's `Content[]`.
 * - `system` messages collapse into a single `systemInstruction` string.
 * - Consecutive `tool` (result) messages collapse into one `function`-role
 *   content turn with multiple `functionResponse` parts — Gemini expects all
 *   tool results to follow a single model turn as one user/function turn.
 */
function toGeminiHistory(messages: LlmMessage[]): {
  system: string;
  convo: Content[];
} {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => contentToString(m.content))
    .join('\n\n');

  const convo: Content[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;

    if (m.role === 'tool') {
      let response: unknown;
      try {
        response = JSON.parse(typeof m.content === 'string' ? m.content : '');
      } catch {
        response = { result: typeof m.content === 'string' ? m.content : '' };
      }
      if (typeof response !== 'object' || response === null) {
        response = { result: response };
      }
      const part: Part = {
        functionResponse: {
          name: m.toolName ?? 'tool',
          response: response as Record<string, unknown>,
        },
      };
      const last = convo[convo.length - 1];
      if (last?.role === 'function') {
        last.parts.push(part);
      } else {
        convo.push({ role: 'function', parts: [part] });
      }
      continue;
    }

    if (m.role === 'assistant') {
      const parts: Part[] = [];
      const text = contentToString(m.content);
      if (text) parts.push({ text });
      for (const call of m.toolCalls ?? []) {
        parts.push({
          functionCall: {
            name: call.name,
            args: (call.args ?? {}) as Record<string, unknown>,
          },
        });
      }
      if (parts.length === 0) parts.push({ text: '' });
      convo.push({ role: 'model', parts });
      continue;
    }

    // user
    convo.push({ role: 'user', parts: toGeminiParts(m.content) });
  }
  return { system, convo };
}

export class GeminiLlmService implements LlmService {
  readonly providerName = 'gemini' as const;
  readonly supportsNativeTools = true;
  readonly defaultModel: string;
  private client: GoogleGenerativeAI;

  constructor(opts?: { apiKey?: string; model?: string }) {
    this.client = new GoogleGenerativeAI(opts?.apiKey ?? env.GEMINI_API_KEY ?? 'not-set');
    this.defaultModel = opts?.model ?? env.GEMINI_MODEL;
  }

  async complete(messages: LlmMessage[], opts?: LlmCompleteOptions): Promise<string> {
    const { system, convo } = toGeminiHistory(messages);
    const model = this.client.getGenerativeModel({
      model: opts?.model ?? this.defaultModel,
      systemInstruction: system || undefined,
      generationConfig: {
        temperature: opts?.temperature ?? 0.4,
        maxOutputTokens: opts?.maxTokens,
      },
    });
    const res = await model.generateContent({ contents: convo });
    const um = res.response.usageMetadata;
    if (um) {
      opts?.onUsage?.({
        promptTokens: um.promptTokenCount ?? 0,
        completionTokens: um.candidatesTokenCount ?? 0,
      });
    }
    return res.response.text();
  }

  async *stream(
    messages: LlmMessage[],
    opts?: LlmStreamOptions,
  ): AsyncIterable<LlmChunk> {
    const { system, convo } = toGeminiHistory(messages);
    const tools = toGeminiTools(opts?.tools);
    const model = this.client.getGenerativeModel({
      model: opts?.model ?? this.defaultModel,
      systemInstruction: system || undefined,
      generationConfig: {
        temperature: opts?.temperature ?? 0.4,
        maxOutputTokens: opts?.maxTokens,
      },
      tools,
    });
    const res = await model.generateContentStream({ contents: convo });

    let toolCallSeen = false;
    let callIndex = 0;
    for await (const chunk of res.stream) {
      // Pull text first (may be empty if this chunk only carried a function call).
      let text = '';
      try {
        text = chunk.text();
      } catch {
        // .text() throws when the chunk has no text part — safe to ignore.
      }
      if (text) yield { type: 'text', delta: text };

      const calls = chunk.functionCalls?.();
      if (calls?.length) {
        for (const c of calls) {
          toolCallSeen = true;
          const call: LlmToolCall = {
            id: `${c.name}_${callIndex++}`,
            name: c.name,
            args: c.args ?? {},
          };
          yield { type: 'tool_call', call };
        }
      }
    }

    // ADR 0193 — the aggregated final response (not the per-chunk stream)
    // carries usageMetadata, same shape complete() already reads.
    if (opts?.onUsage) {
      const um = (await res.response).usageMetadata;
      if (um) {
        opts.onUsage({
          promptTokens: um.promptTokenCount ?? 0,
          completionTokens: um.candidatesTokenCount ?? 0,
        });
      }
    }

    yield { type: 'done', reason: toolCallSeen ? 'tool_calls' : 'stop' };
  }
}
