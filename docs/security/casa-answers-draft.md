# CASA AL1 answers — drafts (2026-10-19)

Saved into the Secusy portal and submitted. **Passed (owner-confirmed 2026-10-23).** Prod at the time = main 5620dff.

---
## NA-1.1.2a (1.1.2 item 2 — not applicable reason)
Chord has no proprietary authentication. Sign-in is only Google Sign-In or Sign in with Apple, so Chord never issues initial passwords or activation codes.

## NA-1.1.2b (1.1.2 item 3 — not applicable reason)
Chord has no proprietary authentication and never issues initial passwords or activation codes, so there is no such process to show.

## NA-1.2.1 (1.2.1 — not applicable reason)
No default accounts exist. There is no admin account, no built-in or seeded user, and no password login of any kind; every account is created by a Google or Apple sign-in. A username-only demo login exists in the code for local development and is disabled in production (AUTH_MODE=google).

## NA-1.3.3 (1.3.3 item 2 — not applicable reason)
Chord has no proprietary authentication and generates no authentication codes; sign-in is Google or Apple only. The one code Chord sends, an SMS code that adds a phone number to an already signed-in account, is generated, expired and rate-limited by Twilio Verify, not by Chord.

---
## 2.2.2 — Option B, written documentation
Chord has no passwords, so there is no password change or password reset in Chord. Users sign in only with Google or Sign in with Apple; a password change happens at that provider.

Chord's sessions do not depend on the provider password. Each Chord session is a random opaque token checked on the server on every request. A session ends when:
- the user signs out (the session row is deleted at once and the cookie cleared);
- the user deletes their account (every session of that user, on every device, is deleted);
- it is unused for 30 days or is older than 90 days (it is deleted and rejected with HTTP 401).

Effect of a provider password change: Google revokes the OAuth refresh tokens for Gmail-scoped grants when the account password changes. Chord's mail/calendar sync then receives invalid_grant, clears the stored token and scopes, and asks the user to reconnect; it never keeps working on the old grant. These provider tokens are not Chord login credentials and cannot be used to sign in to Chord.

There are no relying parties that accept Chord sessions; Chord does not act as an identity provider.

---
## 2.3.3 — Option A, code snippet
```ts
// server/src/utils/session-token.ts
// A session token is 24 random characters from nanoid (crypto.getRandomValues,
// ~144 bits), created fresh at every sign-in. It is stored only as a SHA-256 hash.
export function newSessionToken(): string {
  return `t_${nanoid(24)}`;
}
export function hashSessionToken(token: string): string {
  return 'h_' + createHash('sha256').update(token, 'utf8').digest('hex');
}

// server/src/routes/auth.ts — completeSignIn(), after Google/Apple verify the user
const now = new Date().toISOString();
const token = newSessionToken();
await req.db.insertInto('sessions').values({
  token: hashSessionToken(token),   // only the hash is stored
  user_id: user.id,
  created_at: now,
  last_seen_at: now,
}).execute();
res.cookie(SESSION_COOKIE, token, { ...sessionCookieOptions(), maxAge: sessionCookieMaxAgeMs() });
// sessionCookieOptions(): { httpOnly: true, sameSite: 'lax', secure: true (production), path: '/' }

// server/src/middleware/auth.ts — every request
const stored = hashSessionToken(token);
const row = await req.db.selectFrom('sessions').select(['user_id', 'created_at', 'last_seen_at'])
  .where('token', '=', stored).executeTakeFirst();
if (!row || isSessionExpired(row)) { /* deleted if expired, request is unauthenticated (401) */ }

// Chord uses no static API secrets for users. The only static secrets are
// server-to-server webhook secrets (Stripe, Meta), kept in Secret Manager.
```

---
## 3.2.1 — written description
Chord uses only the OAuth 2.0 Authorization Code flow, always with PKCE where the provider supports it. No Implicit flow and no Resource Owner Password Credentials flow is used anywhere.

