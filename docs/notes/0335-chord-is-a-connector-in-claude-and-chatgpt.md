# 0335 — Chord is a connector in Claude and ChatGPT, and an outside app only suggests

**Status**: accepted (built behind `MCP_CONNECTOR_ENABLED`, default off)
**Date**: 2026-11-12

## Context

The owner wants AI assistants to treat Chord as the action-oriented email
reader: "ask Claude what's waiting in my inbox", "add the dentist email to my
calendar". The strongest proof of that is Chord being usable from inside
Claude and ChatGPT, listed in Anthropic's connector directory and the ChatGPT
apps directory. Both take a **remote MCP server** that users connect with
**OAuth**.

Three facts about the existing code shaped the design:

1. **The bot already has the tools.** `tools.ts` holds ~120 zod-validated
   tools and `executor.ts` runs them under every rule the ADRs built up:
   group scope (ADR 0004/0032/0096), the personal-only gate, the past-date
   and invented-repeat guards, the fixed failure sentence (ADR 0102), the
   cross-group scrubber. A connector that wrote its own data access would
   have to re-earn every one of those, and would drift.
2. **Most bot writes commit directly.** Only ~20 tools are in
   `PROPOSABLE_TOOLS` (mail that leaves the building, deletes). In Chord's own
   chat that is fine: the user is watching the turn. An outside app's turn is
   watched by nobody in Chord, and its model may be acting on an email that
   tells it what to do (prompt injection through the inbox).
3. **Email suggestions already stage `create_event` / `create_task` /
   `add_list_item` as proposals** (ADR 0132/0137) and Action Items already
   renders and confirms them. So "a write is a proposal" needs no new card,
   screen or confirm path for those shapes.

## Decision

**Transport: remote MCP over Streamable HTTP, stateless, JSON responses.**
One endpoint, `POST /api/mcp`, in the web role. No `Mcp-Session-Id`, no
server-to-client stream (`GET`/`DELETE` answer 405): every request carries
its bearer token and is answered on its own, so any web copy can take any
request (ADR 0280) and nothing is held per client. Methods: `initialize`
(echoes a supported protocol version, else the newest), `ping`,
`tools/list`, `tools/call`; notifications get 202. Batches are refused (the
2025-06-18 spec removed them). Hand-written (~150 lines) rather than the MCP
SDK: the stateless JSON subset is small, and the SDK's server transport
wants to own the request and session lifecycle that this deliberately does
not have (the same call ADR 0075 made for Stripe).

**Auth: Chord is the OAuth 2.1 authorization server**, on top of the
existing user model, not a second identity system.

- Discovery: `/.well-known/oauth-protected-resource[/api/mcp]` (RFC 9728)
  and `/.well-known/oauth-authorization-server` (RFC 8414); a 401 from
  `/api/mcp` names the former in `WWW-Authenticate: Bearer
  resource_metadata=…`. Issuer = `WEB_ORIGIN`. nginx proxies only `/api/`,
  so a new snippet (`nginx-chord-mcp.conf`, installed by `deploy.sh` beside
  the security one) sends those two well-known paths to Node.
- Dynamic client registration (RFC 7591) at `/api/oauth/register`: redirect
  URIs must be https, or http on loopback (desktop clients); no fragment, at
  most 10. Public clients (`none`, PKCE only) by default; a client that asks
  for `client_secret_post`/`_basic` gets a secret, stored hashed.
- `/api/oauth/authorize`: an unknown client or a redirect URI that is not
  **exactly** one it registered gets an error PAGE, never a redirect (that is
  the open redirect the check exists for). S256 PKCE is required (`plain` is
  refused: it sends the secret it protects). `resource` (RFC 8707), if sent,
  must be the MCP endpoint. A valid request is stored (30 min, see the addendum) and the
  browser goes to the consent page.
- **Consent is a page in the web app** (`/connect?request=…`), using the
  ordinary web session (cookie + CSRF header, ADR 0316). Signed out, it sends
  the user through sign-in and back (`next=`). It names the app (self-
  asserted, so the redirect host is shown beside it), what each scope allows
  in the user's words (`AI_APP_SCOPE_TEXT`, kernel, shared with Settings), that
  what the app reads goes to that company under its own terms, and how to
  disconnect. Allow/Deny answers the request once (a conditional update; a
  second answer is 409). The redirect carries `code`, `state` and `iss`
  (RFC 9207).
- `/api/oauth/token`: code exchange checks client, exact redirect URI,
  expiry (5 min), PKCE, single use. **A code presented twice revokes the
  grant it produced.** Access tokens live 1 hour, refresh tokens 30 days and
  are **single use**: presenting a spent refresh token revokes the whole
  grant (two parties hold it); losing a race with a concurrent refresh is
  refused without revoking. A refresh may narrow scope, never widen it.
- `/api/oauth/revoke` (RFC 7009): a refresh token ends the grant, an access
  token ends itself.
