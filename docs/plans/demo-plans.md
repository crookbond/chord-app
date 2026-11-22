# Demo plans (investor focus)

The single source of truth for **what we're building toward an investor demo**, why, and the open design choices behind each pillar. Companion to the executable [`../tasks/demo-tasks.md`](../tasks/demo-tasks.md): that file is the build checklist; this one is the narrative + decisions.

Productisation, post-demo direction, and far-future bets are deliberately out of scope here. We focus on landing one tight 5-minute story.

> **Demo objective.** The main act is **LLM-driven information population** — extraction, memory, proactive nudges, grounded answers, the consent loop. The optional encore is a **live Telegram bridge** that the bot can join on the spot if a viewer asks for it.
>
> **Scope rule.** *The LLM is the only required external call.* Chat is in-app by default; documents, calendars, deep links are uploaded or mocked. The Telegram connector is the one sanctioned exception — included opportunistically, not on the critical path. Slack/Discord remain post-demo (they need OAuth, not a 2-minute token swap).

## 1. The reviewer's read

> The direction is strong; the gaps are **narrative + polish**, not raw features.

Restated: the capability is there — what's missing is a **tight 5-minute story** with obvious wow moments, legible before/after state, and copy/visual polish that makes the approval loop feel *magical* (trust via control) rather than *cautious* (friction).

The reviewer's suggested four-moment shape maps almost 1:1 onto shipped code:

| Reviewer moment | Shipped code |
|---|---|
| Drop artifact | Upload picker with permission sheet (Pillar 4, 2026-04-17) |
| Extract + propose (not mutate) | `proposals` table + `PROPOSABLE_TOOLS` gate + inline bubble pills (consensus Phase 3–4, 2026-04-23) |
| Approve once → propagates | Bundle commit + SSE fan-out + Resources live-update (consensus Phase 2, 4) |
| Grounded follow-up with provenance | `queryForTurn` memory injection + `bot.sources` footer + `ProvenanceModal` with `source_raw_context` |

So the bet is: **we already have the parts. What we owe is a curated story, not a new feature push.**

## 2. The seven critiques and what they really mean

| # | Critique | Translation | Primary fix kind |
|---|---|---|---|
| 1 | Story too broad | Cut Resources tabs from 8 to 3. Demo script visits 4 surfaces, not all of them. | Narrative + UX |
| 2 | Approval feels cautious | Copy + motion, not new flows. "Proposed" → "Chord suggests…"; approval animates. | Copy + visual |
| 3 | Input needs theater | Use a real flight PDF, a real school form. Drag-and-drop preview. Seed the Doe family *before* the demo. | Assets + seed |
| 4 | Before/after not legible | A "what changed" ribbon, pulsing counters, or a digest surface. | Visual |
| 5 | Trust shown not implied | Scripted "Why this?" tap. Scripted rejection. Scripted restricted-doc refusal. | Script |
| 6 | No ROI frame | One-line headline per moment. Closing outcome slide. | Copy |
| 7 | Visual polish of Resources | Stronger proposed/confirmed visual divide. Collapsed tabs. Non-empty empty states. | Visual |

Five of seven are **copy / script / visual**. Only 1, 4, 7 carry real code components, and even those are small relative to what's already shipped.

## 3. The four pillars

Every demo moment lives under one of these. They're shipped end-to-end (see [`../../README.md`](../../README.md)).

| # | Moment | What it proves |
|---|---|---|
| 1 | **Chord remembers your family** | Persona + group memory survives turns, feeds replies, never leaks across groups. |
| 2 | **Chord acts before you ask** | Proactive nudge on a scheduled trigger; LLM-evaluated task completion closes a task from an inbound message without keywords. |
| 3 | **Chord plans a trip** | Forward a flight PDF → trip + travel leg created; completeness card surfaces the missing return leg. |
| 4 | **Chord respects boundaries** | Upload with group picker; cross-group fallback ("found in *Doe family*, share with *Seattle trip*?"). |