- Google Sign-In and Gmail/Calendar connect: Authorization Code + PKCE (S256), via expo-auth-session (`usePKCE: true`). The app receives a one-time code; the Chord server exchanges it with Google's token endpoint together with the code_verifier and the registered redirect_uri, then verifies the ID token (issuer, audience = one of Chord's client ids, expiry, subject).
- Microsoft Outlook connect: Authorization Code + PKCE, same pattern; the server exchanges the code with the Microsoft identity platform.
- Sign in with Apple: authorization code flow (`response_type=code`, web uses `response_mode=form_post`). The server exchanges Apple's one-time code at appleid.apple.com/auth/token with a client_secret it signs itself (ES256, 5-minute lifetime) and trusts only the ID token returned in that TLS response.
- OpenRouter (optional, user brings their own AI key): Authorization Code + PKCE (S256), with the state and code_verifier generated and kept on the server.

Tokens returned by providers stay on the server, encrypted at rest (AES-256-GCM). IMAP mailboxes (Yahoo, iCloud) use the mailbox's own app password, not OAuth.

## 3.2.1 — supporting evidence (code)
```ts
// mobile/app/index.tsx (sign-in) and mobile/app/settings.tsx (Gmail / Outlook connect)
const [request, , promptAsync] = AuthSession.useAuthRequest(
  { clientId, redirectUri, scopes, responseType: AuthSession.ResponseType.Code, usePKCE: true },
  discovery,
);

// server/src/services/google/oauth.service.ts — authorization-code exchange
export async function exchangeCode(opts: { code: string; codeVerifier: string; redirectUri: string }) {
  const client = clientForRedirect(opts.redirectUri);
  const body = {
    client_id: client.clientId,
    code: opts.code,
    code_verifier: opts.codeVerifier,   // PKCE
    grant_type: 'authorization_code',   // the only grant type used for sign-in
    redirect_uri: opts.redirectUri,
  };
  const tokens = await postForm(TOKEN_ENDPOINT, body);
  const identity = await verifyIdToken(tokens.id_token);   // iss / aud / exp / sub
  // ...
}

// kernel/src/apple-web.ts — Sign in with Apple on the web
//   response_type: 'code', response_mode: 'form_post', state: <random, single use>

// server/src/services/openrouter-connect.service.ts
const state = b64url(randomBytes(24));
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash('sha256').update(verifier).digest());
url.searchParams.set('code_challenge', challenge);
url.searchParams.set('code_challenge_method', 'S256');
```

---
## 4.1.3 item 1 — where cryptography is used
Encryption / decryption:
1. User credentials held for syncing (Google/Apple/Microsoft refresh tokens, IMAP app passwords, a user's own AI key, chat-connector bot tokens): sealed with AES-256-GCM before storage, opened only on the server when used.
2. Mail and attachment content (message bodies, subjects, attachment files and extracted text, drafts, mail-derived suggestions): envelope encryption, AES-256-GCM with a separate data key per user; the data keys are wrapped by a Cloud KMS key.
3. Email image proxy capability token: AES-256-GCM sealed {user id, expiry}, valid 12 hours.
4. Data in transit: TLS 1.2+ (Cloudflare edge and nginx), Cloud SQL connections over TLS, all provider APIs over HTTPS.
5. At rest by the platform: Cloud SQL storage encrypted with a customer-managed Cloud KMS key; VM disks encrypted by Google Cloud.

Hashing:
6. Session tokens: stored only as SHA-256 of the token.
7. Phone-number matching for contact discovery: HMAC-SHA256 of the E.164 number.
8. PKCE: SHA-256 code challenge (S256).

MAC / HMAC:
9. Inbound webhook verification: Stripe (HMAC-SHA256 over timestamp + raw body), Meta WhatsApp (HMAC-SHA256 over the raw body). Other inbound secrets (Microsoft Graph clientState, Gmail push token, Meta verify token) are compared in constant time.
10. Encrypted search: a per-user blind index, HMAC-SHA256 with a key derived by HKDF-SHA256 from that user's data key.
11. AES-GCM's authentication tag protects every sealed value against modification.

Signatures:
12. Sign in with Apple client_secret: ES256 (ECDSA P-256 / SHA-256) JWT, 5-minute lifetime.

Random values: all tokens, keys, IVs, OAuth state, PKCE verifiers and invite/pairing codes come from Node's CSPRNG (crypto.randomBytes / crypto.getRandomValues via nanoid). No MD5, SHA-1 (except Twilio's own legacy webhook scheme, not used in production), DES, RC4 or CBC mode is used.

