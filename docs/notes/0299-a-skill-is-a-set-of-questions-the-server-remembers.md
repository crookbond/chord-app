# ADR 0299 — A skill is a set of questions the server remembers

- **Status:** Accepted
- **Date:** 2026-10-25
- **Relates to:** ADR 0093 / 0166 (a tool result does not survive a turn),
  ADR 0246 (recipes; `load_skill` deferred), ADR 0280 (pending state),
  ADR 0281 (memory cards), ADR 0149 (shared family artifacts)

## Context

The owner wants guided conversations in chat: onboarding (ask about the
family, the school, home, the briefing) and open-ended help ("help me plan my
day"). Chord had no way to do either well. Asking a series of questions was
left to the model, and the model only sees the *prose* of earlier turns, never
their tool results (ADR 0093). So after a few turns it loses its place, asks
the same question twice, or asks something already on record. ADR 0166 fixed
one case of this (an invitee still waiting on an email) by keeping the open
question on the server and repeating it in the prompt every turn. ADR 0246
noted that once there were many recipes, they should load on demand rather
than all sitting in the prompt.

There are two shapes:

1. **Recipe skills**, like plan my day: instructions and a set of tools,
   finished in a turn or two.
2. **Interview skills**, like onboarding: ordered questions, each answer saved
   as a fact, often spread over days.

## Decision

**A skill is a code file** under `server/src/services/bot/skills/`
(`types.ts` describes one): an `id`, a `title`, a one-line `when`, the
`instructions`, a list of `steps` and a `finish` instruction. A skill is
reviewed and tested like any other code; there is no database of prompts.

**A step** is one question: `ask`, optional `choices`, `saveWith` (the
EXISTING tools that save the answer), optional `howToSave`, and an optional
`known(ctx)` check, run in code, that is true when the answer is already on
record. Nothing a skill learns is stored by the skill: answers go through
`add_person`, `add_important_date`, `update_person`, `remember_fact`,
`set_weather_location`, `set_nudge_time`, `set_email_route`. So consent rules,
memory cards (ADR 0281) and every other check on those writes still apply,
and there is no second way to write anything.

**One table, `skill_runs`** (migration `124`): user, chat, skill, status
(`active` / `paused` / `done` / `stopped`), the open step, and the step ids
answered and skipped. One row per user and skill (`UNIQUE (user_id,
skill_id)`). A table rather than `bot_pending_state`, because that expires
and onboarding can be paused for days. It holds step ids only, never answers.
It is removed with the user or the chat (`ON DELETE CASCADE`).

**Two tools, personal 1:1 only** (`PERSONAL_ONLY_TOOL_NAMES` plus an
`isPersonalTurn` check in the executor, as `send_briefing` does):

- `start_skill { skill, restart? }` starts a skill or resumes a paused one,
  and returns its instructions and the first question to ask. `restart`
  forgets the progress, not the answers, which stay saved.
- `skill_step { action: answered | skip | pause | stop, stepId? }` is called
  after the answer is saved, and returns the next question or `finish`. A
  `stepId` that is not the open question is refused (`wrong_step`) and the
  real open question comes back, so a late or repeated call never marks the
  wrong question done.

**The next question is worked out in code**: the first step not answered or
skipped whose `known()` is false. A user who says "my kids are Ben (9, born
8 May) and Nolan" answers two questions at once, and the birthday question
is then skipped because a birthday is now on record. Known checks read the
data itself: people rows, birthdays, school in a person's notes or a
`school` fact, a user-set weather place plus a `home_airport` fact, a
briefing time changed from 07:00 or turned off, a Google connection or mail
account, a WhatsApp identity (or no `WHATSAPP_PUBLIC_NUMBER` to give out).

