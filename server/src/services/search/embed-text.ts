/**
 * What a vector is made from (ADR 0276). Built from what Chord already has -
 * no new summary is generated - and kept short: the subject, who wrote to
 * whom, where the classifier filed it, the facts already extracted from it,
 * and the start of the first and latest messages, read through the one body
 * reader so hidden text never reaches the embedding (ADR 0268).
 */
import { bodyForModel } from '../../utils/email-text.js';

export interface ThreadEmbedInput {
  subject: string | null;
  fromName: string | null;
  fromEmail: string | null;
  toEmails: string[];
  category: string | null;
  facts: string[];
  firstBody: string;
  latestBody: string;
}

const FIRST_CHARS = 1200;
const LATEST_CHARS = 800;

export function threadEmbeddingText(t: ThreadEmbedInput): string {
  const lines = [
    t.subject ? `Subject: ${t.subject}` : '',
    t.fromName || t.fromEmail ? `From: ${[t.fromName, t.fromEmail && `<${t.fromEmail}>`].filter(Boolean).join(' ')}` : '',
    t.toEmails.length ? `To: ${t.toEmails.slice(0, 5).join(', ')}` : '',
    t.category ? `Filed under: ${t.category}` : '',
    ...t.facts,
    t.firstBody.slice(0, FIRST_CHARS),
    t.latestBody && t.latestBody !== t.firstBody ? t.latestBody.slice(0, LATEST_CHARS) : '',
  ];
  return lines.filter(Boolean).join('\n').replace(/\s+\n/g, '\n').trim();
}

export function messageBody(m: { html?: string | null; text?: string | null; excerpt?: string | null }): string {
  return bodyForModel(m).replace(/\s+/g, ' ').trim();
}

/** A stored fact as one readable line; unknown shapes are skipped, never guessed. */
export function factLines(facts: { receipt?: unknown; delivery?: unknown; flight?: unknown }): string[] {
  const out: string[] = [];
  const r = facts.receipt as { merchant?: string; amount?: number; currency?: string } | null | undefined;
  if (r && r.merchant) out.push(`Receipt: ${r.merchant}${r.amount != null ? ` ${r.amount} ${r.currency ?? ''}` : ''}`.trim());
  const d = facts.delivery as { tracking?: { carrier?: string } | null; etaAt?: string | null } | null | undefined;
  if (d) out.push(`Package delivery${d.tracking?.carrier ? ` by ${d.tracking.carrier}` : ''}${d.etaAt ? `, arriving ${d.etaAt.slice(0, 10)}` : ''}`);
  const f = facts.flight as { ident?: string; origin?: string | null; destination?: string | null } | null | undefined;
  if (f) out.push(`Flight${f.ident ? ` ${f.ident}` : ''}${f.origin ? ` from ${f.origin}` : ''}${f.destination ? ` to ${f.destination}` : ''}`);
  return out;
}

/**
 * About two single-spaced pages (~500 words, ~3,000 characters a page): where a
 * form, letter or itinerary says what it is. ~1,500 tokens, well inside the
 * embedding model's input.
 */
export const FILE_TEXT_CHARS = 6000;

export function attachmentEmbeddingText(a: { filename: string; summary: string | null; text: string | null }): string {
  return [`File: ${a.filename}`, a.summary ?? '', (a.text ?? '').replace(/\s+/g, ' ').slice(0, FILE_TEXT_CHARS)].filter(Boolean).join('\n');
}
