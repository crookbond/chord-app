/**
 * Kysely plugin that opens sealed values in query results (ADR 0201).
 *
 * Reads are the wide side of this change: dozens of services select the
 * columns that get sealed. Rather than touch each one, every result row is
 * scanned and any string carrying the sealed-text prefix is opened in place.
 * Plaintext values pass through untouched, so a table can hold both while a
 * backfill runs, and code that never selects a sealed column pays one
 * `startsWith` per string.
 *
 * Writes are the narrow side and are done explicitly (`sealText`) at the few
 * places that create the values, because `transformQuery` is synchronous and a
 * key may need fetching.
 */
import {
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow,
  type Kysely,
} from 'kysely';

import type { DB } from '../schema.js';
import { logger } from '../../config/logging.js';
import { KeyDestroyedError, NoKeyError, type KeyStore } from './content-keys.js';
import { isSealedText, JSON_CTX_SUFFIX, openText, SealError, sealedContext } from './envelope.js';

/**
 * A value that cannot be opened for a reason about the VALUE (no key, key
 * destroyed, altered, malformed) is returned as stored and logged, so one bad
 * row cannot take a whole list down and a user-typed string that merely looks
 * sealed reads back as typed. A failure of the key PROVIDER (KMS down) is
 * different: it says nothing about the value, and returning ciphertext then
 * would hand a screen full of gibberish for an outage, so it throws.
 */
const unopenableLogged = new Set<string>();
function isValueProblem(err: unknown): boolean {
  return err instanceof SealError || err instanceof NoKeyError || err instanceof KeyDestroyedError;
}

export class ContentDecryptPlugin implements KyselyPlugin {
  /** Values opened. Read by the performance tests. */
  opened = 0;
  /** Values that looked sealed but could not be opened. */
  unopenable = 0;

  constructor(
    private readonly store: KeyStore,
    /** A handle WITHOUT this plugin, used to load keys (no recursion). */
    private readonly keyDb: () => Kysely<DB>,
  ) {}

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return args.node;
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    const rows = args.result.rows;
    if (rows.length === 0) return args.result;

    let pending: Promise<void>[] | null = null;
    for (const row of rows) {
      for (const key in row) {
        const v = row[key];
        if (!isSealedText(v)) continue;
        (pending ??= []).push(
          openText(this.store, this.keyDb(), v).then(
            (plain) => {
              row[key] = sealedContext(v).endsWith(JSON_CTX_SUFFIX) ? (JSON.parse(plain) as unknown) : plain;
              this.opened++;
            },
            (err: unknown) => {
              if (!isValueProblem(err)) throw err;
              this.unopenable++;
              const why = (err as Error).message;
              if (!unopenableLogged.has(why)) {
                if (unopenableLogged.size < 100) unopenableLogged.add(why);
                logger.error('sealed value left unopened', { column: key, why });
              }
            },
          ),
        );
      }
    }
    if (pending) await Promise.all(pending);
    return args.result;
  }
}
