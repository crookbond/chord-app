# Microsoft 365 App Compliance: Publisher Attestation (draft answers)

Started 2026-10-23. **Filled in and saved in Partner Center on 2026-10-23 (all five sections
Complete), not yet submitted.** "As entered" at the end lists the answers that differ from, or
were added to, the drafts below. Publisher verification is done
([microsoft-publisher-verification.md](../ops/microsoft-publisher-verification.md));
this is the optional next tier, a self-assessment that IT admins see before they approve
Chord for their organisation. It is not required for families or personal Outlook accounts.

Answers are grouped by topic, not by Microsoft's question numbers. Copy each one into the
matching question on the form. Most facts come from the CASA draft
([casa-answers-draft.md](./casa-answers-draft.md)) and
[data-protection-architecture.md](../ops/data-protection-architecture.md); re-check anything
marked **CHECK** before submitting. Answer "No" where Chord does not do something. A
truthful "No" is fine; a wrong "Yes" is not.

## Where to fill it in

**Now:** Partner Center → Marketplace offers → **Chord** (a list-only SaaS offer, draft, not
published) → App Compliance. Offer setup, Properties and Offer listing are filled in too (list
only, "Get it now (Free)" to https://www.chordapp.ai, Microsoft Graph integration ticked with
the app id). Partner Center refuses to save any answer over 500 characters without saying why.

History (how the route was found):
Not reachable from Chord's Partner Center account at first (checked 2026-10-23). Microsoft's SaaS
guide (https://learn.microsoft.com/en-us/microsoft-365-app-certification/docs/saasuserguide)
starts the attestation from an **offer**: Marketplace offers → Commercial Marketplace →
select the app → App Compliance. Chord has no offer, because the account is enrolled only in
the AI Cloud Partner Program. An earlier version of the guide also said a SaaS app must be
pre-approved by the App Compliance team (appcert@microsoft.com).

Two ways in:
1. **Email appcert@microsoft.com** (recommended first). Say Chord is a verified-publisher SaaS
   app (Entra app id `af713851-d6c8-4077-bdd3-c61b0eef000b`) not listed in AppSource, and ask
   how to complete Publisher Attestation for it.
2. **Enrol in Commercial Marketplace** (Account settings → Programs) and create a SaaS offer
   for Chord. Free, but it asks for a payout and tax profile and an offer listing; this is the
   route to an AppSource listing as well.

Once the questionnaire is open, it can be filled offline with its Import/Export feature.

---

## App and company information

- **App name:** Chord
- **Publisher:** Family Grocery Trip Chat Agent LLC dba ChordApp.ai (verified publisher)
- **Website:** https://chordapp.ai
- **Privacy policy:** https://chordapp.ai/privacy
- **Terms of use:** https://chordapp.ai/tos
- **Support / security contact:** `hello@chordapp.ai` (**CHECK**: or `privacy@chordapp.ai`,
  the address given to Google; use one that is read)
- **What the app does:** Chord is a family coordination app with an AI assistant. A user can
  connect their own Outlook/Microsoft 365 mailbox and calendar. Chord reads their mail and
  calendar to suggest events, to-dos and trips, to draft replies the user reviews and sends,
  and to keep a two-way calendar sync.
- **Hosting:** a SaaS service run by the publisher on Google Cloud (us-central1). It is not
  hosted on Azure, and nothing is installed in the customer's tenant.
- **Microsoft 365 integration:** Microsoft Graph only, through delegated (per-user)
  permissions. Chord uses no application permissions, admin-only APIs, Teams, SharePoint or
  OneDrive.

## Permissions (Microsoft Graph, delegated)

| Permission | Why |
|---|---|
| `openid`, `email`, `User.Read` | Identify the signed-in mailbox |
| `offline_access` | Keep syncing in the background without asking the user to sign in each time |
| `Mail.ReadWrite` | Read mail to find events and to-dos; mark read, archive or move to Deleted Items when the user does so in Chord |
| `Mail.Send` | Send a reply, forward or new message the user wrote or approved in Chord |
| `Calendars.ReadWrite` | Two-way calendar sync (only when the user connects the calendar) |

Chord never sends mail on its own. A bot-drafted message is sent only after the user taps to
confirm, with an undo window. One exception: a vacation auto-reply the user turned on. Chord
never permanently deletes mail; delete means a move to Deleted Items.

## Data handling

- **Data collected from Microsoft 365:** the connected user's mail (headers, bodies,
  attachments) and calendar events. Nothing from other users in the tenant, and no directory
  data beyond the user's own profile.
- **Stored by Chord:** a mirror of the user's recent mail, attachment text for search, and
  calendar events. Mail bodies, subjects, snippets, attachment files and extracted text are
  encrypted at the application layer (AES-256-GCM, one data key per user, wrapped by Google
  Cloud KMS). Sender/recipient addresses, labels and dates stay readable for routing and joins.
- **Data location:** United States (Google Cloud us-central1: Cloud SQL and the application VM).
- **Processing by AI:** excerpts of mail are sent to an AI model to classify mail and extract
  events, tasks and trips. In production the model is OpenAI's, reached through OpenRouter,
  with routing restricted to zero-data-retention endpoints and training off. Customer data
  is not used to train models. A user may instead bring their own AI provider key.
- **Subprocessors:** Google Cloud (hosting, database, keys), Cloudflare (CDN/TLS),
  OpenRouter and OpenAI (AI processing), Stripe (billing, no mail data), Meta WhatsApp and
  Expo push (only messages the user chooses to receive on those channels). Full list:
  [llm-data-handling.md](../ops/llm-data-handling.md).