Land these four cleanly and the rest is supporting detail.

### Optional encore — live Telegram bridge

If a viewer asks "where does this run in real life?", we can answer with the room they already use. The connector subsystem (commits `eaf40ca` + `0f12229`, ADR 0010 + 0011) lets the bot join an external Telegram group as another member; inbound messages run through the same `postMessage` + `runBotTurn` pipeline, replies fan out via SSE.

**On-the-spot setup (~2 minutes).**
1. In Telegram, open BotFather → `/newbot` → paste the returned token into `TELEGRAM_BOT_TOKEN` and restart the server.
2. In the Chord mobile UI: open a shared group → **Settings** tab → **Add Telegram group** → copy the 6-char pair code.
3. Add the bot to a real Telegram group, type `/chord pair <code>`. The pairing modal flips to "Connected" via SSE; no shell access needed.

**What it proves.** The four pillars don't depend on the surface. Same memory, same proactive scheduler, same trip extraction — now triggered from a chat the audience uses every day. External users surface as `tier='guest'` shadow members in the bound group, so the permission story (Pillar 4) stays honest across surfaces.

**What stays out of scope for this demo.** Slack and Discord (need OAuth + workspace admin), bidirectional message mirroring (rejected by ADR 0011 — bridges *information* through the bot, not messages), real WhatsApp Business API. If a viewer asks, the answer is "same shape, different setup window — Telegram fits a 2-minute live demo, the others don't."

**Footguns to mind on stage.**
- Telegram BotFather → `/setprivacy` must be **Disable** for group chats, otherwise the bot stays silent on non-mention messages.
- The token belongs to one bot identity; if you've used it elsewhere recently, BotFather rate limits will surface as silence, not errors.
- The settings tab is shared-group-only by design; personal groups don't see it.

## 4. The 5-minute investor script

Drop-in replacement for ad-hoc click-through. Each step has one on-screen headline (the ROI sentence) and one thing it proves.

**0. Cold open (20s).** Open to a pre-seeded Doe-family group with a week of real chat. Headline: *"Family coordination shouldn't live in your head."*

**1. Drop the artifact (~60s).** Upload a flight PDF to the group. Permission picker visibly shows "Doe family" pre-checked. Bot bubble: *"I see a Delta flight SEA→BOS, April 28. Want me to add it to a trip?"* with a **Proposal pill** (trip + leg as a bundle). Headline: *"From document to structure in one tap."* Proves: extraction + user-in-the-loop.

**2. Approve once, watch it land everywhere (~45s).** Tap ✓ on the pill. Animated confirm: pill collapses into Resources → Trips, Resources counter pulses, completeness card shows "Missing: return leg" (Chord feels *helpful*, not just *correct*). Headline: *"One approval, shared memory."* Proves: consensus model + propagation + honest gap-flagging.

**3. Ambient memory accretes (~45s).** Someone types "Mia's peanut allergy again — Costco has safe crackers." Chord silently proposes a memory fact. Tap the "Pending facts" tray. Approve. Headline: *"Chord learns what matters — with your permission."* Proves: passive extraction + the consent loop for **quiet** data (not just docs).

**4. Grounded follow-up (~90s).** Later (or a fake-timestamp jump): someone asks "@Chord what time does our flight leave?" Bot answers with the time, plus the **sources footer** ("based on: Delta-confirmation.pdf"). Tap the ⓘ provenance icon on the trip → modal shows the original PDF text snippet that produced it. Headline: *"Answers you can audit."* Proves: retrieval + provenance + trust via control.

**5. Close (30s).** One slide: four outcomes, not features — *less planning thrash · fewer missed details · shared family memory · safe agent behavior.*

## 5. Polish options (ordered by ROI)

Each is independent; pick a subset.

### Must do before demo

