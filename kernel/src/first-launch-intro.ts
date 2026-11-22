/**
 * ADR 0327 — the first-launch intro. Twelve animated pages that say what Chord
 * does, so the person reads what Chord is for before being asked to let it
 * read their mail (ADR 0283).
 *
 * Shown once on a device: on a phone it is the first thing after install,
 * before the sign-in page. Signed in, only while consent is still unanswered:
 * someone who already answered knows Chord, and an update must not put the
 * pages in front of every existing user. The web's signed-out page is the
 * marketing site, so the web plays it at sign-in only.
 */

/** AsyncStorage key; kept on sign-out (it says nothing about the person). */
export const INTRO_SEEN_KEY = 'app.introSeen';

export interface IntroSlide {
  key: string;
  title: string;
  body: string;
}

export const INTRO_SLIDES: readonly IntroSlide[] = [
  {
    key: 'connect',
    title: 'Bring your mail',
    body: 'Sign in with Google or Microsoft and your inbox comes with it. Add Outlook, Yahoo or iCloud any time in Settings.',
  },
  {
    key: 'actions',
    title: 'Never miss an ask',
    body: 'Chord reads your email and pulls out what needs doing: forms to sign, bills to pay, people waiting on you.',
  },
  {
    key: 'calendar',
    title: 'Dates go on the calendar',
    body: 'Appointments, practices and bookings become calendar events with one tap.',
  },
  {
    key: 'school',
    title: 'School mail, sorted',
    body: 'That long school newsletter? Chord finds every date in it and adds the ones that matter.',
  },
  {
    key: 'unsubscribe',
    title: 'Clear out the clutter',
    body: 'Chord spots the mailing lists you never open. Leave them all in one tap, or send their mail straight to Trash.',
  },
  {
    key: 'reply',
    title: 'Replies, written for you',
    body: 'Chord drafts an answer with the times you are actually free. You read it and hit Send.',
  },
  {
    key: 'share',
    title: 'Pass it to your partner',
    body: 'Share an email with your family chat, or forward it, without leaving the app.',
  },
  {
    key: 'chat',
    title: 'Just ask Chord',
    body: '"Move the dentist to Friday." "What time is pickup?" Talk to Chord and it gets done.',
  },
  {
    key: 'lists',
    title: 'Lists the whole family shares',
    body: 'Groceries, packing, gifts. Add from an email or a message, and everyone sees it.',
  },
  {
    key: 'trips',
    title: 'Trips that put themselves together',
    body: 'Flight and hotel confirmations become one trip, with every flight on your calendar. Chord tells you about a night with no hotel.',
  },
  {
    key: 'saves',
    title: 'Save it for later',
    body: 'Restaurants, recipes, links and shows to watch. Tell Chord or share a link, and find it again when you need it.',
  },
  {
    key: 'more',
    title: 'And much more',
    body: 'A morning briefing, birthday reminders, package tracking, receipts and Chord on WhatsApp.',
  },
];

export interface FirstLaunchInput {
  /** This device already showed the intro (or the read failed: never block on it). */
  introSeen: boolean;
  /** Someone is signed in on this device. */
  signedIn: boolean;
  /** ADR 0283 consent is still unanswered (only read when signed in). */
  consentNeeded: boolean;
  /** iOS or Android, not the web. */
  native: boolean;
}

export function shouldShowIntro({ introSeen, signedIn, consentNeeded, native }: FirstLaunchInput): boolean {
  if (introSeen) return false;
  return signedIn ? consentNeeded : native;
}
