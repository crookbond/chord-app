#!/usr/bin/env node
/**
 * parse-trip.mjs — standalone trip parser
 *
 * Usage:
 *   node scripts/parse-trip.mjs <path-to-pdf>
 *   node scripts/parse-trip.mjs <path-to-pdf> --raw   # show raw LLM text too
 *
 * Reads LLM credentials from the repo-root .env (same keys the server uses).
 * Outputs structured trip JSON to stdout.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// ── .env loading ─────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadEnv() {
  try {
    const text = await fs.readFile(path.join(REPO_ROOT, '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    // no .env — rely on actual env vars
  }
}

// ── PDF text extraction ───────────────────────────────────────────────────────

function ensurePdfjsGlobals() {
  const g = globalThis;
  if (!g.DOMMatrix) g.DOMMatrix = class DOMMatrix {};
  if (!g.ImageData) {
    g.ImageData = class ImageData {
      constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
    };
  }
  if (!g.Path2D) {
    g.Path2D = class Path2D {
      constructor() { this._cmds = []; }
      moveTo(x, y) { this._cmds.push(['moveTo', x, y]); }
      lineTo(x, y) { this._cmds.push(['lineTo', x, y]); }
      closePath() { this._cmds.push(['closePath']); }
    };
  }
  if (!process.getBuiltinModule) {
    process.getBuiltinModule = (name) => name === 'module' ? { createRequire } : undefined;
  }
}

async function extractPdfText(filePath) {
  ensurePdfjsGlobals();
  const { PDFParse } = await import('pdf-parse');
  const buf = await fs.readFile(filePath);
  const parser = new PDFParse({ data: buf });
  try {
    const res = await parser.getText();
    return res.text ?? '';
  } finally {
    await parser.destroy();
  }
}

// ── LLM call ─────────────────────────────────────────────────────────────────

async function callLlm(messages, maxTokens = 1200) {
  const baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const apiKey = process.env.OPENAI_API_KEY || '';
  const model = process.env.OPENAI_MODEL || 'gpt-5.4-mini';

  if (!apiKey) throw new Error('OPENAI_API_KEY not set — add it to .env or environment');

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.1 }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LLM HTTP ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// ── Trip extraction prompt ────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a travel document parser. Extract ALL trip details from the provided text and return them as JSON only — no prose, no markdown fences.

Return exactly this shape:
{
  "trip": {
    "name": "short descriptive name",
    "destination": "primary destination city/region (not airport code)",
    "startDate": "YYYY-MM-DD",
    "endDate": "YYYY-MM-DD",
    "participants": ["full name", ...]
  },
  "legs": [
    {
      "mode": "flight|train|car|ferry|other",
      "origin": "city or airport",
      "destination": "city or airport",
      "departAt": "YYYY-MM-DDTHH:MM:00",
      "arriveAt": "YYYY-MM-DDTHH:MM:00",
      "carrier": "airline name or null",
      "flightNo": "flight number or null",
      "confirmation": "confirmation code or null",
      "personaName": "passenger name or null"
    }
  ],
  "accommodations": [
    {
      "propertyName": "hotel or property name",
      "address": "address or null",
      "checkinDate": "YYYY-MM-DD",
      "checkoutDate": "YYYY-MM-DD",
      "confirmation": "confirmation code or null"
    }
  ],
  "reservations": [
    {
      "kind": "restaurant|tour|event|activity|other",
      "name": "name",
      "dateTime": "YYYY-MM-DDTHH:MM:00 or null",
      "address": "address or null",
      "confirmation": "confirmation code or null",
      "notes": "notes or null"
    }
  ]
}

Rules:
- List EVERY flight leg separately. A round trip needs two leg objects.
- Use the exact origin/destination text from the document (city name preferred over code).
- If a time has no timezone info, leave it without timezone (bare ISO datetime).
- If a field is missing/unknown, use null.
- participants: list every named traveller on the booking.
- startDate = earliest departure date; endDate = latest arrival date.
- Return valid JSON only.`;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const showRaw = args.includes('--raw');
  const filePath = args.find(a => !a.startsWith('-'));

  if (!filePath) {
    console.error('Usage: node scripts/parse-trip.mjs <path-to-pdf> [--raw]');
    process.exit(1);
  }

  await loadEnv();

  const absPath = path.resolve(filePath);
  console.error(`Reading: ${absPath}`);

  const ext = path.extname(absPath).toLowerCase();
  let rawText;

  if (ext === '.pdf') {
    console.error('Extracting PDF text...');
    rawText = await extractPdfText(absPath);
  } else {
    rawText = await fs.readFile(absPath, 'utf8');
  }

  if (!rawText.trim()) {
    console.error('ERROR: No text extracted from file. Is it a scanned image PDF?');
    process.exit(1);
  }

  console.error(`Extracted ${rawText.length} characters. Sending to LLM...`);
  if (showRaw) {
    console.error('\n--- EXTRACTED TEXT ---\n');
    console.error(rawText.slice(0, 8000));
    console.error('\n--- END EXTRACTED TEXT ---\n');
  }

  const truncated = rawText.slice(0, 12_000);
  const llmReply = await callLlm([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Parse this travel document:\n\n---\n${truncated}\n---` },
  ], 1500);

  if (showRaw) {
    console.error('\n--- RAW LLM REPLY ---\n');
    console.error(llmReply);
    console.error('\n--- END RAW LLM REPLY ---\n');
  }

  // Strip any accidental markdown fences the LLM added
  const cleaned = llmReply
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.error('ERROR: LLM returned non-JSON. Full reply:');
    console.error(llmReply);
    process.exit(1);
  }

  // Pretty-print the result to stdout
  console.log(JSON.stringify(parsed, null, 2));

  // Summary to stderr
  const t = parsed.trip ?? {};
  const legs = parsed.legs ?? [];
  const stays = parsed.accommodations ?? [];
  console.error(`\nSummary:`);
  console.error(`  Trip:     ${t.name ?? '?'}  ${t.startDate} → ${t.endDate}`);
  console.error(`  Dest:     ${t.destination}`);
  console.error(`  People:   ${(t.participants ?? []).join(', ') || '(none found)'}`);
  console.error(`  Legs:     ${legs.length}`);
  for (const l of legs) {
    console.error(`    ${l.origin} → ${l.destination}  ${l.departAt?.slice(0, 10) ?? ''}  ${l.carrier ?? ''} ${l.flightNo ?? ''}  ${l.personaName ?? ''}`);
  }
  console.error(`  Stays:    ${stays.length}`);
  for (const s of stays) {
    console.error(`    ${s.propertyName}  ${s.checkinDate} → ${s.checkoutDate}`);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
