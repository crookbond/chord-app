# e2e — browser tests for the Chord web app

End-to-end checks that drive the **real running app** in a browser and assert on
behaviour (composer paste, `+` upload, circular send, copy-out — ADR 0054).
These complement the server Vitest suite, which can't exercise client UI.

## How it works

- Uses **`playwright-core` with `channel: 'chrome'`** — it drives your locally
  installed Google Chrome, so there's **no bundled-browser download**.
- Runs against the live dev stack over `http://localhost:8081`. `localhost` is
  required: the web client hard-codes its API at `127.0.0.1:4000` and WebCrypto
  is restricted to secure origins, so a sandboxed/remote browser can't be used.
- This package is intentionally **not an npm workspace** — Metro is sensitive to
  hoisted packages, so Playwright is kept in `e2e/node_modules`, out of the app's
  dependency tree.

## Prerequisites

1. Chrome installed.
2. The dev stack up, with Postgres migrated:
   ```
   npm run migrate        # once
   npm run dev:web        # server (:4000) + Expo web (:8081)
   ```

## Run

From the repo root (auto-installs `e2e/` deps on first run):

```
npm run test:e2e
```

Or directly:

```
cd e2e && npm install && npm test
```

### Options

- `HEADED=1` — watch the run in a visible Chrome window
  (`HEADED=1 npm test` from `e2e/`).
- `CHORD_WEB=http://localhost:19006` — override the web URL if Expo serves
  elsewhere.

Screenshots and a `results.json` summary are written to `e2e/shots/`
(git-ignored). The process exits non-zero if any check fails.

## Layout

- `harness.js` — browser launch, demo login, shared helpers.
- `run.js` — discovers `*.test.js`, runs each, reports, sets the exit code.
- `*.test.js` — one suite per file, exporting `{ name, run(check) }`.

## Not covered here

The native `AttachSheet` (Camera / Paste-image tiles) is device-only — web uses
the OS file dialog — so it isn't exercisable in this web suite. It needs a
device/EAS build, same as the ADR 0049 share target.
