# Who sees user data: model providers and other subprocessors

Written 2026-09-26 for the Google restricted-scope review (Limited Use, CASA Tier 2) and for anyone who asks "where does user mail go". Facts about Chord come from the code and the VM's non-secret settings on that date; facts about other companies come from their own pages, read on that date, and **must be re-read before you submit anything**: terms change. Related: [google-oauth-verification.md](./google-oauth-verification.md), [data-protection-architecture.md](./data-protection-architecture.md).

## The finding that matters

**Production sends model traffic through OpenRouter, and the routing is not constrained by Chord.** The VM runs `LLM_PROVIDER=openai` with `OPENAI_BASE_URL=https://openrouter.ai/api/v1` and `OPENAI_MODEL=openai/gpt-4.1-mini`. So every prompt, including excerpts of a user's mail, goes to OpenRouter and from there to OpenAI. The code (`services/llm/openai.service.ts`) sets no routing preferences, so OpenRouter's account-level defaults apply, and today nothing restricts them.

**Training and retention are two different facts, with two different defaults — worth separating, since Google's rule is specifically about training.** OpenRouter's own `data_collection` flag bundles both into one setting ("allow providers which store user data non-transiently and may train on it"), which reads as though a prompt sent under the default is exposed to training. Checked directly against OpenAI's own current API documentation, 2026-09-30, since that is the actual provider handling our traffic:

- **Training: off by default, and has been since March 2023 — now also blocked explicitly at the OpenRouter account level.** "As of March 1, 2023, data sent to the OpenAI API is not used to train or improve OpenAI models (unless you explicitly opt in to share data with us)." Chord does not opt in anywhere. This is the specific thing Google's Limited Use policy forbids (Google user data used to train a foundational model), and on the training axis it was already true without any setting change — confirmed a second, independent way by a screenshot of OpenRouter's own dashboard (2026-09-30): under "Privacy → Data Policies → Data Training", both **"Allow paid endpoints that train on request data"** and **"Allow free endpoints that train on request data"** are **off**, account-wide, for every provider, not only OpenAI. These toggles are separate from the Zero Data Retention ones above — OpenRouter's own label distinguishes them ("These settings are separate from Zero Data Retention"). Not established whether they were already off before today or were turned off at the same time as the OpenAI ZDR toggle; either way, this is the account's state as of 2026-09-30, not independently re-verified here.
- **Retention: on by default, closed for the current model on 2026-09-30.** "By default, abuse monitoring logs are generated for all API feature usage and retained for up to 30 days." True zero-retention needs OpenAI's own approval ("subject to prior approval by OpenAI and acceptance of additional requirements... get in touch with our sales team"), not a self-service toggle — but OpenRouter's "Zero Data Retention" account privacy page restricts *routing* to the Azure-hosted OpenAI endpoints that already carry that approval, without needing OpenAI's direct sign-off for Chord specifically. The owner turned the OpenAI toggle on (owner-confirmed 2026-09-30; not independently re-verified here). Production's only model, `openai/gpt-4.1-mini`, now routes exclusively to Azure-hosted OpenAI (see the endpoint check below for which ones).
- **Not addressed in OpenAI's docs: whether this default (training off, 30-day retention) is stated for calls made by a reseller like OpenRouter, or only for a direct API key holder.** OpenRouter is itself an ordinary API customer making the same calls, so there is no reason to expect different behavior, but it is inferred, not confirmed in writing by either company.

**Google's rule** (API Services User Data Policy and the Workspace user data policy): Google user data may not be used to train or improve foundational or frontier models, or be stored in conjunction with them; it may only feed a personalized model performing the user-facing feature. On training, this is now covered twice over: OpenAI's own stated default, and OpenRouter's account-level training toggles being off for every provider. On retention, OpenRouter's routing is restricted to zero-retention OpenAI endpoints (below). The remaining open items are evidence and paperwork, not a technical gap.

## What the owner must do (not code)

**Status 2026-09-30: closed by the owner.** The technical finding (training off, retention restricted) is done and evidenced by the dashboard screenshots above. Items 2 and 4 below were deliberately **not** pursued — the owner moved on rather than treating them as blocking — so they are left here as a known, open residual, not silently marked done.

