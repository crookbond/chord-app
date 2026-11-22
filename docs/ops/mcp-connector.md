# The Chord connector for Claude and ChatGPT (ADR 0335)

Chord exposes a remote MCP server so people can use it from inside Claude and
ChatGPT. This page is how to turn it on, test it, and get it listed.

| What | URL (production) |
|---|---|
| MCP server (Streamable HTTP) | `https://chordapp.ai/api/mcp` |
| Protected resource metadata | `https://chordapp.ai/.well-known/oauth-protected-resource/api/mcp` |
| Authorization server metadata | `https://chordapp.ai/.well-known/oauth-authorization-server` |
| Registration (RFC 7591) | `https://chordapp.ai/api/oauth/register` |
| Authorize / token / revoke | `https://chordapp.ai/api/oauth/{authorize,token,revoke}` |
| Consent page | `https://chordapp.ai/connect?request=…` |

Scopes: `read`, `suggest`. Tools and what each does: ADR 0335.

## Turning it on

1. Deploy as usual. `deploy.sh` installs `snippets/chord-mcp.conf` (the two
   `/.well-known/oauth-*` paths go to Node; everything else is under `/api/`)
   and adds its include to the site file. Check after deploy:

   ```bash
   curl -s https://chordapp.ai/.well-known/oauth-authorization-server
   ```

   It should answer 404 JSON while the flag is off (proves nginx reaches Node)
   and the metadata once on. An HTML page means the nginx include is missing:
   re-run the deploy, or check `sudo nginx -T | grep chord-mcp` on the VM.
2. Add `MCP_CONNECTOR_ENABLED=true` to `.env.prod` and redeploy. `WEB_ORIGIN`
   must be `https://chordapp.ai` (it is the OAuth issuer and every URL above).
3. Try it yourself before submitting (next section).

## Testing by hand

- **Claude**: Settings → Connectors → Add custom connector → URL
  `https://chordapp.ai/api/mcp`. Claude registers itself, opens Chord's
  consent page, and lists the tools. Ask "what's waiting in my Chord action
  items" and "add a to-do to call the dentist" - the second should appear in
  Chord → To Do's → Action Items as "Suggested by Claude", and nothing is
  added until you tap ✓.
- **A brand-new user** (the getting-started path, ADR 0335 addendum): add the
  connector while signed out of Chord. The sign-in page should say connecting
  creates a free account; after sign-in (and the AI consent question) you land
  back on the consent page with three steps. Tap "Connect a mailbox" (a new tab
  on the web), connect one, come back: step 2 shows it. Allow, then ask Claude
  "how do I get started with Chord?" - it should call `get_started` and walk
  the steps.
- **ChatGPT**: Settings → Apps & Connectors → Advanced → Developer mode on →
  Create → MCP server URL as above, authentication OAuth.
- **MCP Inspector** (`npx @modelcontextprotocol/inspector`): Streamable HTTP,
  the URL above, "Open Auth Settings" → Quick OAuth Flow.
- Disconnect from Chord → Settings → Connected AI apps, or tell Chord
  "disconnect Claude"; the next call from the app must fail with 401 and the
  app should ask to reconnect.

## Directory submissions (owner, by hand)

These need accounts and legal sign-off only the owner has.

**Anthropic connector directory** (claude.ai → Connectors directory; submit
through Anthropic's remote MCP server submission form):

- [ ] Server URL, name ("Chord"), one-line and long description, category
      (Productivity / Email).
- [ ] Logo (square, transparent PNG/SVG) and 3-5 screenshots of Claude using
      Chord: inbox question answered, a suggestion appearing in Action Items,
      the consent page.
- [ ] Privacy policy URL (`https://chordapp.ai/privacy`) — **must first gain a
      section on connected AI apps** (see below), and support contact
      (`hello@chordapp.ai`).
- [ ] A test account for reviewers with a connected mailbox holding sample
      mail (do not use a real family account; the reviewer will read it).
- [ ] Confirm every tool has a title and read-only/destructive annotations
      (they do: `services/ai-apps/mcp-tools.ts`).
- [ ] Origin validation: `/api/mcp` refuses an unexpected browser `Origin`
      with 403 (`isAllowedMcpOrigin`, ADR 0335 addendum). If a reviewer's web
      client is refused, add its host to `AI_APP_WEB_HOSTS` with a test.
- Submission is in Claude.ai's directory submission portal (admin settings),
  which replaced the old review form; escalations to mcp-review@anthropic.com.
- No redirect allow-list to edit: Chord accepts any https redirect URI a
  client registers, and checks it exactly on every authorization.

**ChatGPT apps directory** (platform.openai.com → Apps; requires a verified
OpenAI organization):

- [ ] Verify the business/organization with OpenAI if not already.
- [ ] App name, description, logo, screenshots, category, the MCP URL above.
- [ ] Privacy policy and terms URLs; support email.
- [ ] Test credentials for review, same as above.
- [ ] Answer the data-use questionnaire: Chord reads mail, calendar, to-dos;
      writes are suggestions the user confirms in Chord; nothing is sent or
      deleted by the app.

**Privacy policy text to add** (owner to approve wording; `mobile/app/privacy.tsx`
and `mobile/public/chord-privacy-policy.txt`):

> *Connected AI apps.* You can connect Chord to an AI app such as Claude or
> ChatGPT. When you do, that app can read your email, to-dos, lists, saved
> places and calendar in Chord, and suggest events, to-dos, list items and
> email replies, which wait in Chord until you confirm them. What the app
> reads is sent to its provider and handled under that provider's terms. You
> can disconnect an app at any time in Settings → Connected AI apps.

**Website** (other session's work): link the two directory listings once they
are live.

## Operations

- Logs: `ai app tool call` (client id, tool, ok) per call;
  `ai app authorization answered`; warnings for a reused code or refresh
  token (the grant is revoked).
- Rate limit: `connectorLimiter`, keyed per token/client, uses
  `RATE_LIMIT_MAX` per `RATE_LIMIT_WINDOW_MS`.
- Kill switch: `MCP_CONNECTOR_ENABLED=false` (all connector routes 404;
  existing tokens stay in the table but cannot be used).
- Revoke everything for one app: `UPDATE oauth_grants SET revoked_at = now()::text
  WHERE client_id = '<id>'; DELETE FROM oauth_tokens WHERE grant_id IN
  (SELECT id FROM oauth_grants WHERE client_id = '<id>');`
