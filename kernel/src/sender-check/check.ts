/**
 * Is this sender who they say they are? (ADR 0294.)
 *
 * Deterministic checks over what is already known about a message: the
 * display name, the address, the receiving server's authentication verdict,
 * Reply-To, the links' hosts and whether the user has corresponded with the
 * address before. Each finding is a `SenderSignal` worded for the reader.
 *
 * Nothing here ever says a message is SAFE. The absence of signals means
 * "nothing found", and the reader says so in those words. A brand not in
 * `BRANDS` is never claimed, so an unlisted company cannot trip a false
 * "this isn't really them".
 */
import type { SenderAuth } from './auth-results';
import { BRANDS, SERVICE_WORDS, type Brand } from './brands';
import { hasNonAscii, hostToUnicode, latinSkeleton } from './confusables';
import {
  domainLabel,
  domainOf,
  editDistance,
  foldLookalikes,
  hasPunycode,
  isFreemail,
  isIpHost,
  registrableDomain,
} from './domains';

export type SenderSignalLevel = 'info' | 'caution' | 'danger';

export type SenderSignalCode =
  | 'brand_mismatch'
  | 'lookalike_domain'
  | 'name_shows_other_address'
  | 'punycode_domain'
  | 'auth_failed'
  | 'auth_weak'
  | 'reply_to_elsewhere'
  | 'suspicious_link'
  | 'impersonates_contact'
  | 'mixed_script_name'
  | 'hidden_characters'
  | 'risky_attachment'
  | 'first_contact'
  | 'not_addressed_to_you';

export interface SenderSignal {
  code: SenderSignalCode;
  level: SenderSignalLevel;
  /** One sentence for the reader. */
  message: string;
}

export interface SenderHistory {
  /** Earlier messages from this address, not counting this one. */
  received: number;
  /** Messages the user has sent to this address. */
  wrote: number;
  /** The address is on one of the user's saved People. */
  inPeople: boolean;
}

export interface SenderCheckInput {
  fromName: string | null;
  fromEmail: string | null;
  replyTo?: string | null;
  /** Null/undefined = the provider did not give us the header (not checked). */
  auth?: SenderAuth | null;
  toEmails: string[];
  ccEmails: string[];
  /** The user's own mailbox addresses. */
  ownAddresses: string[];
  history?: SenderHistory | null;
  /** ADR 0109 mass mail: a newsletter is not "addressed to you" by design. */
  bulk?: boolean;
  /** Hosts of the links in the body. */
  linkHosts?: string[];
  /** A saved person (People) whose name the display name uses, with the
   *  addresses the user has for them. */
  contactNamed?: { name: string; addresses: string[] } | null;
  attachmentNames?: string[];
  /** Registrable domains the user writes to or has in People: what a
   *  look-alike would imitate when it is not a listed brand. */
  knownDomains?: string[];
  /** The user's own message: nothing to check. */
  sent?: boolean;
}

export interface SenderCheck {
  level: 'none' | SenderSignalLevel;
  signals: SenderSignal[];
  /** The company the display name claims, when it claims one we know. */
  claimedBrand: string | null;
  /** The sender's real domain (`notify.robinhood.com`). */
  domain: string | null;
  /** The receiving server confirmed the mail came from `domain` (DMARC pass). */
  verifiedDomain: boolean;
  /** Whether an authentication verdict was available at all. */
  authChecked: boolean;
  history: SenderHistory | null;
  /** Set when `reply_to_elsewhere` fired: the address replies are directed to. */
  replyTo?: string;
}

const RANK: Record<SenderCheck['level'], number> = { none: 0, info: 1, caution: 2, danger: 3 };

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/["'`]/g, '')
    .split(/[^a-z0-9&.-]+/)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ''))
    .filter(Boolean);
}

