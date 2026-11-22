/** ADR 0333 — one rule for who a fact is about, from the name someone used. */
import { describe, expect, it } from 'vitest';

import { factSubjectCandidates, peopleNamed, resolveFactSubject } from '@/services/fact-subject.js';

const people = [
  { id: 'p_ben', displayName: 'Ben Doe' },
  { id: 'p_nolan', displayName: 'Nolan Doe' },
];

describe('resolveFactSubject', () => {
  it('a first name finds the one saved person who has it (the prod case: "Ben" for "Ben Doe")', () => {
    const r = resolveFactSubject("Ben's", factSubjectCandidates({ members: [], personas: [], people }));
    expect(r).toEqual({ kind: 'one', subject: { kind: 'person', id: 'p_ben', name: 'Ben Doe' } });
  });

  it('two people with the name is a question, never a guess', () => {
    const r = resolveFactSubject(
      'Ben',
      factSubjectCandidates({ members: [], personas: [], people: [...people, { id: 'p_ben2', displayName: 'Ben Rao' }] }),
    );
    expect(r.kind).toBe('ambiguous');
  });

  it('a surname alone shared by the family is a question', () => {
    expect(resolveFactSubject('Doe', factSubjectCandidates({ members: [], personas: [], people })).kind).toBe('ambiguous');
  });

  it('nobody by that name is nothing', () => {
    expect(resolveFactSubject('Nimbus', factSubjectCandidates({ members: [], personas: [], people })).kind).toBe('none');
  });

  it('a roster persona and its linked People row are one person', () => {
    const r = resolveFactSubject(
      'Ben',
      factSubjectCandidates({
        members: [],
        personas: [{ id: 'pers_ben', name: 'Ben Doe', isManaged: true, linkedPersonId: 'p_ben' }],
        people,
      }),
    );
    expect(r).toEqual({ kind: 'one', subject: { kind: 'persona', id: 'pers_ben', name: 'Ben Doe' } });
  });

  it('a member and a different contact sharing a first name is a question', () => {
    const r = resolveFactSubject(
      'Priya',
      factSubjectCandidates({
        members: [{ userId: 'u_priya', username: 'priya', displayName: 'Priya Shah' }],
        personas: [],
        people: [{ id: 'p_priya', displayName: 'Priya Kumar' }],
      }),
    );
    expect(r.kind).toBe('ambiguous');
  });

  it('an exact full name wins over first-name matches', () => {
    const r = resolveFactSubject(
      'Ben Rao',
      factSubjectCandidates({ members: [], personas: [], people: [...people, { id: 'p_ben2', displayName: 'Ben Rao' }] }),
    );
    expect(r).toEqual({ kind: 'one', subject: { kind: 'person', id: 'p_ben2', name: 'Ben Rao' } });
  });
});

describe('peopleNamed', () => {
  const labels = ['Ben Doe', 'Nolan Doe', 'John Doe', 'Family'];
  it('a name word only one person has decides it', () => {
    expect([...peopleNamed(new Set(['ben', 'doe', 'global', 'entry']), labels)]).toEqual(['Ben Doe']);
  });
  it('a shared surname alone names everyone who has it', () => {
    expect(peopleNamed(new Set(['doe', 'passport']), labels).size).toBe(3);
  });
});
