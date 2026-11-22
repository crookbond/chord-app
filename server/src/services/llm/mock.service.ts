/**
 * Deterministic demo provider. Replies with a tool-fenced reply based on
 * keywords in the latest user message — enough to drive a live demo when
 * no real OpenAI/Gemini key is configured.
 *
 * Enable via `LLM_PROVIDER=mock`.
 */
import { EXTRACTION_MARKER } from '../ingest/whatsapp/extract.js';
import { classifyThread } from '../email/mock-classifier.js';

import { contentToString } from './types.js';
import type {
  LlmChunk,
  LlmCompleteOptions,
  LlmMessage,
  LlmService,
  LlmStreamOptions,
} from './types.js';

/** Keep in sync with EMAIL_LLM_CLASSIFIER_MARKER in llm-classifier.ts (avoid import cycle). */
const EMAIL_LLM_CLASSIFIER_MARKER = 'EMAIL_LLM_CLASSIFIER_V1';

interface CannedResponse {
  keywords: RegExp;
  build: (lastUser: string) => string;
}

const RESPONSES: CannedResponse[] = [
  {
    keywords: /\b(costco|grocer|list|buy|pick up|add to).*?\b(sunscreen|snorkel|towel|bread|milk|egg|item|bottle)/is,
    build: () => `\`\`\`chord-tool
{ "name": "add_list_item", "args": { "listName": "Costco", "items": ["sunscreen","snorkels","beach towels"] } }
\`\`\`

Added 3 items to Costco list.`,
  },
  {
    keywords: /\b(book|rent|reserve)\s+(a\s+)?(car|rental|hotel)/i,
    build: () => `\`\`\`chord-tool
{ "name": "create_task", "args": { "title": "Book rental car", "remindCue": "3 weeks before trip" } }
\`\`\`

Task created — I'll remind you three weeks before the trip.`,
  },
  {
    keywords: /\b(save|add)\b.*\b(https?:\/\/\S+)/i,
    build: (s) => {
      const url = s.match(/https?:\/\/\S+/)?.[0] ?? '';
      return `\`\`\`chord-tool
{ "name": "save_link", "args": { "title": "Saved link", "url": "${url}" } }
\`\`\`

Saved.`;
    },
  },
  {
    keywords: /\b(potluck|dinner|party)\b/i,
    // Relative, not a fixed date: create_event refuses a start that has
    // already passed, so a literal would quietly stop creating anything.
    build: () => `\`\`\`chord-tool
{ "name": "create_event", "args": { "title": "Potluck", "startsAt": "${new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)}T19:00:00.000Z", "location": "host's place" } }
\`\`\`

Event created. Tell me who's in and what they're bringing and I'll track it.`,
  },
  {
    keywords: /\b(add|save)\s+(fred|restaurant|spot|place|cafe)/i,
    build: (s) => {
      const m = s.match(/(?:add|save)\s+([A-Z][a-zA-Z'-]+(?:\s[A-Z][a-zA-Z'-]+)?)/);
      const name = m?.[1] ?? 'Favourite spot';
      return `\`\`\`chord-tool
{ "name": "save_place", "args": { "name": "${name}", "tags": ["favorite"] } }
\`\`\`

Saved to your places.`;
    },
  },
  {
    // search_web only fires a real fetch under SEARCH_PROVIDER; the mock
    // LLM still exercises the tool call end-to-end (SEARCH_PROVIDER=mock
    // demoes a real, if fixture, result).
    keywords: /\b(search|look up|google)\b.*\b(restaurant|place|city|hotel)/i,
    build: (s) => {
      const m = s.match(/\b(?:search|look up|google)\b\s+(?:for\s+)?(.+)$/i);
      const query = (m?.[1] ?? s).trim();
      return `\`\`\`chord-tool
{ "name": "search_web", "args": { "query": "${query.replace(/"/g, '\\"')}" } }
\`\`\`

Let me look that up.`;
    },
  },
];

function latestUserContent(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return contentToString(messages[i].content);
  }
  return '';
}

function isMemoryExtractionPrompt(messages: LlmMessage[]): boolean {
  for (const m of messages) {
    if (m.role !== 'system' && m.role !== 'user') continue;
    const text = contentToString(m.content);
    if (
      text.includes('personal knowledge and preference graph') ||
      (text.includes('User said:') && text.includes('Assistant replied:'))
    ) {
      return true;
    }
  }
  return false;
}