function containsPhrase(tokens: string[], phrase: string): boolean {
  const p = phrase.split(/\s+/);
  for (let i = 0; i + p.length <= tokens.length; i++) {
    if (p.every((w, j) => tokens[i + j] === w)) return true;
  }
  return false;
}

/**
 * Any character that draws nothing, anywhere in a display name: a name has no
 * reason to hide text, so it is obfuscation (owner rule 2026-10-29). The one
 * exception is the selector and joiner that are part of writing an emoji
 * ("❤️", a family emoji), which is how emoji are encoded, not hidden text.
 */
function hasHiddenCharacters(name: string): boolean {
  const withoutEmojiGlue = name.replace(/(?<=\p{Extended_Pictographic})[️‍]/gu, '');
  return /\p{Default_Ignorable_Code_Point}/u.test(withoutEmojiGlue);
}

/**
 * A distinctive brand written in pieces or glued to a service word: "Coin
 * base", "C o i n b a s e", "Coinbase.com", "CoinbaseSupport", "C0inbase".
 * Pieces must join to exactly the name, and a glued tail must be a service
 * word, so "Venmore Realty" is not Venmo.
 */
function spelledOut(tokens: string[], phrase: string): boolean {
  const target = foldLookalikes(phrase.replace(/[\s.]+/g, ''));
  const parts = tokens.flatMap((t) => t.split(/[.-]+/)).filter(Boolean).map(foldLookalikes);
  for (let i = 0; i < parts.length; i++) {
    const head = parts[i]!;
    if (head.startsWith(target) && head !== target && FOLDED_SERVICE_WORDS.has(head.slice(target.length))) return true;
    let joined = '';
    for (let j = i; j < parts.length && joined.length < target.length; j++) {
      joined += parts[j];
      if (joined === target) return true;
    }
  }
  return false;
}

const FOLDED_SERVICE_WORDS = new Set([...SERVICE_WORDS].map(foldLookalikes));

/** Which brand (if any) a display name presents itself as. */
export function claimedBrandOf(fromName: string | null, fromEmail: string | null): Brand | null {
  const name = fromName?.trim();
  // No display name: the local part is what the reader sees.
  const source = name || (fromEmail ? fromEmail.split('@')[0]!.replace(/[._+]/g, ' ') : '');
  if (!source) return null;
  // Read as the reader sees it: "Rоbinhood" with a Cyrillic о still says
  // Robinhood, and matching it letter for letter let the swap dodge the check.
  const tokens = words(latinSkeleton(source));
  for (const brand of BRANDS) {
    for (const phrase of brand.names) {
      if (!containsPhrase(tokens, phrase)) {
        if (brand.distinctive && spelledOut(tokens, phrase)) return brand;
        continue;
      }
      if (brand.distinctive) return brand;
      const rest = tokens.filter((t) => !phrase.split(/\s+/).includes(t));
      if (rest.every((t) => SERVICE_WORDS.has(t))) return brand;
    }
  }
  return null;
}

function isBrandDomain(brand: Brand, registrable: string): boolean {
  if (brand.domains.includes(registrable)) return true;
  if (!brand.countryDomains) return false;
  const labels = registrable.split('.');
  const base = domainLabel(brand.domains[0]!);
  if (labels[0] !== base) return false;
  const tail = labels.slice(1);
  // amazon.de / amazon.co.uk / amazon.com.au - a real country code only.
  return tail[tail.length - 1]!.length === 2 && tail.length <= 2;
}

export interface Lookalike {
  /** The real domain being imitated (`paypal.com`, or one the user writes to). */
  target: string;
  /** Set when the target is a listed brand. */
  brand: Brand | null;
  /** A look-alike spelling, not just a brand name inside a longer domain. */
  strong: boolean;
  /** The imitation uses letters from another alphabet (punycode). */
  foreign: boolean;
}

