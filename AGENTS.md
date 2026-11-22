# Agent instructions

The instructions for any AI coding agent working in this repository live in
[`CLAUDE.md`](./CLAUDE.md). Read it first; everything there applies to you
too, whatever tool you are.

Short version:

- Read [`docs/architecture.md`](./docs/architecture.md) and the decision
  record in [`docs/notes/`](./docs/notes/) for the area you change.
- Server layering is one-way: `types → config → utils → db → services →
  middleware → routes`.
- No `.js` extensions on imports inside `kernel/`; import shared types as
  `@chord/kernel`.
- A new way to change something gets a matching bot tool in
  `server/src/services/bot/tools.ts` + `executor.ts`.
- An iOS change gets its Android equivalent in the same change.
- Before finishing: `npm run typecheck`, `npm run lint`, `npm test`.
- New env vars go in `server/src/config/env.ts` and at the bottom of
  `example.env`.

License: AGPL-3.0-only. Contributors sign the [CLA](./CLA.md); see
[`CONTRIBUTING.md`](./CONTRIBUTING.md).
