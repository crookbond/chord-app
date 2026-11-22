# How to create a chat skill

A **skill** is a guided conversation in the personal chat: a short set of questions the bot asks one at a time, saving each answer with the bot's normal tools (ADR 0299). A new skill is a JSON file saved to the database. It is live within 30 seconds, with no deploy and no app update (ADR 0300).

The server runs every skill the same way:

- It takes each reply as the answer to the open question and moves on.
- It handles "skip", "later" and "stop" without the AI.
- It shows the answer buttons and remembers where each person is, across days.
- It skips a question whose answer is already on record.

A skill file only says what to ask, how to save each answer, and what to do at the end.

## When to create a skill

Create one when:

- the same few questions come up for many people, in the same order. For example: setting up the school year, a weekly review, getting ready for a trip;
- each answer should be **saved somewhere** (a person, a to-do, an event, a list, a fact), and saved without the user having to say exactly how;
- people need to be able to stop halfway and pick up later.

Don't create one when:

- **It is one question.** Just ask it, or improve a tool's description.
- **It needs something no tool can save.** Add the tool first, in code, with a deploy. A skill can only save through existing tools; `npm run skill -- tools` lists them.
- **It needs to know something the checks can't tell** (see [Checks](#checks)). Either accept that the question may be asked again, or add the check in code first.
- **It is for one shared group chat.** Skills run only in a person's own chat with Chord.
- **It branches**, with a different question depending on an earlier answer. That isn't supported yet. A step's `howToSave` can say "if they said X, save nothing", and its `known` check can skip it.

## Skills live today

As of 2026-10-26. Check the current list with `scripts/deploy/deploy.sh skill list`.

| Skill | Command | Where | Questions |
|---|---|---|---|
| `onboarding` (Getting to know you) | `/onboard` | built in (code) | family, birthdays, schools, home city and airport, phone, briefing time, connect accounts, WhatsApp. Starts by itself on a person's first use. |
| `plan_my_day` (Plan my day) | `/plan` | built in (code) | reads today's events and to-dos, then asks "anything else to fit in?" and lays out the rest of the day from now. |

