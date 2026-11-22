/**
 * ADR 0255 addendum — per-user defaults as key → value in `users.defaults`.
 *
 * The default calendar and default mailbox kept their own columns; every
 * default after them is declared here instead of costing a migration:
 *
 *   export const fooDefault = defineUserDefault('foo', z.enum(['a', 'b']));
 *   await fooDefault.set(db, userId, 'a');   // null removes the key
 *   await fooDefault.get(db, userId);        // 'a' | null
 *
 * Each key carries its own schema, so a value written by an older build that
 * no longer parses reads as null (unset) instead of reaching the caller.
 */
import { sql, type Kysely } from 'kysely';
import type { z } from 'zod';

import { logger } from '@/config/logging.js';
import type { DB } from '@/db/schema.js';

export interface UserDefault<T> {
  readonly key: string;
  get(db: Kysely<DB>, userId: string): Promise<T | null>;
  /** `null` removes the key, which is how a default goes back to unset. */
  set(db: Kysely<DB>, userId: string, value: T | null): Promise<void>;
  /**
   * Read-modify-write under a row lock on the user, so two changes at the
   * same moment (two rules added at once) both land instead of the second
   * write replacing the first. `fn` sees the current value and returns the
   * new one (`null` removes the key, `undefined` writes nothing) and a result
   * handed back to the caller.
   */
  update<R>(
    db: Kysely<DB>,
    userId: string,
    fn: (current: T | null) => { value: T | null | undefined; result: R },
  ): Promise<R>;
}

const declared = new Set<string>();

export function defineUserDefault<S extends z.ZodTypeAny>(key: string, schema: S): UserDefault<z.infer<S>> {
  if (declared.has(key)) throw new Error(`user default "${key}" declared twice`);
  declared.add(key);
  const read = (raw: unknown, userId: string): z.infer<S> | null => {
    if (raw === undefined || raw === null) return null;
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      logger.warn('user default no longer parses; treating as unset', { key, userId });
      return null;
    }
    return parsed.data;
  };
  const self: UserDefault<z.infer<S>> = {
    key,
    async get(db, userId) {
      const row = await db.selectFrom('users').select('defaults').where('id', '=', userId).executeTakeFirst();
      return read(row?.defaults?.[key], userId);
    },
    async update(db, userId, fn) {
      const run = async (trx: Kysely<DB>) => {
        const row = await trx
          .selectFrom('users')
          .select('defaults')
          .where('id', '=', userId)
          .forUpdate()
          .executeTakeFirst();
        const { value, result } = fn(read(row?.defaults?.[key], userId));
        if (value !== undefined) await self.set(trx, userId, value);
        return result;
      };
      return db.isTransaction ? run(db) : db.transaction().execute(run);
    },
    async set(db, userId, value) {
      if (value === null) {
        await db
          .updateTable('users')
          .set({ defaults: sql`defaults - ${key}` as never })
          .where('id', '=', userId)
          .execute();
        return;
      }
      const checked = schema.parse(value);
      await db
        .updateTable('users')
        .set({ defaults: sql`defaults || jsonb_build_object(${key}::text, ${JSON.stringify(checked)}::jsonb)` as never })
        .where('id', '=', userId)
        .execute();
    },
  };
  return self;
}
