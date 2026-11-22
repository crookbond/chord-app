import type { GmailApi, GmailLabel } from '../google/gmail-api.js';

/** How Gmail tells two label names apart: not by case or spacing. A name that
 *  differs from an existing label only in those is refused with a 409. */
const labelKey = (name: string): string => name.trim().replace(/\s+/g, ' ').toLowerCase();

/** The label Gmail would treat as `name`, if the list has one. */
export function findLabel(labels: GmailLabel[], name: string): GmailLabel | undefined {
  return labels.find((l) => l.name === name) ?? labels.find((l) => labelKey(l.name) === labelKey(name));
}

/**
 * The id of the label called `name`, creating it only when the mailbox has no
 * label Gmail would treat as the same. `labels` is the caller's list and gains
 * what this creates. The exact-name lookup this replaces missed a label that
 * differed only in case ("Chord/Kids & School" for a category now titled
 * "Kids & school"), so every pass tried to create it again and Gmail refused
 * (prod: 237 refusals on 2026-10-26). A refusal re-reads the list, since the
 * label may have been made in Gmail after `labels` was read.
 */
export async function findOrCreateGmailLabel(
  api: GmailApi,
  labels: GmailLabel[],
  name: string,
): Promise<GmailLabel> {
  const found = findLabel(labels, name);
  if (found) return found;
  try {
    const created = await api.createLabel(name);
    labels.push(created);
    return created;
  } catch (err) {
    const fresh = findLabel(await api.listLabels(), name);
    if (fresh) {
      labels.push(fresh);
      return fresh;
    }
    throw err;
  }
}