/**
 * A domain that imitates another without being it: a listed brand's, or one
 * the user corresponds with (`knownDomains`, so the school or the bank that
 * is not in `BRANDS` is covered too).
 *
 * The comparison is on what the reader SEES: punycode decoded, letters from
 * other alphabets mapped to the Latin ones they imitate (`latinSkeleton`),
 * then digit and Latin swaps folded (`paypa1`, `rnicrosoft`, `paypaI`).
 * `strong` is a look-alike spelling or one letter off a long name; weak is a
 * brand buried in a longer name (`robinhood-secure`), which a real company
 * occasionally registers too.
 */
export function lookalikeOf(registrable: string, knownDomains: string[] = []): Lookalike | null {
  const label = domainLabel(registrable);
  const foreign = hasNonAscii(label);
  const skeleton = foldLookalikes(latinSkeleton(label));
  const ascii = foreign ? latinSkeleton(label) : label;
  let weak: Lookalike | null = null;
  for (const brand of BRANDS) {
    if (isBrandDomain(brand, registrable)) continue;
    for (const d of brand.domains) {
      const real = domainLabel(d);
      if (real.length < 4 || label === real) continue;
      const realFolded = foldLookalikes(real);
      if (skeleton === realFolded) return { target: d, brand, strong: true, foreign };
      if (real.length >= 7 && editDistance(ascii, real, 1) === 1) return { target: d, brand, strong: true, foreign };
      if (!weak && brand.distinctive && real.length >= 5 && skeleton.includes(realFolded)) {
        weak = { target: d, brand, strong: false, foreign };
      }
    }
  }
  if (weak) return weak;
  // The sender's own domain being one the user already writes to means it is
  // not imitating anything.
  if (knownDomains.includes(registrable)) return null;
  for (const d of knownDomains) {
    const real = domainLabel(d);
    if (real.length < 5 || label === real) continue;
    if (skeleton === foldLookalikes(real)) return { target: d, brand: null, strong: true, foreign };
    if (real.length >= 8 && editDistance(ascii, real, 1) === 1) return { target: d, brand: null, strong: true, foreign };
  }
  return null;
}

const host = (d: string | null) => d ?? 'an unknown address';

