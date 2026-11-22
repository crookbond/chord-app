/**
 * Whose ask is it? The email suggestion pass has the model name the person an
 * item is asked of ("Ash", "Geoff", or "me"), and this decides in code whether
 * that is someone ELSE on the email, in which case the user gets no card.
 *
 * A model asked to judge "is this mine?" answered "me" for both prod cases
 * (an ask to Ash with the user on Cc; times offered to Geoff that mention the
 * user), so the judgment is ours: the model only reports the name it read.
 * A name that matches nobody on the email ("parents", "everyone") is kept,
 * and so is one that matches the user: dropping is only for a name that
 * matches another person on From / To / Cc.
 */

export interface AskPeople {
  /** The user's names and addresses. */
  me: readonly string[];
  /** Everyone else on the message: names and addresses. */
  others: readonly string[];
}

const SELF = new Set(['me', 'you', 'recipient', 'us', 'we', 'everyone', 'all', 'both']);
const FILLER = new Set(['and', 'the', 'of', 'to', 'mr', 'mrs', 'ms', 'dr']);

/** Words of a name or an address's local part, lowercased. */
function words(s: string): string[] {
  const at = s.indexOf('@');
  const part = at === -1 ? s : s.slice(0, at);
  return part
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 2 && !FILLER.has(w));
}

/** "Ash" names "ashton"; a word of at least three letters may be a short form. */
function names(word: string, of: readonly string[]): boolean {
  const pool = of.flatMap(words);
  return pool.some((t) => t === word || (word.length >= 3 && t.startsWith(word)) || (t.length >= 3 && word.startsWith(t)));
}

export function askedSomeoneElse(askedOf: string | undefined, people: AskPeople): boolean {
  if (!askedOf) return false;
  const asked = words(askedOf);
  if (asked.length === 0 || asked.every((w) => SELF.has(w))) return false;
  if (asked.some((w) => names(w, people.me))) return false;
  return asked.some((w) => !SELF.has(w) && names(w, people.others));
}
