/**
 * Role words (ADR 0275): "the dentist" is not a name, so it is matched against
 * what a sender or contact says it is. Whole words only, so a newsletter about
 * "dentalplans" is not the dentist.
 */
import { describe, expect, it } from 'vitest';

import { contactIsRole, matchDeviceContactsByRole, mentionsRole, roleTerms } from '@chord/kernel';

describe('matchDeviceContactsByRole', () => {
  const book = [
    { name: 'Mei Chen', company: 'Smile Studio Orthodontics', emails: [{ email: 'hello@smilestudio.test' }] },
    { name: 'Raj Patel', jobTitle: 'Dentist', phoneNumbers: [{ number: '555-0100' }] },
    { name: 'Dentalplans Sales', company: 'Dentalplans Inc' },
    { name: 'Ann Lee', company: 'Acme', emails: [{ email: 'ann@acme.test' }] },
  ];

  it('finds the role in the company or the job title, entries with an email first', () => {
    const got = matchDeviceContactsByRole(roleTerms('dentist')!, book);
    expect(got.map((m) => m.name)).toEqual(['Mei Chen', 'Raj Patel']);
    expect(got[0]).toMatchObject({ emails: ['hello@smilestudio.test'], company: 'Smile Studio Orthodontics' });
  });

  it('sends nothing for an entry that is not the role', () => {
    expect(matchDeviceContactsByRole(roleTerms('plumber')!, book)).toEqual([]);
  });

  // device-contact-lookup.ts read every entry's emails and phones to answer
  // "the dentist"; it now reads names/companies/titles for the whole book and
  // details only for these candidates, so the prefilter must agree with the match.
  it('picks the same entries from names, companies and titles alone', () => {
    const terms = roleTerms('dentist')!;
    const bare = book.map(({ name, company, jobTitle }: { name: string; company?: string; jobTitle?: string }) => ({ name, company, jobTitle }));
    expect(bare.filter((c) => contactIsRole(terms, c)).map((c) => c.name)).toEqual(
      matchDeviceContactsByRole(terms, book).map((m) => m.name).sort(),
    );
  });
});

describe('roleTerms', () => {
  it.each(['dentist', 'the dentist', 'my Dentist', 'dentists', "the dentist's"])('reads %s as the dentist', (q) => {
    expect(roleTerms(q)).toContain('dental');
  });

  it("reads a casual form: the kids' doctor is the pediatrician", () => {
    expect(roleTerms("the kids doctor")).toContain('pediatrician');
  });

  it('is null for a name', () => {
    expect(roleTerms('Bill Smith')).toBeNull();
    expect(roleTerms('Ann')).toBeNull();
  });
});

describe('mentionsRole', () => {
  const dentist = roleTerms('dentist')!;
  const school = roleTerms('school')!;

  it('finds the role as a whole word', () => {
    expect(mentionsRole('Bright Smiles Dental', dentist)).toBe(true);
    expect(mentionsRole('Lincoln Elementary Office', school)).toBe(true);
    expect(mentionsRole('Smith Middle School PTA', school)).toBe(true);
  });

  it('does not match inside another word', () => {
    expect(mentionsRole('Dentalplans Weekly', dentist)).toBe(false);
    expect(mentionsRole('Schoolhouse Rock Records', school)).toBe(false);
  });

  it('is false for nothing', () => {
    expect(mentionsRole(null, dentist)).toBe(false);
  });
});
