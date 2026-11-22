/**
 * ADR 0260 - the signature can be said in chat, because it can be typed in Settings.
 * The bot shares `signaturePatch` with the route, so what is pinned here is the
 * tool's own contract: it is personal-only, it cleans what it is given, it
 * replaces rather than stacks, and it will not run with nothing to set.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { applyToolCall } from '@/services/bot/executor.js';
import { buildToolDefs, PERSONAL_ONLY_TOOL_NAMES } from '@/services/bot/tools.js';
import { ensurePersonalGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

let db: Kysely<DB>;
let john: string;
let personal: string;

const sig = () =>
  db
    .selectFrom('users')
    .select(['email_signature', 'email_signature_html'])
    .where('id', '=', john)
    .executeTakeFirstOrThrow();

const say = (args: Record<string, unknown>) =>
  applyToolCall(db, {
    groupId: personal,
    actorUserId: john,
    call: { name: 'set_email_signature', args } as never,
    mode: 'commit',
    emit: () => {},
  } as never);

beforeEach(async () => {
  db = await openTestDb();
  john = await createUser(db, 'john', 'John Doe');
  personal = (await ensurePersonalGroup(db, john)).id;
});
afterEach(async () => closeTestDb(db));

describe('set_email_signature', () => {
  it('is offered in the personal chat only, and the model sees text / html / clear', () => {
    expect(PERSONAL_ONLY_TOOL_NAMES.has('set_email_signature')).toBe(true);
    const def = buildToolDefs().find((d) => d.name === 'set_email_signature');
    const props = (def?.parameters as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props).sort()).toEqual(['clear', 'html', 'mailbox', 'pictureFileId', 'text', 'useShared']);
  });

  it('saves a plain signature, markdown link and all', async () => {
    const out = await say({ text: 'John\n[chordapp.ai](https://chordapp.ai)' });
    expect(out.data).toMatchObject({ ok: true, rich: false });
    expect(await sig()).toEqual({
      email_signature: 'John\n[chordapp.ai](https://chordapp.ai)',
      email_signature_html: null,
    });
  });

  it('saves a rich signature cleaned, with the plain text derived from it', async () => {
    const out = await say({
      html: '<b>John</b><br><a href="https://chordapp.ai">My site</a><script>alert(1)</script>',
    });
    expect(out.data).toMatchObject({ ok: true, rich: true });
    const row = await sig();
    expect(row.email_signature_html).not.toMatch(/script|alert/);
    expect(row.email_signature_html).toContain('href="https://chordapp.ai"');
    expect(row.email_signature).toContain('My site (https://chordapp.ai)');
  });

  it('a plain signature set afterwards replaces the rich one instead of stacking', async () => {
    await say({ html: '<b>John</b>' });
    await say({ text: 'Ro' });
    expect(await sig()).toEqual({ email_signature: 'Ro', email_signature_html: null });
  });

  it('clear removes both', async () => {
    await say({ html: '<b>John</b>' });
    const out = await say({ clear: true });
    expect(out.data).toMatchObject({ ok: true, cleared: true });
    expect(await sig()).toEqual({ email_signature: '', email_signature_html: null });
  });

  it('does nothing, and says so, when it is given nothing', async () => {
    await say({ text: 'Keep me' });
    const out = await say({});
    expect(out.data).toMatchObject({ ok: false, reason: 'empty' });
    expect((await sig()).email_signature).toBe('Keep me');
  });
});