No stored (JSON) skills are live yet. The [examples](#examples) below are ready to add.

## Steps

### 1. Write the file

Copy an example from [`docs/ops/skills/examples/`](./skills/examples/) and change it. Keep the file in that folder, named after its id (`weekly_reset.json`), so it lives in git and CI checks it on every change. The format is [below](#the-format).

### 2. Check it on your machine

```bash
npm run skill --workspace=server -- check docs/ops/skills/examples/weekly_reset.json
```

This needs no database. It prints `ok: …`, or every problem: a tool or check that doesn't exist, two questions with the same id, an id or `/command` already taken, text too long.

### 3. Save it to production

From the repo root, in WSL:

```bash
scripts/deploy/deploy.sh skill put docs/ops/skills/examples/weekly_reset.json --by john
```

This copies the file to the VM and saves it there. The server checks it again, and it refuses rather than saving half of it. The command prints `added weekly_reset, version 1`. Every server copy offers it within 30 seconds.

### 4. Try it

In your own chat with Chord, type its command (`/week`) or ask for it in words that match its `when` line ("plan my week").

### 5. Change it, turn it off, undo

- **Change it:** edit the file, `check`, `put` again. That saves version 2, 3 and so on.
- **Turn it off:** `scripts/deploy/deploy.sh skill disable weekly_reset`. It disappears at once, and `enable` brings it back with everyone's progress.
- **Undo a bad edit:** `scripts/deploy/deploy.sh skill rollback weekly_reset 1` makes version 1 current again, saved as a new version.
- **See what is stored:** `skill show weekly_reset [--version 2]`.

Changing a live skill:

- **Wording:** safe any time.
- **A new question:** people partway through are asked it in its turn.
- **A removed question:** anyone on it moves to the next one.
- **Never reuse an old question's `id`** for a different question. People who answered the old one would skip the new one.

## The format

```json
{
  "id": "weekly_reset",
  "title": "Weekly reset",
  "when": "\"weekly reset\", \"plan my week\", usually on a Sunday",
  "command": "week",
  "opensWithQuestion": false,
  "instructions": "How the bot should run it. Repeated to the bot every turn while it runs.",
  "steps": [
    {
      "id": "new_todos",
      "ask": "Anything new you need to get done this week?",
      "choices": ["Nothing new"],
      "saveWith": ["create_task"],
      "howToSave": "One create_task per item, with a due date only when they give one.",
      "known": "has_fact:some_key"
    }
  ],
  "finish": "What the bot does after the last question."
}
```

| Field | Meaning |
|---|---|
| `id` | Permanent name: lower-case letters, digits, `_` (2-40). Not `onboarding` or `plan_my_day`. |
| `title` | What the skill is called (60 characters max). |
| `when` | The phrases that should start it. The bot reads this line to decide. |
| `command` | Typed alone as `/command` in the personal chat, it starts the skill. Must be unused; `onboard` and `plan` are taken. |
| `opensWithQuestion` | `true`: `/command` posts the first question at once. `false`: the bot first looks things up (events, to-dos) as the `instructions` say, then asks. |
| `instructions` | How to run it: the tone, what to read first, what never to invent (3,000 characters max). |
| `steps` | The questions, in order (up to 20). |
| `finish` | What to do once every question is answered or skipped. A summary, an offer. Nothing is created without a yes unless the instructions say so. |

Each step:

| Field | Meaning |
|---|---|
| `id` | Permanent within the skill. |
| `ask` | The question (600 characters max). The bot puts it in its own words. |
| `choices` | Optional buttons under the question (up to 6, 40 characters each). A tap sends the text as the answer. "Skip" is handled without the AI. Don't use "Later" or "Not now": those pause the whole skill. |
| `saveWith` | The tools that save the answer, e.g. `create_task`, `create_event`, `add_list_item`, `remember_fact`, `update_person`, `add_important_date`, `add_family_member`, `set_email_route`, `set_nudge_time`. Use `[]` when there is nothing to save. `npm run skill -- tools` lists them all. |
| `howToSave` | Optional: how to use those tools for this answer. For example "key \"savings_goal\"" or "only on a yes". |
| `known` | Optional: skip the question when this check is true. See below. |

### Checks

| Check | True when |
|---|---|
| `has_people` | the person has saved anyone in People |
| `has_birthday` | any of their People has a birthday saved |
| `knows_school` | a school is in someone's notes or saved as a fact |
| `knows_home` | they set their home city, and their home airport is saved |
| `phone_verified_or_unavailable` | their phone is verified, or this server can't send codes |
| `briefing_time_chosen` | they changed the briefing time from 7:00, or turned it off |
| `has_connected_account` | Google or a mailbox is connected |
| `on_whatsapp_or_unavailable` | they are on WhatsApp, or no WhatsApp number is published |
| `has_fact:<key>` | a confirmed fact about them with that key, e.g. `has_fact:savings_goal` (pair it with a `remember_fact` save using that key) |

`npm run skill -- checks` prints this list. A new kind of check is code (`server/src/services/bot/skills/checks.ts`) and needs a deploy.

### Writing a good skill

- **One thing per question.** "Which school and grade is each kid in?" is fine; "school, teacher and bus times?" is three questions.
- **Say how to save it** in `howToSave` whenever the tool alone is ambiguous: the list name, the fact key, "one task per item".
- **Say what never to invent** in `instructions`: dates, names, amounts.
- **Give an easy way out** on every question: a "Skip" / "None" / "No" button.
- **Read before asking.** If the skill needs today's events or to-dos, set `opensWithQuestion` to `false` and say what to read in `instructions`.
- **Keep it short.** Five questions or fewer is a good size; the server lets you have up to 20.

## Examples

Each example passes `check`, and CI checks them on every change (`definition.test.ts`).

| File | Command | What it does |
|---|---|---|
| [`weekly_reset.json`](./skills/examples/weekly_reset.json) | `/week` | reads the coming week, then asks what's done, what's new, and what's missing from the calendar |
| [`school_year.json`](./skills/examples/school_year.json) | `/school` | schools and grades, first day, school mail to the family chat, a supplies list |
| [`budget_check.json`](./skills/examples/budget_check.json) | `/budget` | reads repeat payments from receipts, asks what to cancel and what you're saving for |

## When a tool is renamed or removed

A stored skill names tools, and tools change with deploys. **Every deploy checks the stored skills against the new code**, after migrations and before the restart (`skill verify --fix`).

- **Renamed tool or check:** add `old → new` to `TOOL_RENAMES` / `CHECK_RENAMES` in `server/src/services/bot/skills/definition.ts`, in the same change as the rename. Stored skills keep working, and the deploy saves each affected skill with the new name. Update the example files too; CI fails until you do.
- **Removed tool or check:** the deploy **stops before the restart**, naming the skill and the missing tool. The old version keeps running. Edit and `put` the skill, or `disable` it, then deploy again. `SKIP_SKILL_VERIFY=1` deploys anyway, and that skill is then skipped until fixed.
- **Before removing a tool,** run `scripts/deploy/deploy.sh skill tools` to see which stored skills use it.

## Commands

`deploy.sh skill …` runs against production (from the repo root, in WSL). `npm run skill --workspace=server -- …` runs against the database in your local `.env`.

| Command | Does |
|---|---|
| `check <file>` | validate a file, no database (local only) |
| `put <file> [--by <name>]` | save it (new, or a new version) and offer it |
| `list` | built-in and stored skills, version, enabled, and any problem |
| `show <id> [--version <n>]` | print a stored definition |
| `disable <id>` / `enable <id>` | hide or bring back |
| `rollback <id> <version>` | make an old version current again |
| `tools` | every tool a skill can name, what it does, which skills use it |
| `checks` | every check `known` can name |
| `verify [--fix]` | can this code run every stored skill? (each deploy runs it) |

On the VM directly, the same `npm run skill` commands run from `/srv/chord` under `chord-with-env` (ADR 0211).
