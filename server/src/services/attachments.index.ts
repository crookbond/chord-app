/**
 * ADR 0021 + ADR 0038 — attachment chunk index.
 *
 * Chunks every indexed attachment's extracted_text + image OCR +
 * summary into ~200-word paragraph rows in the `attachment_chunks`
 * table. Postgres stores a `tsvector GENERATED ALWAYS AS
 * (to_tsvector('english', content)) STORED` column with a GIN index
 * (porter English stemming, matching the SQLite FTS5 tokenizer we
 * used before the cutover). At query time we use `to_tsquery` +
 * `ts_rank_cd` + `ts_headline` to produce a ranked list of chunks
 * with «match»-marked snippets.
 *
 * Pure functions (`chunkText`) live alongside the IO helpers so the
 * unit tests can exercise the splitter without a database.
 */
import { sql, type Kysely } from 'kysely';

import { env } from '../config/env.js';
import { indexKeyFor, sealField } from '../db/crypto/index.js';
import type { DB } from '../db/schema.js';
import { buildWordsQuery, buildWordsVector, headline, queryStems } from '../utils/blind-index.js';

export type ChunkKind = 'summary' | 'ocr' | 'text' | 'caption' | 'keyfacts' | 'questions';

export interface AttachmentChunk {
  attachmentId: string;
  chunkIdx: number;
  kind: ChunkKind;
  content: string;
  charOffset: number;
}

export interface ChunkSearchHit {
  attachmentId: string;
  chunkIdx: number;
  kind: ChunkKind;
  /**
   * Inverted rank score: lower is better. Built from `-ts_rank_cd` so
   * the JS-side filename boost (which subtracts a constant) still
   * pulls boosted rows to the front of an ascending sort. The legacy
   * name is preserved so callers don't churn — semantically it's now
   * "negative cover-density rank" rather than BM25.
   */
  bm25: number;
  /** Snippet with «match» markers around hits and … on truncation boundaries. */
  snippet: string;
  /** The chunk's whole text, so a caller can check which query words it holds
   *  as whole words (ADR 0288). Server-side only. */
  content: string;
}

const MAX_WORDS_PER_CHUNK = 200;

/**
 * Paragraph-aware splitter. Splits on blank lines first; any paragraph
 * longer than `maxWords` is further split into word-bounded windows so
 * one giant blob doesn't become one giant chunk.
 *
 * Returns the chunk content and the byte offset of its start in the
 * original text (handy for future page citations / re-indexing without
 * re-extraction). Empty / whitespace-only chunks are dropped.
 */
export function chunkText(
  text: string,
  maxWords = MAX_WORDS_PER_CHUNK,
): Array<{ content: string; offset: number }> {
  if (!text || !text.trim()) return [];
  const out: Array<{ content: string; offset: number }> = [];
  // Split keeping offsets — track cursor through the original string.
  const paragraphs = text.split(/\n\s*\n/);
  let cursor = 0;
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (trimmed.length === 0) {
      cursor += para.length + 2; // approximate; double newline length
      continue;
    }
    const offsetInOriginal = text.indexOf(para, cursor);
    cursor = offsetInOriginal + para.length;

    const words = trimmed.split(/\s+/);
    if (words.length <= maxWords) {
      out.push({ content: trimmed, offset: offsetInOriginal });
      continue;
    }
    // Long paragraph — slice into word windows. Offsets within a
    // sub-paragraph are approximate (we don't re-walk the source); good
    // enough for snippet display.
    for (let i = 0; i < words.length; i += maxWords) {
      const slice = words.slice(i, i + maxWords).join(' ');
      out.push({ content: slice, offset: offsetInOriginal });
    }
  }
  return out;
}

interface ImageMetaParts {
  caption: string;
  keyFacts: string;
  ocrText: string;
}

