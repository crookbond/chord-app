import type { AttachmentWithExcerpts } from './retrieval.js';

export interface CitationInput {
  attachments: AttachmentWithExcerpts[];
  groupId: string;
  /** Files a file tool (look_at_attachment, reference_file, send_file) used this turn. */
  usedFileIds: ReadonlySet<string>;
}

const MAX_CITED = 4;

/**
 * The files the "based on:" row names under a reply (ADR 0288 + addendum
 * 2026-10-25): only one a file tool (look_at_attachment, reference_file,
 * send_file) reached this turn. Being in the prompt is not enough, and neither
 * is the reply repeating words the file also holds — a /plan reply repeating a
 * to-do read with list_tasks was footed with two club statements whose text
 * held the same words.
 *
 * Only files permissioned to *this group* are named: a retrieved attachment
 * with `owningGroupId !== groupId` is visible to the triggering user but not
 * necessarily to the other members (ADR 0004), and its filename goes out on
 * the group's SSE channel.
 */
export function citedFiles(input: CitationInput): AttachmentWithExcerpts[] {
  const { attachments, groupId, usedFileIds } = input;
  const seen = new Set<string>();
  return attachments
    .filter((a) => {
      if (a.owningGroupId !== groupId || seen.has(a.id)) return false;
      seen.add(a.id);
      return usedFileIds.has(a.id);
    })
    .slice(0, MAX_CITED);
}
