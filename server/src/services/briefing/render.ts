/**
 * ADR 0091 — the two renderings of `BriefingFacts`.
 *
 * `renderTeaser` is the in-app/gated text (ADR 0079). `templateParams` is the
 * out-of-window WhatsApp template's five body slots. They share a facts source
 * so the two surfaces can never quietly drift apart.
 */
import type { BriefingFacts } from './facts.js';

/** Meta rejects an empty template variable, so every slot needs a floor. */
const NOTHING = 'Nothing today';
const ALL_CLEAR = 'All clear';
const CAUGHT_UP = "You're all caught up";

/**
 * Five single-line values for `{{1}}`..`{{5}}` of the approved `daily_briefing`
 * template, in order: weather, this week, heads-up, open tasks, email.
 *
 * Today's events lead the "this week" slot — they are the most actionable
 * thing in the message and the template has no separate slot for them.
 */
export function templateParams(f: BriefingFacts): string[] {
  const week = [f.today, f.thisWeek].filter(Boolean).join(' · ');
  return [
    f.weather ?? 'No forecast available',
    week || NOTHING,
    f.headsUp ?? ALL_CLEAR,
    f.tasks ?? 'No open tasks',
    f.email ?? CAUGHT_UP,
  ].map(sanitizeParam);
}

/**
 * Meta rejects a body parameter containing a newline, a tab, or 4+ consecutive
 * spaces, and rejects an empty one. Enforced here rather than trusted from the
 * facts builder — a rejected template is a silently undelivered briefing.
 */
export function sanitizeParam(s: string): string {
  const flat = s.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return flat.length > 0 ? flat.slice(0, 900) : '—';
}

/**
 * ADR 0079's gated briefing: a few true lines and a pointer at AI Plan. Absent
 * facts are omitted rather than floored — unlike the template, plain text can
 * just be shorter.
 */
export function renderTeaser(f: BriefingFacts, closing?: string): string {
  const lines = ['Morning! A peek at your day:'];
  if (f.weather) lines.push(`• ${f.weather}`);
  lines.push(f.today ? `• ${f.today}` : '• Nothing on the calendar today');
  if (f.thisWeek) lines.push(`• This week: ${f.thisWeek}`);
  if (f.tasks) lines.push(`• ${f.tasks}`);
  if (f.email) lines.push(`• ${f.email}`);
  lines.push('');
  lines.push(
    closing ??
      'Read more… your full briefing, email insights, and Chord replies are paused. Restart them in Settings → AI Plan — buy credits, or add your own key (always free).',
  );
  return lines.join('\n');
}
