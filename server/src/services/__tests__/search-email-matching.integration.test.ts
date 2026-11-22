/**
 * How a plain query (no operators) matches EMAIL, on both surfaces, against
 * mail written the old way: plaintext columns, Postgres-generated tsvector,
 * no blind index (a mailbox that predates ADR 0201).
 *
 * The scenarios live in `defineEmailMatchingSuite` so the same expectations run
 * against sealed, blind-indexed mail too (search-email-matching.sealed).
 * Existing coverage is strong on operators, category replacement and body
 * text, but thin on the core matching rules for mail itself: sender-only
 * matches, stemming, prefix, OR semantics, literal codes, accents, wildcard
 * characters and ordering. That is exactly what a search rewrite has to
 * reproduce, so it is pinned here on the real SQL.
 */
import { defineEmailMatchingSuite } from '@/__test-helpers__/email-matching-suite.js';
import { seedPlainMail } from '@/__test-helpers__/email-seeds.js';

defineEmailMatchingSuite({ seed: seedPlainMail });