## 4.1.3 item 2 — algorithms, keys, IVs, key management
1. Credential sealing — AES-256-GCM, 128-bit tag. Key: 32 bytes from crypto.randomBytes. Kept only wrapped by Cloud KMS (MASTER_KEY_WRAPPED in config); unwrapped once into memory at start-up, and the app refuses to start if it cannot. IV: 12 bytes from crypto.randomBytes for every encryption. Rotation: a new key requires re-sealing; an offline break-glass copy is held by the owner.
2. Content envelope encryption — AES-256-GCM with additional authenticated data (owner id + field context). Data keys: 32 bytes from crypto.randomBytes, one per user (and per shared group), stored only wrapped by the Cloud KMS key `content-kek` (symmetric, HSM-backed by Google; KMS rotation schedule 90 days, old versions still decrypt). IV: 12 random bytes per value. Unwrapped data keys are cached in memory at most 10 minutes. Expiry/destruction: when an account is deleted its data key is destroyed, which makes all of that user's sealed content unreadable (crypto-erasure).
3. Image token — AES-256-GCM with the credential key, 12-byte random IV, 12-hour expiry inside the sealed payload.
4. TLS — certificates from Let's Encrypt (nginx) and Cloudflare, renewed automatically; TLS 1.2 minimum.
5. Cloud SQL CMEK — Cloud KMS key `chord-db`, rotation period 365 days.
6. Session tokens — SHA-256; tokens are 144-bit random values so a fast hash is appropriate; sessions expire after 30 days idle / 90 days absolute.
7. Phone HMAC — HMAC-SHA256 with a pepper. The pepper is shared with the mobile app by design, so this is pseudonymisation, not secrecy.
8. PKCE — SHA-256 of a 32-byte random verifier.
9. Webhook HMAC — HMAC-SHA256 with the provider-issued secret (Stripe webhook signing secret, Meta app secret), stored in Google Secret Manager, rotated by regenerating at the provider and updating Secret Manager. Comparisons use crypto.timingSafeEqual.
10. Blind index — HMAC-SHA256 truncated to 32 bits; key = HKDF-SHA256(user data key, "chord:blind-index-v1"); destroyed with the data key.
12. Apple ES256 — Apple-issued .p8 private key stored in Secret Manager; a fresh JWT is signed for each call and expires after 5 minutes.

Secrets (keys, API keys, webhook secrets) are stored in Google Secret Manager and fetched into a root-only tmpfs file at service start; they are never in the repository or on the VM disk.

---
## 4.1.4 — written description
Chord uses only authenticated encryption (AES-256-GCM) — there is no CBC mode or padding anywhere, so padding-oracle attacks do not apply. Every failure is handled without revealing why it failed:

- A sealed value that fails GCM authentication (wrong key, altered, truncated) raises one generic error ("sealed value failed authentication"); no plaintext is returned and the caller cannot distinguish key errors from tampering.
- When reading data, a value that cannot be opened is left sealed (the ciphertext, never partial plaintext) and logged on the server, so one bad row cannot break a page. If the key service (Cloud KMS) is unavailable, the request fails closed with an error instead of returning anything.
- The image proxy token returns the same 403 for malformed, tampered, wrong-key and expired tokens.
- Stored mailbox credentials that cannot be decrypted mark the mailbox as needing reconnection; the user is asked to sign in again.
- Webhook signatures that fail verification get a fixed 401/403 response.
- Server errors (HTTP 5xx) always return the fixed text "internal error"; the actual cause is written only to the server log.
- Start-up fails closed: if the wrapped master key cannot be unwrapped, the content key provider is missing, or a secret cannot be fetched from Secret Manager, the service does not start.

