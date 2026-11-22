/**
 * Message templates for the load sim. Two pools:
 *   - chatter: free-form messages between humans (no @Chord). Drives load
 *     and tests the no-react path. Some include URLs so the
 *     `bot.save-offer` plumbing is exercised.
 *   - chord: messages addressed to @Chord that should reliably produce a
 *     specific tool call. Each entry declares the *expected* tool so the
 *     verifier can assert the LLM picked the right one. The bot is
 *     allowed to call additional tools too — verification is "did the
 *     expected tool fire," not "only this tool fired."
 *
 * Coverage axes: 5 destinations × dates × hotels for trips; 5 list kinds
 * (destinations / grocery / date spots / hiking trails / likes); event +
 * task + save_link + save_place + important_date variants. Prompts are
 * randomized per axis so the same template doesn't repeat verbatim.
 */
export interface ChatterTemplate {
  pattern: string;
  variants?: string[];
}

export interface ChordTemplate {
  prompt: string;
  /**
   * Expected tool to fire at least once. Use the sentinel `'(none)'` for
   * scenarios where the bot should answer in prose alone (e.g. inline
   * recipe answers); pair with `expectNoTool: true` to assert it.
   */
  expectTool: string;
  /** If set, the bot.card SSE event must include a card of this kind. */
  expectCardKind?: 'task' | 'list' | 'save' | 'event' | 'trip' | 'action';
  /** If set, any action card URL must match this allowed-host pattern. */
  expectUrlHost?: RegExp;
  /**
   * Assert the turn fired NO tool calls at all. Used by inline-only
   * patterns like "give me a recipe" where prose IS the answer.
   */
  expectNoTool?: boolean;
  /**
   * Tools that MUST NOT fire. Used by browse-intent patterns where one
   * tool is expected but a tempting wrong tool should be avoided
   * (e.g. recipe browse fires suggest_external_action but never save_media).
   */
  forbiddenTools?: string[];
}

/**
 * Scenario that needs side-effects (attachment upload, etc.) before the
 * prompt fires. Used by form-fill and screenshot flows. The runner calls
 * `setup()` with the user's client + groupId, gets back a ChordTemplate
 * for verifyTurn, and optionally a `postCheck` that runs after bot.done.
 */
export interface SetupContext {
  client: {
    uploadFile: (
      groupId: string,
      filename: string,
      buffer: Buffer,
      mimeType: string,
    ) => Promise<{ id: string }>;
    postMessage: (groupId: string, body: string) => Promise<{ id: string }>;
    listProposals: () => Promise<Array<{ id: string; kind: string }>>;
  };
  groupId: string;
  /**
   * True when the sim is running against the mock LLM provider. Scenarios
   * that depend on real LLM behaviour (vision/OCR, free-text reasoning)
   * use this to short-circuit with `skipped: true` instead of asserting
   * — see screenshot_classify.
   */
  mock: boolean;
}

/**
 * Result of a setup-scenario postCheck. `skipped` is treated neutrally
 * by the analyzer (separate column from ok / fail) — it means "this
 * scenario is N/A in the current run", not "this passed".
 */
export interface PostCheckResult {
  ok: boolean;
  reason?: string;
  skipped?: boolean;
}

export interface SetupScenario {
  id: string;
  setup: (ctx: SetupContext) => Promise<ChordTemplate | null>;
  postCheck?: (ctx: SetupContext) => Promise<PostCheckResult>;
}

export const CHATTER: string[] = [
  'running 5 min late, parking now',
  'who picked up dinner last time?',
  'kids said the school bake sale moved to friday',
  'guess what — got the new running shoes, finally',
  'omg my flight got delayed an hour, ugh',
  'remember to grab the spare keys',
  'someone sent me this — https://www.nytimes.com/2026/05/article.html',
  'check this out https://www.bonappetit.com/recipe/best-pasta',
  'just heard back from the contractor, he can do tuesday',
  'btw the dishwasher is making that sound again',
  'lol yes please bring extra napkins',
  'anyone want to swing by before the movie?',
  'ok i confirmed the table for 4 at 7:30',
  'cancel that — moving it to 8 because of traffic',
  'flight UA 215 SEA→SFO tomorrow 9am, see u in the lounge',
  'photo from the trail today (pretend image attached)',
  'package finally arrived, thank god',
  'who has the costco card today',
  'did anyone book the airbnb yet??',
  'reservation moved from sat to sun, 6:30, four people',
  'kids got picked for the soccer tournament next weekend!!',
  'zoom link for parent meeting: https://us02web.zoom.us/j/82736192',
  'reminder: trash day shifted to wednesday this week',
  'gonna pick up bread on the way home',
  'ok grocery list — milk, eggs, oat milk, cilantro',
  'love this place — https://www.opentable.com/r/some-spot-seattle',
  'flight attendant said gate change to B7',
  'the airbnb host confirmed, check-in 4pm',
  'anyone seen my charger??',
  'hot take: tuesday taco night should be permanent',
];

