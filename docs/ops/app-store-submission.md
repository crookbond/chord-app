# App Store submission — submission packet

Everything needed to submit the iPhone app to the public App Store (US
storefront): the listing text, the App Privacy answers, the review notes, the
demo account, and what is still open. Paste-ready blocks are in fenced code.
Release-plan context: Workstream O3 in
[`../tasks/friends-and-family-release.md`](../tasks/friends-and-family-release.md).
TestFlight (H1) is already live; this is the step after it.

Checked against the code on 2026-10-25. If a new feature collects something new
(a new permission, a new kind of data, an analytics or crash SDK), update the
App Privacy section here **and** in App Store Connect.

## Already done in the app

| Apple requirement | Where it is met |
|---|---|
| 5.1.2(i) — ask before personal data goes to a third-party AI | `/ai-consent` screen after sign-in, Settings → AI model switch (ADR 0283) |
| 4.8 — an Apple-equivalent login beside Google | Sign in with Apple (ADR 0156) |
| 5.1.1(v) — delete the account in the app | Settings → Account → Delete account (ADR 0043), also revokes the Apple token |
| 3.1.1 — anything sold on the web is also sold by In-App Purchase | The plan card sells through the App Store (RevenueCat), with Restore purchases and Redeem a code; a web-bought plan gets one **Manage billing ↗** link (ADR 0340; ADR 0241's link-only card was rejected 13 Nov 2026) |
| 3.1.2 — subscription terms on the purchase screen | Renewal text + Terms of Use and Privacy Policy links under the iPhone purchase buttons (ADR 0340). Also put the Terms of Use link in the app description or the EULA field |
| 5.1.1(iv) — an explanation before a permission prompt always continues to it | Location card and Find friends have one **Continue** button (ADR 0340; the location card's **Not now** was rejected 13 Nov 2026) |
| 5.1.1 — permission texts say what the data is used for | `mobile/app.json` `infoPlist` and the plugin texts |
| Export compliance | `ITSAppUsesNonExemptEncryption: false` (standard HTTPS only) |
| iPhone only | `supportsTablet: false` — no iPad to test on, so no iPad screenshots. The app still runs on an iPad in iPhone compatibility mode, and Apple may open it that way |

Plans are sold through `react-native-purchases` (RevenueCat). Setup steps are in
`docs/ops/billing.md` → "App Store"; the subscriptions must be
attached to the version before submitting.

## App information

Fields in App Store Connect → the app → App Information and the version page.
Character limits are Apple's.

**Name** (30). The App Store record already exists from TestFlight; keep its
name. If "Chord" alone is taken on the store, use:

```
Chord: Family Assistant
```

**Subtitle** (30):

```
Family inbox, calendar, to-dos
```

**Category:** Productivity. Secondary: Lifestyle.

**Promotional text** (170, can be changed without a new build):

```
Chord reads your email, keeps your calendar in sync, and turns the dates, bills and plans buried in your inbox into to-dos you confirm with one tap.
```

**Description** (4000):

```
Chord is an assistant for busy families. It reads your email, keeps your calendar in sync, and keeps track of the to-dos, lists and trips that fall out of both - so nothing slips.

EMAIL THAT TELLS YOU WHAT MATTERS
- Connect Gmail, Outlook or Yahoo. Chord sorts your mail into clear categories and brings the messages that need you to the top.
- It spots what's inside: a school form due Friday, a dentist appointment, a flight, a package arriving, a bill to pay.
- Each one becomes a suggestion - an event, a to-do or a list item - linked to the email it came from. Nothing is added until you tap to confirm.
- Read, reply, forward and search your mail in one place. Ask Chord to draft a reply that offers times you're actually free.

ONE CALENDAR FOR THE FAMILY
- Two-way sync with Google Calendar, plus the calendars on your iPhone.
- Invitations, flights and bookings from your email land on the right day, without duplicates.
- Chord warns you when two plans clash.

TO-DOS, LISTS AND TRIPS
- Action items from your email, tasks with due dates, shared shopping lists, saved places, and trips built from your confirmation emails.
- Share any of it with a family group, or keep it to yourself.

JUST ASK
- Chat with Chord the way you'd text a person: "add milk to the Costco list", "what's on Saturday?", "when does Maya's passport expire?".
- A morning briefing sums up the day: what's on the calendar, what's due, and what arrived overnight.
- Works in the app, and also in WhatsApp and Telegram if you connect them.

YOUR DATA, YOUR CALL
- Chord asks before any of your data is sent to its AI provider, names that provider, and lets you say no.
- Nobody at Chord reads your email. We don't sell your data, show ads, or train AI models on it.
- Delete your account and everything in it from Settings at any time.
```

**Keywords** (100, comma-separated, no spaces after commas; 95 used). No
trademarked names (Gmail, Outlook) — guideline 2.3.7:

```
family,email,inbox,calendar,to-do,planner,organizer,assistant,AI,trips,reminders,schedule,lists
```

**URLs**

| Field | Value |
|---|---|
| Support URL | `https://chordapp.ai` (the page lists `hello@chordapp.ai`) |
| Marketing URL | `https://chordapp.ai` |
| Privacy Policy URL | `https://chordapp.ai/privacy` |

**Copyright:** `2026 Family Grocery Trip Chat Agent LLC`

**Availability:** United States only (Pricing and Availability → deselect every
other country). Stripe web checkout is the reason.

**Price:** Free (the app itself; plans are bought on the web).

### Age rating

Answer Apple's questionnaire as follows. Apple computes the rating from the
answers; expect a teen rating because people can chat with each other.

| Question | Answer | Why |
|---|---|---|
| Violence, sexual content, profanity, horror, drugs, gambling, contests | None | Chord publishes no content of its own |
| Medical or treatment information | None | |
| Messaging and chat | **Yes** | Group chats between family members |
| User-generated content | **Yes** | Messages, files and photos people share in a group |
| Unrestricted web access | No | There is no browser in the app. Links open in Safari |
| Advertising | No | |
| Parental controls / age assurance | No | The Terms require a parent's or guardian's consent under 18 (ADR 0283) |

## App Privacy

App Store Connect → App Privacy. For every type below: **linked to the user's
identity: Yes. Used for tracking: No.** The only purpose is **App
Functionality**. Chord has no analytics, advertising or crash SDK in the app;
if one is added (Sentry, workstream N), add *Crash Data* and *Performance Data*.

"Collected" in Apple's sense means it leaves the phone and we keep it longer
than it takes to answer the request.

| Apple category | Data type | Collected? | What it is in Chord |
|---|---|---|---|
| Contact Info | Name | **Yes** | From Google / Apple / Microsoft sign-in |
| | Email Address | **Yes** | Sign-in email, connected mailboxes |
| | Phone Number | **Yes** | Optional, verified by text message (ADR 0064) |
| | Physical Address | No | |
| | Other User Contact Info | No | |
| Health & Fitness | Health, Fitness | No | |
| Financial Info | Payment Info | No | Card details are entered on Stripe's page, never in the app |
| | Credit Info | No | |
| | Other Financial Info | **Yes** | Amounts, shop and card type + last four digits read from receipt emails (ADR 0160/0249) |
| Location | Precise Location | No | The app asks only for approximate location |
| | Coarse Location | **Yes** | A city and coordinates rounded to ~1 km for the weather (ADR 0258); a city from the IP address if not allowed (ADR 0091) |
| Sensitive Info | Sensitive Info | No | Not collected as a category (it may appear inside someone's own email) |
| Contacts | Contacts | **Yes** | Hashed phone numbers to find friends on Chord (ADR 0065); one contact's details when you ask about them (ADR 0212). Hashing does not count as anonymous to Apple, so declare it |
| User Content | Emails or Text Messages | **Yes** | Connected mail, chat messages |
| | Photos or Videos | **Yes** | Photos and screenshots you attach to a chat |
| | Audio Data | No | The app never records audio (microphone permission is off) |
| | Gameplay Content | No | |
| | Customer Support | No | Support is by email, outside the app |
| | Other User Content | **Yes** | Files, tasks, lists, events, trips, saved people and facts |
| Browsing History | Browsing History | No | |
| Search History | Search History | No | Searches are answered and not kept |
| Identifiers | User ID | **Yes** | Chord account id |
| | Device ID | **Yes** | The push-notification token for each device (declared to be safe) |
| Purchases | Purchase History | **Yes** | Which plan you are on and when it renews (from Stripe) |
| Usage Data | Product Interaction | No | |
| | Advertising Data | No | |
| | Other Usage Data | **Yes** | How many AI tokens your account used (ADR 0193) |
| Diagnostics | Crash Data | No | No crash SDK in the app |
| | Performance Data | No | |
| | Other Diagnostic Data | **Yes** | Server logs: device, app version, errors |
| Other Data | Other Data Types | No | |

Third parties that receive data (for the privacy policy, already listed there,
not an App Store field): the AI model provider (after consent), Google /
Microsoft / Yahoo (the mailboxes and calendars you connect), Twilio (phone
verification), Meta and Telegram (only if you connect them), Stripe (billing),
Open-Meteo (a city's coordinates only).

## Demo account (owner)

The reviewer needs working sign-in **and** something to look at. Sign in with
Apple works with the reviewer's own Apple ID, but that account has no mail, so
also give a Google demo account:

1. Create a Google account for review only, e.g. `reviewer.test@gmail.com`.
   Turn off 2-Step Verification for it, and sign in to it once from a phone and
   a computer, so Google is less likely to ask the reviewer to verify a new
   sign-in from an unknown location.
2. If the Google sign-in screen is still **Testing** (Google Auth Platform →
   Audience), add the account as a test user, or the reviewer cannot sign in.
3. Sign in to Chord with it on a real iPhone. Allow AI use, connect Gmail and
   Calendar.
4. Fill it so every screen has something on it:
   - send it 5–10 emails: a flight confirmation, a school email with a date in
     it, a receipt, a delivery notice with a tracking number, a dinner
     invitation;
   - add a few calendar events this week;
   - create a family group with a second account and post a couple of messages;
   - let Chord make some suggestions and confirm one or two.
5. Check the next day that the morning briefing arrived.
6. Turn on the review sign-in (ADR 0345): in `.env.prod` set
   `REVIEW_SIGN_IN_EMAIL` to the demo account's address and
   `REVIEW_SIGN_IN_PASSWORD` to 20+ random characters, run `secrets.sh push`,
   deploy. Check the sign-in page shows "App review sign-in" and that the
   email + password open the demo account with its mail.
7. Give reviewers THAT email and password (App Review Information →
   Sign-in required; Play Console → App content → App access), not the Google
   password: Google asks a new device to verify, which the reviewer cannot do
   (Play rejected version code 5 for exactly this). Don't commit the password
   anywhere in this repo. Empty the password after review to turn it off.

## Review notes (App Review Information → Notes, 4000)

Fill in the two bracketed parts before pasting.

```
Chord is an assistant for families. It reads the user's email, keeps their calendar in sync, and turns what it finds into to-dos and events the user confirms.

SIGNING IN
- On the sign-in screen, tap "App review sign-in" (below the sign-in buttons) and enter the email and password from the Sign-in fields. This opens the demo account, which has sample email and calendar events already in it, and needs no Google sign-in or device verification.
- "Sign in with Apple" also works with any Apple ID, but that account starts empty (no mail connected).
- [If Google verification is still pending: Google may show "Google hasn't verified this app". Tap Advanced, then Go to Chord. Our verification is in progress.]

FIRST LAUNCH
- After sign-in, Chord asks permission before any personal data is sent to its AI provider (guideline 5.1.2(i)). The screen names the provider and lists what is sent. Tap Allow to see the AI features; Not now keeps them off. The choice can be changed in Settings > AI model.
- Calendar, Contacts, Location, Photos and Notification permissions are asked only when a feature needs them and can all be declined in the system prompt. Where Chord explains a permission first (location on Action Items, Find friends), its only button is Continue, which shows the system prompt.

WHERE TO LOOK
- Action Items (first tab): suggestions Chord made from the demo mailbox. Tap the check mark to confirm one.
- Email: the mailbox sorted into categories.
- Messages: chat with Chord, e.g. "what's on my calendar this week?" or "add milk to the grocery list".
- Calendar: the synced Google calendar.

PURCHASES
- Plans (Individual or Family, monthly or annual) are sold by In-App Purchase in Settings > AI Plan, with Restore purchases and Redeem a code. Someone who subscribed on chordapp.ai sees their plan and a link to manage it there.
- The demo account has its free tokens (ADR 0325), so every feature works without paying.

ACCOUNT DELETION
- Settings > Account > Delete account deletes the account and its data (and revokes Sign in with Apple).

CHATS BETWEEN PEOPLE
- Group chats are private and invite-only: people join with a link from someone already in the group. Any member can leave a group, and messages can be deleted.

Contact: [name, phone], hello@chordapp.ai
```

## Screenshots (owner)

- iPhone 6.9" set only (1320 × 2868 portrait): Apple scales it for smaller
  iPhones. 3–10 images. No iPad set (iPad is off).
- Take them on the demo account, so no real family data appears.
- Suggested order: Action Items with a suggestion card → Email categories → an
  email with a docked suggestion → Calendar week → chat with Chord → morning
  briefing → AI consent screen (shows the privacy stance).
- No Android devices or other platforms' names in the images (2.3.10).

## Before you press Submit

- [ ] Native build with the current `app.json` (the calendar text and
      `supportsTablet: false` are native settings — an OTA update does not
      change them). `eas build -p ios --profile production`, then
      `eas submit -p ios`.
- [ ] Demo account ready and checked from a phone that has never used it.
- [ ] Listing text, keywords, URLs, category, age rating, App Privacy filled in.
- [ ] Availability: United States only.
- [ ] Review notes pasted with the bracketed parts filled in.
- [ ] `https://chordapp.ai/privacy` loads and matches this page's App Privacy
      table.

## Company account (for a transfer after release)

Decided 2026-10-26: submit from the current personal developer account, and
move the app to a company account once it is live. Apple transfers only an
app that has had a version released on the App Store
([criteria](https://developer.apple.com/help/app-store-connect/transfer-an-app/app-transfer-criteria/)),
so the transfer cannot happen before the first release. Get the account
ready in the meantime:

1. **Apple ID for `hello@chordapp.ai`** (owner creates it). It needs two-factor
   authentication on a phone you keep. `hello@` is a list that forwards to
   `john@`, so Apple's codes and mail arrive there.
2. **D-U-N-S number** for Family Grocery Trip Chat Agent LLC: look it up, or
   request one, at
   [developer.apple.com/enroll/duns-lookup](https://developer.apple.com/enroll/duns-lookup/)
   while signed in. Use the legal name and address exactly as registered.
   Free. A new number can take a few days to a couple of weeks to issue.
3. **Enroll as an organization** with that Apple ID: legal name, D-U-N-S,
   the public website `https://chordapp.ai`, and an email on that domain. The
   person enrolling must be able to bind the company to agreements. Apple
   calls to verify. $99 a year.
4. **After the first release**: start the transfer from the personal account,
   accept it in the company account, and do Apple's user-ID migration for
   Sign in with Apple **before** the transfer
   ([TN3159](https://developer.apple.com/documentation/technotes/tn3159-migrating-sign-in-with-apple-users-for-an-app-transfer)).
   Each user's Apple ID is tied to the developer team, so without it every
   Apple sign-in user would arrive as a stranger. That is server work (a
   transfer id per user, then an exchange in the new team), plus a new Sign
   in with Apple key, push key and team ID in the universal-links file. It
   gets its own ADR when the time comes.

## Risks worth knowing before review

- **Guideline 1.2 (user-generated content).** Apps where people can post to
  each other are expected to offer a way to report and block. Chord's chats are
  invite-only, and the server can already block a user for direct messages
  (`blocks.service.ts`, ADR 0067), but there is no Report or Block button in a
  group chat. Reviewers sometimes accept private, invite-only chats without it;
  if they reject on 1.2, the fix is a Report / Block action on a message or
  member plus a contact address in the app.
- **Google sign-in for the reviewer.** A new sign-in from Apple's network can
  trigger Google's "verify it's you". The demo-account steps above reduce it;
  the review notes offer Sign in with Apple as a fallback.
- **The billing link (3.1.1(a)).** The US storefront allows a link to buy
  outside the app. The card shows no prices on iPhone. ADR 0241 records the
  text-only fallback if review objects.
