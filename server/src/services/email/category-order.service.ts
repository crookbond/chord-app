/**
 * ADR 0266 — a user's own order for the email categories in the AI view.
 * One writer for the route (press-and-drag) and the bot tool, so both check
 * names the same way. Stored as titles: the views group by title, and a
 * title is what the user says.
 */
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { categoryKey, pinToTop } from '@chord/kernel';

import type { DB } from '../../db/schema.js';
import { defineUserDefault } from '../user-defaults.service.js';

export const MAX_PINNED_CATEGORIES = 40;
const UNSORTED = 'Unsorted';

export const emailCategoryOrder = defineUserDefault(
  'email_category_order',
  z.array(z.string().trim().min(1).max(120)).max(MAX_PINNED_CATEGORIES),
);

export async function getCategoryOrder(db: Kysely<DB>, userId: string): Promise<string[]> {
  return (await emailCategoryOrder.get(db, userId)) ?? [];
}

async function categoryTitles(db: Kysely<DB>, userId: string): Promise<string[]> {
  const rows = await db
    .selectFrom('email_categories')
    .select('title')
    .where('user_id', '=', userId)
    .execute();
  const seen = new Map<string, string>();
  // Cards shows mail no category holds as "Unsorted"; it can be placed too.
  seen.set(categoryKey(UNSORTED), UNSORTED);
  for (const r of rows) {
    const k = categoryKey(r.title);
    if (k && !seen.has(k)) seen.set(k, r.title.trim());
  }
  return [...seen.values()];
}

export type SetCategoryOrderResult =
  | { ok: true; order: string[] }
  | { ok: false; reason: 'not_found'; name: string; candidates: string[]; categories: string[] }
  | { ok: false; reason: 'too_many' };

/**
 * `mode: 'top'` puts `titles` first and keeps earlier pins after them ("keep
 * Finance on top"); `'replace'` makes `titles` the whole pinned order ("sort
 * them School, Finance, Travel"); an empty `'replace'` clears it. A name that
 * matches no category exactly refuses the whole change and returns close
 * names, so the user is asked rather than a guess being stored.
 */
export async function setCategoryOrder(
  db: Kysely<DB>,
  userId: string,
  titles: string[],
  mode: 'top' | 'replace' = 'replace',
): Promise<SetCategoryOrderResult> {
  const known = await categoryTitles(db, userId);
  const byKey = new Map(known.map((t) => [categoryKey(t), t]));
  const canonical: string[] = [];
  for (const raw of titles) {
    const hit = byKey.get(categoryKey(raw));
    if (!hit) {
      const want = categoryKey(raw);
      const candidates = known.filter((t) => {
        const k = categoryKey(t);
        return want.length > 0 && (k.includes(want) || want.includes(k));
      });
      return { ok: false, reason: 'not_found', name: raw, candidates, categories: known };
    }
    canonical.push(hit);
  }
  const order =
    mode === 'top' ? pinToTop(await getCategoryOrder(db, userId), canonical) : pinToTop([], canonical);
  if (order.length > MAX_PINNED_CATEGORIES) return { ok: false, reason: 'too_many' };
  await emailCategoryOrder.set(db, userId, order.length > 0 ? order : null);
  return { ok: true, order };
}

/** Every category title the user has, for the bot's read. */
export async function listCategoryTitles(db: Kysely<DB>, userId: string): Promise<string[]> {
  return categoryTitles(db, userId);
}