// ── Coverage axes ────────────────────────────────────────────────────

interface Destination {
  city: string;       // short name shown in prompts ("SF", "Lisbon", …)
  airport: string;    // IATA for flight prompts
  hotels: string[];
}

const DESTINATIONS: Destination[] = [
  {
    city: 'San Francisco',
    airport: 'SFO',
    hotels: ['the Fairmont', 'Phoenix Hotel', 'Hotel Drisco', 'Proper Hotel SF'],
  },
  {
    city: 'Lisbon',
    airport: 'LIS',
    hotels: ['Bairro Alto Hotel', 'Memmo Alfama', 'Pousada de Lisboa', 'The Lumiares'],
  },
  {
    city: 'Barcelona',
    airport: 'BCN',
    hotels: ['Hotel Casa Fuster', 'Cotton House Hotel', 'Hotel Neri', 'Sofia Barcelona'],
  },
  {
    city: 'London',
    airport: 'LHR',
    hotels: ['The Hoxton Holborn', 'Ham Yard Hotel', 'The Standard London', 'The Ned'],
  },
  {
    city: 'Delhi',
    airport: 'DEL',
    hotels: ['The Imperial', 'Taj Mahal Hotel', 'The Oberoi', 'ITC Maurya'],
  },
];

interface ListSpec {
  /** Names the user might use; sim picks one. */
  names: string[];
  /** Items to add (3-5 randomly chosen each time). */
  items: string[];
}

const LIST_SPECS: ListSpec[] = [
  {
    names: ['destinations', 'travel wishlist', 'places to visit'],
    items: [
      'Reykjavik', 'Faroe Islands', 'Patagonia', 'Kerala', 'Hokkaido',
      'Banff', 'Sicily', 'New Zealand', 'Slovenia', 'Vietnam', 'Morocco',
    ],
  },
  {
    names: ['grocery', 'Costco list', 'Trader Joes'],
    items: [
      'oat milk', 'sourdough', 'arugula', 'sherry vinegar', 'eggs',
      'almonds', 'mango', 'cilantro', 'feta', 'olive oil', 'bread',
      'salmon', 'kimchi', 'avocados',
    ],
  },
  {
    names: ['date spots', 'restaurants to try', 'date night list'],
    items: [
      'Sunda', 'Salare', 'State Bird Provisions', 'Liholiho Yacht Club',
      'Atelier Crenn', 'Canlis', 'Foreign Cinema', 'Zuni Cafe', 'Quince',
    ],
  },
  {
    names: ['hiking trails', 'PNW hikes', 'weekend hikes'],
    items: [
      'Mount Si', 'Rattlesnake Ledge', 'Lake 22', 'Wallace Falls',
      'Mailbox Peak', 'Mount Pilchuck', 'Heather Lake', 'Bridal Veil Falls',
    ],
  },
  {
    names: ['likes', 'gift ideas', 'wishlist'],
    items: [
      'vinyl reissues', 'pour-over coffee gear', 'natural wine',
      'wood-fired pizza spots', 'bouldering shoes', 'bird-watching guides',
      'leather notebooks', 'vintage maps',
    ],
  },
];

const PEOPLE: { name: string; kind: 'birthday' | 'anniversary' | 'death' | 'other' }[] = [
  { name: 'Alice', kind: 'birthday' },
  { name: 'John', kind: 'birthday' },
  { name: 'Ananya', kind: 'birthday' },
  { name: 'Mom', kind: 'birthday' },
  { name: 'Dad', kind: 'birthday' },
  { name: 'us', kind: 'anniversary' },
];

const PLACES: { name: string; area: string; tag: string }[] = [
  { name: 'Salare', area: '25th Ave NE', tag: 'date night' },
  { name: 'Canlis', area: 'Queen Anne', tag: 'special occasion' },
  { name: 'Tilth', area: 'Wallingford', tag: 'brunch' },
  { name: 'Kedai Makan', area: 'Capitol Hill', tag: 'cheap eats' },
  { name: 'Sushi Kashiba', area: 'Pike Place', tag: 'sushi' },
];

