/** What a failed invitation answer says (ADR 0104). The server's reason is the
 *  error message; each one has a different next step. */
export function rsvpErrorText(err: unknown): string {
  switch ((err as Error | null)?.message) {
    case 'no_google':
      return "Couldn't reply — reconnect Google in Settings.";
    case 'no_organizer':
      return "Couldn't tell who sent this. Reply from your email instead.";
    case 'send_failed':
      return "Couldn't reach the organizer. Try again in a moment.";
    default:
      return "Couldn't send your reply — nothing was changed.";
  }
}
