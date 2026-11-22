/**
 * AnthropicLlmService — transcript/tool translation + stream-event mapping.
 *
 * The Anthropic SDK is stubbed (no network): `messages.create` is a spy we
 * point at canned return values, and we assert both the *request* it received
 * (translated history + tools) and the `LlmChunk` stream the service produced
 * from a canned sequence of raw stream events.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = { create: createMock };
    constructor(public opts: unknown) {}
  }
  return { default: FakeAnthropic };
});

import { AnthropicLlmService } from '../anthropic.service.js';
import type { LlmChunk, LlmMessage } from '../types.js';

function log(label: string, payload: object): void {
  console.log(`[anthropic] ${label}`, JSON.stringify(payload));
}

async function* fakeStream(events: unknown[]): AsyncGenerator<unknown> {
  for (const e of events) yield e;
}

async function collect(iter: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

beforeEach(() => {
  createMock.mockReset();
});

describe('AnthropicLlmService — identity', () => {
  it('reports provider, default model, native-tool support', () => {
    const svc = new AnthropicLlmService({ apiKey: 'k', model: 'claude-x' });
    expect(svc.providerName).toBe('anthropic');
    expect(svc.defaultModel).toBe('claude-x');
    expect(svc.supportsNativeTools).toBe(true);
  });
});

describe('AnthropicLlmService — request translation', () => {
  it('splits system out, maps tool_use/tool_result, sanitizes tool schema', async () => {
    createMock.mockReturnValue(fakeStream([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }]));
    const svc = new AnthropicLlmService({ apiKey: 'k' });

    const messages: LlmMessage[] = [
      { role: 'system', content: 'You are Chord' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 't1', name: 'add_task', args: { title: 'milk' } }],
      },
      { role: 'tool', content: '{"ok":true}', toolCallId: 't1', toolName: 'add_task' },
    ];

    await collect(
      svc.stream(messages, {
        tools: [
          {
            name: 'add_task',
            description: 'add a task',
            parameters: {
              $schema: 'http://json-schema.org/draft-07/schema#',
              type: 'object',
              properties: { title: { type: 'string' } },
            },
          },
        ],
      }),
    );

    const arg = createMock.mock.calls[0][0] as Record<string, any>;
    log('request', { system: arg.system, messages: arg.messages, tools: arg.tools });

    expect(arg.system).toBe('You are Chord');
    expect(arg.stream).toBe(true);
    expect(arg.max_tokens).toBeGreaterThan(0);

    expect(arg.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'add_task', input: { title: 'milk' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"ok":true}' }],
      },
    ]);

    // $schema stripped; the rest of the JSON Schema preserved under input_schema.
    expect(arg.tools[0].name).toBe('add_task');
    expect(arg.tools[0].input_schema).toEqual({
      type: 'object',
      properties: { title: { type: 'string' } },
    });
  });

  it('maps image parts to base64 image blocks', async () => {
    createMock.mockReturnValue(fakeStream([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }]));
    const svc = new AnthropicLlmService({ apiKey: 'k' });

    await collect(
      svc.stream([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image', mimeType: 'image/png', base64: 'AAAA' },
          ],
        },
      ]),
    );

    const arg = createMock.mock.calls[0][0] as Record<string, any>;
    log('image-request', { messages: arg.messages });
    expect(arg.messages[0].content).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
  });
});

describe('AnthropicLlmService — stream mapping', () => {
  it('emits text, reassembles tool_use JSON, maps stop_reason', async () => {
    createMock.mockReturnValue(
      fakeStream([
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'tool_1', name: 'do', input: {} },
        },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a":' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '1}' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ]),
    );
    const svc = new AnthropicLlmService({ apiKey: 'k' });
    const chunks = await collect(svc.stream([{ role: 'user', content: 'go' }], { tools: [] }));
    log('chunks', { chunks });

    expect(chunks).toEqual([
      { type: 'text', delta: 'Hello' },
      { type: 'tool_call', call: { id: 'tool_1', name: 'do', args: { a: 1 } } },
      { type: 'done', reason: 'tool_calls' },
    ]);
  });

  it('maps max_tokens stop_reason to length, end_turn to stop', async () => {
    createMock.mockReturnValue(
      fakeStream([{ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }]),
    );
    let svc = new AnthropicLlmService({ apiKey: 'k' });
    let chunks = await collect(svc.stream([{ role: 'user', content: 'go' }]));
    expect(chunks.at(-1)).toEqual({ type: 'done', reason: 'length' });

    createMock.mockReturnValue(
      fakeStream([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }]),
    );
    svc = new AnthropicLlmService({ apiKey: 'k' });
    chunks = await collect(svc.stream([{ role: 'user', content: 'go' }]));
    log('stop-mapping', { last: chunks.at(-1) });
    expect(chunks.at(-1)).toEqual({ type: 'done', reason: 'stop' });
  });
});

describe('AnthropicLlmService — complete', () => {
  it('concatenates text blocks, ignoring tool_use blocks', async () => {
    createMock.mockResolvedValue({
      content: [
        { type: 'text', text: 'hi ' },
        { type: 'tool_use', id: 'x', name: 'y', input: {} },
        { type: 'text', text: 'there' },
      ],
    });
    const svc = new AnthropicLlmService({ apiKey: 'k' });
    const out = await svc.complete([{ role: 'user', content: 'hi' }]);
    log('complete', { out });
    expect(out).toBe('hi there');
  });
});