1. ~~Open the OpenRouter account's privacy settings and turn on Zero Data Retention for OpenAI.~~ **Done 2026-09-30** (owner-confirmed; not independently re-verified here). The screenshot that showed all five toggles off, taken the same day before this change, is the "before" record.
2. **Find OpenRouter's separate prompt-logging setting and confirm it is off.** Not the same page as the ZDR toggle above; OpenRouter documents an opt-in discount for logging prompts that grants it commercial rights to the logged content. **Deferred 2026-09-30, not pursued** — still genuinely unknown whether it is on or off.
3. ~~Write down the result for the review file.~~ **Done** — both screenshots exist (before: all ZDR toggles off; after: OpenAI ZDR on, both Data Training toggles off).
4. **Ask OpenRouter for a Data Processing Agreement.** Their privacy policy refers to DPAs ("if you have a Data Processing Agreement with us…") without saying how to get one. **Deferred 2026-09-30, not pursued.**

## The technical control worth adding (proposed, not built — secondary to the account toggle, now on)

The account-level OpenRouter setting (above, done 2026-09-30) was the primary fix: it is simpler than a per-request parameter, and it cannot be bypassed by a code path that forgets to set one. The equivalent request-level control — sending `provider: { data_collection: "deny", zdr: true }` on every request when the base URL is OpenRouter — is still worth adding as belt-and-suspenders, so the guarantee does not depend on nobody ever touching the account setting, and so a future second OpenRouter account (a second environment, a key rotation) does not silently ship without it. **Checked before recommending it:** OpenRouter's public list of ZDR endpoints (`/api/v1/endpoints/zdr`, 921 endpoints, 57 providers on 2026-09-26) includes `openai/gpt-4.1-mini` on **two endpoints, both Azure** (one tagged `azure/swedencentral`) — consistent with the account toggle now routing that model only to Azure. Costs already accepted by turning the account toggle on, restated here because they apply identically to the code version:

- traffic goes to **Azure OpenAI**, and possibly **Sweden Central**: worth a line in the privacy policy;
- fewer endpoints, so slower failover and possibly price and latency differences;
- if a model is chosen later with no ZDR endpoint, requests fail (OpenRouter's docs say ZDR is enforced but do not say what happens with no match) — the account toggle would then need to be turned off for that model before switching, and the setting tested per model.

The models with the widest ZDR availability today are newer ones (the list has `openai/gpt-5.x` and `gpt-6` families); that is a model decision, not made here.

## Everything that sees user data

| Party | What it sees | Why | Controls and notes |
|---|---|---|---|
| **Google Cloud** (Compute, Cloud SQL, KMS, Secret Manager, Logging) | Everything Chord stores, but mail, attachment text and files are **sealed** with per-user keys held in Cloud KMS ([ADR 0201](../notes/0201-email-and-attachments-are-sealed-at-rest.md)) | Hosting | Data Access logs on for KMS, Cloud SQL, Secret Manager; alerts on human decrypts ([audit-logging.md](./audit-logging.md)). Root on the VM can still read what the app can |
| **Cloudflare** | Every request and response between users and `chordapp.ai`, in the clear at their edge (DNS shows the domain resolves to Cloudflare's proxy) | CDN, TLS | It terminates TLS, so API responses, including mail views, pass through it. **Confirm the SSL mode is "Full (strict)"** and that no caching rule touches `/api`; note Cloudflare in the subprocessor list |
| **OpenRouter, and OpenAI (the only upstream provider production routes to)** | Prompts: subject, snippet, sender, body excerpts, attachment text and chat context (amounts below) | Classification, extracting events, tasks and trips, drafting replies, bot answers | Not used for training (OpenAI's own default, and OpenRouter's account-level training toggles are off); routing restricted to zero-retention OpenAI endpoints since 2026-09-30 (see above), so the 30-day abuse-monitoring default no longer applies to this traffic |
| **Users' own model providers** (BYOK) | Whatever the user sends through their own key | The user chose the provider | Their key, their terms; Chord stores the key sealed (ADR 0210/0211) |
| **Twilio / Meta (WhatsApp)** | Messages a user sends to or receives from the bot on WhatsApp, and the briefing text | The WhatsApp channel the user connected | Meta Cloud API in production ([ADR 0090](../notes/0090-whatsapp-cloud-api-direct.md)); the briefing can contain the day's calendar and mail-derived items |
| **Expo push** | A notification title and short body | Push notifications | New-mail notifications carry generic text (no subject or sender) unless `PUSH_EMAIL_PREVIEW` is turned on; it is off by default and not set in production |
| **Stripe** | Billing identity and payment data | Subscriptions (billing is currently off) | Card data never touches Chord |
| **Open-Meteo** | A city or coordinates | The briefing's weather line | No mail or account data |
| **Google (Gmail, Calendar APIs)** | The user's own mailbox and calendar | The product | The source of the restricted-scope data |

## What is actually sent to the model

From the code on 2026-09-26. Excerpts, never a whole mailbox:

| Pass | What | Size |
|---|---|---|
| Classifier | subject, sender, snippet (280 chars), body excerpt | `BODY_EXCERPT_CHARS` (2,000) per thread, batched |
| Suggestions (events, tasks, lists) | the thread's body | 2,000 chars, then a **deep read up to 24,000 chars** when the model asks for more (`EMAIL_DEEP_READ_CHARS`, set in prod) |
| Trips (bookings) | the email body through the trip classifier | up to 16,000 chars |
| Attachments | extracted text of a file | up to 8,000 to 16,000 chars per call, 40,000 stored |
| Reply drafting | the messages of the thread | 3,000 chars per message |
| Bot turns | recent chat, retrieved file and mail excerpts, calendar and task context | bounded per turn |
| Read-time check | the opened message, once | as suggestions |
| People extraction from mail | **off** in production (`EMAIL_PERSONS_ENABLED=false`) | n/a |

The original phase-1 plan said "2,000 chars, 8,000 for trips and attachments". Both figures are now higher (24,000 deep read; 16,000 trips), so a description written from that plan understates what is sent. Anything submitted to Google should use the table above.

## What Chord does itself

- Prompts and replies are no longer logged with content; the old `prompts.log` (full prompts) was deleted in phase 6, and the newer daily prompt logs hold only metadata such as attachment filenames.
- The model receives plaintext, decrypted in memory for the call. That is inherent: sealed-at-rest cannot protect what the model must read.
- Bulk and marketing mail is not mined ([ADR 0127](../notes/0127-a-gate-needs-two-signals-agreeing.md)). When billing is switched on, a user with no entitlement is skipped by the mail AI passes ([ADR 0079](../notes/0079-thirty-day-trial-then-gate.md)); **billing is off today, so every connected user's mail is processed.**

## Sources

Read 2026-09-26 unless dated otherwise; re-read before submitting anything — terms change.

- OpenRouter, provider routing: https://openrouter.ai/docs/guides/routing/provider-selection (`data_collection`, `zdr`)
- OpenRouter, provider logging and retention: https://openrouter.ai/docs/guides/privacy/provider-logging
- OpenRouter, privacy policy: https://openrouter.ai/privacy
- OpenRouter, ZDR endpoint list: https://openrouter.ai/api/v1/endpoints/zdr
- OpenRouter, account Privacy / Data Policies dashboard page (openrouter.ai, Settings → Privacy): screenshotted twice 2026-09-30 — before (all five Zero Data Retention toggles off) and after (OpenAI's ZDR toggle on; the separate "Data Training" section's two toggles, "allow paid endpoints that train" and "allow free endpoints that train", both off, account-wide)
- **OpenAI, API data controls (read 2026-09-30):** https://developers.openai.com/api/docs/guides/your-data — "data sent to the OpenAI API is not used to train or improve OpenAI models" by default since March 1, 2023; "abuse monitoring logs are generated for all API feature usage and retained for up to 30 days" by default; Zero Data Retention needs OpenAI's own prior approval via their sales team, it is not self-service
- Google, API Services User Data Policy: https://developers.google.com/terms/api-services-user-data-policy
- Google, Workspace user data and developer policy: https://developers.google.com/workspace/workspace-api-user-data-developer-policy

**Caveats on the reading:** the OpenRouter, OpenAI and Google pages were summarised by a fetch tool, so quoted phrases should be checked against the live pages; the Google sentence about foundational and frontier models came from a search result, not the policy text itself, so read that section directly before relying on the wording; and OpenAI's page does not say whether its stated defaults apply identically to API calls made by a reseller (OpenRouter) versus a direct API key holder — assumed here, not confirmed by either company in writing.