function partsFromImageMeta(raw: string | null): ImageMetaParts {
  const empty = { caption: '', keyFacts: '', ocrText: '' };
  if (!raw) return empty;
  try {
    const v = JSON.parse(raw) as {
      caption?: unknown;
      keyFacts?: unknown;
      ocrText?: unknown;
    };
    return {
      caption: typeof v.caption === 'string' ? v.caption : '',
      keyFacts: Array.isArray(v.keyFacts)
        ? (v.keyFacts as unknown[]).filter((x) => typeof x === 'string').join('\n')
        : '',
      ocrText: typeof v.ocrText === 'string' ? v.ocrText : '',
    };
  } catch {
    return empty;
  }
}

/**
 * Re-index a single attachment. Idempotent — wipes any existing chunks
 * for the row before inserting fresh ones. Safe to call from extraction
 * completion, copyAttachmentToGroup, and the migration backfill.
 */
export async function indexAttachmentChunks(
  db: Kysely<DB>,
  attachmentId: string,
): Promise<void> {
  const row = await db
    .selectFrom('attachments')
    .select(['id', 'scope_id', 'filename', 'summary', 'extracted_text', 'image_meta', 'answerable_questions'])
    .where('id', '=', attachmentId)
    .executeTakeFirst();
  if (!row) return;

  await removeAttachmentChunks(db, attachmentId);

  const inserts: AttachmentChunk[] = [];
  let idx = 0;

  // ADR 0021 Tier-2 — index the generated "answerable questions" first, at the
  // highest kind weight, so a user's question phrasing matches here even when
  // the document's prose uses different words.
  const questions = (row.answerable_questions ?? '').trim();
  if (questions) {
    inserts.push({
      attachmentId: row.id,
      chunkIdx: idx++,
      kind: 'questions',
      content: questions,
      charOffset: 0,
    });
  }

  const summary = (row.summary ?? '').trim();
  if (summary) {
    inserts.push({
      attachmentId: row.id,
      chunkIdx: idx++,
      kind: 'summary',
      content: summary,
      charOffset: 0,
    });
  }

  const imageParts = partsFromImageMeta(row.image_meta);

  const caption = imageParts.caption.trim();
  if (caption) {
    inserts.push({
      attachmentId: row.id,
      chunkIdx: idx++,
      kind: 'caption',
      content: caption,
      charOffset: 0,
    });
  }

  const keyFacts = imageParts.keyFacts.trim();
  if (keyFacts) {
    inserts.push({
      attachmentId: row.id,
      chunkIdx: idx++,
      kind: 'keyfacts',
      content: keyFacts,
      charOffset: 0,
    });
  }

  const ocr = imageParts.ocrText.trim();
  for (const c of chunkText(ocr)) {
    inserts.push({
      attachmentId: row.id,
      chunkIdx: idx++,
      kind: 'ocr',
      content: c.content,
      charOffset: c.offset,
    });
  }

  for (const c of chunkText(row.extracted_text ?? '')) {
    inserts.push({
      attachmentId: row.id,
      chunkIdx: idx++,
      kind: 'text',
      content: c.content,
      charOffset: c.offset,
    });
  }

  if (inserts.length === 0) return;

  // ADR 0201 - the chunk text is sealed under the attachment's owner and
  // indexed by keyed hashes; the filename stays readable, as it is on the
  // attachment row, and is folded into the index so a filename-only hit works.
  const key = await indexKeyFor(row.scope_id);
  for (const c of inserts) {
    const stored = await sealField(row.scope_id, 'attachment_chunks:content', c.content);
    const blind = buildWordsVector(key, c.content, row.filename);
    await sql`
      INSERT INTO attachment_chunks (attachment_id, chunk_idx, kind, filename, content, blind_words)
      VALUES (${c.attachmentId}, ${c.chunkIdx}, ${c.kind}, ${row.filename}, ${stored}, ${blind}::tsvector)
    `.execute(db);
    await sql`
      INSERT INTO attachment_chunk_meta (attachment_id, chunk_idx, kind, char_offset)
      VALUES (${c.attachmentId}, ${c.chunkIdx}, ${c.kind}, ${c.charOffset})
    `.execute(db);
  }
}

