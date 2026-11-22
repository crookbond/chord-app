/**
 * The way out to the provider (ADR 0107).
 *
 * Chord reads and answers mail; filing it — star, move, folders — stays in the
 * provider (archive and move-to-Trash are the exceptions, ADR 0107 / 0215).
 * That trade only works if getting there is one
 * tap, so every thread carries a link to itself in the mailbox it came from.
 *
 * Honesty rule, same as the rest of the mail layer: a link is emitted only when
 * we know where it goes. `exact: false` means the link opens the MAILBOX rather
 * than this thread, and the label says which product — so "Open Yahoo Mail" is
 * never mistaken for a promise to land on the message. When we know neither, the
 * answer is `null` and the client renders nothing rather than a dead button.
 */

export interface ProviderLink {
  url: string;
  /** Button text, e.g. "Open in Gmail". */
  label: string;
  /** True when the URL opens THIS thread; false when it opens the mailbox. */
  exact: boolean;
}

/** Webmail roots for the IMAP presets. `custom` is deliberately absent. */
const IMAP_WEBMAIL: Record<string, { url: string; label: string }> = {
  yahoo: { url: 'https://mail.yahoo.com/', label: 'Open Yahoo Mail' },
  aol: { url: 'https://mail.aol.com/', label: 'Open AOL Mail' },
  icloud: { url: 'https://www.icloud.com/mail/', label: 'Open iCloud Mail' },
};

export function providerThreadLink(input: {
  provider: 'gmail' | 'outlook' | 'imap';
  /** The mailbox's own address — Gmail needs it to pick the right signed-in profile. */
  emailAddress: string | null;
  /** Provider-native thread id (NOT the account-prefixed stored form). */
  nativeThreadId: string | null;
  /** IMAP preset key, when the provider is imap. */
  presetKey?: string | null;
}): ProviderLink | null {
  switch (input.provider) {
    case 'gmail': {
      if (!input.nativeThreadId) return null;
      // `authuser` picks the profile when several Google accounts are signed in;
      // without it a second mailbox opens the wrong inbox. `#all/` reaches the
      // thread wherever it lives, including archived mail.
      const who = input.emailAddress ? `?authuser=${encodeURIComponent(input.emailAddress)}` : '';
      return {
        url: `https://mail.google.com/mail/u/0/${who}#all/${encodeURIComponent(input.nativeThreadId)}`,
        label: 'Open in Gmail',
        exact: true,
      };
    }
    case 'outlook':
      // Graph gives us a conversationId, and OWA deep links are keyed on the
      // MESSAGE id in a different encoding - so a thread link would be a guess.
      // The mailbox root is the honest answer until that is verified.
      return { url: 'https://outlook.office.com/mail/', label: 'Open in Outlook', exact: false };
    case 'imap': {
      const web = input.presetKey ? IMAP_WEBMAIL[input.presetKey] : undefined;
      // A custom IMAP host has no webmail we can name. Better nothing than a guess.
      return web ? { url: web.url, label: web.label, exact: false } : null;
    }
    default:
      return null;
  }
}
