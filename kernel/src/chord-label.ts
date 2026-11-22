/**
 * ADR 0142 — provider-side form of a Chord label.
 *
 * Display names live in `chord_label_ids`; the mailbox tag is always
 * `Chord/<name>` so it does not collide with ordinary user labels. IMAP
 * keywords are atoms and cannot carry spaces or several specials — encode
 * those into a safe atom rather than STORE-and-hope.
 */

/** Gmail label name / Outlook category string for a Chord display name. */
export function chordProviderLabel(displayName: string): string {
  const name = displayName.trim();
  return name ? `Chord/${name}` : 'Chord';
}

/**
 * IMAP keyword atom for a Chord display name.
 * Atoms cannot include spaces or: ( ) { % * " \\ ]. Encode the display
 * portion as base64url so every Unicode name round-trips; decode is only
 * needed if we ever read keywords back — which ADR 0142 forbids.
 */
export function chordImapKeyword(displayName: string): string {
  const name = displayName.trim();
  const payload = Buffer.from(name, 'utf8').toString('base64url');
  return `Chord_${payload}`;
}
