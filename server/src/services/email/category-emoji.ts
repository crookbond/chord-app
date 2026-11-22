/**
 * Read-time emoji fallback for tile icons (ADR 0068 addendum). The classifier
 * contract already carries an optional per-category `icon`; when none was
 * assigned, tiles get a deterministic keyword-matched emoji so the map can
 * label rectangles too small for their title. First matching rule wins;
 * unmatched titles get no icon (the client just renders text).
 */
const RULES: Array<[RegExp, string]> = [
  [/school|class|teacher|pta|tuition|student|education|homework/, '🏫'],
  [/flight|airline|airfare/, '✈️'],
  [/hotel|lodging|airbnb|stay/, '🏨'],
  [/travel|trip|vacation/, '🧳'],
  [/bank|finance|statement|invest|brokerage/, '🏦'],
  [/bill|utilit|payment due/, '🧾'],
  [/tax/, '🧮'],
  [/insurance/, '🛡️'],
  [/order|deliver|shipping|package|amazon/, '📦'],
  [/receipt|purchase/, '🧾'],
  [/coupon|deal|promo|discount|sale/, '🏷️'],
  [/grocery|shopping/, '🛒'],
  [/health|medical|doctor|dental|pharmac|clinic|appointment/, '🩺'],
  [/fitness|gym|workout/, '💪'],
  [/friend|family|personal/, '💛'],
  [/kid|child|daycare|camp/, '🧒'],
  [/sport|soccer|baseball|basketball|swim|tennis|team/, '⚽'],
  [/recipe|food|restaurant|dining|cook/, '🍽️'],
  [/newsletter|digest|weekly|news/, '📰'],
  [/event|invit|rsvp|party|calendar/, '📅'],
  [/work|job|career|linkedin|recruit/, '💼'],
  [/home|house|mortgage|rent|hoa/, '🏠'],
  [/car|auto|vehicle|dmv/, '🚗'],
  [/pet|vet /, '🐾'],
  [/music|concert|ticket/, '🎟️'],
  [/photo|album/, '📷'],
  [/tech|software|developer|github/, '💻'],
  [/subscri|membership/, '🔁'],
  [/security|alert|verification|account/, '🔐'],
  [/government|city |county|court|irs/, '🏛️'],
  [/church|temple|community|volunteer/, '🤝'],
  [/social|facebook|instagram|twitter|reddit/, '💬'],
];

export function emojiForCategory(title: string): string | null {
  const t = title.toLowerCase();
  for (const [re, emoji] of RULES) {
    if (re.test(t)) return emoji;
  }
  return null;
}
