/**
 * Extract and repair a JSON object / array from a model response that may
 * contain markdown fences, preamble text, trailing commas, or truncated output.
 * Ported from `john-app/src/extract/llm.ts` with no behaviour changes.
 */

export function extractJson(raw: string): string {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1].trim() : raw;

  const start = candidate.search(/[{[]/);
  if (start === -1) return candidate;

  return repairJson(extractBalanced(candidate, start));
}

export function parseJsonLoose(raw: string): unknown {
  const cleaned = extractJson(raw);
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/**
 * Parse a JSON object out of an LLM response. Strips one optional ```...```
 * fence, then takes the slice from the first `{` to the last `}` (greedy
 * outer-most). Returns null on any parse failure or non-object result.
 *
 * Use this for prompts that ask the model for a single top-level object
 * (e.g. content classifier, trip classifier, vision extraction). For
 * arbitrary JSON with possible trailing commas / mid-stream truncation,
 * reach for `parseJsonLoose` instead.
 */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const v = JSON.parse(stripped.slice(start, end + 1));
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Parse a JSON array out of an LLM response. Strips an optional ```...```
 * fence, tries a full parse first (handles `[…]` directly without text
 * around it), then falls back to extracting the first `[...]` block via
 * regex. Returns null when no array can be recovered.
 *
 * Use this for prompts that ask the model for a top-level array
 * (extraction, completion eval, form-field resolver).
 */
export function parseJsonArray(raw: string): unknown[] | null {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const v = JSON.parse(trimmed);
    if (Array.isArray(v)) return v;
  } catch {
    // fall through to regex extraction
  }
  const m = trimmed.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function extractBalanced(s: string, start: number): string {
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return s.slice(start);
}

function repairJson(s: string): string {
  s = s.replace(/,\s*([}\]])/g, '$1');

  const stack: string[] = [];
  let inString = false;
  let escape = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }

  if (inString) s += '"';
  while (stack.length) s += stack.pop();

  return s;
}