## 4.1.4 — supporting evidence (code)
```ts
// server/src/db/crypto/envelope.ts — AES-256-GCM, one generic failure
function decrypt(dek: Buffer, blob: Buffer, ad: Buffer): Buffer {
  if (blob.length < IV_BYTES + TAG_BYTES) throw new SealError('sealed value is truncated');
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(blob.length - TAG_BYTES);
  const ct = blob.subarray(IV_BYTES, blob.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', dek, iv);
  decipher.setAAD(ad);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new SealError('sealed value failed authentication (wrong key, or altered)');
  }
}

// server/src/db/crypto/decrypt-plugin.ts — reading never leaks partial plaintext
(err: unknown) => {
  if (!isValueProblem(err)) throw err;        // key provider down -> fail closed
  this.unopenable++;
  logger.error('sealed value left unopened', { column: key, why });
  // the stored ciphertext is returned unchanged
}

// server/src/services/email/image-token.ts — every failure is the same null -> 403
export function readImageToken(token: string | undefined, now = Date.now()): string | null {
  // malformed / tampered / wrong key / expired all return null
}

// server/src/middleware/error-handler.ts — no internal detail to the client
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const e = err as { status?: number; message?: string };
  const status = typeof e.status === 'number' ? e.status : 500;
  if (status >= 500) {
    logger.error('unhandled error', { err });
    res.status(status).json({ error: 'internal error' });
    return;
  }
  res.status(status).json({ error: e.message ?? 'request failed' });
}

// server/src/db/crypto/master-key.ts — boot fails closed if the KMS unwrap fails
```

---
## 5.2.1 — written description
Chord accepts file uploads in three places, all for signed-in users only:
1. Files shared into a chat (POST /api/v1/groups/{id}/files) — membership in the group is checked first; limit 20 MB.
2. Calendar import (POST /api/v1/ingest/ics) — membership checked; limit 100 MB (nginx caps request bodies at 50 MB).
3. WhatsApp chat export import (zip) — limit 100 MB upload; the archive is checked before anything is extracted: at most 10,000 entries, at most 512 MB unpacked in total, entries that declare no size are refused, and any entry name that is absolute, contains "..", or resolves outside the extraction folder is refused (no path traversal, no zip bombs).

Files are never executed or interpreted as code. They are stored outside the web root (DATA_DIR, not under the nginx-served directory), under generated ids with sanitised filenames, and encrypted at rest (AES-256-GCM, per-user key). Their content is only read to extract text for search and summaries.

Files are served back only through an authenticated route that checks the user may read that file. Because the type is whatever the uploader or email sender claimed, Chord does not trust it: only images (not SVG) and PDF may be shown inline; everything else is sent as a download (Content-Disposition: attachment). Any type a browser could run as a page — HTML, XHTML, SVG, XML, JavaScript, or any other non-plain text type — is served as application/octet-stream, with X-Content-Type-Options: nosniff and Content-Security-Policy: default-src 'none'; sandbox. Email attachments are served the same way.

## 5.2.1 — supporting evidence (code)
```ts
// server/src/routes/files.ts
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// server/src/utils/content-disposition.ts
export function isActiveContentType(mimeType: string | null | undefined): boolean {
  const m = (mimeType ?? '').split(';')[0]!.trim().toLowerCase();
  if (!m || !m.includes('/')) return true;
  if (/(html|xml|svg|javascript|ecmascript)/.test(m)) return true;
  if (m.startsWith('text/') && !PASSIVE_TEXT.has(m)) return true;
  return false;
}

export function safeFileHeaders(mimeType, filename, opts: { inline?: boolean } = {}) {
  const m = (mimeType ?? '').split(';')[0]!.trim().toLowerCase();
  const inline = !!opts.inline && INLINE_SAFE.has(m);   // images (not svg) + pdf only
  const headers: Record<string, string> = {
    'content-type': isActiveContentType(m) ? 'application/octet-stream' : mimeType!,
    'content-disposition': attachmentDisposition(filename, inline ? 'inline' : 'attachment'),
    'x-content-type-options': 'nosniff',
  };
  if (!inline) headers['content-security-policy'] = "default-src 'none'; sandbox";
  return headers;
}

// server/src/services/ingest/whatsapp/unzip.ts — checked before extraction
export const ZIP_MAX_ENTRIES = 10_000;
export const ZIP_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
function isSafeEntryName(name: string): boolean {
  if (!name || name.includes('\0')) return false;
  const norm = name.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) return false;
  return !norm.split('/').some((seg) => seg === '..');
}
// ...each destination is also resolved and must stay inside the temp folder.
```

