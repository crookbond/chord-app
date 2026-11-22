import type { ToolCall, ToolName } from './tools.js';
import { toolSchemas } from './tools.js';

/** Matches ```chord-tool …``` fences (non-greedy, multiline). */
const FENCE = /```chord-tool\s*([\s\S]*?)```/g;

export interface ParsedReply {
  /** The text with all chord-tool fences stripped. */
  cleanBody: string;
  /** Tool calls extracted and validated against zod. Invalid ones are dropped. */
  calls: ToolCall[];
  /** Parse-warnings we want to log (malformed JSON, unknown tool name, validation fail). */
  warnings: string[];
}

export function parseReply(text: string): ParsedReply {
  const calls: ToolCall[] = [];
  const warnings: string[] = [];
  const cleanBody = text
    .replace(FENCE, (_match, payload: string) => {
      try {
        const obj = JSON.parse(payload.trim()) as { name?: string; args?: unknown };
        const name = obj.name as ToolName | undefined;
        if (!name || !(name in toolSchemas)) {
          warnings.push(`unknown tool: ${String(name)}`);
          return '';
        }
        const schema = toolSchemas[name];
        const parsed = schema.safeParse(obj.args);
        if (!parsed.success) {
          warnings.push(`invalid args for ${name}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
          return '';
        }
        calls.push({ name, args: parsed.data });
        return '';
      } catch (err) {
        warnings.push(`malformed chord-tool JSON: ${(err as Error).message}`);
        return '';
      }
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { cleanBody, calls, warnings };
}