- **O1. Seed the exact demo state.** Extend `npm run demo:seed` to land the scripted Doe family at the moment right *before* step 1 (flight PDF not yet uploaded; one pending memory already in the tray for step 3). Add `npm run demo:reset` for clean reruns. **Cost: ½ day.** High leverage — the demo fails on bad data, not bad code.
- **O2. Copy pass on approval surfaces.** *Proposed* → *Chord suggests.* *Reject* → *Not now*. Post-approve toast: *"Saved to the Boston trip."* Re-read the consent UI as an investor who has never heard of the product. **Cost: few hours.**
- **O3. Provenance tap is demoable.** `source_raw_context` modal exists; add a gentle "🔍 Why?" affordance on trip cards and memory rows so the presenter can reach it without digging. **Cost: few hours.**
- **O4. Real artifacts checked in.** An actual Delta flight confirmation PDF, an actual school-form-looking PDF, one screenshot. Put them in `server/fixtures/demo/` and surface them in `demo:seed`. **Cost: few hours + find PDFs.**

### Strongly recommended

- **O5. Approval animation.** When a proposal confirms, the pill collapses into the matching Resources counter, which briefly pulses. React Native reanimated already in the mobile workspace. **Cost: 1 day.** Highest "magical" ROI per the reviewer.
- **O6. Resources hierarchy collapse.** Go from 8 sections to 3 top-level groupings:
  - **Memory** (facts + audit)
  - **Plans** (tasks + events + trips)
  - **Stuff** (saves + places + contacts + media + lists)

  Sub-sections still exist inside each tab. Keeps the data model intact; only `resources.tsx`. **Cost: 1–1.5 days.** Directly answers critique #1 and #7.
- **O7. Proposed vs. confirmed visual treatment.** Pending rows: left yellow bar + italic label; confirmed rows: subtle green tick on first appear. Shared styling so the pattern is learnable. **Cost: ½ day.**
- **O8. "Since yesterday" ribbon.** Top of Resources: *"+3 proposals · +2 confirmed · +1 memory fact"* for the last 24h. Links at the updates. Addresses critique #4. **Cost: ½ day.**

### Nice to have

- **O9. Empty-state selling copy.** Instead of blank sections, show "Chord will save grocery runs, school forms, and trip docs here." Addresses the *resources-feel-dense* half of critique #7 from the opposite direction. **Cost: few hours.**
- **O10. Guided-demo mode.** A hidden `?demo=1` flag that surfaces step-by-step prompts ("Step 2 of 4: approve the proposal"). Helps when someone else presents. **Cost: 1 day.**
- **O11. Closing outcomes slide baked into the app.** A `/demo-outcomes` route with the four-outcome card so we don't leave the app to close. **Cost: few hours.**

### Suggested sequencing

- Day 1 (decide Q1–Q5 below). Start O1 + O4 — they unblock everyone else's polish.
- Day 2: O2, O3, O7.
- Day 3: O5, O8.
- Day 4: O6 — biggest UX bet, last so smaller wins are banked.
- Day 5: dry-run the script end-to-end. O9 / O11 if time.

### Deliberately cut

- Real email forwarding / IMAP. In-app upload remains canonical.
- Swipe-to-approve / emoji reactions on pills (consensus Phase 5 has natural-language verbs; good enough).
- Auto-approve mode for low-risk entities. The investor story *is* the consent loop — don't weaken it.
- Any new tool or new entity type. Capability is sufficient.
- **Native function-calling on Gemini.** Phase 4 leftover; OpenAI path works and that's what we'll demo against.
- **Admin UI in `client/`.** Engineering audience can be served by logs.
- **Classifier for directive vs. discussion** (consensus Phase 6). Orthogonal to the demo story.

## 6. Open design questions

Decide these per pillar before building. Each pillar's PR should close its relevant Q by citing the chosen option in the commit body. Once closed, leave the row for context.

> All options assume the scope rule: the LLM is the only real external call. "Mocked" ≠ "stubbed" — a mock builds a believable surface, a stub is a disabled affordance.

