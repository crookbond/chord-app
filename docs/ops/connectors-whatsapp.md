# WhatsApp connector (Twilio) — deploy + test runbook

For the design see [ADR 0053](../notes/0053-whatsapp-twilio-connector.md) and
[`../subsystems/connectors.md`](../subsystems/connectors.md).

WhatsApp differs from Telegram: it's **webhook-based** (like Slack/Discord),
so it needs a **public HTTPS URL** that Twilio can POST to. For local dev that
means an https tunnel (ngrok or similar). The whole connector can be built and
exercised against the **Twilio WhatsApp Sandbox** with no Meta approval.

WhatsApp is a strictly 1×1 personal-assistant surface: the thread binds to the
user's **personal group only** — no cross-group targeting (ADR 0053 §7).

## What you'll need

- A Twilio account (the free trial is enough for the Sandbox).
- An https tunnel to your dev server (see "Tunnels" below).
- The Chord server running with the `TWILIO_*` env vars set.

## Tunnels (pick one)

The WhatsApp connector is webhook-based, so Twilio needs a public HTTPS URL
that reaches your local `:4000`. Two easy options on Windows:

**Cloudflare quick tunnel — fewest steps, no account:**

```powershell
winget install Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:4000
```

Prints a `https://<random>.trycloudflare.com` URL.

**ngrok — needs a free signup + authtoken:**

```powershell
winget install ngrok.ngrok
ngrok config add-authtoken <your-authtoken>   # one-time, from ngrok.com dashboard
ngrok http 4000
```

Prints a `https://<random>.ngrok-free.app` URL.

> **The URL changes every run** with both quick tunnels, so each restart you
> re-paste it into *both* the Sandbox webhook field and `TWILIO_PUBLIC_URL`,
> then restart the server. For a **constant** URL use a named tunnel (below).
> ngrok's free browser-warning interstitial only affects browser GETs;
> Twilio's POST webhooks pass through untouched.

**Cloudflare named tunnel — constant URL on our own domain (recommended for
recurring dev).** chordapp.ai is already on Cloudflare, so we can pin a stable
subdomain (e.g. `wa-dev.chordapp.ai`) to the local server. Set the Twilio
webhook once and forget it — and because the hostname never changes, the
inbound HMAC validates cleanly (keep `TWILIO_VALIDATE_SIGNATURE=1`).

```powershell
# one-time
cloudflared tunnel login                                   # browser → pick the chordapp.ai zone
cloudflared tunnel create chord-dev                        # prints a Tunnel ID + a <UUID>.json creds path
cloudflared tunnel route dns chord-dev wa-dev.chordapp.ai  # creates the CNAME for you
```

Then `C:\Users\<you>\.cloudflared\config.yml`:

```yaml
tunnel: chord-dev
credentials-file: C:\Users\<you>\.cloudflared\<UUID>.json
ingress:
  - hostname: wa-dev.chordapp.ai
    service: http://localhost:4000
  - service: http_status:404
```

Run with `cloudflared tunnel run chord-dev` (or `cloudflared service install` to
start on boot). `TWILIO_PUBLIC_URL=https://wa-dev.chordapp.ai`.

> **Don't** point the apex `chordapp.ai`, `www`, or any `/join`-bearing host at
> the dev tunnel, and don't route `/.well-known/*` through it — those serve the
> ADR 0048 deep-link verification from production. A separate `wa-dev` subdomain
> is a different DNS record and doesn't touch that.

## 1. Get Sandbox credentials

In the Twilio Console: **Messaging → Try it out → Send a WhatsApp message**.
The Sandbox page shows:

- Your **Account SID** and **Auth Token** (Console home).
- The Sandbox sender, `whatsapp:+14155238886`.
- A **join code** ("join <two-words>"). Twilio auto-generates this phrase per
  sandbox — it's not customizable; use whatever yours displays.

## 2. Set env vars

```bash
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_WHATSAPP_FROM=whatsapp:+14155238886
TWILIO_PUBLIC_URL=https://<your-tunnel-url>          # no trailing slash, no path
TWILIO_VALIDATE_SIGNATURE=1                          # 0 only if the tunnel rewrites the URL
```

On boot you should see `whatsapp connector ready { from: 'whatsapp:+14155238886' }`.
Missing any of SID / token / FROM → `connectors: whatsapp disabled (...)` and the
connector stays off (no crash).

## 3. Point the Sandbox webhook at your server

In the Sandbox settings, set **"When a message comes in"** to:

```
https://<your-tunnel-url>/api/v1/webhooks/whatsapp     (HTTP POST)
```

The inbound signature is computed over this exact URL, so `TWILIO_PUBLIC_URL`
must match it (scheme + host, no trailing slash). If they diverge, validation
fails with `401 signature mismatch` — fix the URL rather than disabling the check.

## 4. Join the Sandbox and send a message

From your phone's WhatsApp, message the Sandbox number with `join <code>`, then
send anything. The server creates a shadow user + an `external_identities` row
keyed by your `whatsapp:+E164`.

## 5. Bind the thread to a group (for testing)

Onboarding (Google sign-in + personal-group auto-bind) is the production path;
for a quick test, bind your Sandbox channel to a group directly. Find your
`whatsapp:+E164` (server logs or `external_identities`) and:

```bash
npm run connector:bind --workspace=server -- bind whatsapp "whatsapp:+15551234567" <groupId>
```

Now messages to the Sandbox post into that group and the bot replies back to
your WhatsApp.

