# Google OAuth verification — submission packet

Everything needed to submit Chord's Google Cloud project for OAuth app
verification: the console fields, the scope justifications (paste-ready), the
demo video script, and what happens after. Release-plan context: Workstream H2
gate 1 in [`../tasks/friends-and-family-release.md`](../tasks/friends-and-family-release.md).
This gate applies to **iOS and web**, not just Android — it is about the Google
scopes, not the platform.

## What is being verified

One Google Cloud project, `178917388887`, which holds both OAuth clients:

| Client | Id prefix | Used by |
|---|---|---|
| Web | `178917388887-56snv7ef…` | web app, and Android via ADR 0081 |
| iOS | `178917388887-iuo4l866…` | native iOS (ADR 0041) |

Scopes Chord requests — this is the complete list, checked against the code
(`mobile/app/index.tsx` sign-in, `mobile/app/settings.tsx` Calendar/Gmail connect):

| Scope | Google's class | Requested when |
|---|---|---|
| `openid`, `email`, `profile` | non-sensitive | sign-in |
| `https://www.googleapis.com/auth/calendar` | **sensitive** | sign-in (declinable), and Settings → Connect Calendar |
| `https://www.googleapis.com/auth/gmail.modify` | **restricted** | Settings → Connect Gmail only |

`gmail.modify` being **restricted** is what makes this long: it requires an
annual third-party security assessment (CASA) on top of the normal review.

## Before you submit (owner-only steps)

1. **Deploy the current `main`** — the reviewer reads the live privacy policy
   and compares it with the app. The 2026-09-10 policy corrections (sending
   mail, message storage, AI provider + WhatsApp/Telegram disclosure, the dead
   `/settings/delete` link, the Limited Use link) and the Gmail-disconnect fix
   must be live first.
2. **Check the publishing status** (Google Auth Platform → Audience). It must be
   **In production** to submit. If it is still **Testing**, note that Google
   expires refresh tokens for sensitive scopes after 7 days in that mode — every
   tester would have to reconnect weekly.
3. **Verify `chordapp.ai` in Google Search Console** with a Google account that
   is an Owner or Editor on project `178917388887`. Verification is refused for
   a domain the submitting account does not own.
4. **Logo**: a square PNG, 120×120, with no Google marks. Uploading a logo is
   what triggers brand review, so use the final one.
5. **A demo Google account** with realistic mail and calendar entries, for the
   video. Do not record your own mailbox — reviewers see every frame.

## Console fields (Google Auth Platform)

Older consoles call this area the *OAuth consent screen*.

**Branding**

| Field | Value |
|---|---|
| App name | `Chord` (must match what the homepage calls the app) |
| User support email | `privacy@chordapp.ai` (or a monitored inbox you prefer) |
| App logo | the 120×120 PNG |
| Application home page | `https://chordapp.ai` |
| Application privacy policy link | `https://chordapp.ai/privacy` |
| Application terms of service link | `https://chordapp.ai/tos` |
| Authorized domains | `chordapp.ai` |
| Developer contact | an address you read |

**Data access** — add the five scopes above, then paste one justification per
sensitive/restricted scope.

### Justification — `…/auth/calendar`

> Chord is a family assistant that keeps a household's plans in one place. With
> the user's permission it reads the user's calendar list and events to show
> their schedule in the app and to warn about conflicts before a plan is made.
> When the user (or their family group) creates a plan in Chord, Chord writes the
> event to one calendar on the user's account, creating a dedicated secondary
> calendar for it if the user does not already have one — which is why the full
> calendar scope is needed rather than calendar.events. When the user answers an
> invitation in Chord (Yes / Maybe / No), Chord updates their own attendee
> response on that event so the organizer is told. Sync is two-way: edits and
> deletions made in Google Calendar are reflected in Chord. Calendar data is used
> only to provide these features to the user, is never sold or used for
> advertising, and is not used to train AI models.

### Justification — `…/auth/gmail.modify`

