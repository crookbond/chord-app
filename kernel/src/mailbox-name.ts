/**
 * What a mailbox is called on screen (ADR 0145).
 *
 * One rule, in kernel, because the chip row, the per-row account badge and
 * Settings all render the same mailbox and must agree about its name — three
 * copies of a fallback chain is how they stop agreeing.
 *
 * The fallback is deliberately the ADR 0119 rule it replaces: the local part,
 * which is what tells two of someone's own mailboxes apart in the space a chip
 * has. A nickname simply wins when there is one.
 */

/**
 * Whether the user has any mailbox to read: the primary Gmail OR an attached
 * one (ADR 0080). `EmailStatus.connected` means the primary Gmail only, so an
 * account with just Outlook (Sign in with Microsoft, ADR 0293) has
 * `connected: false` and still has mail.
 */
export function hasAnyMailbox(
  status: { connected: boolean; accounts?: readonly unknown[] } | null | undefined,
): boolean {
  if (!status) return false;
  return status.connected || (status.accounts?.length ?? 0) > 0;
}

/**
 * The mailboxes the user can filter by: `'primary'` (the Gmail on the user row,
 * ADR 0080) only when that Gmail is connected, then each attached mailbox's id.
 * Listing `'primary'` unconditionally showed an Outlook-only account a Gmail
 * chip that filtered to nothing.
 */
export function mailboxFilterIds(
  status: { connected: boolean; accounts?: readonly { id: string }[] } | null | undefined,
): string[] {
  if (!status) return [];
  return [...(status.connected ? ['primary'] : []), ...(status.accounts ?? []).map((a) => a.id)];
}

/** The mailbox part of an address: `family@yahoo.example` reads as `family`. */
export function mailboxLocalPart(address: string): string {
  return address.split('@')[0] || address;
}

/**
 * Display name for an attached mailbox.
 *
 * `nickname` is whitespace-tolerant: a nickname of spaces is not a name, and
 * must fall back rather than render an invisible chip.
 */
export function mailboxDisplayName(
  nickname: string | null | undefined,
  emailAddress: string,
): string {
  const nick = nickname?.trim();
  return nick || mailboxLocalPart(emailAddress);
}

/** Display name for the primary Gmail, which has no account row (ADR 0080). */
export function primaryMailboxDisplayName(nickname: string | null | undefined): string {
  return nickname?.trim() || 'Gmail';
}

/** Longest nickname we store. Chips are narrow; this is already generous. */
export const MAILBOX_NICKNAME_MAX = 40;

/**
 * Normalize a nickname for storage: trimmed, or null when the user cleared it.
 *
 * Null is how a mailbox goes back to its default name, so an empty string from
 * a cleared text field must not be stored as a nickname that renders blank.
 */
export function normalizeMailboxNickname(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, MAILBOX_NICKNAME_MAX) : null;
}
