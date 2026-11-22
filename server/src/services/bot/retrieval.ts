import type { Kysely } from 'kysely';

import type { AttachmentsTable, DB } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { hasWord, wordSet } from '../../utils/whole-words.js';
import {
  type ChunkKind,
  searchAttachmentChunks,
} from '../attachments.index.js';
import { fileSimilarities } from '../search/semantic.js';

export interface RetrievedAttachment {
  id: string;
  filename: string;
  summary: string | null;
  extractedText: string | null;
  indexedAt: string | null;
  pinned: number;
  created_at: string;
  /** Not injected into the prompt — used for the cross-group fallback signal. */
  owningGroupId: string | null;
  /** The on-disk blob is gone (routes/files.ts stamps this on a 404 download).
   *  The extracted text/summary below is still whatever was captured at
   *  upload time — real, but the model must not imply the file itself can
   *  still be opened, sent, or referenced with a card. */
  blobMissing: boolean;
}

// Note: `extracted_text` is deliberately NOT in this row. It's large and only
// the top FULLTEXT_DOC_CAP docs get it inlined into the prompt, so the bulk
// visibility query skips it and `hydrateFulltext` fetches it for just those few.
export type AttachmentRow = Pick<
  AttachmentsTable,
  | 'id'
  | 'filename'
  | 'summary'
  | 'indexed_at'
  | 'pinned'
  | 'created_at'
  | 'scope_kind'
  | 'scope_id'
  | 'blob_missing_at'
>;

// The token rules live in utils so the blind index builds documents by the same
// rules queries are read by; re-exported so existing imports keep working.
import { extractKeywords } from '../../utils/keywords.js';
export { STOPWORDS, extractKeywords } from '../../utils/keywords.js';

const CAP_TOTAL = 12;
const CAP_PINNED = 6;

async function fetchAttachmentsVisibleTo(
  db: Kysely<DB>,
  opts: { groupId: string; userId: string },
): Promise<AttachmentRow[]> {
  const membership = await db
    .selectFrom('group_members')
    .innerJoin('groups', 'groups.id', 'group_members.group_id')
    .select(['group_members.tier', 'groups.adults_only'])
    .where('group_members.group_id', '=', opts.groupId)
    .where('group_members.user_id', '=', opts.userId)
    .executeTakeFirst();
  const groupBlocked = membership?.adults_only === 1 && membership.tier === 'guest';

  return db
    .selectFrom('attachments')
    .select([
      'attachments.id as id',
      'attachments.filename as filename',
      'attachments.summary as summary',
      'attachments.indexed_at as indexed_at',
      'attachments.pinned as pinned',
      'attachments.created_at as created_at',
      'attachments.scope_kind as scope_kind',
      'attachments.scope_id as scope_id',
      'attachments.blob_missing_at as blob_missing_at',
    ])
    .where((eb) =>
      groupBlocked
        ? eb('uploaded_by', '=', opts.userId)
        : eb.or([
            eb.and([eb('scope_kind', '=', 'group'), eb('scope_id', '=', opts.groupId)]),
            eb('uploaded_by', '=', opts.userId),
          ]),
    )
    .execute();
}

function toRetrieved(row: AttachmentRow): RetrievedAttachment {
  return {
    id: row.id,
    filename: row.filename,
    summary: row.summary,
    // Full text isn't in the bulk row; hydrateFulltext fills it for the top docs.
    extractedText: null,
    indexedAt: row.indexed_at,
    pinned: row.pinned,
    created_at: row.created_at,
    owningGroupId: row.scope_kind === 'group' ? row.scope_id : null,
    blobMissing: row.blob_missing_at != null,
  };
}

/** How many of the top-ranked docs get their full `extracted_text` inlined into
 *  the prompt. Owned here (retrieval decides what to hydrate); context imports
 *  it so the inlining cap and the hydration cap can't drift apart. */
export const FULLTEXT_DOC_CAP = 2;

/**
 * Fetch `extracted_text` for the first FULLTEXT_DOC_CAP entries only — the ones
 * `attachmentBlock` actually inlines — and patch it onto them. Keeps the large
 * column out of the per-turn bulk visibility scan over every visible file.
 */
async function hydrateFulltext<T extends { id: string; extractedText: string | null }>(
  db: Kysely<DB>,
  ordered: T[],
): Promise<T[]> {
  const ids = ordered.slice(0, FULLTEXT_DOC_CAP).map((a) => a.id);
  if (ids.length === 0) return ordered;
  const rows = await db
    .selectFrom('attachments')
    .select(['id', 'extracted_text'])
    .where('id', 'in', ids)
    .execute();
  const textById = new Map(rows.map((r) => [r.id, r.extracted_text]));
  return ordered.map((a, idx) =>
    idx < FULLTEXT_DOC_CAP ? { ...a, extractedText: textById.get(a.id) ?? null } : a,
  );
}

export interface RetrievedExcerpt {
  /** Chunk index within the source attachment (handy for citations / dedup). */
  chunkIdx: number;
  kind: ChunkKind;
  /** ts_headline() output — `«match»` markers + `…` truncation. */
  snippet: string;
}

export interface AttachmentWithExcerpts extends RetrievedAttachment {
  excerpts: RetrievedExcerpt[];
}

const MAX_EXCERPTS_PER_TURN = 10;
/** Chunk hits fetched before the relevance check thins them (ADR 0288), so a
 *  file with a real match is not crowded out by one-word hits on others. */
