/**
 * Windowed LLM extraction of chord-tool calls from a parsed WhatsApp chat.
 *
 * The pipeline slides a fixed-size window (200 messages, 20-message overlap —
 * john-app's proven tuning) across the conversation and asks the LLM to
 * return structured tool calls the Chord bot would have made had it been
 * present. Valid calls are paired with the formatted window text as
 * `provenance` so downstream entities can trace back to the source messages.
 *
 * Dedup is deliberately not performed here — overlapping windows will produce
 * duplicate calls for the same real-world entity. The follow-up that lands
 * dedup should match on natural keys at the service layer (task title,
 * trip name+dates, etc.).
 */
import { parseJsonLoose } from '../../../utils/json-repair.js';
import type { LlmMessage, LlmService } from '../../llm/types.js';
import { isToolName, toolSchemas, type ToolCall } from '../../bot/tools.js';

import type { ParsedChatMessage } from './parse.js';

export interface ExtractionWindow {
  messages: ParsedChatMessage[];
  startIdx: number;
  endIdx: number;
}

export interface ExtractedCall {
  call: ToolCall;
  provenance: string;
}

export const EXTRACTION_MARKER = '[[chord-extract-window]]';

const WINDOW_SIZE = 200;
const WINDOW_OVERLAP = 20;

const SYSTEM_PROMPT = `You extract structured entities from a WhatsApp chat fragment. You're helping a planning assistant named Chord back-fill its memory of what this group has been planning.

Respond with ONLY a JSON object of the form { "calls": [...] }. Each element of the array is a tool call the Chord assistant would make to record an entity:
  { "name": "<tool_name>", "args": { ... } }

Valid tool names (write-side only): create_task, add_list_item, save_link, save_place, save_media, save_contact, create_event, create_trip, add_travel_leg, add_accommodation.

Be conservative. If you're not confident the chat fragment describes a concrete entity (not speculation, not cancelled plans, not hypotheticals, not jokes), skip it. Return { "calls": [] } when in doubt. Never invent dates, flight numbers, addresses, or other specifics that aren't present in the text.

Dates: use ISO 8601 timestamps (YYYY-MM-DDTHH:mm:ss.sssZ) for any \`*At\` field. For \`create_trip\`, \`startDate\` and \`endDate\` are bare YYYY-MM-DD. Skip the entity entirely if you can't determine a date.`;

export function windowMessages(
  messages: ParsedChatMessage[],
  size = WINDOW_SIZE,
  overlap = WINDOW_OVERLAP,
): ExtractionWindow[] {
  if (messages.length === 0) return [];
  const step = Math.max(1, size - overlap);
  const windows: ExtractionWindow[] = [];
  for (let start = 0; start < messages.length; start += step) {
    const end = Math.min(start + size, messages.length);
    windows.push({ messages: messages.slice(start, end), startIdx: start, endIdx: end });
    if (end === messages.length) break;
  }
  return windows;
}

export function formatWindow(w: ExtractionWindow): string {
  return w.messages
    .map((m) => {
      const ts = m.sentAt.toISOString();
      const body = m.body.replace(/\n+/g, ' ').trim();
      return `[${ts}] ${m.sender}: ${body}`;
    })
    .join('\n');
}

export function buildExtractionPrompt(
  window: ExtractionWindow,
  members: string[],
): LlmMessage[] {
  const body = formatWindow(window);
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `${EXTRACTION_MARKER}\n` +
        `Group members: ${members.join(', ')}\n` +
        `Messages ${window.startIdx + 1}–${window.endIdx}:\n\n` +
        body,
    },
  ];
}

export async function extractFromWindow(
  llm: LlmService,
  window: ExtractionWindow,
  members: string[],
): Promise<ExtractedCall[]> {
  const raw = await llm.complete(buildExtractionPrompt(window, members), {
    temperature: 0,
    maxTokens: 2048,
  });
  const parsed = parseJsonLoose(raw) as { calls?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.calls)) return [];

  const provenance = formatWindow(window);
  const out: ExtractedCall[] = [];
  for (const entry of parsed.calls as Array<{ name?: unknown; args?: unknown }>) {
    if (!entry || typeof entry.name !== 'string' || !isToolName(entry.name)) continue;
    const schema = toolSchemas[entry.name];
    const validated = schema.safeParse(entry.args);
    if (!validated.success) continue;
    out.push({
      call: { name: entry.name, args: validated.data } as ToolCall,
      provenance,
    });
  }
  return out;
}