---
## 6.1.1 — dependency scan
Upload: docs/security/dependency-check-report.html (OWASP Dependency-Check, scan of main after the upgrade).
Result: 0 critical, 4 high, 1 moderate. The 4 high are all in Expo SDK 54 build-time tooling (braces via metro/jest file matching; image-size via metro asset sizing; node-forge via the expo-updates code-signing CLI). None runs on the server or ships in the app bundle; braces and node-forge have no patched release. (UPLOAD MANUALLY — the browser tool cannot attach files.)

---
## 6.4.1 — written description
DNS for chordapp.ai is hosted on Cloudflare (nameservers arch.ns.cloudflare.com and lilyana.ns.cloudflare.com). The application is served from chordapp.ai and www.chordapp.ai only. Both are proxied by Cloudflare to Chord's own Google Cloud VM (the only origin), which serves them with a valid certificate. Mail for the domain is handled by Google Workspace (MX records to aspmx.l.google.com and its alternates), and the TXT records are Google and Microsoft domain-verification records plus SPF (include:_spf.google.com).

There are no subdomains pointing to third-party services (no CNAMEs to hosting platforms, storage buckets, or SaaS endpoints), so there is no dangling record that could be taken over. Records are reviewed when infrastructure changes, and any record for a retired resource is removed at the same time as the resource.

(ATTACH: Cloudflare → chordapp.ai → DNS → Records → Export, as a supporting file.)

---
## 6.5.1 item 1 — protections
Chord stores no passwords and never handles card details, so neither can reach a log:
- Sign-in is Google or Apple only; Chord receives one-time authorization codes, which are exchanged and never logged. OAuth access/refresh tokens are never logged; they are only stored encrypted.
- Payments happen entirely on Stripe Checkout and the Stripe Billing Portal (hosted by Stripe). Chord's server only receives Stripe webhook events and logs ids (user id, Stripe customer id, plan) — never card numbers or payment method details.
- There is no request-body or header logging. The only request log line records method and path, and the query string is redacted: values of token, k, code, state, access_token, id_token, refresh_token, code_verifier, key, api_key, secret, password, signature and similar are replaced by "REDACTED" before the line is written. The web server (nginx) access log records the path only, without the query string or Referer.
- Session tokens are never logged, and are stored in the database only as SHA-256 hashes.
- AI prompt logging in production records only sizes and tool names, never message or mail content (full prompt logging is refused in production).
- Logs are written as JSON on the server, rotated (2 × 25 MB per log), and server errors returned to clients contain no internal detail.

## 6.5.1 item 2 — sample log during login (Google sign-in of a new user)
```
{"level":"debug","message":"POST /api/v1/auth/google","svc":"chord-server","timestamp":"2026-10-19T23:58:12.401Z"}
{"level":"info","message":"created google user jdoe (jdoe@example.com)","svc":"chord-server","timestamp":"2026-10-19T23:58:13.020Z"}
{"level":"debug","message":"GET /api/v1/me","svc":"chord-server","timestamp":"2026-10-19T23:58:13.311Z"}
{"level":"debug","message":"GET /api/v1/me/stream?token=REDACTED","svc":"chord-server","timestamp":"2026-10-19T23:58:13.540Z"}
```
No authorization code, PKCE verifier, OAuth token, ID token or session token appears. A returning user's sign-in writes only the first line.

## 6.5.1 item 3 — sample log during payment
```
{"level":"debug","message":"POST /api/v1/me/billing/checkout","svc":"chord-server","timestamp":"2026-10-19T23:59:02.118Z"}
{"level":"debug","message":"POST /api/v1/webhooks/stripe","svc":"chord-server","timestamp":"2026-10-19T23:59:41.902Z"}
{"level":"info","message":"stripe subscription customer linked","userId":"u_8ZQk2LmP4xTa","customerId":"cus_R2bXk9Lq0aZ1","svc":"chord-server","timestamp":"2026-10-19T23:59:41.955Z"}
{"level":"debug","message":"POST /api/v1/webhooks/stripe","svc":"chord-server","timestamp":"2026-10-19T23:59:42.310Z"}
{"level":"info","message":"stripe subscription period granted","userId":"u_8ZQk2LmP4xTa","plan":"individual","interval":"month","svc":"chord-server","timestamp":"2026-10-19T23:59:42.371Z"}
```
Card entry happens on Stripe's hosted Checkout page; Chord's server never receives card data, so none can be logged.