const SAVE_LINKS: { url: string; title: string }[] = [
  { url: 'https://www.nytimes.com/best-cookies', title: 'NYT best cookies' },
  { url: 'https://www.bonappetit.com/recipe/perfect-pasta', title: 'BA perfect pasta' },
  { url: 'https://kottke.org/article-of-interest', title: 'kottke.org piece' },
  { url: 'https://www.npr.org/great-podcast-2026', title: 'NPR podcast roundup' },
  { url: 'https://airbnb.com/rooms/12345', title: 'Sicily airbnb' },
];

const TASKS: { title: string; when: string }[] = [
  { title: 'call the dentist', when: 'tomorrow at 2pm' },
  { title: 'pick up the prescription', when: 'Friday' },
  { title: 'renew the passport', when: 'next month' },
  { title: 'mail the package', when: 'Wednesday' },
  { title: 'book the cleaner', when: 'this weekend' },
];

const EVENTS: { title: string; when: string; duration: string; loc?: string }[] = [
  { title: 'soccer practice', when: 'Wednesday at 5pm', duration: '90-minute', loc: 'Lower Woodland field 3' },
  { title: 'parent-teacher conference', when: 'Tuesday at 4pm', duration: '30-minute' },
  { title: 'dentist cleaning', when: 'Thursday at 10am', duration: '45-minute' },
  { title: 'team standup', when: 'Monday at 9am', duration: '30-minute' },
  { title: 'piano recital', when: 'Saturday at 2pm', duration: '2-hour', loc: 'Town Hall' },
  { title: 'yoga class', when: 'Sunday at 8am', duration: '75-minute' },
];

// ── Helpers ──────────────────────────────────────────────────────────

function rand<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function randSubset<T>(arr: readonly T[], min: number, max: number): T[] {
  const n = min + Math.floor(Math.random() * (max - min + 1));
  const copy = [...arr];
  copy.sort(() => Math.random() - 0.5);
  return copy.slice(0, Math.min(n, copy.length));
}

const MONTHS = ['May', 'June', 'July', 'August', 'September', 'October'];

function tripDates(): { startMonth: string; startDay: number; endMonth: string; endDay: number } {
  const startMonth = rand(MONTHS);
  const startDay = 5 + Math.floor(Math.random() * 18);
  const dur = 4 + Math.floor(Math.random() * 8);
  const endDay = startDay + dur;
  // Keep simple: month rollover not modeled; range stays inside the same month.
  return { startMonth, startDay, endMonth: startMonth, endDay };
}

// ── Generated CHORD prompts ──────────────────────────────────────────

function genTripPrompts(): ChordTemplate[] {
  return DESTINATIONS.map((d) => {
    const { startMonth, startDay, endMonth, endDay } = tripDates();
    return {
      prompt: `@Chord create a trip — ${d.city}, ${startMonth} ${startDay} to ${endMonth} ${endDay}`,
      expectTool: 'create_trip',
      expectCardKind: 'trip' as const,
    };
  });
}

function genAccommodationPrompts(): ChordTemplate[] {
  return DESTINATIONS.map((d) => {
    const hotel = rand(d.hotels);
    const startDay = 10 + Math.floor(Math.random() * 15);
    const dur = 3 + Math.floor(Math.random() * 6);
    const month = rand(MONTHS);
    return {
      prompt: `@Chord we're staying at ${hotel} in ${d.city}, ${month} ${startDay} check-in, ${month} ${startDay + dur} check-out`,
      expectTool: 'add_accommodation',
    };
  });
}

function genTravelLegPrompts(): ChordTemplate[] {
  const carriers = ['UA', 'AA', 'BA', 'AI', 'TAP', 'IB'];
  return DESTINATIONS.map((d) => {
    const carrier = rand(carriers);
    const flightNo = 100 + Math.floor(Math.random() * 800);
    const day = 5 + Math.floor(Math.random() * 20);
    const month = rand(MONTHS);
    return {
      prompt: `@Chord adding a flight for John — ${carrier} ${flightNo} SEA→${d.airport} ${month} ${day} 09:15 to 17:30`,
      expectTool: 'add_travel_leg',
    };
  });
}

function genListPrompts(): ChordTemplate[] {
  return LIST_SPECS.map((spec) => {
    const listName = rand(spec.names);
    const items = randSubset(spec.items, 3, 5);
    return {
      prompt: `@Chord add to the ${listName} list — ${items.join(', ')}`,
      expectTool: 'add_list_item',
      expectCardKind: 'list' as const,
    };
  });
}