export async function removeAttachmentChunks(
  db: Kysely<DB>,
  attachmentId: string,
): Promise<void> {
  await sql`DELETE FROM attachment_chunks WHERE attachment_id = ${attachmentId}`.execute(db);
  await sql`DELETE FROM attachment_chunk_meta WHERE attachment_id = ${attachmentId}`.execute(db);
}

/**
 * Postgres `to_tsquery` wants tokens joined by operators (`&`, `|`),
 * with `:*` for prefix matches. Our user input ("@Chord what time is
 * the soccer game") is plain prose. Strip non-alphanumerics, keep
 * tokens ≥3 chars, OR them together as prefix-matched terms — same
 * tolerant-typo behavior the old FTS5 `"foo"* OR "bar"*` query had.
 *
 * Returns null when nothing remains after cleaning, so callers can
 * short-circuit without issuing a query.
 */
function buildTsQuery(rawKeywords: string[]): string | null {
  const cleaned = rawKeywords
    .map((k) => k.replace(/[^a-zA-Z0-9]+/g, '').toLowerCase())
    .filter((k) => k.length >= 3);
  if (cleaned.length === 0) return null;
  return cleaned.map((k) => `${k}:*`).join(' | ');
}

/**
 * Run a tsvector-ranked search across the chunk index. Caller passes
 * the candidate set of attachment IDs visible to the triggering user
 * — we filter inside the SQL (cheaper than post-filtering once N
 * grows). The JS-side filename boost is preserved so the user typing
 * a keyword that literally names the file gets that file first.
 */
/** Per-chunk-kind rank boost (subtracted from bm25 — lower is better). A hit in
 *  the LLM summary or extracted key-facts is a stronger relevance signal than a
 *  hit buried in raw body/OCR text. (ADR 0021 Tier-1.) */
const KIND_BOOST: Record<ChunkKind, number> = {
  questions: 4,
  summary: 3,
  keyfacts: 3,
  caption: 2,
  text: 0,
  ocr: 0,
};

interface ChunkRow {
  attachment_id: string;
  chunk_idx: number;
  kind: ChunkKind;
  filename: string;
  content: string;
  rank: number;
  snippet: string;
}

const CHUNK_HEADLINE = { open: '«', close: '»', maxWords: 32, lead: 8 } as const;

/**
 * The chunks matching a query, best first (ADR 0201). A chunk's text is sealed
 * under its attachment's OWNER (a group or a user), and its index is keyed by
 * that owner, so a search across several groups is one query per owner: the
 * candidates are grouped by owner and each group is asked in its own key. The
 * snippet is built in the application from the opened chunk, since
 * `ts_headline` cannot read ciphertext.
 *
 * Chunks written before the index (no `blind_words`) are read through the old
 * generated tsvector while `CONTENT_LEGACY_TSV` is on.
 */
