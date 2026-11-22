/**
 * Universal date stamp for LLM calls. Without an explicit "today" pin,
 * models silently anchor to their training cutoff and produce
 * wrong-year answers, especially for relative phrases ("next Friday",
 * "the 12th"). buildLlmContext already adds a rich date block on the
 * chat path, but many other call sites (proactive nudges, extraction,
 * classifiers, form fill, completion service, etc.) build their own
 * system prompts and forget. This wrapper guarantees a TODAY line on
 * every LlmService call, regardless of caller.
 *
 * It is idempotent: if the first system message already contains
 * `TODAY IS`, the wrapper passes through unchanged so we don't
 * duplicate the chat path's richer block.
 */
import type {
  LlmCompleteOptions,
  LlmContentPart,
  LlmMessage,
  LlmService,
  LlmStreamOptions,
} from './types.js';
import { upcomingDatesTable, weekdayOf } from '../../utils/tz.js';

function todayStamp(): string {
  const iso = new Date().toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const date = iso.slice(0, 10);
  const year = iso.slice(0, 4);
  return `TODAY IS ${weekdayOf(date)} ${date} (UTC). Today's year is ${year}. Do not infer "today" from your training data — anchor every relative date to TODAY above. Weekday → date for the next two weeks: ${upcomingDatesTable(date)}. Look weekdays up in this list; never compute one yourself.`;
}

function contentText(content: string | LlmContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is Extract<LlmContentPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function withStamp(messages: LlmMessage[]): LlmMessage[] {
  const stamp = todayStamp();
  const first = messages[0];
  if (first && first.role === 'system') {
    if (contentText(first.content).includes('TODAY IS')) return messages;
    if (typeof first.content === 'string') {
      return [{ ...first, content: `${stamp}\n\n${first.content}` }, ...messages.slice(1)];
    }
    const parts: LlmContentPart[] = [{ type: 'text', text: stamp }, ...first.content];
    return [{ ...first, content: parts }, ...messages.slice(1)];
  }
  return [{ role: 'system', content: stamp }, ...messages];
}

export function withDateStamp(inner: LlmService): LlmService {
  return {
    providerName: inner.providerName,
    defaultModel: inner.defaultModel,
    supportsNativeTools: inner.supportsNativeTools,
    complete: (messages: LlmMessage[], opts?: LlmCompleteOptions) =>
      inner.complete(withStamp(messages), opts),
    stream: (messages: LlmMessage[], opts?: LlmStreamOptions) =>
      inner.stream(withStamp(messages), opts),
  };
}

export const __testing = { withStamp, todayStamp };
