/**
 * Does a name the model passed for "which group" / "which calendar" just mean
 * the asker themselves?
 *
 * Prod: `create_event` arrived four times with `withGroupName: "/personal"`.
 * The self-word check was an exact match on "personal", the slash failed it,
 * and the event was refused each time. A model spells "me" many ways
 * ("/personal", "personal calendar", "my own default calendar", "just me"),
 * so the name is reduced to its words, the filler ones are dropped, and what
 * is left is compared.
 */
const FILLER = new Set([
  'calendar',
  'calendars',
  'group',
  'chat',
  'the',
  'a',
  'my',
  'own',
  'only',
  'just',
  'default',
  'account',
  'on',
  'to',
]);

const SELF = new Set(['me', 'myself', 'self', 'mine', 'i', 'personal', 'private', 'primary']);

export function isSelfReference(name: string): boolean {
  const words = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return false;
  const rest = words.filter((w) => !FILLER.has(w));
  // "my calendar", "my own": nothing but filler around an implied "me".
  if (rest.length === 0) return words.some((w) => w === 'my' || w === 'own' || w === 'default');
  return rest.every((w) => SELF.has(w));
}