function genSavePlacePrompts(): ChordTemplate[] {
  return PLACES.map((p) => ({
    prompt: `@Chord save this place — ${p.name} on ${p.area}, great for ${p.tag}`,
    expectTool: 'save_place',
  }));
}

function genSaveLinkPrompts(): ChordTemplate[] {
  return SAVE_LINKS.map((l) => ({
    prompt: `@Chord save this link ${l.url} — ${l.title.toLowerCase()}`,
    expectTool: 'save_link',
    expectCardKind: 'save' as const,
  }));
}

function genTaskPrompts(): ChordTemplate[] {
  return TASKS.map((t) => ({
    prompt: `@Chord remind me to ${t.title} ${t.when}`,
    expectTool: 'create_task',
    expectCardKind: 'task' as const,
  }));
}

/**
 * Task prompts that carry an explicit due time. The verifier here only
 * asserts that `create_task` fires and a task card lands (the sim's
 * verifier doesn't inspect field values); the unit test
 * `trust-task-flows.integration.test.ts` covers the exact-time invariant
 * deterministically.
 */
function genTaskWithTimePrompts(): ChordTemplate[] {
  const variants: { title: string; due: string }[] = [
    { title: 'call the vet', due: 'tomorrow at 3pm' },
    { title: 'pick up the prescription', due: 'Friday at 10am' },
    { title: 'submit the form', due: 'next Monday at 9am' },
    { title: 'water the plants', due: 'in 2 hours' },
  ];
  return variants.map((v) => ({
    prompt: `@Chord remind me to ${v.title} ${v.due}`,
    expectTool: 'create_task',
    expectCardKind: 'task' as const,
  }));
}

/**
 * Slash-command exercise — verifies the Telegram `/chord <text>` path
 * is wired up correctly through the @-mention pipeline. The sim posts
 * native @-mentions via the HTTP API, so these are not platform-real
 * Telegram messages; they live here to keep the templates discoverable
 * and to coach the LLM that bare `/chord` prefixes are valid bot
 * invocations.
 */
function genSlashCommandPrompts(): ChordTemplate[] {
  return [
    {
      prompt: '/chord remind me to call the vet tomorrow at 3pm',
      expectTool: 'create_task',
      expectCardKind: 'task' as const,
    },
    {
      prompt: '/chord add milk and bread to the costco list',
      expectTool: 'add_list_item',
      expectCardKind: 'list' as const,
    },
  ];
}

function genEventPrompts(): ChordTemplate[] {
  return EVENTS.map((e) => ({
    prompt: `@Chord put ${e.title} on the calendar for ${e.when} — it's a ${e.duration} session${e.loc ? ` at ${e.loc}` : ''}`,
    expectTool: 'create_event',
    expectCardKind: 'event' as const,
  }));
}

function genImportantDatePrompts(): ChordTemplate[] {
  const dates = ['March 14', 'May 8', 'June 12', 'July 21', 'September 3', 'November 18'];
  return PEOPLE.map((p) => ({
    prompt:
      p.kind === 'anniversary'
        ? `@Chord remember our anniversary is ${rand(dates)}`
        : `@Chord remember ${p.name}'s birthday is ${rand(dates)}`,
    expectTool: 'add_important_date',
  }));
}

/**
 * Cross-surface search prompts — exercise that `search_saves` is the
 * tool the LLM picks when the user asks about things they previously
 * told Chord about, regardless of whether the original write was a
 * `save_*` (saves table) or `add_list_item` (lists table).
 */
function genSearchPrompts(): ChordTemplate[] {
  return [
    {
      prompt: '@Chord which restaurants did I want to try?',
      expectTool: 'search_saves',
    },
    {
      prompt: '@Chord which places have I saved for date night?',
      expectTool: 'search_saves',
    },
    {
      prompt: '@Chord what hikes did I add to the hiking list?',
      expectTool: 'search_saves',
    },
    {
      prompt: '@Chord which links did I save about cookies?',
      expectTool: 'search_saves',
    },
  ];
}

/**
 * "Where is X?" routing — person → Apple Find My; place → Google Maps.
 * The LLM must distinguish a saved-person name from a place name. People
 * names below match the `PEOPLE` array seeded earlier in the run via
 * add_important_date prompts, so they exist in the user's saved-people
 * list by the time these fire (sim ordering is randomized but the pool
 * is uniform, so over a normal run people are present long before the
 * verifier evaluates rate).
 */
