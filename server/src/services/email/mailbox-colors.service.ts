/**
 * ADR 0278 — every mailbox has its own color, like every calendar: the
 * user's pick, else the next free color of Chord's palette (mailboxes carry
 * no provider color). One writer for Settings and the `set_mailbox_color`
 * bot tool. Picks are stored as a per-user default keyed by mailbox
 * (`'primary'` or an account id).
 */
import type { Kysely } from 'kysely';
import { z } from 'zod';

import { assignCalendarColors, normalizeCalendarColor } from '@chord/kernel';

import type { DB } from '../../db/schema.js';
import { defineUserDefault } from '../user-defaults.service.js';
import {
  listMailboxChoices,
  matchMailboxByName,
  type MailboxChoice,
  type MailboxPreread,
} from './default-mailbox.js';

export const mailboxColorChoices = defineUserDefault(
  'mailbox_colors',
  z.record(z.string().min(1).max(64), z.string().regex(/^#[0-9A-F]{6}$/)),
);

export interface MailboxColors {
  /** Display color per mailbox key ('primary' or an account id). */
  colors: Record<string, string>;
  /** Only the colors the user picked, same keys. */
  picked: Record<string, string>;
}

/** Display colors for every connected mailbox, the primary first. */
export async function mailboxColors(
  db: Kysely<DB>,
  userId: string,
  pre?: MailboxPreread,
): Promise<MailboxColors> {
  const [mailboxes, stored] = await Promise.all([
    listMailboxChoices(db, userId, pre),
    mailboxColorChoices.get(db, userId),
  ]);
  const picked: Record<string, string> = {};
  for (const m of mailboxes) {
    const p = stored?.[m.mailbox];
    if (p) picked[m.mailbox] = p;
  }
  const assigned = assignCalendarColors(mailboxes.map((m) => ({ id: m.mailbox, chosen: picked[m.mailbox] })));
  return { colors: Object.fromEntries(assigned), picked };
}

export type SetMailboxColorResult =
  | { ok: true; mailbox: MailboxChoice; color: string; picked: boolean }
  | { ok: false; reason: 'not_found' | 'no_mailbox' | 'bad_color' }
  | { ok: false; reason: 'ambiguous'; candidates: MailboxChoice[] };

/**
 * Color one mailbox, by key (Settings) or by what the user called it (chat).
 * A null / empty color clears the pick, back to the palette.
 */
export async function setMailboxColor(
  db: Kysely<DB>,
  userId: string,
  target: { mailbox: string } | { name: string },
  color: string | null,
): Promise<SetMailboxColorResult> {
  let choice: string | null = null;
  if (color !== null && color.trim() !== '') {
    choice = normalizeCalendarColor(color);
    if (!choice) return { ok: false, reason: 'bad_color' };
  }
  let mailbox: MailboxChoice | undefined;
  if ('mailbox' in target) {
    const all = await listMailboxChoices(db, userId);
    if (all.length === 0) return { ok: false, reason: 'no_mailbox' };
    mailbox = all.find((m) => m.mailbox === target.mailbox);
    if (!mailbox) return { ok: false, reason: 'not_found' };
  } else {
    const found = await matchMailboxByName(db, userId, target.name);
    if (!found.ok) return found;
    mailbox = found.mailbox;
  }
  const stored = { ...((await mailboxColorChoices.get(db, userId)) ?? {}) };
  if (choice) stored[mailbox.mailbox] = choice;
  else delete stored[mailbox.mailbox];
  await mailboxColorChoices.set(db, userId, Object.keys(stored).length > 0 ? stored : null);
  const after = await mailboxColors(db, userId);
  return { ok: true, mailbox, color: after.colors[mailbox.mailbox], picked: choice !== null };
}