---
## 6.6.1 — browser storage after logout
After logout nothing confidential and no authentication material remains in the browser.

The session cookie (chord.sid, HttpOnly, Secure, SameSite=Lax) is cleared by the server, and the session row is deleted on the server so the token is useless even if a copy survived.

On sign-out the web app removes every key it stored in localStorage (AsyncStorage on web) — the stored session token, cached email thread lists, the cached calendar, snoozed-suggestion state, location consent, push registration, pending invite and referral codes — and clears sessionStorage. The only keys deliberately kept are three layout preferences that say nothing about the person (how the email and calendar screens are drawn). This is an allow-list, so any new cache is cleared by default. The page then reloads, so nothing from the previous account stays in memory.

---
## 6.7.1 — written description
Server-side secrets (database URL, OAuth client secrets, Apple signing key, Stripe secret key and webhook secret, Meta app secret and tokens, Twilio token, AI provider keys) are stored in Google Secret Manager. They are not in the source repository (.env files are git-ignored and the repository was scanned for key patterns), and not stored on the VM's disk:

- At service start, a root-owned systemd pre-start step (fetch-secrets.mjs) reads each secret from Secret Manager using the VM's own service account (through the metadata server) and writes them to /run/chord-secrets/secrets.env — a tmpfs (memory) file, directory mode 0700, file mode 0600 — which systemd loads into the service's environment. A missing or refused secret stops the service from starting.
- The deploy refuses to proceed unless every secret exists in Secret Manager, and the deployed .env contains no secret values.
- The VM runs as a dedicated least-privilege service account (chord-vm) with read access to these secrets, decrypt rights on the content key, and log writing — nothing else.
- The application master key that encrypts stored user credentials is kept only wrapped by Cloud KMS and unwrapped into memory at start-up.
- User OAuth refresh tokens, IMAP app passwords, users' own AI keys and connector tokens are stored encrypted (AES-256-GCM) in the database.
- Access to secrets and keys is recorded in Cloud Audit Logs (Data Access logs for KMS and Secret Manager) shipped to a separate audit bucket, with email alerts if anyone other than the app's service account decrypts with the content key or reads a secret.
- Rotation: a secret is rotated by issuing a new value at the provider, adding a new version in Secret Manager, and restarting the services.

## 6.7.1 — supporting evidence (code)
```ini
# scripts/deploy/templates/chord.service
[Service]
# Root-owned, runs before the app: fetch secrets from Secret Manager into tmpfs.
ExecStartPre=+/usr/bin/env node /usr/local/lib/chord/fetch-secrets.mjs
EnvironmentFile=/srv/chord/.env                    # non-secret config only (SECRETS_MODE=only)
EnvironmentFile=/run/chord-secrets/secrets.env     # tmpfs, 0600, written above
```
```js
// scripts/deploy/vm/fetch-secrets.mjs (abridged)
// token from the metadata server -> GET secretmanager.googleapis.com/v1/projects/<p>/secrets/<NAME>/versions/latest:access
// 404/403 => exit 1 (service does not start); transient errors retried with backoff
// values containing a newline or NUL are refused
fs.mkdirSync('/run/chord-secrets', { mode: 0o700 });
fs.writeFileSync(tmp, lines.join('\n'), { mode: 0o600 });
fs.renameSync(tmp, '/run/chord-secrets/secrets.env');
```
```
# scripts/deploy/secret-keys.txt — names held in Secret Manager (values never in git)
DATABASE_URL  MASTER_KEY  CONTENT_KEK  OPENAI_API_KEY  ANTHROPIC_API_KEY  GEMINI_API_KEY
GOOGLE_CLIENT_SECRET  MS_CLIENT_SECRET  APPLE_PRIVATE_KEY  STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET  REVENUECAT_WEBHOOK_SECRET  TWILIO_AUTH_TOKEN  META_WHATSAPP_TOKEN
META_APP_SECRET  META_WEBHOOK_VERIFY_TOKEN  TELEGRAM_BOT_TOKEN  GOOGLE_SEARCH_API_KEY ...
```

