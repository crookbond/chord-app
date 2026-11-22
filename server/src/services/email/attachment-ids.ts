import type { EmailAttachmentRef } from '@chord/kernel';

/**
 * A re-read part list with the ids the stored list already had. Gmail hands
 * out a new attachment id on every read of a message (the old ones keep
 * working), so rewriting the list after a re-read changed every id under a
 * reader that was still holding the previous ones, and its downloads 404'd.
 * A part keeps its old id when the old list has one with the same name, type,
 * size and Content-ID that no other part has claimed.
 */
export function keepAttachmentIds(
  previous: EmailAttachmentRef[] | null | undefined,
  next: EmailAttachmentRef[],
): EmailAttachmentRef[] {
  const pool = [...(previous ?? [])];
  return next.map((part) => {
    const i = pool.findIndex(
      (p) =>
        p.filename === part.filename &&
        p.mimeType === part.mimeType &&
        p.size === part.size &&
        (p.contentId ?? null) === (part.contentId ?? null),
    );
    if (i < 0) return part;
    const [old] = pool.splice(i, 1);
    return { ...part, id: old!.id };
  });
}
