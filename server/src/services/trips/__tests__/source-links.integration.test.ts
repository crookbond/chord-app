/**
 * Tapping a flight on the Trips tab must open what it was read from. An
 * email-mined leg (ADR 0158) has no file — only `gmail:<threadId>` — so the
 * app had nothing to open; a screenshot-read leg had only an id, so the app
 * could not tell an image from a PDF and handed it to the share sheet.
 */
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';
import { createGroup } from '@/services/groups.service.js';
import { listTripStatusesForUser } from '@/services/trips.service.js';
import { attachTripSourceLinks } from '../source-links.js';

describe('trip source links', () => {
  let db: Kysely<DB>;
  let john: string;
  let alice: string;
  let rdms: string;
  const now = new Date().toISOString();

  const leg = (id: string, extra: { sourceDocId?: string; raw?: string }) =>
    db
      .insertInto('travel_legs')
      .values({
        id, trip_id: 'tr_del', persona_id: null, passenger_name: 'DOE/JOHN',
        mode: 'flight', origin: 'EWR', destination: 'DEL', depart_at: '2026-11-02T21:00:00-05:00',
        arrive_at: '2026-11-04T01:00:00+05:30', carrier: 'AI', flight_no: '106', confirmation: 'ZQ7K3M',
        notes: null, source_doc_id: extra.sourceDocId ?? null, created_at: now,
        source_raw_context: extra.raw ?? null, cancelled_at: null,
      })
      .execute();

  const thread = (id: string, owner: string, gid: string) =>
    db
      .insertInto('email_threads')
      .values({
        id, user_id: owner, gmail_thread_id: gid, subject: 'Air India eTicket', from_email: 'eticket@airindia.com',
        gmail_label_ids: JSON.stringify(['INBOX']), is_unread: 0, last_message_at: now, created_at: now, updated_at: now,
      })
      .execute();

  const attachment = (id: string, scopeKind: 'group' | 'user', scopeId: string, uploadedBy: string, summary: string | null) =>
    db
      .insertInto('attachments')
      .values({
        id, scope_kind: scopeKind, scope_id: scopeId, uploaded_by: uploadedBy, filename: 'IMG_4412.PNG',
        mime_type: 'image/png', size: 1234, path: `x/${id}.png`, summary, extracted_text: null, image_meta: null,
        pinned: 0, indexed_at: summary ? now : null, created_at: now,
      })
      .execute();

  beforeEach(async () => {
    db = await openTestDb();
    john = await createUser(db, 'ownertest', 'John Doe');
    alice = await createUser(db, 'alice.dr.stone', 'Alice stone');
    rdms = (await createGroup(db, { name: 'RDMS', kind: 'group', createdBy: john })).id;
    await db
      .insertInto('group_members')
      .values({ group_id: rdms, user_id: alice, role: 'member', tier: 'verified', joined_at: now })
      .execute();
    await db
      .insertInto('trips')
      .values({
        id: 'tr_del', group_id: rdms, name: 'Trip to Delhi', destination: 'Delhi', start_date: '2026-11-02',
        end_date: '2026-11-20', created_by: john, created_at: now, source_raw_context: null, cancelled_at: null,
        deleted_at: null,
      })
      .execute();
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  it('links an email-mined leg to the viewer’s own copy of the thread', async () => {
    await thread('et_john', john, '19a3f0c2d4e5b6a7');
    await thread('et_alice', alice, 'other-thread');
    await leg('l_email', { raw: 'gmail:19a3f0c2d4e5b6a7' });

    const [forJohn] = await attachTripSourceLinks(db, john, await listTripStatusesForUser(db, john));
    expect(forJohn!.legs[0]!.sourceEmailThreadId).toBe('et_john');

    // Thread rows are per-user: Alice does not have this email, so no link.
    const [forAlice] = await attachTripSourceLinks(db, alice, await listTripStatusesForUser(db, alice));
    expect(forAlice!.legs[0]!.sourceEmailThreadId).toBeUndefined();
  });

  it('says the source email is gone once the mailbox no longer holds it — to its owner only', async () => {
    await thread('et_john', john, '19a3f0c2d4e5b6a7');
    await leg('l_email', { raw: 'gmail:19a3f0c2d4e5b6a7' });
    // A permanent delete: the next sync finds no messages and drops the thread row.
    await db.deleteFrom('email_threads').where('id', '=', 'et_john').execute();

    const [forJohn] = await attachTripSourceLinks(db, john, await listTripStatusesForUser(db, john));
    expect(forJohn!.legs[0]!.sourceEmailThreadId).toBeUndefined();
    expect(forJohn!.legs[0]!.sourceEmailGone).toBe(true);

    // Alice never had this email; its absence from her mailbox is not a deletion.
    const [forAlice] = await attachTripSourceLinks(db, alice, await listTripStatusesForUser(db, alice));
    expect(forAlice!.legs[0]!.sourceEmailGone).toBeUndefined();
  });

  it('describes a screenshot source so the app can show it in-app, with what was extracted', async () => {
    await thread('et_john', john, 'g1');
    await db.insertInto('attachments').values({
      id: 'att_png', scope_kind: 'group', scope_id: rdms, uploaded_by: john, filename: 'IMG_4412.PNG',
      mime_type: 'image/png', size: 1234, path: 'x/att_png.png', summary: 'Air India AI106 EWR→DEL, PNR ZQ7K3M',
      extracted_text: null, image_meta: null, pinned: 0, indexed_at: now, created_at: now,
      origin_email_thread_id: 'et_john',
    }).execute();
    await leg('l_png', { sourceDocId: 'att_png', raw: 'att_png' });

    const [forJohn] = await attachTripSourceLinks(db, john, await listTripStatusesForUser(db, john));
    expect(forJohn!.legs[0]!.sourceDoc).toEqual({
      id: 'att_png',
      filename: 'IMG_4412.PNG',
      mimeType: 'image/png',
      summary: 'Air India AI106 EWR→DEL, PNR ZQ7K3M',
      emailThreadId: 'et_john',
    });

    // Alice can read the group file but not John's email thread.
    const [forAlice] = await attachTripSourceLinks(db, alice, await listTripStatusesForUser(db, alice));
    expect(forAlice!.legs[0]!.sourceDoc?.mimeType).toBe('image/png');
    expect(forAlice!.legs[0]!.sourceDoc?.emailThreadId).toBeUndefined();
  });

  it('does not describe a file the viewer cannot read', async () => {
    await attachment('att_private', 'user', john, john, null);
    await leg('l_private', { sourceDocId: 'att_private' });

    const [forAlice] = await attachTripSourceLinks(db, alice, await listTripStatusesForUser(db, alice));
    expect(forAlice!.legs[0]!.sourceDoc).toBeUndefined();
    const [forJohn] = await attachTripSourceLinks(db, john, await listTripStatusesForUser(db, john));
    expect(forJohn!.legs[0]!.sourceDoc?.summary).toBeUndefined();
  });
});