- **Every secret is stored as `h_<sha256>`** (client secret, code, access and
  refresh token), the rule ADR 0269 set for sessions. Tables (migration
  `148`): `oauth_clients`, `oauth_requests`, `oauth_grants` (one live grant
  per user and client), `oauth_tokens`; user-owned rows cascade with account
  deletion (ADR 0043). Expired requests/tokens are pruned by the daily ADR
  0226 pass.
- A Chord session token is not an MCP token and vice versa: they live in
  different tables and `/api/mcp` reads only `oauth_tokens`.

**Scopes: `read` and `suggest`.** No scope asked = both. An unknown scope
fails the request rather than being dropped (a client must never believe it
holds a power the user was not shown). `tools/list` lists only what the grant
allows; a call outside it returns an error result.

**Tools: a curated subset of the bot registry, run through the chat turn's
own step.** `runToolForAiApp` (`bot.service.ts`) is `validateNativeCall`
(schema, time anchoring) then `executeAndBroadcast` (personal-only gate,
executor, scrubber, fixed failure sentence) in the user's **personal chat**,
so ADR 0004/0096's personal-scope rule decides what is read (the user's
mail, and their groups' to-dos/lists/events read across groups the way the
1:1 already does), quiet (no bot-tool SSE). Schemas come from
`buildToolDefs` (internal fields already stripped, ADR 0102); descriptions
are rewritten for an assistant that is not Chord's bot.

- `read`: `search`, `read_email`, `list_action_items`, `list_tasks`,
  `get_list`, `search_saves`, `find_events`, `get_my_availability`,
  `query_mail_senders`, `query_receipts`, `list_subscriptions`.
  `list_action_items` is the one connector-only tool: pending proposals from
  email and from connected apps, read with the same `listProposalsForUser` +
  `attachSourceHrefs` the Action Items tab uses.
- `suggest`: `create_event`, `create_task`, `add_list_item`,
  `reply_to_email`, `trash_email`, `unsubscribe_from_sender`.