> Gmail access is optional and requested only when the user taps "Connect Gmail".
> Chord reads the user's messages to sort them by category and attention, to
> suggest events, to-dos and list items found in their mail (nothing is created
> until the user confirms each suggestion), to include an email summary in the
> user's morning briefing, and to let the user search their mail. The user can
> reply to, compose and forward mail from Chord, archive a thread, and mark it
> read or unread; those actions are written back to Gmail so the mailbox stays in
> sync. gmail.modify is the narrowest single scope that covers reading, sending
> and changing labels; Chord never permanently deletes mail. Message content is
> processed by our AI model provider only to provide these user-facing features,
> under terms that prohibit training on it. We do not sell Gmail data, use it for
> advertising, or use it to train AI models, and we adhere to the Google API
> Services User Data Policy including Limited Use.

## Demo video script

Google needs one video (unlisted YouTube link) showing, for the production
client, the consent flow and each requested scope in use. Record on **desktop
web** so the browser address bar — which shows the `client_id` — is visible on
the Google consent page. English, 3–6 minutes, no voice-over required but
on-screen captions help.

1. **Homepage.** Open `https://chordapp.ai`. Scroll briefly; click through to
   the privacy policy and back.
2. **Sign in.** Click "Sign in with Google". On Google's page, **zoom on the
   address bar** so `client_id=178917388887-56snv7ef…` is readable. Show the app
   name "Chord" and the Calendar permission; grant it.
3. **Calendar — read.** Open Calendar in Chord; show events that came from
   Google Calendar (open `calendar.google.com` in a second tab to show they match).
4. **Calendar — write.** In the personal chat, type
   `@Chord add dentist on Friday at 3pm`. Show the event appear in Chord, then in
   Google Calendar on the Chord-managed calendar.
5. **Calendar — invitation.** (If the demo account has one pending) answer an
   invitation's Yes/No card in Chord and show the response in Google Calendar.
6. **Connect Gmail.** Settings → Connected accounts → Connect Gmail. On the
   consent page, again show the address bar, then the Gmail permission; grant it.
7. **Gmail — read + organise.** Open the Email tab; show mail sorted into
   categories; open a thread.
8. **Gmail — suggestion.** Show a suggestion extracted from an email (e.g. an
   event from a school email); confirm it, and show the result in To Do's or
   Calendar.
9. **Gmail — send.** Reply to a thread from Chord; switch to Gmail and show the
   reply in Sent.
10. **Gmail — modify.** Archive a thread and mark another read in Chord; show
    both reflected in Gmail.
11. **User control.** Settings → Disconnect Gmail; show the email surface empty
    and Gmail shown as disconnected.

The iOS client uses the same scopes. If the reviewer asks for it separately,
add a short iPhone screen recording of steps 2 and 6.

## After you submit

1. **Brand + scope review.** Google may email questions; reply in the same
   thread. Common asks: a clearer video, a privacy-policy sentence moved or
   linked, a narrower scope. Google does not publish a firm timeline.
2. **CASA (for `gmail.modify`).** Once the scope review passes, Google sends
   instructions to complete a CASA Tier 2 assessment through an authorized lab
   listed on the App Defense Alliance site. The lab scans the app and reviews a
   questionnaire; its letter of assessment goes back to Google. **This repeats
   every 12 months.** Google decides the tier. Prices from TAC Security's own
   page, checked 2026-09-10, per app per year: Tier 2 **$675** (Basic, two
   revalidations) / **$855** (Premium, unlimited revalidations) / $1,800
   (Enterprise); Tier 3 $4,500. Blogs still quote an older $540. TAC states 1–2
   business days to scan and 5–6 for Google to act on the letter. Pick a plan
   with unlimited revalidations: a first scan usually has findings to fix, and
   each fix needs a rescan.
3. **Approval** removes the "Google hasn't verified this app" screen and the
   100-user cap for unverified apps — the two things that block a public launch.

## Why this gates the public launch

An unverified app stops accepting new users at 100, and every user sees
"Google hasn't verified this app" on the way in. Neither is survivable for a
public launch, so verification (CASA included) has to finish **before** it —
start it now; it is the longest external lead time on the release.

## Re-verification triggers

Adding a new sensitive or restricted scope, changing the app name or logo, or
changing the homepage/privacy domain sends the app back through review. The
vacation-responder and send-as features were deliberately built without new
scopes for this reason (ADRs 0124, 0130).