function isEmailClassifierPrompt(messages: LlmMessage[]): boolean {
  for (const m of messages) {
    if (m.role !== 'system') continue;
    if (contentToString(m.content).includes(EMAIL_LLM_CLASSIFIER_MARKER)) return true;
  }
  return false;
}

/** Deterministic path assignments for EMAIL_CLASSIFIER=llm + LLM_PROVIDER=mock. */
function mockEmailClassifierResponse(messages: LlmMessage[]): string {
  const content = latestUserContent(messages);
  let threads: { gmailThreadId?: string; fromEmail?: string | null; subject?: string }[] = [];
  try {
    const parsed = JSON.parse(content) as { threads?: unknown };
    if (Array.isArray(parsed.threads)) {
      threads = parsed.threads as typeof threads;
    }
  } catch {
    return JSON.stringify({ assignments: [] });
  }
  const assignments = [];
  for (const t of threads) {
    if (typeof t.gmailThreadId !== 'string') continue;
    const path = classifyThread(t.fromEmail ?? null, t.subject ?? '');
    if (!path) continue;
    assignments.push({ gmailThreadId: t.gmailThreadId, path, confidence: 0.85 });
  }
  return JSON.stringify({ assignments });
}

function pickReply(messages: LlmMessage[]): string {
  const content = latestUserContent(messages);
  if (isEmailClassifierPrompt(messages)) {
    return mockEmailClassifierResponse(messages);
  }
  if (isMemoryExtractionPrompt(messages)) {
    return '[]';
  }
  if (content.includes(EXTRACTION_MARKER)) {
    return mockExtractionResponse(content);
  }
  for (const r of RESPONSES) {
    if (r.keywords.test(content)) return r.build(content);
  }
  return "Got it. (mock LLM — set LLM_PROVIDER=openai or gemini with a real API key for richer replies.)";
}

function mockExtractionResponse(fragment: string): string {
  const calls: unknown[] = [];

  const remind = fragment.match(
    /\b(?:remind me to|remember to|need to|don't forget to|we should)\s+([^.!?\n]{3,120})/i,
  );
  if (remind) {
    const title = remind[1].trim().replace(/[.,;].*$/, '').slice(0, 200);
    if (title) calls.push({ name: 'create_task', args: { title } });
  }

  if (/\b(costco|groceries|shopping list|grocery run)\b/i.test(fragment)) {
    const items = Array.from(
      fragment.matchAll(
        /\b(milk|bread|eggs|chicken|rice|pasta|sunscreen|towels?|beer|water|coffee|cheese|butter|apples?|bananas?)\b/gi,
      ),
    ).map((m) => m[1].toLowerCase());
    const unique = Array.from(new Set(items)).slice(0, 10);
    if (unique.length) {
      calls.push({ name: 'add_list_item', args: { listName: 'Costco', items: unique } });
    }
  }

  const urlMatch = fragment.match(/https?:\/\/[^\s)]+/);
  if (urlMatch) {
    calls.push({
      name: 'save_link',
      args: { title: 'Shared link', url: urlMatch[0] },
    });
  }

  const place = fragment.match(
    /\b(?:dinner|lunch|brunch|meet|coffee)\s+at\s+([A-Z][a-zA-Z'&-]+(?:\s[A-Z][a-zA-Z'&-]+){0,2})/,
  );
  if (place) {
    calls.push({ name: 'save_place', args: { name: place[1] } });
  }

  return JSON.stringify({ calls });
}

export class MockLlmService implements LlmService {
  readonly providerName = 'mock' as const;
  readonly supportsNativeTools = false;
  readonly defaultModel = 'chord-mock';

  async complete(messages: LlmMessage[], _opts?: LlmCompleteOptions): Promise<string> {
    return pickReply(messages);
  }

  async *stream(
    messages: LlmMessage[],
    _opts?: LlmStreamOptions,
  ): AsyncIterable<LlmChunk> {
    const full = pickReply(messages);
    const words = full.match(/\S+\s*/g) ?? [full];
    for (const w of words) {
      yield { type: 'text', delta: w };
      await new Promise((r) => setTimeout(r, 20));
    }
    yield { type: 'done', reason: 'stop' };
  }
}