## Interactive buttons (ADR 0053 §7)

Proposal confirm/reject (and other callback action cards) render as WhatsApp
**quick-reply buttons** via the Content API. This needs pre-created quick-reply
templates — **one-time, no Meta approval** for in-session use:

1. Twilio Console → **Content Template Builder → Create new → `twilio/quick-reply`**.
2. Make a **2-button** template: body `{{1}}`, button 1 `id={{2}}` `title={{3}}`,
   button 2 `id={{4}}` `title={{5}}`. (Optionally a **3-button** one adding
   `id={{6}}` `title={{7}}`.) Don't submit for approval — in-session is fine.
3. Copy each `HX…` SID into `.env`:
   ```
   TWILIO_QUICK_REPLY_SID_2=HX...
   TWILIO_QUICK_REPLY_SID_3=HX...
   ```

**Unset → buttons degrade to plain text** (no crash). When set, a proposal
arrives with tappable Yes/No; tapping routes the `verb:id` payload through the
shared callback handler. **WhatsApp has no message-edit**, so the resolution is
a **follow-up message** ("✓ Confirmed"), not an in-place button update; a stale
tap returns "Already resolved."

## Current limitations (MVP — ADR 0053 §5)

- **Reactive only.** The bot answers inside the 24h window. Proactive
  templates (daily nudge, calendar-reconnect) are a fast-follow.
- **Text only.** Inbound media (`MediaUrlN`) and outbound attachments (public
  URL) are not yet wired — a media-only inbound is dropped with a log line.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `connectors: whatsapp disabled` at boot | one of `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_WHATSAPP_FROM` is empty |
| `401 signature mismatch` | `TWILIO_PUBLIC_URL` ≠ the URL Twilio calls (proxy scheme/host); fix it, or set `TWILIO_VALIDATE_SIGNATURE=0` for tunnel dev only |
| Inbound 200 but no group post | channel not bound — run the `connector:bind` step |
| `twilio send failed: ... (code 63016)` | outbound free-form outside the 24h window — expected until the template layer ships |
| Nothing arrives | Sandbox webhook not set to `.../api/v1/webhooks/whatsapp`, or you haven't sent `join <code>` |

---

## Production: Meta Cloud API (ADR 0090)

Everything above uses Twilio, which stays the default and the local-dev path —
its sandbox needs no Meta approval. **Production runs direct against Meta**,
because a phone number belongs to exactly one WhatsApp Business Account and
Twilio cannot claim a number already attached to one. That conflict is what the
console reports as "Oops, something went wrong".

### Setup

1. **App** — developers.facebook.com → your app → add the **WhatsApp** product.
2. **Token** — Business Settings → System Users → add a system user with access
   to the WABA, then *Generate token* with `whatsapp_business_messaging` and
   `whatsapp_business_management`. This is `META_WHATSAPP_TOKEN`.
3. **Phone Number ID** — WhatsApp Manager → API Setup. An opaque numeric id,
   **not** the phone number. This is `META_WHATSAPP_PHONE_NUMBER_ID`.
4. **App Secret** — App Dashboard → Settings → Basic. This is `META_APP_SECRET`,
   used to verify `X-Hub-Signature-256` on every webhook.
5. **Webhook** — App Dashboard → WhatsApp → Configuration:
   - Callback URL: `https://<host>/api/v1/webhooks/whatsapp`
   - Verify token: any string you invent, also set as
     `META_WEBHOOK_VERIFY_TOKEN`
   - Subscribe to the **`messages`** field.
6. Set `WHATSAPP_PROVIDER=cloud` and restart.

Meta verifies the URL with a `GET` carrying `hub.challenge`, which the server
echoes as `text/plain`. If verification fails, check the verify token matches
exactly and that the host is publicly reachable over HTTPS.

### The out-of-window template

The daily briefing fires at the user's `nudge_hour`, which is almost always
outside WhatsApp's 24-hour session window, so it needs an **approved template**
(ADR 0089). Set `META_NUDGE_TEMPLATE_NAME` to its name.

> The existing `morning_nudge` template will **not** work. It is a text-only
> template with one variable and no buttons; ADR 0089 needs a quick-reply
> template with body `{{1}}` and two buttons, so the Yes/No answer comes back
> as a deterministic `n+` / `n-` payload rather than free text. A new template
> has to be authored in WhatsApp Manager and approved.

In-session messages need no template at all on Meta — quick-reply buttons for
proposal confirm/reject send free-form inside the window, unlike Twilio's
Content SIDs.

### Troubleshooting

| Symptom | Cause |
|---|---|
| `WHATSAPP_PROVIDER=cloud but Meta credentials are incomplete` | one of the four required `META_*` values is empty; WhatsApp is disabled |
| Webhook verification fails in the App Dashboard | `META_WEBHOOK_VERIFY_TOKEN` mismatch, or the host is not reachable over public HTTPS |
| `401 signature mismatch` | `META_APP_SECRET` is wrong, or a proxy is re-encoding the body (the HMAC is over raw bytes) |
| `whatsapp cloud send failed: 400 … (code 131047)` | outside the 24h window with no template — expected; ADR 0089's gate should have caught it |
| `whatsapp cloud: nudge template name not configured` | `META_NUDGE_TEMPLATE_NAME` empty while the ADR 0089 gate asked for a prompt |
| Delivery receipts appearing as chat messages | should be impossible — `statuses` payloads are ignored; file a bug |