function genWhereIsPersonPrompts(): ChordTemplate[] {
  const phrasings = ['where is', 'where\'s', 'find', 'locate'];
  return PEOPLE.filter((p) => p.kind === 'birthday')
    .map((p) => p.name)
    .map((name) => ({
      prompt: `@Chord ${rand(phrasings)} ${name}?`,
      expectTool: 'suggest_external_action',
      expectCardKind: 'action' as const,
      expectUrlHost: /icloud\.com\/find/i,
    }));
}

function genWhereIsPlacePrompts(): ChordTemplate[] {
  const places = [
    'the Eiffel Tower',
    'Pike Place Market',
    'Atelier Crenn',
    'Times Square',
    'the Taj Mahal',
    'Gas Works Park',
    'the Golden Gate Bridge',
    'Sagrada Familia',
  ];
  const phrasings = ['where is', 'where\'s', 'directions to', 'show me on the map'];
  return places.map((p) => ({
    prompt: `@Chord ${rand(phrasings)} ${p}?`,
    expectTool: 'suggest_external_action',
    expectCardKind: 'action' as const,
    expectUrlHost: /google\.com\/maps/i,
  }));
}

function genRecipeInlinePrompts(): ChordTemplate[] {
  // "Give me a recipe" / "what should I cook" — answer is INLINE prose,
  // no tool fire. The forbiddenTools list catches the two tempting wrong
  // answers (kicking the user out to AllRecipes via suggest_external_action,
  // or saving a recipe the user didn't ask to save).
  const phrasings = [
    '@Chord give me a recipe',
    '@Chord what should I cook tonight?',
    '@Chord any recipe ideas?',
    '@Chord recipe for tadka daal',
    '@Chord recipe for khichdi',
    '@Chord we have chicken and peppers — what should I make?',
    "@Chord I've got cauliflower and potatoes, what's a quick dinner?",
    '@Chord something easy for tonight',
  ];
  return phrasings.map((p) => ({
    prompt: p,
    expectTool: '(none)',
    expectNoTool: true,
    forbiddenTools: ['suggest_external_action', 'save_media', 'save_link'],
  }));
}

function genRecipeBrowsePrompts(): ChordTemplate[] {
  // Browse intent — user explicitly asks to see/find recipe links. Should
  // fire suggest_external_action with kind=recipe (AllRecipes). save_media
  // is still forbidden — the user asked to browse, not to save.
  const phrasings = [
    '@Chord show me recipes for thai green curry',
    '@Chord find me a recipe link for vegetarian lasagna',
    '@Chord search recipes for chicken biryani',
    '@Chord find recipes for weeknight pasta',
    '@Chord show me a recipe link for paneer tikka masala',
  ];
  return phrasings.map((p) => ({
    prompt: p,
    expectTool: 'suggest_external_action',
    expectCardKind: 'action' as const,
    expectUrlHost: /allrecipes/i,
    forbiddenTools: ['save_media', 'save_link'],
  }));
}

function genSuggestActionPrompts(): ChordTemplate[] {
  const out: ChordTemplate[] = [];
  // Restaurant suggestions across destination cities + Seattle.
  for (const place of [...PLACES.map((p) => p.name), 'Atelier Crenn', 'Belon']) {
    out.push({
      prompt: `@Chord give me a link to reserve a table for 4 at ${place} on Saturday at 7pm`,
      expectTool: 'suggest_external_action',
      expectCardKind: 'action',
      expectUrlHost: /(opentable|resy|tock|sevenrooms)\./i,
    });
  }
  // Flights to each destination.
  for (const d of DESTINATIONS) {
    out.push({
      prompt: `@Chord show me a search link for flights from SEA to ${d.airport} on June 12, returning June 19`,
      expectTool: 'suggest_external_action',
      expectCardKind: 'action',
      expectUrlHost: /(google\.com\/travel|kayak|expedia|skyscanner|momondo)/i,
    });
  }
  // Hotels in each destination.
  for (const d of DESTINATIONS) {
    out.push({
      prompt: `@Chord show me a search link for hotels in ${d.city}, check-in Aug 14, check-out Aug 18`,
      expectTool: 'suggest_external_action',
      expectCardKind: 'action',
      expectUrlHost: /(expedia|booking|hotels|kayak|airbnb|google\.com\/travel)/i,
    });
  }
  return out;
}

/**
 * Generated at module load. The simulator picks uniformly at random
 * from this pool, so coverage across destinations / list kinds /
 * templates is uniform per call.
 */
