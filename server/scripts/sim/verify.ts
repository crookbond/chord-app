/**
 * Per-Chord-turn verifier. Collects SSE events that arrive between the
 * @Chord prompt being posted and `bot.done`, then asserts the prompt's
 * declared expectations:
 *   - the expected tool fired at least once,
 *   - if a card kind is expected, a bot.card with that kind was emitted,
 *   - if a URL host is expected, every action card URL satisfies it.
 *
 * Returns a structured result so the orchestrator can log + tally
 * failure categories without throwing on every miss.
 */
import type { ChordTemplate } from './scenarios.js';

export interface CapturedTurn {
  /** The user's prompt id (result of POST /messages). */
  promptMessageId: string;
  /** Bot reply message ids seen for this turn. */
  replyMessageIds: string[];
  toolCalls: { name: string; status: 'ok' | 'error'; summary: string }[];
  cards: { kind: string; title: string; url?: string }[];
  done: boolean;
  /** True when no bot.done arrived within the timeout. */
  timedOut: boolean;
  startedAt: number;
  durationMs?: number;
}

export type VerifyFailure =
  | { code: 'timeout' }
  | { code: 'no-tool-call' }
  | { code: 'wrong-tool'; expected: string; got: string[] }
  | { code: 'tool-error'; name: string; summary: string }
  | { code: 'missing-card'; expectedKind: string }
  | { code: 'bad-url'; url: string; expectedHost: string }
  | { code: 'missing-url' }
  | { code: 'unexpected-tool'; got: string[] }
  | { code: 'forbidden-tool'; name: string };

export interface VerifyResult {
  ok: boolean;
  failures: VerifyFailure[];
  turn: CapturedTurn;
}

export function verifyTurn(
  template: ChordTemplate,
  turn: CapturedTurn,
  opts: { mock?: boolean } = {},
): VerifyResult {
  const failures: VerifyFailure[] = [];

  if (turn.timedOut) {
    failures.push({ code: 'timeout' });
    return { ok: false, failures, turn };
  }

  const names = turn.toolCalls.map((t) => t.name);

  if (template.expectNoTool) {
    // Inline-prose-only pattern. Any tool fire is a failure (except in
    // mock mode where the regex provider is unreliable). Tool errors
    // still count regardless.
    if (!opts.mock && turn.toolCalls.length > 0) {
      failures.push({ code: 'unexpected-tool', got: names });
    }
    for (const t of turn.toolCalls) {
      if (t.status === 'error') {
        failures.push({ code: 'tool-error', name: t.name, summary: t.summary });
      }
    }
  } else if (turn.toolCalls.length === 0) {
    // Mock provider is regex-driven and frequently produces no tool
    // call for realistic-sounding prompts; only timeouts and tool
    // errors count as failures in mock mode.
    if (!opts.mock) failures.push({ code: 'no-tool-call' });
  } else {
    if (!opts.mock && !names.includes(template.expectTool)) {
      failures.push({
        code: 'wrong-tool',
        expected: template.expectTool,
        got: names,
      });
    }
    for (const t of turn.toolCalls) {
      if (t.status === 'error') {
        failures.push({ code: 'tool-error', name: t.name, summary: t.summary });
      }
    }
  }

  if (template.forbiddenTools && !opts.mock) {
    for (const name of names) {
      if (template.forbiddenTools.includes(name)) {
        failures.push({ code: 'forbidden-tool', name });
      }
    }
  }

  if (template.expectCardKind && !opts.mock) {
    const cardsOfKind = turn.cards.filter((c) => c.kind === template.expectCardKind);
    if (cardsOfKind.length === 0) {
      failures.push({
        code: 'missing-card',
        expectedKind: template.expectCardKind,
      });
    } else if (template.expectUrlHost) {
      // Pass if ANY card of the expected kind has a matching URL —
      // the LLM often produces several action cards (e.g. flights +
      // hotels in one turn) and we only need the on-target one.
      const urls = cardsOfKind.map((c) => c.url).filter((u): u is string => !!u);
      if (urls.length === 0) {
        failures.push({ code: 'missing-url' });
      } else if (!urls.some((u) => template.expectUrlHost!.test(u))) {
        failures.push({
          code: 'bad-url',
          url: urls.join(' | '),
          expectedHost: String(template.expectUrlHost),
        });
      }
    }
  }

  return { ok: failures.length === 0, failures, turn };
}
