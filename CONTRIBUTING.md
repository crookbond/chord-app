# Contributing to Chord

Thanks for helping. Bug reports, fixes and new features are all welcome.

## Before your first pull request

**Sign the [Contributor License Agreement](./CLA.md).** Comment on your pull
request: *"I have read the Chord CLA and I agree to it."* One signature covers
everything you contribute later. Pull requests without it cannot be merged.

The CLA lets the project stay AGPL-3.0 for everyone while also being offered
under other terms; you keep the right to use your own work however you like.

## Working on the code

1. Read [`CLAUDE.md`](./CLAUDE.md) (the project's working rules, for people and
   AI agents alike) and the decision record in [`docs/notes/`](./docs/notes/)
   for the area you change.
2. Run Chord locally with the [5-minute self-host steps](./README.md#self-host-in-5-minutes).
3. Before you open the pull request:

   ```bash
   npm run typecheck
   npm run lint
   npm test          # needs Postgres
   ```

## What makes a pull request easy to accept

- **A bug fix comes with a test that fails without the fix.** Say what went
  wrong, why, and how to reproduce it.
- **A new way to change something also gets a chat command** (a bot tool in
  `server/src/services/bot/tools.ts` + `executor.ts`), reusing the same
  service function.
- **An iPhone change gets its Android equivalent** in the same pull request.
- **A choice between real alternatives gets a decision record** in
  `docs/notes/` (template in [`docs/notes/README.md`](./docs/notes/README.md)).
- New environment variables go in `server/src/config/env.ts` and at the bottom
  of `example.env`.

## Security issues

Do not open a public issue for a vulnerability. Email
**hello@chordapp.ai** with the details.

## License

By contributing you agree your contribution is licensed under
[AGPL-3.0-only](./LICENSE) and under the terms of the [CLA](./CLA.md).
