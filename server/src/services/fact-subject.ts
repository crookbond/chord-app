/**
 * ADR 0333 — who a fact is about, from the name someone used.
 *
 * One rule for every writer (chat extraction, `remember_fact`): an exact name
 * wins; otherwise a name matches a person when every word of it is one of
 * that person's name words ("Ben" → "Ben Doe"), and only when exactly
 * one person matches. Several = ask, none = nothing is saved. A fact is never
 * filed under the speaker, or under the whole family, because a name did not
 * match: that is how one person's ID number was answered for another.
 *
 * Kinds are tried in order — a chat member, then a managed persona on the
 * family roster, then the speaker's own saved person — so the same human
 * known both as a member and as a contact resolves to the member, as before.
 */

import { hasWord, words } from '../utils/whole-words.js';

export type FactSubjectKind = 'user' | 'persona' | 'person';

/**
 * Does the text name the person a fact label is for? Any word of their name
 * ("Ben" for "Ben Doe"). "Family"/"Someone" are not people. A surname
 * shared by the family names all of them, which only ever shows MORE facts,
 * each still labelled.
 */
export function namesPerson(text: ReadonlySet<string>, about: string): boolean {
  if (about === 'Family' || about === 'Someone') return false;
  const parts = words(about).filter((w) => w.length >= 2);
  return parts.length > 0 && parts.some((p) => hasWord(text, p));
}

/**
 * The people a question is about, among these labels. A name word only one
 * of them has ("Ben") decides it; a word they share ("Doe") counts only
 * when nothing more specific was said.
 */
export function peopleNamed(text: ReadonlySet<string>, labels: Iterable<string>): Set<string> {
  const people = [...new Set(labels)].filter((l) => l !== 'Family' && l !== 'Someone');
  const freq = new Map<string, number>();
  for (const l of people) for (const w of new Set(words(l))) freq.set(w, (freq.get(w) ?? 0) + 1);
  const specific = people.filter((l) => words(l).some((w) => w.length >= 2 && freq.get(w) === 1 && hasWord(text, w)));
  return new Set(specific.length > 0 ? specific : people.filter((l) => namesPerson(text, l)));
}

export interface FactSubjectCandidate {
  kind: FactSubjectKind;
  id: string;
  /** Names this subject goes by: display name, username. */
  names: string[];
  /** Ids of other candidates that are this same human (a roster persona's
   *  linked People row), so matching both is one person, not two. */
  sameAs?: string[];
}

export type FactSubjectResult =
  | { kind: 'one'; subject: { kind: FactSubjectKind; id: string; name: string } }
  | { kind: 'ambiguous'; candidates: Array<{ kind: FactSubjectKind; id: string; name: string }> }
  | { kind: 'none' };

const KIND_ORDER: FactSubjectKind[] = ['user', 'persona', 'person'];

function nameWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function normal(s: string): string {
  return nameWords(s).join(' ');
}

function pickByKind(
  hits: Array<{ c: FactSubjectCandidate; name: string }>,
): FactSubjectResult | null {
  if (hits.length === 0) return null;
  for (const kind of KIND_ORDER) {
    const ofKind = hits.filter((h) => h.c.kind === kind);
    // The same subject can match on two of its names; count subjects, not names.
    const ids = [...new Set(ofKind.map((h) => h.c.id))];
    if (ids.length === 1) {
      const h = ofKind[0];
      return { kind: 'one', subject: { kind: h.c.kind, id: h.c.id, name: h.c.names[0] ?? h.name } };
    }
    if (ids.length > 1) {
      return {
        kind: 'ambiguous',
        candidates: ids.map((id) => {
          const h = ofKind.find((x) => x.c.id === id)!;
          return { kind: h.c.kind, id, name: h.c.names[0] ?? h.name };
        }),
      };
    }
  }
  return null;
}

export function resolveFactSubject(name: string, candidates: FactSubjectCandidate[]): FactSubjectResult {
  const needle = normal(name);
  if (!needle) return { kind: 'none' };

  // Only a FULL name is exact. A username is usually a first name, so it is
  // matched like one below, where another person sharing it makes a question.
  const exact: Array<{ c: FactSubjectCandidate; name: string }> = [];
  for (const c of candidates) {
    const full = c.names[0];
    if (full && normal(full) === needle) exact.push({ c, name: full });
  }
  const byExact = pickByKind(exact);
  if (byExact) return byExact;

  const asked = nameWords(name);
  const partial: Array<{ c: FactSubjectCandidate; name: string }> = [];
  for (const c of candidates) {
    for (const n of c.names) {
      if (!n) continue;
      const words = new Set(nameWords(n));
      if (asked.every((w) => words.has(w))) {
        partial.push({ c, name: n });
        break;
      }
    }
  }
  // A first name shared by a member and a contact is two people, not one:
  // unlike an exact match, a partial match across kinds is ambiguous.
  const same = new Set<string>();
  for (const p of partial) for (const id of p.c.sameAs ?? []) same.add(id);
  const distinct = partial.filter((p) => !same.has(p.c.id));
  const kinds = new Set(distinct.map((p) => p.c.kind));
  if (kinds.size > 1) {
    const ids = new Map(distinct.map((p) => [p.c.id, p]));
    return {
      kind: 'ambiguous',
      candidates: [...ids.values()].map((p) => ({ kind: p.c.kind, id: p.c.id, name: p.c.names[0] ?? p.name })),
    };
  }
  return pickByKind(distinct) ?? { kind: 'none' };
}

/**
 * Candidates from what a chat knows: its members, its managed roster personas
 * and the speaker's saved people. A persona and its linked People row are one
 * human, and so is a saved person with exactly a member's or persona's name.
 */
export function factSubjectCandidates(input: {
  members: Array<{ userId: string; username: string; displayName: string | null }>;
  personas: Array<{ id: string; name: string; isManaged: boolean; linkedPersonId: string | null }>;
  people: Array<{ id: string; displayName: string }>;
}): FactSubjectCandidate[] {
  const namedLike = (name: string | null) =>
    name ? input.people.filter((p) => normal(p.displayName) === normal(name)).map((p) => p.id) : [];
  const out: FactSubjectCandidate[] = [];
  for (const m of input.members) {
    out.push({ kind: 'user', id: m.userId, names: [m.displayName ?? m.username, m.username], sameAs: namedLike(m.displayName) });
  }
  for (const p of input.personas) {
    if (!p.isManaged) continue;
    out.push({
      kind: 'persona',
      id: p.id,
      names: [p.name],
      sameAs: [...(p.linkedPersonId ? [p.linkedPersonId] : []), ...namedLike(p.name)],
    });
  }
  for (const p of input.people) out.push({ kind: 'person', id: p.id, names: [p.displayName] });
  return out;
}
