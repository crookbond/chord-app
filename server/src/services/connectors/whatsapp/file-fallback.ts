/**
 * What a WhatsApp recipient is told when a file could not be sent (ADR 0140).
 *
 * One rule with two callers, for the reason ADR 0122 extracted its SSRF guard:
 * the two transports fail for unrelated reasons — Meta can genuinely fail an
 * upload, Twilio cannot send media at all without hosting the file publicly —
 * but what the recipient deserves to hear is identical, and two copies of that
 * sentence is how they stop being identical.
 *
 * The old behaviour on both was to log a warning and send the message body,
 * which for `send_file` is the bare filename. That reads as a delivered file
 * and leaves no way to reach it — ADR 0107's failure, on the outbound path.
 */
export function undeliverableFileText(filename: string, moreUrl?: string): string {
  const head = `I couldn't attach "${filename}" here.`;
  return moreUrl ? `${head} It's in Chord: ${moreUrl}` : `${head} It's in the Chord app.`;
}