export const CHORD_PROMPTS: ChordTemplate[] = [
  ...genTripPrompts(),
  ...genAccommodationPrompts(),
  ...genTravelLegPrompts(),
  ...genListPrompts(),
  ...genSavePlacePrompts(),
  ...genSaveLinkPrompts(),
  ...genTaskPrompts(),
  ...genTaskWithTimePrompts(),
  ...genSlashCommandPrompts(),
  ...genEventPrompts(),
  ...genImportantDatePrompts(),
  ...genSearchPrompts(),
  ...genSuggestActionPrompts(),
  ...genWhereIsPersonPrompts(),
  ...genWhereIsPlacePrompts(),
  ...genRecipeInlinePrompts(),
  ...genRecipeBrowsePrompts(),
];

// ── Setup scenarios (require attachment upload before prompt) ────────

import { buildSchoolFormFixture, tinyPng } from './fixtures.js';

/**
 * Form-fill scenario: upload a synthetic fillable school PDF, then ask
 * Chord to fill it for a known kid. Expects `start_form_fill` to fire.
 * The follow-up `complete_form_fill` is conversational and depends on
 * gap-fill answers from the user — out of scope for the simulator's
 * one-turn-at-a-time model. The verifier just asserts the schema
 * extraction and resolution kicked off.
 */
export const FORM_FILL_SCENARIOS: SetupScenario[] = [
  {
    id: 'form_fill_school_ananya',
    setup: async ({ client, groupId }) => {
      const buf = await buildSchoolFormFixture();
      const att = await client.uploadFile(
        groupId,
        `school_form_${Date.now()}.pdf`,
        buf,
        'application/pdf',
      );
      // Brief pause so the upload + indexing settles before the prompt.
      await new Promise((r) => setTimeout(r, 200));
      return {
        prompt: `@Chord please fill this school form for Ananya — attachment ${att.id}`,
        expectTool: 'start_form_fill',
      };
    },
  },
  {
    id: 'form_fill_school_ambiguous',
    setup: async ({ client, groupId }) => {
      // No subject named — the bot should either ask which kid or pick
      // the most recently mentioned. Either way, the form-fill tool
      // should still get called once the kid is identified — but in
      // one-turn mode we just check the bot's first response. So expect
      // EITHER start_form_fill (auto-routed) or no tool but a prose
      // disambiguator. We assert against start_form_fill and let the
      // verifier's mock-mode lenience cover the disambiguator path.
      const buf = await buildSchoolFormFixture();
      const att = await client.uploadFile(
        groupId,
        `school_form_${Date.now()}.pdf`,
        buf,
        'application/pdf',
      );
      await new Promise((r) => setTimeout(r, 200));
      return {
        prompt: `@Chord fill this form (attachment ${att.id})`,
        expectTool: 'start_form_fill',
      };
    },
  },
];

/**
 * Screenshot-classify scenario: upload an image and rely on the
 * background classifier (no @Chord prompt needed). Verifier checks
 * that proposals appeared. The 1×1 PNG fixture short-circuits in mock
 * mode (low OCR signal) — non-mock runs need a real screenshot fixture
 * piped in via the CLIs `--screenshot-fixture` flag (TODO).
 */
export const SCREENSHOT_SCENARIOS: SetupScenario[] = [
  {
    id: 'screenshot_classify',
    setup: async ({ client, groupId }) => {
      await client.uploadFile(
        groupId,
        `screenshot_${Date.now()}.png`,
        tinyPng(),
        'image/png',
      );
      // No prompt — the classifier runs in background. Return null to
      // tell the runner to skip the @Chord turn but still run postCheck.
      return null;
    },
    postCheck: async ({ client, mock }) => {
      // Mock provider has no vision/OCR — the classifier path can't
      // produce save proposals from a 1×1 PNG. Skip rather than fail.
      if (mock) {
        return { ok: true, skipped: true, reason: 'mock provider skips OCR' };
      }
      // Wait up to 10s for classifier proposals to land.
      for (let i = 0; i < 20; i += 1) {
        const proposals = await client.listProposals();
        if (proposals.length > 0) return { ok: true };
        await new Promise((r) => setTimeout(r, 500));
      }
      return { ok: false, reason: 'no proposals appeared within 10s' };
    },
  },
];

export const SETUP_SCENARIOS: SetupScenario[] = [
  ...FORM_FILL_SCENARIOS,
  ...SCREENSHOT_SCENARIOS,
];