export function checkSender(input: SenderCheckInput): SenderCheck {
  const fromEmail = input.fromEmail?.trim().toLowerCase() ?? null;
  const domain = domainOf(fromEmail);
  const registrable = registrableDomain(domain);
  const auth = input.auth ?? null;
  const verifiedDomain =
    auth?.dmarc === 'pass' &&
    !!registrable &&
    (!auth.dmarcFrom || registrableDomain(auth.dmarcFrom) === registrable);
  const result: SenderCheck = {
    level: 'none',
    signals: [],
    claimedBrand: null,
    domain,
    verifiedDomain,
    authChecked: !!auth,
    history: input.history ?? null,
  };
  if (input.sent || !fromEmail) return result;
  const add = (code: SenderSignalCode, level: SenderSignalLevel, message: string) =>
    result.signals.push({ code, level, message });

  const brand = claimedBrandOf(input.fromName, fromEmail);
  const brandOk = !!brand && !!registrable && !isFreemail(registrable) && isBrandDomain(brand, registrable);
  if (brand) result.claimedBrand = brand.name;
  if (brand && !brandOk) {
    add(
      'brand_mismatch',
      'danger',
      isFreemail(registrable)
        ? `Says it is from ${brand.name}, but it was sent from a personal ${registrable} address. ${brand.name} does not send from those.`
        : `Says it is from ${brand.name}, but it was sent from ${host(domain)}. ${brand.name}'s mail comes from ${brand.domains[0]}.`,
    );
  }

  const imitated = registrable && !brandOk ? lookalikeOf(registrable, input.knownDomains ?? []) : null;
  if (imitated) {
    const shownAs = imitated.foreign ? hostToUnicode(registrable!) : registrable!;
    const yours = imitated.brand ? '' : ', which you correspond with';
    add(
      'lookalike_domain',
      imitated.strong || imitated.brand === brand ? 'danger' : 'caution',
      imitated.foreign
        ? `${shownAs} is written with letters from another alphabet to look like ${imitated.target}${yours}. It is a different address.`
        : imitated.strong
          ? `${registrable} is spelled to look like ${imitated.target}${yours}, but it is a different address.`
          : `${registrable} uses the name ${imitated.brand!.name} but is not ${imitated.target}.`,
    );
  } else if (hasPunycode(domain)) {
    add(
      'punycode_domain',
      'caution',
      `The address shows as ${hostToUnicode(domain!)} but uses letters from another alphabet that can imitate ordinary ones.`,
    );
  }

  const shown = input.fromName?.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0]?.toLowerCase();
  if (shown && shown !== fromEmail && registrableDomain(domainOf(shown)) !== registrable) {
    add('name_shows_other_address', 'danger', `The name shows ${shown}, but the real sender is ${fromEmail}.`);
  }

  if (auth) {
    if (auth.dmarc === 'fail') {
      add('auth_failed', 'danger', `Your mail provider could not confirm this really came from ${host(domain)}.`);
    } else if (auth.dmarc !== 'pass' && auth.spf !== 'pass' && auth.dkim !== 'pass' && (auth.spf || auth.dkim)) {
      add('auth_weak', 'caution', `Your mail provider could not confirm who sent this.`);
    }
  }

  const replyDomain = registrableDomain(domainOf(input.replyTo));
  if (replyDomain && registrable && replyDomain !== registrable) {
    const strong = isFreemail(replyDomain) || !!brand;
    if (strong) {
      result.replyTo = input.replyTo!.trim();
      add('reply_to_elsewhere', 'caution', `Replies would go to ${result.replyTo}, not to the sender.`);
    }
  }

  const odd = [...new Set((input.linkHosts ?? []).filter((h) => isIpHost(h) || hasPunycode(h)))];
  if (odd.length > 0) {
    add('suspicious_link', 'caution', `A link goes to ${odd[0]}, an address made to hide where it leads.`);
  }

  // The family version of CEO fraud: "Alice Stone" from an address that is
  // not one the user has for Alice.
  const c = input.contactNamed;
  if (c && c.addresses.length > 0 && !c.addresses.some((a) => a.toLowerCase() === fromEmail)) {
    add(
      'impersonates_contact',
      'danger',
      `Uses the name ${c.name}, but not the address you have for them (${c.addresses[0]}).`,
    );
  }

  if (input.fromName && hasMixedScripts(input.fromName)) {
    add('mixed_script_name', 'caution', 'The name mixes letters from different alphabets, a way to imitate a real name.');
  }

  if (input.fromName && hasHiddenCharacters(input.fromName)) {
    add(
      'hidden_characters',
      'danger',
      'The name hides invisible characters, a trick to slip past spam filters.',
    );
  }

  const risky = (input.attachmentNames ?? []).find(isRiskyAttachment);
  if (risky) {
    add('risky_attachment', 'danger', `The attachment ${risky} can run code or open a fake sign-in page. Don't open it.`);
  }

  const h = input.history;
  const stranger = !!h && h.received === 0 && h.wrote === 0 && !h.inPeople;
  if (stranger) add('first_contact', 'info', 'This is the first email you have had from this address.');

  const own = new Set(input.ownAddresses.map((a) => a.toLowerCase()));
  const toYou = [...input.toEmails, ...input.ccEmails].some((a) => own.has(addressOf(a)));
  if (!input.bulk && own.size > 0 && !toYou && (input.toEmails.length > 0 || input.ccEmails.length > 0)) {
    add('not_addressed_to_you', 'info', 'Your address is not on the To or Cc line.');
  }

  escalateReplyTo(result, brand?.name ?? null);

  // A known correspondent with only a quiet signal is not a warning; first
  // contact amplifies nothing on its own either.
  for (const s of result.signals) if (RANK[s.level] > RANK[result.level]) result.level = s.level;
  return result;
}