- **Data sharing:** none beyond the subprocessors above. No selling of data, no advertising
  use.
- **Retention:** mail is mirrored for a recent window and kept while the mailbox is connected.
  Disconnecting a mailbox removes its synced data. **CHECK**: confirm what disconnect deletes
  for Outlook before stating it.
- **Deletion:** a user can delete their account in the app, or at
  https://chordapp.ai/delete-account. Deletion removes their data and destroys their
  encryption key, which makes their sealed content unreadable in every copy, including
  backups (backups expire on Cloud SQL's retention schedule).
- **Customer admin control:** a tenant admin can block or revoke Chord in Entra (Enterprise
  applications) at any time; revoking stops Chord's access immediately.

## Security

- **Encryption in transit:** TLS 1.2+ everywhere (Cloudflare edge, nginx origin with HSTS,
  Cloud SQL connections, all provider APIs over HTTPS).
- **Encryption at rest:** application-layer AES-256-GCM for mail and files (above); OAuth
  refresh tokens and other credentials sealed with a key held only wrapped by Cloud KMS; Cloud
  SQL disk encrypted with a customer-managed KMS key.
- **Secrets:** stored in Google Secret Manager and loaded into memory at service start; never
  in source control or on the VM disk.
- **Access control:** each user sees only their own data; group data is checked by
  membership on every request. Production runs as a least-privilege service account. Access
  to keys and secrets is recorded in Cloud Audit Logs, with email alerts on any decrypt or
  secret read by a principal other than the app.
- **Authentication:** users sign in with Google or Apple; Chord stores no passwords. Sessions
  are random tokens stored only as SHA-256 hashes, ending after 30 days idle or 90 days.
- **MFA for administrators:** **CHECK**. Confirm MFA is on for the Google Cloud owner
  account, `hello@chordapp.ai` (Entra/Partner Center: yes, required for publisher
  verification), GitHub, Cloudflare and Stripe before answering "Yes".
- **Vulnerability management:** dependency scanning (OWASP Dependency-Check, npm audit) with
  findings tracked in [dependency-exploitability.md](./dependency-exploitability.md).
- **Penetration test / independent assessment:** Chord **passed Google's CASA assessment**
  (Cloud Application Security Assessment, App Defense Alliance) in October 2026. **CHECK**:
  the tier and date on the letter of validation. No separate third-party penetration test
  beyond CASA; answer "No" to a question that asks specifically for one.
- **Logging and monitoring:** application and access logs; no mail content, tokens or
  passwords in logs. **CHECK**: automatic crash reporting (ADR 0227) is built; confirm it
  is switched on in production before mentioning it.
- **Incident response:** **CHECK**. There is no written incident-response plan yet. Either
  answer "No", or write a short one first (who is told, how users are notified, within what
  time). The publisher would notify affected users and Microsoft by email.
- **Backups:** Cloud SQL automated daily backups with point-in-time recovery, encrypted.

## Compliance and certifications

Answer **No** to each of these unless it changes: ISO 27001, SOC 2, HIPAA, HITRUST,
PCI DSS (card data is handled only by Stripe), FedRAMP.

- **GDPR / CCPA:** the privacy policy describes the data collected, its use and user rights.
  Access and deletion are self-service (account deletion). **CHECK**: whether to claim GDPR
  compliance formally; there is no EU representative and no signed DPA with OpenRouter.
- **Data Processing Agreement:** not offered to customers today.

## As entered (2026-10-23)

- **Microsoft interfaces** (the 500-character limit forced this short form): "Microsoft
  identity platform OAuth 2.0 auth code flow with PKCE (login.microsoftonline.com v2.0),
  delegated scopes only. Microsoft Graph v1.0 for the signed-in user: /me; /me/mailFolders and
  messages/delta (mail sync); /me/messages (read, mark read, attachments, move, reply) and
  /me/sendMail; /me/calendars, calendarView/delta and /me/events (sync, create, update, delete,
  accept/decline). /subscriptions built but off. No Teams, SharePoint, OneDrive, EWS,
  application permissions or admin APIs."
- **Graph permissions** (all Delegated, each with a justification): Mail.ReadWrite, Mail.Send,
  Calendars.ReadWrite, User.Read, offline_access. Least privilege: Yes.
- **Identity:** Entra app Yes (`af713851-d6c8-4077-bdd3-c61b0eef000b`, tenant
  `79a333fc-8fa4-45c0-bda4-3745fc68e1df`); identity-platform checklist reviewed: No; MSAL: No,
  "the server runs the standard OAuth 2.0 authorization code flow against the v2.0 endpoints
  directly over HTTPS; refresh tokens are encrypted with a key wrapped by Cloud KMS";
  Conditional Access: No; CAE: No; credentials in code: No; other Microsoft APIs: No.
- **Anti-malware:** Traditional Anti-Malware (ClamAV, nightly scan, emailed on a detection,
  see [patch-policy.md](./patch-policy.md)).
- **Patching / unsupported software:** true since 2026-10-23, when Node moved to 22 and the
  VM rebooted onto the patched kernel.
- **Answered No, and could become Yes with work:** written incident-response plan, formal risk
  management, employee account process, second reviewer on code changes, IDPS, regular log
  review, data sharing agreements. GDPR is answered No (see above).
