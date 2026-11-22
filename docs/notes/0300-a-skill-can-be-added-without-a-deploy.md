# ADR 0300 - A skill can be added without a deploy

Status: accepted, 2026-10-26. Extends ADR 0299.

## Context

ADR 0299 made a chat skill a TypeScript file in `server/src/services/bot/skills/`.
Adding or changing one, even a single question's wording, needed a server
deploy. (Never an app update: the app only draws the question and its
answer buttons.) The owner wants to add skills and questions without a
deploy.

Three parts of a skill are code today:

- `known(ctx)`, the check that the answer is already on record, is a function.
- `ask` may be a function (onboarding's WhatsApp question reads the number from config).
- The list of skills is fixed when the server is built: `start_skill`'s schema is a
  `z.enum` of skill ids, and every lookup reads the `SKILLS` constant.

## Decision

**A skill can also be a row.** `skill_definitions` (migration `125`) holds one
JSON definition per skill with the same fields as a code skill: `id`, `title`,
`when`, `command`, `opensWithQuestion`, `instructions`, `steps`, `finish`.
`enabled` decides whether it is offered. Every save writes a copy to
`skill_definition_versions`, so a bad edit can be rolled back.

The built-in skills (onboarding, plan my day) stay in code. A row can never
take a built-in's id or command.

**Postgres, not a file on the VM.** A file would be seen by one server copy and
not another (ADR 0280), and it would sit outside backups. The table is already
backed up with everything else.

**Checked when saved, not when run.** `putSkillDefinition` refuses a definition
whose:

- shape is wrong or any text is too long;
- `id` or `/command` is taken (a built-in or another row);
- `saveWith` names a tool that does not exist;
- `known` names a check that does not exist;
- steps reuse an id.

So a broken skill never reaches a user. The loader checks every row again and
skips (and logs) one that no longer passes, for example a row naming a tool
that was since removed.

**`known` is a fixed menu.** Arbitrary code cannot be loaded at run time. A row
picks from named checks in `skills/checks.ts`:

- `has_people`
- `has_birthday`
- `knows_school`
- `knows_home`
- `phone_verified_or_unavailable`
- `briefing_time_chosen`
- `has_connected_account`
- `on_whatsapp_or_unavailable`
- `has_fact:<key>` (a confirmed fact with that key about the user, e.g. `has_fact:home_airport`)

Onboarding uses the same functions, so a check behaves the same in a code
skill and a row. A new kind of check still needs a deploy; a new skill that
uses existing checks does not.

**Picked up within 30 seconds, without a restart.** The web role reads the
table at start and every 30 s (`startSkillRegistry`). Every lookup reads that
in-memory list: the prompt's skill list, `/command`, `start_skill`, and runs
in progress. `start_skill`'s `skill` argument is now a plain string, checked
when called (`unknown_skill`).

**A run on a question that no longer exists moves on.** If a question is
removed, or a run is sitting on one, the next touch goes on to the next
unanswered question instead of leaving the run stuck. The built-in skills
had the same gap.

**A disabled skill disappears.** Its runs are left as they are and come back
if it is enabled again.

**Only the owner writes skills.** A skill's text goes into the bot's
instructions, so whoever writes one steers the bot. Writing is a command run
with database access, not a user-facing route or chat tool:

```
npm run skill --workspace=server -- check <file.json>   (no database)
npm run skill --workspace=server -- put  <file.json> [--by <name>]
npm run skill --workspace=server -- list
npm run skill --workspace=server -- show <id> [--version <n>]
npm run skill --workspace=server -- disable <id>
npm run skill --workspace=server -- enable <id>
npm run skill --workspace=server -- rollback <id> <version>
```

On the VM this runs under `chord-with-env` (ADR 0211). The definition format
and an example are in `docs/ops/skills.md`. Two more commands show what a
skill can use: `tools` (every tool, its first sentence, and which stored
skills name it) and `checks`.

**A code change cannot quietly break a stored skill.** A stored skill names
tools, and tools change with deploys.

- **Renamed:** the old name goes into `TOOL_RENAMES` / `CHECK_RENAMES`
  (`definition.ts`) in the same change. The name is swapped whenever a row is
  read, so the skill keeps working. A test fails if a rename points at
  something that does not exist.
- **Every deploy checks:** it runs `npm run skill -- verify --fix` with the
  NEW code against the live table, after migrations and before the restart.
  `--fix` saves each renamed skill under the new name, as a new version.
  An enabled skill naming a tool or check that no longer exists stops the
  deploy. The output names the skill and the tool, and the old services keep
  running. The person decides: edit and `put` the skill, or `disable` it,
  then deploy again.
- **Escape hatch:** `SKIP_SKILL_VERIFY=1` deploys anyway, and the skill is
  then skipped by the loader. A disabled skill is reported but never stops a
  deploy.

The deploy stops rather than editing a skill for a removed tool, because
nothing can know what the skill should do instead.

## Consequences

- A row has no compile-time checks, so validation at save is the only gate.
  It is strict on purpose.
- The `known` menu limits what a row can detect until a check is added in code.
- Removing or renaming a step id in a row is allowed. People on that question
  move to the next one, and their place in the old question is not kept.
  Never reuse an old id for a different question.
- Skills are still personal-chat only and still not written by users.

## Rejected

- **Files on the VM:** missed by a second copy and outside backups.
- **Loading JavaScript at run time:** arbitrary code on the server.
- **A chat tool or route for writing skills:** any account that reaches it can rewrite the bot's instructions. Revisit with a real admin role.
- **Moving the built-in skills into rows:** they would lose their tests and type checks, for no gain.