**Writes stay confirm-gated.** A new executor input, `stageWrites`, makes
propose mode stage **every** write tool, not only `PROPOSABLE_TOOLS`. Each
suggestion becomes an ordinary proposal with provenance `connector:<grantId>`
(sealed like email-derived args, ADR 0201), shows in Action Items under the
app's name ("Suggested by Claude", section "Suggested for you"), and is
confirmed or dismissed there with the existing confirm path, which re-runs
the executor in commit mode with every guard. The tool result says nothing
has changed yet and links to Action Items. Deliberately **not** exposed:
anything that sends, deletes or acts across people without a card a person
taps through a NEW flow — `compose_email`/`forward_email` (ADR 0214's
address-source rule needs a conversation to read sources from; a reply goes
to the thread's own people), `delete_event`, `complete_task`, `message_user`,
`message_group`, account/billing/settings tools, and the connected-app tools
themselves.

**AI consent and billing.** The connector does not call Chord's model for
any of these tools, so ADR 0283's consent (which is about Chord sending data
to Chord's model provider) is not asked for; the consent page is this flow's
disclosure, and it names the receiving app. Where a tool does reach Chord's
model or embedder (meaning search, ADR 0276), the choke points already
enforce consent and the allowance (ADR 0283/0325/0332): with no consent or no
allowance, search falls back to keywords. Connector use is not metered
otherwise.

**Revoking.** Settings → Connected AI apps lists each app (what it may do,
last used) with Disconnect (`GET/DELETE /api/v1/me/ai-apps`). Chat:
personal-only `list_connected_apps` and `disconnect_app { app }` (exact name,
else a unique partial, else candidates and nothing done), calling the same
service. Disconnecting revokes the grant and deletes its tokens at once.

**Rate limits.** Claude's and ChatGPT's servers send every user's calls from a
few IPs, so the per-IP general and auth limiters would starve them. The
connector routes are mounted before those, under `connectorLimiter`, keyed on
a hash of the `Authorization` header, else the `client_id`, else the IP.

**Off by default.** `MCP_CONNECTOR_ENABLED=false` makes every connector route
404 (Settings' list still answers, empty).

## Consequences

- An app connected to Chord can read the user's whole mailbox and to-dos.
  That is the product, and the consent page says it; the protection against
  an app (or an email steering it) doing harm is that it cannot change
  anything without the user's tap in Chord.
- A suggestion has no chat bubble: it lives in Action Items only. A user who
  never opens Action Items never sees it; it expires after 72h like any
  proposal.
- The consent page names a client by what the client says it is. The
  directories vet listed apps; an unlisted client a user adds by URL is shown
  with its redirect host so a lookalike name is visible.
- Revocation is immediate for new requests; a request already running
  finishes.
- Spent codes stay a day and spent refresh tokens until they would have
  expired, so reuse can still be detected; then the prune removes them.
- Not round-tripped against live Claude or ChatGPT here (no public URL from
  this machine); everything up to the wire is tested
  (`ai-apps-connector.integration.test.ts`). The directory submissions are
  the owner's (`docs/ops/mcp-connector.md`).

## Rejected

- **A separate API with its own data access** — re-implements every scope
  and safety rule the executor holds, and drifts.
- **Committing writes directly, like the bot does** — nobody in Chord is
  watching the turn, and the inbox can instruct the model.
- **Third-party auth (Auth0 etc.) or Google as the authorization server** —
  a second identity system for the same users; Chord's sign-in already covers
  Google, Apple and Microsoft.
- **Stateful sessions and SSE streaming** — nothing here streams, and session
  state would need to be shared across web copies.
- **The MCP SDK's server transport** — see above; revisit if streaming or
  server-to-client requests are ever needed.
- **Exposing compose/forward** — needs a source for every address (ADR 0214);
  revisit with a rule for addresses an outside app supplies.
- **Requiring ADR 0283 consent** — that consent is about Chord's model
  provider; this flow's own consent page names the recipient.

## Addendum 2026-11-12 — getting started from Claude or ChatGPT

Owner request: someone who connects Chord from Claude or ChatGPT is led step
by step through (1) an account if they have none, (2) connecting their
mailboxes, (3) what they can ask. The messengers already do this their own way
(WhatsApp: AI consent + a few free answers + a link that connects or creates an
account, ADR 0053; Telegram: the sign-up link first, ADR 0031; then the ADR
0299 onboarding skill in the app). The connector reaches Chord through a
browser page first, so steps 1 and 2 belong on that page and the rest in the
tools.

**Where each step lives:**

1. **Account — the sign-in page, before consent.** A signed-out `/connect`
   already sent people to sign in and back (`next=`), and signing in with
   Google, Apple or Microsoft already *creates* an account for someone new.
   What was missing was saying so: when `next` is a `/connect?…` link the
   sign-in page jumps to the sign-in card and says "Connecting Chord to Claude
   or ChatGPT … signing in creates your free account, and then you come
   straight back". A new user is **not** sent through the twelve-page intro
   (ADR 0327) on the way back (it would outlast the authorization), but the
   ADR 0283 AI consent question is still asked (short, and it governs Chord's
   own handling of their mail). The authorization request now lasts **30
   minutes**, not 10, so signing up and connecting a mailbox fits inside it;
   the code it produces still lasts 5.
2. **Mailboxes — on the consent page, before Allow, never blocking it.** The
   page is now three numbered steps: *Your Chord account ✓*, *Your mailboxes*
   (the connected ones, or "Connect a mailbox", which opens Settings on the
   connected-accounts card — `/settings?open=mailboxes`, in a new tab on the
   web so the consent page and its request stay open; the list re-reads when
   the person comes back), *Allow <app>*. Allow works with no mailbox (some
   people only want lists and to-dos), and the app picks the step up later.
3. **What to ask — after Allow, in the app, and listed on the page.** New
   connector tool **`get_started`** (listed for every grant, read or suggest)
   returns the same three steps with `done` flags, `nextStep`, the mailboxes,
   the Settings link and `tryAsking`. The server `instructions` tell the app
   to call it when the user has just connected, asks what Chord can do, or a
   tool reports no mailbox, and to walk the steps one at a time (give the link,
   wait, then offer two or three things to try). Every mail tool's result
   carries `noMailbox { connectAt, instruction }` when the user has none, so an
   empty search says why instead of looking like "no results". The things to
   try are one kernel list, `AI_APP_TRY_ASKING`, shared by the consent page and
   the tool; each entry names the tools that answer it and the scope it needs,
   and a test fails if an entry names a tool the connector does not offer at
   that scope, so the tutorial cannot promise what does not ship. A read-only
   grant is offered only the read entries.

**Bot tool.** `get_started` changes nothing, so it needs no chat twin (the
CLAUDE.md rule is for mutating capabilities); the in-app equivalent is the ADR
0299 onboarding skill.

**Rejected:** blocking Allow until a mailbox is connected (people who want only
lists would be stuck, and the request would expire); a separate sign-up page
for connector users (the existing sign-in already creates accounts, and a
second page drifts); the tutorial only in the server instructions (clients
differ in whether they use them, and a tool result is something the app can
quote); MCP prompts for the tutorial (not every client shows prompts).

**Origin check (same change).** The MCP spec says a server must check the
`Origin` header to stop DNS rebinding, and Anthropic's directory review checks
for it. `/api/mcp` now answers **403** to a request whose `Origin` is not
Chord's own, an https page on claude.ai / claude.com / anthropic.com /
chatgpt.com / openai.com (or a subdomain), or a page on this machine
(`localhost`, for the MCP Inspector). A request with **no** `Origin` passes:
that is how Claude's and ChatGPT's servers call (server to server), and it
still needs a valid token. The OAuth endpoints are unchanged (they are not the
MCP transport and are reached by redirects and server calls). Rejected: an
env-var allow-list (nothing to configure yet; a new web client is a one-line
code change with a test), refusing a missing `Origin` (breaks every real
client).
