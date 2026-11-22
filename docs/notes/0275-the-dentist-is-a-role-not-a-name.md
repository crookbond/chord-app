# 0275 — "The dentist" is a role, not a name

**Status:** Accepted, 2026-10-19. Extends ADR 0270; uses ADR 0212's phone lookup.

## Context

ADR 0270 resolves a person asked for by name. Families just as often ask for
someone by what they are: "mail from the dentist", "what did the school send",
"the plumber's quote". Nobody is called Dentist, so the name match found no
one, the words went back into the text, and the eval's "mail from the
dentist" returned nothing at all — though the mail was right there from
"Bright Smiles Dental".

What a role IS lives in four places, none of them a name:

- **People** (ADR 0076): free-text notes the user wrote ("our dentist").
- **Saved contacts**: an organisation, a note, tags — but no email.
- **Senders' own names**: "Bright Smiles Dental", "Lincoln Elementary Office".
- **The phone's address book**: company and job title. Never uploaded
  (ADR 0065); reachable only by ADR 0212's live, personal-chat-only lookup,
  which until now matched names only.

## Decision

- **A role vocabulary** (`kernel/src/roles.ts`): about twenty roles a family
  deals with, each with specific whole-word terms (dentist → dental, DDS,
  orthodontics; school → elementary, PTA, academy, school district). Loose
  terms ("health", "care", "electric") are left out on purpose: they would
  make every newsletter a dentist. A word not in the list is not a role, and
  is searched as a word.
- **When a name matches nobody and the word is a role**, `resolveCorrespondent`
  looks, strongest first:
  1. People whose notes or name mention it;
  2. saved contacts whose organisation, note or tags do — then that contact's
     NAME is resolved among the user's correspondents, since it has no email;
  3. senders whose own name, or address local part, says it (a robot address
     like noreply@ counts only under a name that says so, ADR 0270's rule).
  The domain is NOT read: "dental" inside `brightsmilesdental` cannot be told
  apart from `dentalplansweekly`, a newsletter.
- **A role does not ask "which one?"** Every sender that is the school is the
  school; up to ten addresses stand for one role.
- **Then the phone.** If the server places no one, the search tool asks the
  asker's phone (ADR 0212, personal chat only, `CONTACT_LOOKUP_TIMEOUT_MS`)
  with `role` terms; the app reads Company and Job Title and sends only the
  entries that match (`matchDeviceContactsByRole`, entries with an email
  first). Their emails become the sender filter. An app that predates this
  ignores `role` and does a name lookup, which finds nothing — no harm.
- **Then remember it.** A role found only on the phone comes back with an
  instruction: after the results, ask once whether to save that contact to
  People with the role as its note (`add_person`, an existing tool). Saved,
  step 1 finds it next time without the phone.

## Consequences

- Eval (keyword only): person hit@3 0.83 → 1.00, MRR 0.89 → 0.94.
- A role search costs at most three small queries before the mail query, and
  a phone round trip only when all three find nothing.
- The phone path reads the whole address book on the device (company is not a
  filter the OS offers); only matching entries leave it. The pre-prompt text
  now says "the name or role you asked about".
- An address-book entry with no email gives a name only; it is not used as a
  filter (a phone number does not find mail).
- The role list is English and short; adding a role is a one-line change.

## Rejected

- **Letting the model guess the dentist's address.** It does not know it; the
  user's own data does.
- **Matching a role inside a domain name.** It made a dental-plans newsletter
  "the dentist" in the first test run.
- **Asking which dentist when several match.** For a role, the union is what
  the user means more often than not, and a question is a worse default.
- **Uploading company / job title for all contacts.** ADR 0065 keeps the
  address book on the phone; one live answer per question is enough.