/** Signals that say the message itself may be a fake, so a Reply-To elsewhere
 *  is where the answer is collected rather than a help desk or a list. */
const FAKE_SIGNS: ReadonlySet<SenderSignalCode> = new Set([
  'brand_mismatch',
  'lookalike_domain',
  'auth_failed',
  'auth_weak',
  'name_shows_other_address',
]);

/**
 * A Reply-To elsewhere is ordinary on real mail (lists, assistants, support
 * desks) and stays a gentle line there. On a message that already looks fake
 * it is how the answer reaches the attacker, so it becomes a danger warning
 * that says so plainly.
 */
function escalateReplyTo(result: SenderCheck, brand: string | null): void {
  const signal = result.signals.find((s) => s.code === 'reply_to_elsewhere');
  if (!signal || !result.replyTo) return;
  const fake = result.signals.some(
    (s) => s !== signal && (s.level === 'danger' || FAKE_SIGNS.has(s.code)),
  );
  if (!fake) return;
  const who = brand ?? result.domain ?? 'the sender';
  signal.level = 'danger';
  signal.message =
    `Replying sends your answer to ${result.replyTo}, which is not ${who}. ` +
    `Don't reply, and don't share account details or codes.`;
}

export interface ReplyToWarning {
  /** Where the email asks replies to go. */
  address: string;
  /** `danger` = the message looks fake: confirm before any reply is started. */
  level: 'caution' | 'danger';
  message: string;
  confirmBeforeReply: boolean;
}

/** The Reply-To finding of a check, and whether replying should be confirmed first. */
export function replyToWarning(check: SenderCheck | null | undefined): ReplyToWarning | null {
  const signal = check?.signals.find((s) => s.code === 'reply_to_elsewhere');
  if (!check || !signal || !check.replyTo) return null;
  const level = signal.level === 'danger' ? 'danger' : 'caution';
  return { address: check.replyTo, level, message: signal.message, confirmBeforeReply: level === 'danger' };
}

/** Latin letters beside Cyrillic or Greek ones in one name ("Pаypal" with a Cyrillic а). */
export function hasMixedScripts(name: string): boolean {
  const latin = /[A-Za-z]/.test(name);
  const other = /[Ͱ-ϿЀ-ӿ]/.test(name);
  return latin && other;
}

/** Programs, scripts, disk images and HTML pages: a file that runs, not a document. */
const RISKY_EXT = new Set([
  'exe', 'scr', 'com', 'pif', 'bat', 'cmd', 'msi', 'msix', 'appx', 'jar', 'js', 'jse', 'vbs', 'vbe',
  'wsf', 'hta', 'ps1', 'lnk', 'iso', 'img', 'vhd', 'html', 'htm', 'shtml', 'xhtml', 'svg', 'one', 'reg', 'apk',
]);

export function isRiskyAttachment(filename: string): boolean {
  const parts = filename.toLowerCase().trim().split('.');
  if (parts.length < 2) return false;
  const ext = parts[parts.length - 1]!;
  return RISKY_EXT.has(ext);
}

/** `"Ann Lee" <ann@x.com>` or `ann@x.com` → `ann@x.com`. */
export function addressOf(raw: string): string {
  const m = /<([^>]+)>/.exec(raw);
  return (m ? m[1]! : raw).trim().toLowerCase();
}

/** Hosts of the `http(s)` links in an HTML body (deduped, lower case). */
export function linkHostsFromHtml(html: string | null | undefined, max = 200): string[] {
  if (!html) return [];
  const out = new Set<string>();
  const re = /href\s*=\s*["']?\s*(https?:\/\/[^"'\s>]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.size < max) {
    try {
      out.add(new URL(m[1]!).hostname.toLowerCase());
    } catch {
      // not a URL
    }
  }
  return [...out];
}
