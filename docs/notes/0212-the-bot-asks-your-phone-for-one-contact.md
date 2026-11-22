# 0212 — The bot asks your phone for one contact

**Status**: accepted; built 2026-09-25. Not yet verified on a real phone.
**Date**: 2026-09-25

Amends [ADR 0065](./0065-deterministic-contact-discovery.md) and [ADR 0157](./0157-inviting-someone-to-an-event.md) on what contact data may reach the server. Builds on the People graph ([ADR 0016](./0016-family-graph-in-sqlite.md), [ADR 0076](./0076-email-derived-people-and-family-facts.md)).

## Context

The app has Contacts permission, and people expect the bot to answer from it: "what is Ben's email", "what's mom's number", "add Ben's birthday". Nothing could.

- The bot runs on the server. The address book lives on the phone and has never been uploaded: ADR 0065 sends only hashed numbers (plus display names), and ADR 0157 sends only the one email the user picks.
- Chord's own `people` rows hold an email and important dates, but there was **no phone field**. The only tool that read the email was `get_person_profile`, and **no tool updated a person** except `add_person`'s fill-if-empty email.

## Decision

**1. Ask the phone for one name, on demand.**

A new read tool, `get_contact_info { name }`, is available in the personal 1:1 only (`PERSONAL_ONLY_TOOL_NAMES`, plus an executor `isPersonalTurn` backstop, the same rule as `get_person_profile`). It works in three steps:

1. It always asks the phone first: it broadcasts `contact.lookup { requestId, query }` on the **personal chat's channel**, so only the asker's own devices see the name.
2. It waits up to `CONTACT_LOOKUP_TIMEOUT_MS` (8s) for `POST /me/contact-lookups/:id`.
3. It then reads the asker's saved person (email, phone, birthday) and returns both. The phone wins: the user keeps their Contacts current, while a saved person may hold an address learned from an old email. Saved People fills only a field the phone didn't return, or answers when the phone can't (not found, no permission, unavailable).

On the phone, the app:

- asks for Contacts permission if it can still ask (the user just asked for a contact, so this is the moment);
- reads with the OS name filter;
- sends at most 5 entries (name, emails, phones, birthday) chosen by `matchDeviceContacts`. That function lives in kernel so it has tests; it keeps only entries whose name contains every word of the query.

The server side works like this:

- The pending request lives **in memory** and is answered once.
- An answer from any user other than the asker is refused.
- **Nothing is stored.** The contact data exists only in that turn's tool result and in the reply the user asked for.
- If no phone answers, the result is `unavailable`. That covers the app being closed, a web client (it has no address book and stays silent), or WhatsApp.
- The tool description says what to tell the user for each status, and never to guess an address.

**2. Remember it on the person.**

Migration `094` adds `people.phone`, free text as the user gave it; nothing dials or matches it. `updatePerson` patches fields: `undefined` leaves a field alone, and `null` or `''` clears it. The bot tool `update_person { personName, newDisplayName?, notes?, email?, phone? }` creates the person if unknown, like `add_important_date`. The REST route `PATCH /me/people/:id` calls the same service. Birthdays keep going through `add_important_date`.

The People screen shows the phone. The iOS/Android Contacts permission text no longer promises that names and numbers never leave the phone, because this feature sends one entry when asked.

## Consequences

- The privacy posture moves from "only hashes and a picked email" to "also one matched entry when the owner asks for it, from the owner's own phone, in the owner's own 1:1". There is still no bulk upload and no server copy.
- **One web instance only**, like `pending-invites.ts` and the bot-turn queue (ADR 0172/0178): the answering POST has to reach the process running the turn.
- Every lookup goes to the phone, even when saved People already has the answer, because the owner wants the phone to be authoritative. A phone that doesn't answer (app closed, web, WhatsApp) therefore costs the full timeout before the bot replies from saved People.
- The permission string lives in native config, so the new wording needs a store build to take effect.
- Only the user's 1:1 can ask. In the family chat the tool isn't offered, because the answer would put the asker's contact details in front of the group.

## Rejected

- **Syncing the whole address book** (sealed per ADR 0201). This would answer anywhere, including WhatsApp, but it reverses the promise ADR 0065 and ADR 0157 were built on, for a question asked about one person at a time.
- **An import-into-People flow as the only source.** Nothing answers until you import, and the question is usually about someone you never imported.
- **Offering the lookup in shared groups.**
- **Persisting the lookup in a table so it survives several web instances.** That would store contact data server-side for a round trip that lasts seconds.
- **Writing the birthday back into the phone's contact.** The owner chose Chord's People as the one place a birthday is kept.
