/**
 * Common English given-name nicknames, both directions (ADR 0270).
 *
 * Used when a person is asked for by name: "emails from Bill" must find
 * William, and "from Bob" must find Robert. Deliberately a short list of the
 * forms people actually use; a name not here matches only itself.
 */
const GROUPS: string[][] = [
  ['william', 'bill', 'billy', 'will', 'willy', 'liam'],
  ['robert', 'bob', 'bobby', 'rob', 'robbie', 'bert'],
  ['richard', 'rick', 'ricky', 'rich', 'dick'],
  ['james', 'jim', 'jimmy', 'jamie'],
  ['john', 'johnny', 'jack'],
  ['jonathan', 'jon', 'jonny'],
  ['joseph', 'joe', 'joey'],
  ['michael', 'mike', 'mikey', 'mick'],
  ['thomas', 'tom', 'tommy'],
  ['christopher', 'chris', 'kit'],
  ['christina', 'christine', 'chris', 'tina'],
  ['daniel', 'dan', 'danny'],
  ['david', 'dave', 'davey'],
  ['matthew', 'matt'],
  ['anthony', 'tony'],
  ['andrew', 'andy', 'drew'],
  ['steven', 'stephen', 'steve'],
  ['edward', 'ed', 'eddie', 'ted', 'ned'],
  ['charles', 'charlie', 'chuck', 'chas'],
  ['benjamin', 'ben', 'benny'],
  ['samuel', 'sam', 'sammy'],
  ['samantha', 'sam', 'sammy'],
  ['alexander', 'alex', 'al', 'xander', 'sasha'],
  ['alexandra', 'alex', 'alexa', 'sasha'],
  ['nicholas', 'nick', 'nicky'],
  ['patrick', 'pat', 'paddy'],
  ['patricia', 'pat', 'patty', 'trish'],
  ['peter', 'pete'],
  ['gregory', 'greg'],
  ['timothy', 'tim', 'timmy'],
  ['kenneth', 'ken', 'kenny'],
  ['ronald', 'ron', 'ronnie'],
  ['donald', 'don', 'donnie'],
  ['lawrence', 'larry'],
  ['frederick', 'fred', 'freddie'],
  ['henry', 'hank', 'harry'],
  ['harold', 'harry', 'hal'],
  ['elizabeth', 'liz', 'lizzie', 'beth', 'betsy', 'betty', 'eliza', 'libby'],
  ['katherine', 'catherine', 'kathryn', 'kate', 'katie', 'kathy', 'cathy', 'kat'],
  ['margaret', 'maggie', 'meg', 'peggy', 'marge'],
  ['jennifer', 'jen', 'jenny'],
  ['jessica', 'jess', 'jessie'],
  ['rebecca', 'becky', 'becca'],
  ['susan', 'sue', 'susie'],
  ['deborah', 'debra', 'deb', 'debbie'],
  ['victoria', 'vicky', 'tori'],
  ['abigail', 'abby'],
  ['kimberly', 'kim'],
  ['jacqueline', 'jackie'],
  ['theodore', 'theo', 'ted', 'teddy'],
  ['vincent', 'vince', 'vinny'],
  ['zachary', 'zach', 'zack'],
  ['joshua', 'josh'],
  ['jacob', 'jake'],
  ['nathan', 'nathaniel', 'nate'],
  ['gabriel', 'gabe'],
  ['raymond', 'ray'],
  ['leonard', 'leo', 'len', 'lenny'],
  ['douglas', 'doug'],
  ['phillip', 'philip', 'phil'],
  ['jeffrey', 'geoffrey', 'jeff'],
];

const VARIANTS = new Map<string, Set<string>>();
for (const g of GROUPS) {
  for (const name of g) {
    const set = VARIANTS.get(name) ?? new Set<string>([name]);
    for (const other of g) set.add(other);
    VARIANTS.set(name, set);
  }
}

/** Every form of a given name, lower-case, including the name itself. */
export function nameVariants(name: string): string[] {
  const n = name.toLowerCase();
  return [...(VARIANTS.get(n) ?? new Set([n]))];
}
