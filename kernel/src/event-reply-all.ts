/**
 * ADR 0306 — write to everyone on a calendar event. The calendar sheet, the
 * bot card and the composer share these so "who gets it" has one answer.
 */

/**
 * Organizer first, then the guests; lowercased, each once, and never one of
 * the writer's own addresses (`exclude`).
 */
export function eventReplyAllRecipients(
  guests: readonly string[] | null | undefined,
  organizer: string | null | undefined,
  exclude: readonly (string | null | undefined)[] = [],
): string[] {
  const mine = new Set(exclude.filter((e): e is string => !!e).map((e) => e.trim().toLowerCase()));
  const out: string[] = [];
  for (const raw of [organizer, ...(guests ?? [])]) {
    const a = raw?.trim().toLowerCase();
    if (!a || !a.includes('@') || mine.has(a) || out.includes(a)) continue;
    out.push(a);
  }
  return out;
}

/** The composer route, prefilled with these recipients and the event's title. */
export function eventComposeHref(to: readonly string[], subject: string): string {
  const q = [`to=${encodeURIComponent(to.join(', '))}`];
  if (subject.trim()) q.push(`subject=${encodeURIComponent(subject.trim())}`);
  return `/email/compose?${q.join('&')}`;
}