---
## 7.1.1 item 1 — statement
Chord receives webhooks (it is a webhook consumer) and does not send webhooks to anyone. Inbound webhooks: Stripe (billing events), Meta WhatsApp Cloud API (incoming messages), and, when mail push is enabled, Microsoft Graph and Google Pub/Sub change notifications. Chord has no feature that lets a user register a callback URL.

## 7.1.1 item 2 — N/A reason
Chord is not a webhook provider; it does not send webhooks.

## 7.1.1 item 3 — consumer HTTPS evidence
Webhook endpoints are only reachable over HTTPS (TLS 1.2+). The registered endpoint URLs at Stripe, Meta, Microsoft and Google are all https://chordapp.ai/api/v1/webhooks/…. The domain is proxied by Cloudflare; any plain-HTTP request receives a 301 redirect to HTTPS, and nginx on the origin also redirects port 80 to 443 (certbot --redirect). The site sends Strict-Transport-Security: max-age=31536000; includeSubDomains. The Node application's own port (4000) is not exposed: the Google Cloud firewall admits only ports 80 and 443 to the web server (plus SSH for administration), so the application is reachable only through nginx (verified: a direct connection to the VM on port 4000 gets no response).
Verified: `curl -I http://chordapp.ai/` → `HTTP/1.1 301 Moved Permanently`; `curl -I https://chordapp.ai/api/v1/health` → `Strict-Transport-Security: max-age=31536000; includeSubDomains`.

---
## 7.1.2 — mark whole requirement N/A
Chord does not send webhooks; it is a webhook consumer only (Stripe, Meta WhatsApp, Microsoft Graph, Google Pub/Sub), so there are no endpoints whose ownership Chord needs to verify.

---
## 7.2.1 item 1 — N/A reason
Chord is not a webhook provider; it does not sign or send webhooks.

## 7.2.1 item 2 — consumer verification (code)
```ts
// Raw bytes are kept for every body before JSON parsing (server/src/app.ts):
app.use(express.json({ limit: '2mb',
  verify: (req, _res, buf) => { (req as { rawBody?: string }).rawBody = buf.toString('utf8'); } }));

// Stripe — HMAC-SHA256 over `${timestamp}.${rawBody}`, header Stripe-Signature
// server/src/services/stripe.service.ts
const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
const expectedBuf = Buffer.from(expected, 'utf8');
return v1s.some((v1) => {
  const got = Buffer.from(v1, 'utf8');
  return got.length === expectedBuf.length && crypto.timingSafeEqual(got, expectedBuf);
});

// Meta WhatsApp — HMAC-SHA256 over the raw body, header X-Hub-Signature-256
// server/src/services/connectors/whatsapp/cloud.api.ts
const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
const a = Buffer.from(signatureHeader);
const b = Buffer.from(expected);
if (a.length !== b.length) return false;
return crypto.timingSafeEqual(a, b);
// Used with req.rawBody — never the parsed / re-serialised JSON.
// A failed check returns 401 {"error":"signature mismatch"} and nothing is processed.
```
Microsoft Graph and Google Pub/Sub notifications do not carry an HMAC signature (that is how those providers work); they are authenticated by a per-subscription random clientState (Graph) and a secret token (Gmail push), compared in constant time, and they carry no data — each only triggers Chord to re-read the mailbox through the provider's authenticated API.

---
## 7.2.2 — constant-time comparison (code)
```ts
// Stripe and Meta signatures: crypto.timingSafeEqual (see 7.2.1).

// Other shared secrets (Graph clientState, Gmail push token, Meta verify token):
// server/src/utils/secret-compare.ts
export function secretsEqual(presented: string | null | undefined, expected: string | null | undefined): boolean {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false;
  if (expected.length === 0) return false;
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);   // equal-length digests, so no length leak
}

// server/src/services/email/mail-subscriptions.ts
if (clientState !== null && !secretsEqual(clientState, row.client_state)) { /* rejected */ }
// server/src/routes/mail-push.ts
if (typeof req.query.token !== 'string' || !secretsEqual(req.query.token, env.MAIL_PUSH_GMAIL_TOKEN)) { /* 403 */ }
```

---
## 7.2.3 item 1 — N/A reason
Chord is not a webhook provider; it does not send webhooks.

