/**
 * Mail can now suggest a to-do (ADR 0132).
 *
 * The distinction these tests pin: a LIST item is a thing to buy or bring, a
 * TASK is an obligation with a lifecycle — a due date, ADR 0092's stale
 * handling, and an exit other than deletion. Filing obligations as list rows
 * threw all of that away.
 */
import { describe, expect, it } from 'vitest';

import { parseSuggestions, suggestionFromProposal } from '@/services/email/magics.service.js';

const parseSuggestion = (raw: string) => parseSuggestions(raw)[0] ?? null;

describe('parsing a task suggestion', () => {
  it('reads a task with a deadline', () => {
    const raw = JSON.stringify({
      kind: 'task',
      title: 'Return the permission slip',
      dueAt: '2026-09-04T17:00:00-04:00',
    });

    expect(parseSuggestion(raw)).toEqual({
      kind: 'task',
      title: 'Return the permission slip',
      dueAt: '2026-09-04T17:00:00-04:00',
    });
  });

  it('reads a task with no deadline, because most have none', () => {
    const raw = JSON.stringify({ kind: 'task', title: 'Renew the passport' });

    expect(parseSuggestion(raw)).toEqual({ kind: 'task', title: 'Renew the passport' });
  });

  it('strips the filler tail, like every other suggestion', () => {
    // "and act accordingly" adds nothing and turns one to-do into two cards.
    const raw = JSON.stringify({
      kind: 'task',
      title: 'Pay the invoice and take action accordingly',
    });

    expect(parseSuggestion(raw)).toEqual({ kind: 'task', title: 'Pay the invoice' });
  });

  it('refuses a task with no title', () => {
    expect(parseSuggestion(JSON.stringify({ kind: 'task', title: '   ' }))).toBeNull();
    expect(parseSuggestion(JSON.stringify({ kind: 'task' }))).toBeNull();
  });

  it('still reads events and list items', () => {
    expect(
      parseSuggestion(JSON.stringify({ kind: 'list', listName: 'Costco', item: 'milk' })),
    ).toEqual({ kind: 'list', listName: 'Costco', item: 'milk' });
    expect(
      parseSuggestion(
        JSON.stringify({ kind: 'event', title: 'Dentist', startsAt: '2026-09-04T09:00:00-04:00' }),
      ),
    ).toMatchObject({ kind: 'event', title: 'Dentist' });
  });
});

describe('rendering a staged task as a card', () => {
  const row = (args: Record<string, unknown>) => ({
    id: 'pr_1',
    tool_name: 'create_task',
    args_json: JSON.stringify(args),
    target_group_id: null,
  });

  it('carries the due date as the card detail', () => {
    const card = suggestionFromProposal(
      row({ title: 'Return the slip', dueAt: '2026-09-04T17:00:00-04:00' }),
    );

    expect(card).toMatchObject({
      kind: 'task',
      title: 'Return the slip',
      detail: '2026-09-04T17:00:00-04:00',
    });
  });

  it('has a null detail when the task has no deadline', () => {
    expect(suggestionFromProposal(row({ title: 'Renew the passport' }))).toMatchObject({
      kind: 'task',
      detail: null,
    });
  });

  it('ignores a create_task proposal with no title', () => {
    expect(suggestionFromProposal(row({ dueAt: '2026-09-04T17:00:00-04:00' }))).toBeNull();
  });
});