async function fetchChunkRows(
  db: Kysely<DB>,
  keywords: string[],
  candidateIds: string[],
  tsQuery: string,
  overshoot: number,
): Promise<ChunkRow[]> {
  const cleaned = keywords
    .map((k) => k.replace(/[^a-zA-Z0-9]+/g, '').toLowerCase())
    .filter((k) => k.length >= 3);
  const stems = queryStems(cleaned);
  const out: ChunkRow[] = [];

  const owners = await db.selectFrom('attachments').select(['id', 'scope_id']).where('id', 'in', candidateIds).execute();
  const byOwner = new Map<string, string[]>();
  for (const o of owners) {
    const list = byOwner.get(o.scope_id) ?? [];
    list.push(o.id);
    byOwner.set(o.scope_id, list);
  }

  for (const [owner, ids] of byOwner) {
    const key = await indexKeyFor(owner, false);
    if (!key) continue;
    const q = buildWordsQuery(key, cleaned);
    if (!q.words) continue;
    const res = await sql<Omit<ChunkRow, 'snippet'>>`
      SELECT attachment_id, chunk_idx, kind, filename, content,
             ts_rank_cd(blind_words, ${q.words}::tsquery) AS rank
      FROM attachment_chunks
      WHERE blind_words @@ ${q.words}::tsquery
        AND attachment_id IN (${sql.join(ids)})
      ORDER BY rank DESC
      LIMIT ${overshoot}
    `.execute(db);
    for (const r of res.rows) out.push({ ...r, snippet: headline(r.content, stems, undefined, CHUNK_HEADLINE) });
  }

  if (env.CONTENT_LEGACY_TSV) {
    const res = await sql<ChunkRow>`
      SELECT
        attachment_id, chunk_idx, kind, filename, content,
        ts_rank_cd(body_tsv, to_tsquery('english', ${tsQuery})) AS rank,
        ts_headline(
          'english',
          content,
          to_tsquery('english', ${tsQuery}),
          'MaxFragments=1, MaxWords=32, MinWords=8, StartSel=«, StopSel=», ShortWord=2'
        ) AS snippet
      FROM attachment_chunks
      WHERE blind_words IS NULL
        AND body_tsv @@ to_tsquery('english', ${tsQuery})
        AND attachment_id IN (${sql.join(candidateIds)})
      ORDER BY rank DESC
      LIMIT ${overshoot}
    `.execute(db);
    out.push(...res.rows);
  }

  out.sort((a, b) => Number(b.rank) - Number(a.rank));
  return out.slice(0, overshoot);
}

export async function searchAttachmentChunks(
  db: Kysely<DB>,
  opts: {
    keywords: string[];
    candidateIds: string[];
    limit: number;
    /** Tier-1 ranking: coordination (more query terms matched ⇒ higher) +
     *  per-kind weighting. Off by default so the baseline path is unchanged. */
    ranking?: 'baseline' | 'weighted';
  },
): Promise<ChunkSearchHit[]> {
  if (opts.candidateIds.length === 0) return [];
  const tsQuery = buildTsQuery(opts.keywords);
  if (!tsQuery) return [];
  const weighted = opts.ranking === 'weighted';

  // Pull a wider set than `limit` so the JS-side filename boost has
  // room to re-rank without losing real hits. ts_rank_cd's column-length
  // normalization can flatten a filename hit against a long body hit;
  // the deterministic JS post-rank below restores the intended ordering.
  const overshoot = Math.max(opts.limit * 4, 24);
  const result = { rows: await fetchChunkRows(db, opts.keywords, opts.candidateIds, tsQuery, overshoot) };

  const lowered = opts.keywords.map((k) => k.toLowerCase()).filter((k) => k.length >= 3);
  const hits = result.rows.map((r) => {
    const filenameLower = r.filename.toLowerCase();
    const filenameMatched = lowered.some((k) => filenameLower.includes(k));
    // The `bm25` field is "lower is better" by API contract. Flip the
    // ts_rank_cd sign (rank: higher is better → `-rank`: lower is better)
    // and subtract a constant when the filename matched. Magnitude (10)
    // is generous relative to typical ts_rank_cd values (~0.01–1.0) and
    // mirrors the old FTS5 boost so callers see the same ordering.
    let bm25 = -r.rank;
    if (filenameMatched) bm25 -= 10;
    if (weighted) {
      // Coordination: prefer chunks that match MORE distinct query terms — an
      // AND-preference that keeps OR recall. Lexical prefix check on the raw
      // text approximates the stemmed match well enough to rank with.
      const hay = `${filenameLower} ${r.content.toLowerCase()}`;
      const matched = lowered.filter((k) => hay.includes(k)).length;
      bm25 -= Math.max(0, matched - 1) * 4;
      bm25 -= KIND_BOOST[r.kind] ?? 0;
    }
    return {
      attachmentId: r.attachment_id,
      chunkIdx: r.chunk_idx,
      kind: r.kind,
      bm25,
      snippet: r.snippet,
      content: r.content,
    };
  });
  hits.sort((a, b) => a.bm25 - b.bm25);
  return hits.slice(0, opts.limit);
}
