/**
 * Coverage for the set_my_name tool + the greetingName resolver.
 *
 * - set_my_name with `preferredName` stores the preferred name.
 * - set_my_name with `useFirstNameAsPreferred` promotes the first name
 *   already on file to the preferred name (the LLM doesn't need to know it).
 * - greetingName prefers preferred → first → first-word-of-display → username.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { greetingName } from '@chord/kernel';

import type { DB } from '@/db/schema.js';
import { createGroup } from '@/services/groups.service.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

async function preferredNameOf(db: Kysely<DB>, userId: string): Promise<string | null> {
  const row = await db
    .selectFrom('users')
    .select(['preferred_name'])
    .where('id', '=', userId)
    .executeTakeFirst();
  return row?.preferred_name ?? null;
}

describe('set_my_name tool', () => {
  let db: Kysely<DB>;

  beforeEach(async () => {
    db = await openTestDb();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('stores an explicit preferred name', async () => {
    const john = await createUser(db, 'john', 'John Doe');
    const group = await createGroup(db, { name: 'John', kind: 'personal', createdBy: john });

    await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: { name: 'set_my_name', args: { preferredName: 'Ro' } },
    });

    expect(await preferredNameOf(db, john)).toBe('Ro');
  });

  it('promotes the first name on file when useFirstNameAsPreferred is set', async () => {
    // createUser derives first_name from the leading word, so first_name = 'John'.
    const john = await createUser(db, 'john', 'John Doe');
    const group = await createGroup(db, { name: 'John', kind: 'personal', createdBy: john });

    await applyToolCall(db, {
      groupId: group.id,
      actorUserId: john,
      provenance: null,
      call: { name: 'set_my_name', args: { useFirstNameAsPreferred: true } },
    });

    expect(await preferredNameOf(db, john)).toBe('John');
  });
});

describe('greetingName', () => {
  it('prefers preferred → first → display first word → username', () => {
    expect(
      greetingName({ username: 'john', displayName: 'John Doe', firstName: 'John', preferredName: 'Ro' }),
    ).toBe('Ro');
    expect(greetingName({ username: 'john', displayName: 'John Doe', firstName: 'John' })).toBe('John');
    expect(greetingName({ username: 'john', displayName: 'John Doe' })).toBe('John');
    expect(greetingName({ username: 'john' })).toBe('john');
  });
});
