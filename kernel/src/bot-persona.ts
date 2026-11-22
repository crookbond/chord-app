/**
 * Bot-persona text matching (ADR 0027).
 *
 * The bot's mention alias, imperative directive grammar, and
 * confirm-verb grammar all depend on the configured persona's
 * `mentionAliases`. The kernel exports builders so server + tests can
 * derive the regex from a runtime alias list rather than hardcoding
 * `@chord`. Defaults preserve pre-ADR behaviour for callers that
 * don't yet have persona context (test helpers, ingest pipelines
 * pre-bound to a single bot).
 *
 * Aliases are lowercase short labels (`'chord'`, `'chord-beta'`).
 * Regex special characters are escaped so aliases like `'gpt5.test'`
 * don't accidentally enable wildcard matching.
 */

/** Single shipped alias, matches the pre-ADR `@chord` literal. */
export const DEFAULT_BOT_MENTION_ALIASES: readonly string[] = ['chord'];

/** Imperative verbs that signal "the user is giving me an order" — used by
 * the strict-mode retry to distinguish directives from questions. Behavior,
 * not identity, so the list lives here and is shared across personas. */
export const DEFAULT_IMPERATIVE_VERBS: readonly string[] = [
  'remember',
  'remind',
  'add',
  'save',
  'track',
  'put',
  'create',
  'book',
  'reserve',
  'find',
  'show',
  'log',
  'set',
  'update',
  'delete',
  'note',
  'import',
  'subscribe',
  'upload',
];

/** Verbs the proposal-resolution grammar (ADR 0009) recognises. */
export const DEFAULT_CONFIRM_VERBS: readonly string[] = [
  'confirm',
  'approve',
  'drop',
  'reject',
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function aliasAlternation(aliases: readonly string[]): string {
  if (aliases.length === 0) {
    throw new Error('aliasAlternation: at least one alias required');
  }
  return aliases.map(escapeRegex).join('|');
}

/**
 * Match `@<alias>` at start-of-string or after whitespace, with a word
 * boundary after the alias so `@chordfoo` does not match.
 */
export function buildMentionRegex(aliases: readonly string[]): RegExp {
  return new RegExp(`(^|\\s)@(?:${aliasAlternation(aliases)})\\b`, 'i');
}

/**
 * Match a directive that *starts* with the bot address (with or without
 * `@`), then an optional comma and whitespace, then one of the
 * imperative verbs. e.g. `"@chord remember Alice's birthday"` or
 * `"chord, add milk to the costco list"`.
 */
export function buildImperativeRegex(
  aliases: readonly string[],
  verbs: readonly string[] = DEFAULT_IMPERATIVE_VERBS,
): RegExp {
  const alias = aliasAlternation(aliases);
  const verbAlt = verbs.join('|');
  return new RegExp(
    `^\\s*(?:@(?:${alias})|(?:${alias})),?\\s+(${verbAlt})\\b`,
    'i',
  );
}

/**
 * Match a proposal-resolution command: `@<alias> <verb> [ref]` with an
 * optional trailing period. Capture group 1 is the verb, group 2 is the
 * reference (may be undefined).
 */
export function buildConfirmRegex(
  aliases: readonly string[],
  verbs: readonly string[] = DEFAULT_CONFIRM_VERBS,
): RegExp {
  const alias = aliasAlternation(aliases);
  const verbAlt = verbs.join('|');
  return new RegExp(
    `^\\s*@(?:${alias})\\s+(${verbAlt})(?:\\s+(\\S+))?\\s*\\.?\\s*$`,
    'i',
  );
}

/**
 * Match a slash command of the form `/<alias> pair <code>` issued on an
 * external bridge. Capture group 1 is the pairing code (4-8 alphanumeric,
 * case-insensitive on input). Capture group 2 is an optional `replace`
 * or `force` token that tells the consume step to discard any existing
 * binding on this channel and rebind to the new group.
 *
 * Telegram auto-appends `@botname` to slash commands when the bot is in
 * a group with multiple bots — `/chord@my_chord_bot pair ABC123` is the
 * idiomatic disambiguator. The optional `(?:@[\w]+)?` suffix lets the
 * regex accept either form; the connector still decides whether to act
 * on the message based on its own bot identity.
 */
export function buildPairCommandRegex(aliases: readonly string[]): RegExp {
  return new RegExp(
    `^/(?:${aliasAlternation(aliases)})(?:@[\\w]+)?\\s+pair\\s+([A-Z0-9]{4,8})(?:\\s+(replace|force))?\\s*$`,
    'i',
  );
}

/**
 * Match the in-channel `/<alias> unpair` command. No arguments — the
 * connector unbinds the current channel's binding (if any). Used to
 * recover from a stale or wrong-bot auto-pair without going through
 * the Chord app.
 */
export function buildUnpairCommandRegex(aliases: readonly string[]): RegExp {
  return new RegExp(
    `^/(?:${aliasAlternation(aliases)})(?:@[\\w]+)?\\s+unpair\\s*$`,
    'i',
  );
}

/**
 * Match a generic slash invocation of the bot — `/<alias> <text>` — used
 * as a substitute for `@<alias>` on Telegram, where the client's
 * `@`-autocomplete only surfaces registered bot usernames. The bare form
 * `/<alias>` (no trailing text) is also matched and treated as an empty
 * directive — the bot will reply with a generic prompt.
 *
 * Capture group 1 is whatever the user typed after the alias (may be
 * empty). Returns null when the message doesn't start with the slash
 * command.
 *
 * Reserved subcommands like `pair` are intentionally matched here too —
 * callers should run the more specific `buildPairCommandRegex` first and
 * fall through to this only when that doesn't match.
 */
export function buildSlashCommandRegex(aliases: readonly string[]): RegExp {
  return new RegExp(
    `^/(?:${aliasAlternation(aliases)})(?:@[\\w]+)?(?:\\s+(.*))?$`,
    'is',
  );
}