### Q1 — Memory extraction cadence (Pillar 1)

How does Chord *decide* to write a memory?

| Option | Behaviour | Pro | Con |
|---|---|---|---|
| **A.** Silent + always-on | After every user turn, run extraction; write high-confidence facts silently. | Richest memory graph after 20 messages — investor sees depth. | Risks writing noisy / embarrassing facts during a live demo. |
| **B.** Explicit only | Only `@Chord remember X` writes. Passive extraction off. | Zero surprise. Easy to explain on stage. | Memory tab looks empty unless the script populates it. |
| **C.** Post-document only | Extract from uploaded doc content, not chat text. | Predictable; we control the corpus. | Misses the "Chord learns from conversation" wow factor. |

Recommendation: **A for the demo build, with a kill-switch env flag.** Use the flag to turn it off live if the audience is chatty.

### Q2 — Memory scope visibility (Pillar 1)

| Option | Behaviour |
|---|---|
| **A.** Show scope chip on each memory row (`persona` / `group`) | Teaches the "hermetic groups" story visually. |
| **B.** Colour-coded, no label | Cleaner, weaker signal. |
| **C.** No scope surfaced | Smallest UI surface. Loses the story. |

Recommendation: **A.** Scope is core to the pitch.

### Q3 — Proactive message surface (Pillar 2)

| Option | Behaviour |
|---|---|
| **A.** Inline in the personal chat | Feels like a 1:1 DM. Matches Companion §B.4. |
| **B.** Separate "Updates" tab with badge | Easier to control noise during demo. |
| **C.** Both (A primary, B archive) | Most product-faithful. More UI. |

Recommendation: **A for demo.** One channel.

### Q4 — LLM-evaluated completion scope (Pillar 2)

Which messages trigger task-completion evaluation?

| Option | Behaviour |
|---|---|
| **A.** Every user message | True to Spec §6.3. Expensive per-message LLM call. |
| **B.** Only @Chord messages + forwarded docs | Predictable, cheap, hides half the magic. |
| **C.** Every message, but batched (every 30s) | Cheap + mostly-live. Slight lag. |

Recommendation: **C.** Cheap, feels live, fewer racey UI updates.

### Q5 — Trip completeness surface (Pillar 3)

| Option | Behaviour |
|---|---|
| **A.** Card in group Resources → Trips tab | Faithful to Spec §8.2. User has to navigate. |
| **B.** Proactive nudge on gap ("Missing Nolan's return flight") | Dramatic; reuses Pillar 2 scheduler. |
| **C.** Both (B surfaces, tapping opens A) | Best of both. Most work. |

Recommendation: **C, staged.** Build A first; layer B once scheduler is stable.

### Q6 — Doc-permission picker placement (Pillar 4)

| Option | Behaviour |
|---|---|
| **A.** Bottom sheet after file selection, before upload kicks off | Matches DocPerms §D.3. One extra tap. |
| **B.** Inline chip under the attach icon | Fewer taps, easier to miss. |
| **C.** Defaults silently, surfaces picker only for shared groups | Smoothest UX, weakest demo signal. |

Recommendation: **A.** The picker IS the feature.

### Q7 — Cross-group fallback affordance (Pillar 4)

| Option | Behaviour |
|---|---|
| **A.** Inline button in the bot reply ("Share with this group?") | One-tap, matches DocPerms §D.9. |
| **B.** Separate system message below the bot reply | Harder to miss; more chrome. |
| **C.** Bot mentions in-line, no button | Most WhatsApp-faithful. Not needed since we're in-app. |

Recommendation: **A.**

### Q8 — Identity tiers in the demo (P2)

| Option | Behaviour |
|---|---|
| **A.** Drop identity from the demo | Smallest build. Loses the safety story. |
| **B.** Decorative badge only (Verified / Guest) | Shows the access-matrix story with zero backend. |
| **C.** Simulated three tiers with differing access in-app | Faithful to Identity §E.3. Real engineering. |

