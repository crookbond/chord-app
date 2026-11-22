# Dev + runtime

## Prerequisites

- Node ≥ 20 (tested on 24).
- Postgres ≥ 14 on `127.0.0.1:5432`. One-time setup in
  [postgres.md](./postgres.md) (create `chord` role + `chord` and
  `chord_test` databases).

## First run

```bash
npm install                # workspace install across root/server/mobile/client
cp example.env .env
# create the chord database (see postgres.md), then:
npm run migrate            # applies 001_pg_init to $DATABASE_URL
npm run dev                # server on :4000 + Expo dev server
```

Pick a platform in the Expo terminal (`w` for web, `i`/`a` for device simulators). Or use:

```bash
npm run dev:server         # server only
npm run dev:mobile         # Expo only
npm run dev:web            # server + expo start --web in parallel
```

## Environment variables

All declared in `example.env`. Loaded via `dotenv/config` in `server/src/config/env.ts`, which anchors paths to the repo root (see [kernel-path.md](./kernel-path.md)).

Key knobs:
- `SERVER_PORT` / `SERVER_HOST` — where Express listens. Default `127.0.0.1:4000`.
- `LLM_PROVIDER` — `openai` | `gemini` | `mock`. Default `openai`.
- `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` — OpenAI-compatible endpoint. Leave `OPENAI_BASE_URL=https://api.openai.com/v1` for OpenAI; set `http://localhost:11434/v1` for Ollama.
- `GEMINI_API_KEY` / `GEMINI_MODEL`.
- `EXPO_PUBLIC_API_BASE` — Expo reads this at bundle time. Use your LAN IP when testing on a phone.

With `LLM_PROVIDER=mock` the bot works end-to-end without any API key — useful for CI and for first-run demos.

### Per-developer secrets

`.env` is the shared, committed-defaults file (copied from `example.env`).
Real secrets — Google OAuth client, `MASTER_KEY`, LLM API keys — go in
`.env.local`, which is gitignored. `dotenv` loads `.env` first, then
`.env.local` overrides; do not check `.env.local` in.

The shared values (which Google project, which LLM org) live in the
team's password manager under "Chord — dev secrets". When you join:

1. Fetch the entry, paste into `.env.local` at the repo root.
2. Generate your own `MASTER_KEY` if missing:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
   Each dev's local DB is sealed against their own key — re-grant Google in
   each dev environment.

`AUTH_MODE=demo` is the default in `example.env` and lets the legacy
username-only `POST /api/v1/session` route work for local mock testing.
Any deployed environment must set `AUTH_MODE=google`.

### Google OAuth setup (ADR 0014 + 0015)

For real users, configure three Google OAuth clients in the same Google
Cloud project (Console → APIs & Services → Credentials):

| Client type | Used by | Redirect URI |
|---|---|---|
| Web | Server-side code exchange | `GOOGLE_REDIRECT_URI` |
| iOS | iOS Expo build | `EXPO_PUBLIC_GOOGLE_REDIRECT_URI_NATIVE` |
| Android | Android Expo build | `EXPO_PUBLIC_GOOGLE_REDIRECT_URI_NATIVE` |

(Web sign-in from `expo start --web` uses the Web client and
`EXPO_PUBLIC_GOOGLE_REDIRECT_URI_WEB`.)

All redirect URIs are configurable per deployment via env. Defaults:
- `chord://oauthredirect` — native (matches the `mobile/app.json` `scheme`).
- `http://localhost:19006/oauthredirect` — web dev. Override for staging
  / prod web origins.

Mobile env vars are `EXPO_PUBLIC_*` because Expo only inlines that prefix
at bundle time. Server env vars (`GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`) are server-only — never expose the secret in any
`EXPO_PUBLIC_*` var.

## Directory layout

See [architecture.md](../architecture.md). Workspaces are `server`, `mobile`, `client`. **`kernel/` is deliberately not a workspace** — it's a plain TypeScript folder. See [kernel-path.md](./kernel-path.md).

## Typecheck

```bash
npx tsc -p server/tsconfig.json --noEmit
cd mobile && npx tsc --noEmit
npx tsc -p kernel/tsconfig.json --noEmit
```

