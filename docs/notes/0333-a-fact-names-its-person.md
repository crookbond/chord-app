# 0333 — A fact names its person, and only its owner sees a private one

**Status**: accepted
**Date**: 2026-11-11

## Context

Prod, 11 Nov 2026, personal WhatsApp chat: "What is ben global entry" was
answered with another family member's Global Entry number. The user
corrected it, and `correct_memory` then found Ben's correct number already
saved. Four things composed:

1. **The prompt did not say whose a fact was.** `memoryBlock` (`context.ts`)
   wrote each fact as `[persona] global_entry_number: <n>`. Two family
   members' numbers looked the same, so the model picked one.
2. **The prompt held 12 facts.** `queryForTurn` defaulted to `.limit(12)`,
   ordered by confidence. A family with more facts than that lost the rest.
3. **`remember_fact` had no "about" field.** It always saved the fact as the
   speaker's own. "Ben's Global Entry is X" said in chat was saved under
   the speaker, and a second child's number then *replaced* it (same subject
   + key supersedes). The fix's test reproduces this: on the old code, two
   calls leave one row, labelled as the parent's.
4. **Extraction filed a person it could not match as "Family".**
   `resolveSubject` matched exact names only, and in the personal chat had
   no roster to match against, so "Ben" (saved as "Ben Doe") became a
   household fact. Two children's IDs under one household key overwrite
   each other.

An audit of every reader and writer of `memories` then found that a
private fact (`scope = 'persona'`, owned by `persona_id`) reached other
members in several places: `GET /me/memories` and
`GET /groups/:id/memories` returned every member's private facts; the
confirm/reject routes and the family-profile edit/delete routes let any
member act on them; the family profile and the memory clean-up pass read
them; form filling read them (as "about the form-uploader"); and live
events sent their values on the chat's channel.

## Decision

- **Every fact shown to a model or a person says who it is about.** The
  label comes from `subject_type`/`subject_id` (`labelMemorySubjects`), never
  from `scope`/`persona_id`, which say who may SEE a fact. The chat prompt
  (`bot/turn-facts.ts`), form filling (`gatherKnowledge`, with the form's own
  person tagged `[FORM SUBJECT]` and a rule to fill per-person fields only
  from that person's lines), the app's fact list (`Memory.about`), the
  People screen (facts joined by subject, no longer by first name in the
  value) all carry it. The prompt also says: answer about a person only from
  that person's lines; if they have none, say nothing is saved.
- **The chat prompt is not capped at 12.** A chat with up to
  `ALL_FACTS_UP_TO` (80) confirmed facts gets all of them. Above that, the
  turn gets every fact about a person the user named (this message, plus
  their previous one within 10 minutes), every fact whose name shares a word
  with the question ("global entry"), the 25 closest by meaning (ADR 0284's
  vectors) and the 15 newest — and is told how many more exist and to call
  `list_memories` with a query before saying something is not saved. Below
  80 there is no meaning call, so no embedding cost.
- **One rule for who a fact is about** (`fact-subject.ts`,
  `resolveFactSubject`), used by chat extraction and `remember_fact`: an
  exact FULL name wins; otherwise every word asked must be a word of exactly
  one person's name ("Ben" → "Ben Doe"). Several people = a question,
  none = nothing saved. A username counts like a first name. A roster
  persona and its linked People row (or a saved person with exactly a
  member's or persona's name) are one person. Kinds in order: member,
  managed persona, the speaker's saved person.
- **`remember_fact` takes `about`.** Omitted or a self-word = the speaker;
  "family" = the household; a name = that person by the rule above, and
  `ambiguous`/`not_found` saves nothing and says so. A fact about another
  member stays the speaker's private fact, filed under that member.
- **Extraction never files an unplaced person under the family.** It is not
  saved. The prompt now lists the roster and the speaker's saved people.
  The log line no longer prints fact values.
- **`list_memories` answers a question about a person from that person's
  facts.** When the query names someone (`peopleNamed`: a name word only
  one of them has decides it; a shared surname counts only when nothing
  more specific was said), a meaning match on anyone else's fact is dropped;
  nothing left = `matched: false` with that person's own facts.
- **A private fact reaches only its owner** (`factVisibleTo` /
  `canSeeFact` in `memory.service.ts`, one rule): both fact list routes, the
  confirm/reject routes, `listFamilyFacts` (now takes `{ viewerId }` or
  `'shared'`), the family-profile edit/delete routes, form filling, and
  `familyFactsForContext` (shared facts only — it feeds every member's
  prompt and the briefing). The memory clean-up pass reviews shared facts
  only, since it runs on one member's model. Live events for a private fact
  go to `user:<owner>` (`broadcastFact`). The family-profile add route
  checks the person is a member or a roster persona of THIS chat.
- Caps raised where they silently dropped facts: the visible-facts read
  (correct/forget/list search) 200 → 2000, the extraction "already known"
  list 40 → 200, `familyFactsForContext` 40 → 200.

## Consequences

- A fact about someone Chord cannot place is lost rather than misfiled. The
  speaker can add the person (`add_person`) and say it again; `remember_fact`
  says why it saved nothing.
- **Existing rows are not corrected.** Facts already saved under the wrong
  person (via the old `remember_fact`) or as household facts (via the old
  extraction fallback) keep their subject; with names now shown, they are
  visible as such and can be fixed with `correct_memory`/`forget_memory` or
  in the app. No safe automatic rule tells whose they were.
- A fact typed in the family profile about another member is now the
  typist's private fact about them (it used to be handed to that member as
  their own private fact, which the typist could no longer see).
- The chat prompt is built from one more query plus the label lookup; above
  80 facts, one embedding call for the question.
- A kid known both as a family-chat roster persona and as a People row in
  the personal chat still has two separate sets of facts (personal-chat
  facts land on the People row). Joining them is not done here.

Also fixed, found in the same audit:
- **Email relationship facts no longer replace each other.**
  `email/person-extraction.ts` writes `kid_name`/`parent_name`/
  `sibling_name`/`friend_name` as one fact about the user, so a second
  child's name superseded the first. For these relations (a person can have
  several) the value now collects every name, once each (`addToNameList`:
  "Ben Doe, Nolan Doe"). `spouse_name`/`partner_name` still hold one.
- **Onboarding checks** (`skills/checks.ts`) count only facts about the user:
  `hasFact` and `knowsHome` require the subject to be the user (owning a
  private fact about the spouse's airport no longer counts), `knowsHome`
  ignores a proposed airport, and `knowsSchool` reads only facts the user may
  see (`factVisibleTo`) — another member's private school fact no longer
  skips the question.
- **The briefing's family facts** de-duplicate on the subject's identity,
  key and value (`ContextFact.subjectKey`), not on the display label: two
  people with one label, or two values, are never merged. A fact whose
  persona row is gone is left out instead of shown as "A family member".
- The People screen keeps the owner's relationship facts ("spouse name:
  Alice") under that person only when the whole value is their full or
  first name.

## Rejected

- **Labels only, keep the cap.** Fixes the guess, still drops facts.
- **Every fact in every prompt, no cap.** A few thousand facts is tens of
  thousands of tokens per round trip; a bounded pick plus `list_memories`
  covers the rest.
- **Meaning search only.** A question naming a person must get all of that
  person's facts whatever the topic; similarity alone can miss them.
- **Keep the household fallback.** It is the overwrite path.
- **First-name matching that picks the first hit.** Two Bens would file
  one's passport under the other.
- **Fixing existing rows automatically.** Nothing reliable says whose an
  old misfiled fact was.
