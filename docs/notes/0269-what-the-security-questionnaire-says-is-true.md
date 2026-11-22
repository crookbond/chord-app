# 0269 — What the security questionnaire says is true

**Status:** Accepted, 2026-10-19

## Context

Chord is going through Google's CASA AL1 assessment. Before answering the
questionnaire a read-only review checked each answer against the code and
found eleven places where the honest answer was "no" or "partly". Each one is
small; together they are the difference between a questionnaire that
describes the product and one that describes intentions. The earlier IDOR
fixes (PR #91) were the first batch from the same review.

## Decision

Fix all of them in one change, each with a test built from the failure as it
was.

1. **The session cookie is `Secure` in production.** `chord.sid` was
   `HttpOnly; SameSite=Lax` only. One helper, `sessionCookieOptions()`, now
   sets and clears it everywhere; `secure` is on when `NODE_ENV=production`
   (prod is served only over HTTPS through nginx + Cloudflare) and off in
   local dev, which runs over `http://127.0.0.1` where a Secure cookie would
   never come back. Keyed on `NODE_ENV`, not `req.secure`: behind Cloudflare
   the `X-Forwarded-Proto` nginx sees depends on Cloudflare's TLS mode, and a
   cookie's security must not depend on a dashboard setting.

2. **Session tokens are stored hashed.** `sessions.token` held the token the
   client presents, so any read of the table (a backup, a dump, a log of a
   query) was a set of working sign-ins. It now holds `h_` + SHA-256 of it;
   sign-in stores the hash and returns the token, `loadSession` and logout
   hash what they are shown. A plain SHA-256 is enough: the token has 144
   bits of entropy, so there is no guessable secret for a slow hash to
   protect. Migration `112` (`hashSessionTokens`, extracted and tested like
   `mergeDuplicateLists`) rewrites existing rows in place with Postgres
   `sha256()` — same digest as Node's, pinned by a test — and skips rows
   already starting `h_`, so a re-run never hashes a hash. A deploy migrates
   **before** it restarts, so the old process can still write a raw token in
   the seconds between; the web role therefore runs the same idempotent
   rewrite at boot, before it serves. Requests that reach the old process in
   that window are answered 401 (the app shows the sign-in page once; the
   stored token is still good after the restart). Account deletion, retention
   pruning and the Google-consent session re-point key on `user_id` or
   timestamps and needed no change.

3. **Session tokens stay out of logs and off ordinary URLs.** The web client
   sends its token as `?token=` on its two SSE streams (an `EventSource` cannot
   set headers). The debug request log printed `req.url` with the query; it
   now goes through `redactUrl`, which blanks the value of every
   credential-shaped parameter (`token`, `k`, `code`, `state`,
   `validationToken`, `hub.verify_token`, …) and keeps the names. Separately,
   the `?token=` fallback was a pathless `router.use` on a router mounted
   ahead of every other one, and `loadSession` runs once per request — so a
   query-string session was accepted on **every** route. It is now mounted on
   the two stream paths only. nginx's access log recorded the full request
   line too; the site now includes `snippets/chord-security.conf`, which logs
   with a `chord_noquery` format (method, path, status, size, user agent — no
   query, no Referer, which can carry one).

4. **Secrets are compared in constant time.** Graph's `clientState`, the
   Gmail push URL token and Meta's `hub.verify_token` were compared with
   `!==`. They go through `secretsEqual` (`utils/secret-compare.ts`), which
   hashes both sides so `timingSafeEqual` always sees equal lengths (no early
   return that leaks the length) and never matches an empty expected value.
   The sweep found the other comparisons already constant-time (Stripe,
   Slack, Meta signature, RevenueCat, the classifier token, the master-key
   check).

5. **Pairing codes come from a CSPRNG.** The connector pairing code (it binds
   an outside chat to a Chord group) was built with `Math.random`. It is
   `nanoid`'s `customAlphabet` over the same alphabet and length. The sweep
   found no other `Math.random` in non-test server code except the sim seed
   scripts and the test-database name, neither security-relevant.

6. **A URL the user typed is screened before the server calls it.** The BYOK
   `baseUrl` was fetched with no host check, so saving a key was an SSRF
   probe (169.254.169.254, 10/8, localhost) and the failure message relayed
   whatever that host answered. `assertSafeModelEndpoint` (`utils/ssrf.ts`)
   requires https on a public host in production and allows anything
   elsewhere, so a developer can still point at a local Ollama. It runs **on
   save** and **on every request**: the OpenAI client for a BYOK endpoint gets
   `modelEndpointFetch`, which re-screens the host and refuses redirects,
   because a name that was public at save time can be re-pointed later. The
   validation failure no longer echoes the upstream text; it is logged and
   the user gets a fixed sentence (the auth/credit messages of ADR 0044 are
   unchanged). The sweep found the same shape in the **custom IMAP preset**
   (ADR 0080): a host and port the user types, which the verify login then
   connects to. In production that host and its SMTP host must be public
   too. The shared block list grows: 224/4 multicast, 240/4 reserved,
   198.18/15, 192.0.0/24, the three TEST-NETs, ff00::/8, and the two IPv6
   prefixes that carry an IPv4 address a gateway will route to (64:ff9b::/96
   NAT64 and 2002::/16 6to4) are screened by the address they embed.

7. **A file someone else typed the type of is not served as a page.** The
   email attachment download sent the sender's content type with `inline`,
   so an HTML or SVG attachment opened as a document on our origin.
   `safeFileHeaders` serves inline only images (not SVG) and PDF, downloads
   everything else, turns HTML/XHTML/SVG/XML/JS and unknown `text/*` into
   `application/octet-stream`, and always sends `nosniff` (plus a sandbox CSP
   on downloads). Group file downloads, which trusted the uploader's type,
   use the same helper. The inline `cid:` image and the remote image proxy
   already allow `image/*` only and send `default-src 'none'; sandbox`, so
   SVG there cannot run script; they are unchanged.

8. **A WhatsApp export cannot unpack without limit.** `AdmZip.extractAllTo`
   had no cap on entries or decompressed size. Every entry is now checked
   before anything is written: at most 10,000 entries, at most 512 MB
   declared in total (adm-zip inflates an entry to at most its declared size,
   so the declared total is a real bound — except a declared size of 0, which
   it does not cap, so a non-trivial body claiming 0 is refused), and no
   absolute, drive-letter or `..` path. A refused zip is a 400 with the
   reason.

9. **Signing out forgets the account on the device.** Sign-out removed the
   token and push registration and left the mail and calendar caches, the
   decision snoozes, the Apple Calendar/Reminders id maps, location consent
   and pending invite codes in AsyncStorage (localStorage on web). It now
   removes **every** key except an allow-list of layout choices that say
   nothing about the person (`email.viewMode`, `email.aiViewStyle`,
   `calendar.viewMode`) — an allow-list, so a key added later is cleared
   unless someone decides it is harmless (`storageKeysToClearOnSignOut` in
   kernel, tested). Memory too: on native, modules holding another account's
   data for the life of the app (the To Do's cache, the id maps, the reader's
   prefetch, the reply-draft hand-off) register a reset in `mobile/src/sign-out.ts`;
   on web the page reloads after sign-out. Account deletion does the same.
   The demo-mode "recent usernames" list goes too: harmless, but it names who
   used the device.

10. **A 5xx does not carry its message to the client.** The global handler
    returned `err.message` for every status, e.g. `Cloud KMS decrypt failed
    (503)`. It is extracted to `middleware/error-handler.ts`; a 5xx logs the
    error and answers `internal error`, a 4xx with a `status` set by its
    thrower keeps its message. No code throws a 5xx with intended user text;
    routes that want one already answer it themselves with `res.status(...)`.

11. **HSTS.** helmet set it on `/api` only; the SPA had none, and nothing in
    nginx did. The same nginx snippet adds `Strict-Transport-Security:
    max-age=31536000; includeSubDomains` (`always`) and hides Node's copy on
    proxied responses so there is one. `deploy.sh` writes the snippet and the
    log format every deploy and adds the `include` after each `server_name`
    in the site file once — that file is certbot's after `tls`, so it is
    edited, not replaced; certbot keeps the include in the 443 block it
    converts. The redirect block carries the header too, harmlessly
    (browsers ignore HSTS over HTTP). **TLS protocols and ciphers are not set
    here**: they come from certbot's `/etc/letsencrypt/options-ssl-nginx.conf`
    and must be checked on the VM with `sudo nginx -T` (and at the edge,
    Cloudflare's minimum TLS version) before the questionnaire says what they
    are. `preload` is not set: it is a commitment for every subdomain that is
    slow to undo.

## Consequences

- Every existing session survives the deploy; for a few seconds during it,
  requests to the old process are refused.
- A raw token pulled from a database backup made before this change still
  works until it expires (ADR session expiry) — the migration hashes the live
  table, not old backups.
- A BYOK endpoint or custom IMAP host that is private or plain http stops
  working in production, by design. None is known to exist; a key saved
  before this change with such a URL fails at use with the screen's message.
- nginx access logs lose query strings and Referer, which no one read.
- The first deploy edits the live nginx site; `nginx -t` runs before the
  reload, so a bad edit fails the deploy rather than nginx.

## Rejected

- **Secure cookie from `req.secure`** — depends on Cloudflare's TLS mode.
- **A slow hash (bcrypt/scrypt) for session tokens** — costs every request
  and protects nothing a 144-bit random value does not already protect.
- **Accepting a raw token as a fallback after the migration** — keeps the
  raw-token lookup path forever to cover a few seconds; the boot-time rewrite
  covers the same window.
- **Blocking private BYOK endpoints everywhere** — breaks the documented
  local Ollama/vLLM path in development.
- **Rewriting the nginx site from the template** — would drop certbot's TLS
  block (why `deploy.sh` never re-writes it).
- **A deny-list of storage keys to clear on sign-out** — every new cache would
  leak until someone remembered to add it.

## Addendum 2026-10-22: CORS and the dependency findings after the lab review

The lab failed two items on the first review.

**6.3.1, any origin trusted.** `cors({ origin: true, credentials: true })`
echoed whatever `Origin` a request sent and allowed credentials, so the scan's
random origins (on `/health`, `/me`, `POST /waitlist`) were allowed to read
responses with the user's cookie. `buildCorsOriginCheck`
(`utils/cors-origins.ts`) allows `https://chordapp.ai`,
`https://www.chordapp.ai`, the origins of `WEB_ORIGIN` and `SIGNUP_URL`, and
any listed in the new `CORS_ALLOWED_ORIGINS`. Outside production it also
allows localhost and private-LAN addresses, for Expo web dev. A request with
no `Origin` is still allowed: the native apps, webhooks and server-to-server
calls send none, and CORS doesn't apply to them. A refused origin only loses
the CORS headers. The request still runs, as a plain form post would, so
none of this is authorization. Apple's web `form_post` callback is
unaffected for that reason.

**6.1.1, components with known vulnerabilities.** `uuid` 7 (via `xcode`) is
forced to 11.1.1 with an override. `braces` 3.0.3, `image-size` 1.2.1 and
`node-forge` 1.4.0 can't be upgraded: two are already the latest release,
and `image-size` 2 breaks Metro 0.83, which still passes it file paths. All
three are only in Expo's build tools, never in the server or the app
bundle. They are suppressed in `docs/security/dependency-check-suppression.xml`
and the reasoning is in `docs/security/dependency-exploitability.md`.

Rejected: a regex over `*.chordapp.ai` (one forgotten subdomain becomes a
credentialed origin), forcing `image-size` 2 (the web build fails).