**The prompt** (personal turns only) gets one line per skill, with this
user's progress in it ("paused at question 3 of 7"); full instructions only
after `start_skill`, which is the on-demand loading ADR 0246 deferred. While
a skill runs, a block repeats its instructions and the open question every
turn (ADR 0166's pattern), placed last, after the tool rules, so its question
is the one the model sees most recently. A message about something else is
answered normally; the skill waits.

**One skill runs per chat**: starting another pauses the first.

**Answer chips**: when a question has `choices`, the tool result carries a
`BotCard` of the new kind `choices` with `replies`. In the app each reply is a
chip that posts its text as the user's message, shown only on the newest
message (an older question is settled). Bridged surfaces get the same
answers in `subtitle` to type.

**Offering onboarding**: the catalogue line tells the model it may offer the
questions once, in one sentence, when a user who has not done them (or
paused them) greets it, asks what it can do, or is new, and to start only
when they agree. Nothing is started unasked.

### The first two skills

- **`onboarding`** ("Getting to know you"), seven questions: who is in the
  family, birthdays, schools (with a one-time offer to route that school's
  mail to a shared family chat), home city and airport, briefing time,
  connecting calendar and mail (pointing to Settings, since that is an OAuth
  flow), WhatsApp. Every question can be skipped.
- **`plan_my_day`**: read today's events, open to-dos and free time first,
  give a short overview, ask what else has to fit, then lay the day out and
  offer to add the new items, creating them only on a yes.

## Consequences

- A new skill is a new file plus a line in `SKILLS`; its `saveWith` tool
  names are type-checked against the tool registry.
- Never rename a shipped step id: it is stored in `skill_runs`.
- Every skill costs one prompt line per personal turn; a running one adds its
  block. Both are small.
- Kids are saved as private People rows (`add_person`), not as managed
  personas in a shared group: the 1:1 has no group to put a persona in, and
  choosing one is a decision onboarding should not make for the user. Moving
  them into the family group is the existing People flow.
- The answer chips are mobile-only taps; WhatsApp shows them as text, not as
  buttons (ADR 0139 allows three quick-reply buttons, not built here).
- Verified with the mock tool path and integration tests, not yet against a
  live model on a real onboarding.

## Addendum 2026-10-25 — the family is in the family chat, and the phone is verified in chat

**Family members go on the roster, and the ones without an account are in the
family chat.** The household question now saves through `add_family_member`
(the family roster, ADR 0231, which already mirrors each person into People)
rather than `add_person`. A child can only be on Chord with a parent's consent
(ADR 0283), and a young child usually has no account at all. Leaving such a
child only in the parent's private People list meant nothing in a shared
chat could be for them. Now everyone on the roster without an account is a
**managed persona in the family chat** (ADR 0151), looked after by the plan's
owner, with `household_role` read from the relationship ("son" → child,
"grandma" → grandparent, "nanny" → caregiver, "wife" → parent):
`placeRosterProfilesInFamilyGroup` runs when someone is added to the roster
and when the family chat is first created (ADR 0234). The persona is linked
to the People row (`personas.linked_person_id`), so it is made once. When
that person later gets an account and accepts, the persona becomes theirs
(`member_user_id` set, no longer managed) instead of a second one appearing,
so what was said about them stays with them. Someone returning after leaving
keeps their own old persona and the managed stand-in is removed. Removing a
profile from the roster removes the persona. With no family chat, nothing
changes: the roster and People only. A child WITH an account already joins
groups like anyone else, and the family invite seats them in the family chat.

**Phone verification is a chat tool, `verify_phone { phone?, code? }`**,
the same `startPhoneVerification` / `verifyPhone` as Settings → Phone
(ADR 0064), and a new onboarding question placed before the briefing.
The first call texts a code. The number it went to is kept in
`bot_pending_state` (kind `phone`, 15 min), because the reply with the code
comes in a later turn and does not repeat the number. The second call
verifies, and the tool says verified only when it was. A number typed
without a country code is read as North American, the ADR 0237 rule
(`phoneCandidates`), and the reply says which number the code went to. The
question is skipped when the number is verified or no SMS provider is set up.
Cost stated: the code the user types passes through the chat history and
the model like any message; it is single-use and expires within minutes, so
reading it later proves nothing.

## Addendum 2026-10-25 — onboarding starts on first use, and `/onboard` starts it any time

No button (owner decision). **First use starts onboarding by itself**, through
one idempotent function, `maybeStartOnboarding` (`skills/auto-start.ts`).
Two moments count as first use:

- **Agreeing to AI use** (ADR 0283), in the app or by replying AGREE in chat.
  Every new user does this before the bot can answer, so it is the real first
  use. The opening question is posted into the personal chat as a bot
  message, after the consent thanks, with its answer chips.
- **The first message in the personal chat**, for deployments that do not ask
  for consent. Nothing is posted: the run starts, and that turn's reply
  answers the user and then asks the first question (the running-skill block
  now says to ask the question when the conversation does not show it yet).

"First use" is read from the data: a real account (a WhatsApp taster shadow
never, ADR 0098), onboarding never started, and at most one message of theirs
in the personal chat. Existing users who have been chatting never get it
unasked. The bot no longer offers skills itself; the earlier "may offer
onboarding once" line is removed.

**Slash commands.** Each skill has a `command`: `/onboard` (onboarding) and
`/plan` (plan my day). Typed alone in the personal chat it is read in code,
before any model runs. A paused or running skill resumes ("Picking up where we
left off"); a finished or stopped one starts again (answers stay saved, so
their questions are skipped). A skill marked `opensWithQuestion` (onboarding)
posts its question at once as the turn's own reply (same message id, so the
reply placeholder clears), with answer chips. One that has to read first
(plan my day) starts and the turn runs, so the model looks the day up before
asking. Anything other than the bare command ("/onboard me", "please
/onboard") is an ordinary message. Asking in words still works.

## Addendum 2026-10-25: the server moves the run on

In prod, `/plan` showed the overview and asked "Anything else you need to fit
in today?"; the user said "lunch and squash" and the model asked follow-up
questions instead of calling `skill_step`, so the run sat on the same question
and no plan came. Moving on was left to the model, which is the problem this
ADR set out to avoid, one step later. It applied to every skill.

So a skill is a guided run, moved on in code:

- While a skill runs in a chat, the user's next message IS the answer to the
  open question. `handleSkillReply` (`skills/reply.ts`) records it before any
  model runs, and the model is told (`skillTurnBlock`): THIS message answers
  "<question>", save it with <tools> (or save nothing), then ask <next
  question>, or after the last one follow the skill's `finish`. The first
  message of a fresh user is never taken as an answer (onboarding is not open
  yet when it arrives).
- A message that is only skip / later / stop (typed, or a tapped chip) is read
  in code and answered without a model: skip posts the next question, later
  pauses, stop ends. Chips that meant "skip" now say Skip, so "Later" and "Not
  now" no longer read as pause.
- `skill_step` is now only `reopen | pause | stop`. `reopen` is the model's way
  back when the message was about something else: the question is open again
  and nothing was saved for it. Any other action is refused.
- While a skill runs, the reply is always a bubble, even when a write tool
  fired (otherwise the next question was hidden behind a receipt strip), and
  the open question's chips are attached by the server.

Rejected: a stricter prompt (the instruction was already there), and asking
the model whether a message is an answer before recording it (a second model
call every turn, for the rare off-topic case `reopen` already covers).

## Addendum 2026-10-25: a plan for today starts now

Asked at 7:40 PM, `/plan` listed the 9 AM cleaning and the noon meeting as
ahead and called everything outside them free. A plan for today now starts
at the time it is asked: the skill's instructions and finish say so (events
and free time already over are left out; under about two hours left, offer
tomorrow; a later day the user names is planned in full). Underneath, today's
availability line (`renderAvailability`, shared with the reply composer and
`get_my_availability`) covers only the rest of the day and says so -
"Sun, Oct 25 (rest of today, from 7:40 PM): …", an event running through now
starts "now" - and a time asked about earlier today is `ALREADY PAST`, never
`FREE`. The email suggestions' free-times line already started from now.

## Not built

- An app button or card for skills (owner decision: none; first use and
  `/onboard` cover it).
- Moving `MAIL_QUESTION_RECIPES` (ADR 0246) into a skill.
- Skills a user writes.
- Skills in shared groups.

## Rejected

- **Leaving the questions to the model.** It loses its place across turns,
  which is the problem.
- **`bot_pending_state` for progress.** It expires; onboarding outlives it.
- **Storing answers in the run.** A second copy of what the save tools
  already keep, with none of their rules.
- **A separate onboarding screen.** Two places to keep in step, and it would
  not work on WhatsApp.
- **The model deciding what is already known.** A code check over the data
  cannot be talked out of it.