Recommendation: **B.** Shield icon next to names. Don't build a tier enforcer.

### Q9 — Demo seed data (P3)

| Option | Behaviour |
|---|---|
| **A.** Fully seeded Doe family — users, attachments, 1 trip, 1 week of events | Demo runs out of the box. Risks feeling scripted. |
| **B.** Empty start, demo script creates everything live | Feels authentic. One typo derails. |
| **C.** Seed corpus (users, attachments, events); demo creates tasks/memories live | Balance. Most realistic for an investor. |

Recommendation: **C.** Seeded context + live interaction.

### Q10 — Deep-link placeholder behaviour (P2)

| Option | Behaviour |
|---|---|
| **A.** Toast with the URL it *would* open | Clear. Honest. |
| **B.** Copy URL to clipboard, toast "Copied" | Feels functional. Investor might not probe. |
| **C.** No-op, grey styling | Clearly not-wired. Safest. |

Recommendation: **A.**

### Q11 — Mock surfaces to add (optional)

Each is < ½-day build. Pick zero or more depending on script:

| Mock | What it adds | When it's worth it |
|---|---|---|
| Email forward form | Paste an email body → creates attachment as if received at `doe-family@chord.app`. | Demonstrates ingestion-email story without IMAP. |
| `.ics` calendar upload | Upload → populate `events` table → bot can answer "what time is cello?". | If the script wants a calendar-aware bot reply. |
| Voice-note with canned transcript | Audio upload → pre-set transcription displayed inline. | Only if the script reads a voice note. |
| "Forwarded by WhatsApp" badge on an attachment | Cosmetic — sets a flag, renders a badge. | Tells "document came in from a group chat" without building any chat. |
| Deep-link toast | Tapping Uber / Maps shows a toast with the URL that *would* open. | Cheapest credibility for the deep-link pillar. |

Nothing on this list is required. Add the ones that make the script land.

## 7. Open questions for the next session

1. **Which PDF?** Real Delta confirmation in fixtures, or a convincing fake? (Real is better for credibility; fake is safer for IP.)
2. **Who presents?** If recorded/hands-off, O10 (guided mode) moves up. If founder live, O10 drops.
3. **Cold start or warm start?** The reviewer's "ask a follow-up later" implies warm; the script above assumes the Doe fixture is loaded.
4. **Pending memory in step 3** — fabricate the trigger message in the seed, or type it live during the demo for authenticity? Live is riskier but more convincing.
5. **Accept the reviewer's offer** to write a concrete 5-minute script with exact steps?

## 8. Deferred forever (for the demo)

These never become options within demo scope:

- Real WhatsApp channel (inbound or outbound, incl. Business API)
- Real Slack / Discord connectors as a live-demo card (they need OAuth + workspace admin — too much setup ceremony)
- Real email ingestion / IMAP / SMTP / Resend
- Real OAuth (Google / Apple / Meta)
- Real calendar sync (Google / CalDAV)
- Real payment / billing
- Multi-node server / Redis SSE hub
- Real push notifications (APNs / FCM / Expo)
- Real Whisper / transcription

The **live Telegram bridge** is the one explicit exception (see §3 encore). It earns its place because the BotFather flow + token swap fits inside a demo window; the others don't.

If a viewer asks "can it do X?" — answer "not in the demo; here's the shape of how it would work." Don't quietly wire a real API call.

## References

- [`../tasks/demo-tasks.md`](../tasks/demo-tasks.md) — the four pillars + executable build checklist.
- [`../tasks/consensus-before-commit.md`](../tasks/consensus-before-commit.md) — the proposal/approval machinery this demo leans on.
- [`../notes/0009-consensus-before-commit.md`](../notes/0009-consensus-before-commit.md) — the ADR behind the consent loop.
- [`../../README.md`](../../README.md) — four-pillar status summary.
