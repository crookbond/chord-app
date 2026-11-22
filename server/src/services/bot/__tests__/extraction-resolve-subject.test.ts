/**
 * docs/notes/0189 — `resolveSubject` (bot/extraction.ts) gained a third
 * fallback, against the sender's own private `people` list, after group
 * member and managed persona. Pure-function unit test: a group member wins
 * a name collision over a persona, which wins over a private person, which
 * wins over leaving the subject unresolved.
 */
import type { Persona } from '@chord/kernel';
import { describe, expect, it } from 'vitest';

import { resolveSubject } from '../extraction.js';
import type { PersonWithDates } from '../../people.service.js';

const persona = (over: Partial<Persona>): Persona => ({
  id: 'pers_x',
  groupId: 'g1',
  memberUserId: null,
  name: 'Ben',
  householdRole: 'child',
  isManaged: true,
  managedBy: 'u_parent',
  birthdate: null,
  linkedPersonId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const person = (over: Partial<PersonWithDates>): PersonWithDates => ({
  id: 'p_x',
  ownerUserId: 'u1',
  displayName: 'Alice',
  notes: null,
  email: null,
  phone: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  importantDates: [],
  ...over,
});

describe('resolveSubject', () => {
  it('"self" always resolves to the sender', () => {
    expect(resolveSubject('self', 'u1', [], [], [])).toEqual({ kind: 'user', id: 'u1' });
  });

  it('resolves an unmanaged member by username or display name', () => {
    const members = [{ userId: 'u2', username: 'sam', displayName: 'Sam Doe' }];
    expect(resolveSubject('sam', 'u1', members, [], [])).toEqual({ kind: 'user', id: 'u2' });
    expect(resolveSubject('Sam Doe', 'u1', members, [], [])).toEqual({ kind: 'user', id: 'u2' });
  });

  it('falls back to a managed persona when no member matches', () => {
    const ben = persona({ id: 'pers_ben', name: 'Ben' });
    expect(resolveSubject('ben', 'u1', [], [ben], [])).toEqual({ kind: 'persona', id: 'pers_ben' });
  });

  it("falls back to the sender's private people list when neither matches (docs/notes/0189)", () => {
    const alice = person({ id: 'p_alice', displayName: 'Alice' });
    expect(resolveSubject('alice', 'u1', [], [], [alice])).toEqual({ kind: 'person', id: 'p_alice' });
  });

  it('a real member wins a name collision over a persona or a private person', () => {
    const members = [{ userId: 'u2', username: 'ben', displayName: null }];
    const benPersona = persona({ id: 'pers_ben', name: 'ben' });
    const benPerson = person({ id: 'p_ben', displayName: 'ben' });
    expect(resolveSubject('ben', 'u1', members, [benPersona], [benPerson])).toEqual({
      kind: 'user',
      id: 'u2',
    });
  });

  it('a managed persona wins a name collision over a private person', () => {
    const benPersona = persona({ id: 'pers_ben', name: 'ben' });
    const benPerson = person({ id: 'p_ben', displayName: 'ben' });
    expect(resolveSubject('ben', 'u1', [], [benPersona], [benPerson])).toEqual({
      kind: 'persona',
      id: 'pers_ben',
    });
  });

  it('returns null when nothing matches', () => {
    expect(resolveSubject('a total stranger', 'u1', [], [], [])).toBeNull();
  });
});