## 7.2.3 item 2 — consumer replay protection (code + note)
```ts
// Stripe — the timestamp is (a) read from the Stripe-Signature header, (b) checked
// against a 300-second tolerance window, and (c) part of the HMAC input.
// server/src/services/stripe.service.ts
const SIGNATURE_TOLERANCE_S = 300;
const t = Number(parts.get('t')?.[0]);                         // (a)
const nowS = Math.floor((opts.nowMs ?? Date.now()) / 1000);
if (Math.abs(nowS - t) > SIGNATURE_TOLERANCE_S) return false;  // (b)
const expected = crypto.createHmac('sha256', secret)
  .update(`${t}.${rawBody}`)                                   // (c) timestamp inside the signed data
  .digest('hex');
```
Stripe events are also applied idempotently (the same invoice or checkout event sets the same values), so a replay inside the window changes nothing.

Meta's WhatsApp Cloud API signs only the payload (X-Hub-Signature-256) and does not provide a signed timestamp, so a timestamp check is not possible for that provider. A replayed Meta delivery can only re-deliver a message Meta already sent (it cannot be forged or altered without the app secret), over HTTPS only. Microsoft Graph and Google Pub/Sub notifications likewise carry no signed timestamp; they contain no data and only cause Chord to re-sync the mailbox from the provider's API, so a replay has no effect beyond an extra sync.

---
## 7.3.1 item 1 — N/A reason
Chord does not send webhooks and does not accept user-supplied callback URLs.

## 7.3.1 item 2 — statement
Chord is a webhook consumer only and does not accept user-supplied callback URLs; its own webhook endpoints are registered by the operator in each provider's console (Stripe, Meta, Microsoft, Google). The one callback URL Chord passes to a third party (OpenRouter's OAuth callback) is built by the server from its own configured origin, never from user input. Separately, wherever Chord fetches a URL that came from a user or an email (calendar feed import, one-click unsubscribe, the email image proxy, a user's own AI endpoint, a custom IMAP/SMTP host), it resolves the host and refuses private and internal addresses — 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16 (incl. 169.254.169.254), 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, multicast and reserved ranges, IPv6 loopback, link-local, unique-local and NAT64 — re-checking every redirect hop.

---
## 7.3.2 item 1 — provisioning and storage
Webhook signing secrets are issued by each provider (the Stripe webhook signing secret, the Meta app secret and verify token) and stored only in Google Secret Manager. They are never committed to the repository (.env files are git-ignored; the repository has been scanned for secret patterns) and never written to the VM's disk: at service start a root-owned step fetches them from Secret Manager into a memory-only (tmpfs) file readable only by root, which systemd loads into the service environment. Access is restricted by IAM to the app's own service account and recorded in Cloud Audit Logs. Rotation: generate a new secret at the provider, add it as a new Secret Manager version, restart the service. Microsoft Graph clientState values are random 24-byte values generated per subscription and stored in the database.

## 7.3.2 item 2 — unique secrets
Yes. Each inbound webhook has its own secret: Stripe uses its webhook signing secret, Meta uses the app secret (plus a separate verify token for the subscription handshake), each Microsoft Graph subscription has its own random clientState, and Gmail push uses its own token. No secret is shared between endpoints.

---
## CORRECTIONS to already-saved answers

### C1 — 3.1.4 description
- "Record ids are random 24-character values" → "Record ids are random 12-character values".
- In the Webhooks bullet: "(Stripe, Meta, Slack, Microsoft Graph clientState, Gmail push token)" → "(Stripe, Meta, Microsoft Graph clientState, Gmail push token)", and add "compared in constant time".

### C2 — Shared access-control answer (3.1.1–3.1.3)
"…the server issues a random opaque session token. It is stored in the sessions table and sent either as an HttpOnly, SameSite=Lax cookie or as an Authorization: Bearer header."
→ "…the server issues a random opaque session token (about 144 bits). Only a SHA-256 hash of it is stored in the sessions table; the token itself is sent to the client as an HttpOnly, Secure, SameSite=Lax cookie or used as a request header."

### C3 — 2.2.1 (logout) — keep, add one sentence after "Deletes the session's row":
"(The table holds only a SHA-256 hash of each token, so a copy of the database cannot be used to sign in.)"