Or `npm run typecheck` at the root (runs all three).

## Web export as a bundler smoke test

```bash
cd mobile && npx expo export --platform web --output-dir .expo-web-test
rm -rf .expo-web-test
```

If that succeeds, you know kernel aliasing, metro config, and TypeScript paths are all healthy for the web target. Doesn't prove the native bundle works.

## Mobile ports + hot reload

- Metro runs on `:8081` by default. The server is on `:4000` — no conflict.
- Kernel edits hot-reload into the Expo app because `mobile/metro.config.js` includes `kernel/` in `watchFolders`.

## Running on a real phone

1. Set `EXPO_PUBLIC_API_BASE=http://<your-lan-ip>:4000` in `.env`.
2. Start server bound to `0.0.0.0`: `SERVER_HOST=0.0.0.0 npm run dev:server`.
3. `npm run dev:mobile`, scan the QR with Expo Go.

### WSL2 specifics

WSL2 runs in a NAT'd VM, so by default Metro binds to a `172.x` address
the phone on your LAN cannot reach. Two ways to fix it.

**Option 1 — LAN mode + Windows port-forward (preferred at home).**

Find the WSL IP and your Windows LAN IP:

```bash
ip -4 addr show eth0 | awk '/inet / {print $2}' | cut -d/ -f1   # WSL IP
```

In **PowerShell as Administrator** on Windows, forward the Metro + server
ports from the Windows LAN IP into the WSL VM, and open the firewall:

```powershell
# Replace <wsl-ip> with the IP from above. WSL IP changes each reboot.
netsh interface portproxy add v4tov4 listenport=8081 listenaddress=0.0.0.0 connectport=8081 connectaddress=<wsl-ip>
netsh interface portproxy add v4tov4 listenport=4000 listenaddress=0.0.0.0 connectport=4000 connectaddress=<wsl-ip>
New-NetFirewallRule -DisplayName "Expo Metro 8081" -Direction Inbound -LocalPort 8081 -Protocol TCP -Action Allow
New-NetFirewallRule -DisplayName "Chord server 4000" -Direction Inbound -LocalPort 4000 -Protocol TCP -Action Allow
```

In `.env.local` (Windows LAN IP from `ipconfig`):

```
EXPO_PUBLIC_API_BASE=http://<windows-lan-ip>:4000
SERVER_HOST=0.0.0.0
REACT_NATIVE_PACKAGER_HOSTNAME=<windows-lan-ip>
```

`REACT_NATIVE_PACKAGER_HOSTNAME` is the load-bearing one: without it,
Metro advertises the 172.x WSL VM IP in the QR code and the phone can't
resolve it. With it, the QR points at the Windows LAN IP, traffic hits
the port-proxy, and lands inside WSL. Smoke test from the phone's
browser before launching Expo: `http://<windows-lan-ip>:4000/api/v1/health`.

WSL IP rotates on every reboot. To clean up rules: `netsh interface
portproxy reset`. A re-run helper script is on the Phase 5 follow-ups.

**Option 2 — Tunnel mode (no networking config).**

```bash
npm install --workspace=mobile --save-dev @expo/ngrok
cd mobile && npx expo start --tunnel
```

The QR points at an `*.exp.direct` URL reachable from any network
including cellular. Slower and less reliable than LAN mode. The server
still needs to be reachable — either keep the port-forward from Option 1
for `:4000`, or run a second `ngrok http 4000` and point
`EXPO_PUBLIC_API_BASE` at the ngrok URL.

**Expo Go version.** Expo Go on the phone must support the project's
SDK (currently SDK 54). If the app refuses to load the bundle, check
the App Store / Play Store for an Expo Go update.

## Logs

Winston writes to `logs/combined.log` + `logs/error.log` in the repo root. Dev console also shows coloured output. Level via `LOG_LEVEL` (`debug` by default).

## Resetting local state

```bash
dropdb chord && createdb chord    # wipes DB rows
rm -rf data logs                  # wipes uploaded files + logs
npm run migrate
```

`data/` no longer contains the DB (Postgres lives at `DATABASE_URL`).
Both halves need to be cleared for a true reset.