const CHUNK_CANDIDATES = 60;

/**
 * Does a file match one of the trigger's messages well enough to go in the
 * prompt on words alone (ADR 0288)? `retrievalText` is several human messages
 * joined by newlines; each is judged on its own, so a long conversation does
 * not make every file look relevant by pooling words.
 *
 * A message qualifies the file when a real word of it (4+ letters) is a word of
 * the filename, or when at least two of its words — and at least half of them —
 * are whole words of the file's matching chunks. One generic word ("Friday",
 * "date") hits every contract and decides nothing.
 */
export function wordsQualifyFile(retrievalText: string, filename: string, chunkTexts: string[]): boolean {
  const nameWords = wordSet(filename);
  const bodyWords = wordSet(chunkTexts.join(' '));
  for (const line of retrievalText.split('\n')) {
    const keys = extractKeywords(line);
    if (keys.length === 0) continue;
    if (keys.some((k) => k.length >= 4 && hasWord(nameWords, k))) return true;
    const matched = keys.filter((k) => hasWord(bodyWords, k) || hasWord(nameWords, k)).length;
    if (matched >= 2 && matched * 2 >= keys.length) return true;
  }
  return false;
}

/**
 * ADR 0021 — pulls visible attachments AND their best-matching paragraph
 * excerpts. Replaces the old "rank attachments by filename+summary, then
 * dump the first 4k chars of up to 3 files" path.
 *
 * Pipeline:
 *   1. Compute the user-visible candidate set.
 *   2. Empty-keyword path → return pinned files only, no excerpts.
 *   3. Otherwise rank chunks across the candidate set, group by attachment.
 *   4. ADR 0288 — keep a file only if it is relevant: by meaning when it has a
 *      vector of the user's embedding model (similarity at least
 *      `RETRIEVAL_SEMANTIC_MIN_SIM`, and it may come in with no word in
 *      common), else by `wordsQualifyFile`. Pinned files are kept as before.
 */
export async function selectExcerptsForTurn(
  db: Kysely<DB>,
  opts: { groupId: string; triggeringUserId: string; triggerText: string },
): Promise<AttachmentWithExcerpts[]> {
  const rows = await fetchAttachmentsVisibleTo(db, {
    groupId: opts.groupId,
    userId: opts.triggeringUserId,
  });
  if (rows.length === 0) return [];

  const keywords = extractKeywords(opts.triggerText);
  const pinned = rows.filter((r) => r.pinned).slice(0, CAP_PINNED);

  if (keywords.length === 0) {
    // No usable keywords — same fallback as before: surface pinned files
    // only, no excerpts. The bot will still see the file's summary.
    return hydrateFulltext(db, pinned.map((r) => ({ ...toRetrieved(r), excerpts: [] })));
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  const candidateIds = rows.map((r) => r.id);
  const [hits, similarity] = await Promise.all([
    searchAttachmentChunks(db, { keywords, candidateIds, limit: CHUNK_CANDIDATES }),
    opts.triggeringUserId
      ? fileSimilarities(db, opts.triggeringUserId, opts.triggerText, candidateIds)
      : Promise.resolve(null),
  ]);

  const chunksById = new Map<string, string[]>();
  for (const h of hits) {
    const arr = chunksById.get(h.attachmentId) ?? [];
    arr.push(h.content);
    chunksById.set(h.attachmentId, arr);
  }
  const relevant = (id: string): boolean => {
    const sim = similarity?.get(id);
    if (sim !== undefined) return sim >= env.RETRIEVAL_SEMANTIC_MIN_SIM;
    const row = byId.get(id);
    return !!row && wordsQualifyFile(opts.triggerText, row.filename, chunksById.get(id) ?? []);
  };

  const grouped = new Map<string, RetrievedExcerpt[]>();
  const ordered: AttachmentWithExcerpts[] = [];
  const seen = new Set<string>();
  let excerptCount = 0;
  // Hits-first preserves rank ordering.
  for (const h of hits) {
    if (!relevant(h.attachmentId)) continue;
    if (excerptCount < MAX_EXCERPTS_PER_TURN) {
      const arr = grouped.get(h.attachmentId) ?? [];
      arr.push({ chunkIdx: h.chunkIdx, kind: h.kind, snippet: h.snippet });
      grouped.set(h.attachmentId, arr);
      excerptCount += 1;
    }
    if (seen.has(h.attachmentId)) continue;
    const row = byId.get(h.attachmentId);
    if (!row) continue;
    seen.add(h.attachmentId);
    ordered.push({ ...toRetrieved(row), excerpts: [] });
  }
  for (const a of ordered) a.excerpts = grouped.get(a.id) ?? [];
  // Close in meaning but sharing no word with the question: in on its summary.
  if (similarity) {
    const byMeaning = [...similarity.entries()]
      .filter(([id, sim]) => !seen.has(id) && sim >= env.RETRIEVAL_SEMANTIC_MIN_SIM)
      .sort((x, y) => y[1] - x[1]);
    for (const [id] of byMeaning) {
      const row = byId.get(id);
      if (!row) continue;
      seen.add(id);
      ordered.push({ ...toRetrieved(row), excerpts: [] });
    }
  }
  // Pinned files without hits still get appended so the bot can fall back on
  // summary alone.
  for (const r of pinned) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    ordered.push({ ...toRetrieved(r), excerpts: [] });
  }
  return hydrateFulltext(db, ordered.slice(0, CAP_TOTAL));
}
