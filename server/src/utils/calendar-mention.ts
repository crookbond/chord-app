/**
 * The calendar names a message might be asking for: "add to Neural Calendar
 * - call with Gautam" says "Neural". Read back from the word "calendar" for
 * up to four words, stopping at a preposition ("to", "on", "from", ...) or a
 * "my"/"the"/"a", so "call on Thursday to Neural calendar" gives "Neural",
 * not "Thursday to Neural".
 *
 * No preposition is needed in front: "Rudderstack calendar: add ..." at the
 * start of a message names one too. Every tail of the words is offered,
 * longest first ("Neural Magic calendar" offers "Neural Magic", then
 * "Magic"): the caller keeps one only when a real calendar of the user's
 * answers to it, so the list of calendars decides, not the grammar (prod
 * 2026-11-17, "From Rudderstack calendar" fell to the default because the
 * old reading needed "to"/"on"/"in"/"into"/"onto" in front of the name).
 *
 * A possessive ("John's calendar") is someone's calendar, which is the
 * event's assignee, not a calendar name, so it is left out.
 */
const STOPS = new Set(['to', 'on', 'in', 'into', 'onto', 'from', 'for', 'using', 'with', 'via', 'at', 'off']);
const DETERMINERS = new Set(['my', 'the', 'our', 'a', 'an', 'your', 'his', 'her', 'their']);
const MAX_NAME_WORDS = 4;

export function calendarNamesSaidIn(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const names: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (!/^cal(?:endar)?\b/i.test(words[i].replace(/^[^\p{L}]+/u, ''))) continue;
    const name: string[] = [];
    let j = i - 1;
    while (j >= 0 && name.length < MAX_NAME_WORDS) {
      const raw = words[j];
      const w = raw.toLowerCase().replace(/[^\p{L}\p{N}'’&._@-]/gu, '');
      if (!w) break;
      if (STOPS.has(w) || DETERMINERS.has(w)) break;
      // Punctuation ending a word ("Gautam, Neural calendar") ends the name.
      if (name.length > 0 && /[,;:!?()]$/.test(raw)) break;
      name.unshift(raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''));
      j--;
    }
    if (name.length === 0) continue;
    const said = name.join(' ').trim();
    if (!said || /['’]s$/i.test(said)) continue;
    for (let k = 0; k < name.length; k++) {
      const tail = name.slice(k).join(' ').trim();
      if (tail && !names.includes(tail)) names.push(tail);
    }
  }
  return names;
}
