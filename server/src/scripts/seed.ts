/**
 * Demo seed — populates the DB with a Doe-family corpus so the app has
 * something demo-ready on cold boot. Idempotent-ish: if the usernames already
 * exist, it skips user creation but still layers on the rest.
 *
 * Run: npm run demo:seed
 */
import { pathToFileURL } from 'node:url';

import { nanoid } from 'nanoid';

import { logger } from '../config/logging.js';
import { openDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { createGroup, ensurePersonalGroup } from '../services/groups.service.js';
import { upsertMemory } from '../services/memory.service.js';
import { createTask } from '../services/tasks.service.js';
import { setGrant } from '../services/trust.service.js';
import { enqueueFromTask } from '../services/proactive.service.js';
import {
  addAccommodation,
  addTravelLeg,
  createTrip,
} from '../services/trips.service.js';

async function upsertUser(
  db: ReturnType<typeof openDb>,
  username: string,
  displayName: string,
): Promise<string> {
  const existing = await db
    .selectFrom('users')
    .select('id')
    .where('username', '=', username)
    .executeTakeFirst();
  if (existing) {
    // ensurePersonalGroup is idempotent — covers users created before
    // the per-user personal-group rule landed.
    await ensurePersonalGroup(db, existing.id);
    return existing.id;
  }
  const id = `u_${nanoid(12)}`;
  await db
    .insertInto('users')
    .values({
      id,
      username,
      display_name: displayName,
      created_at: new Date().toISOString(),
      shadow: 0,
    })
    .execute();
  await ensurePersonalGroup(db, id);
  return id;
}

async function addMember(
  db: ReturnType<typeof openDb>,
  groupId: string,
  userId: string,
  role: 'owner' | 'member',
  tier: 'verified' | 'trusted' | 'guest',
): Promise<void> {
  const existing = await db
    .selectFrom('group_members')
    .select('user_id')
    .where('group_id', '=', groupId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (existing) {
    await db
      .updateTable('group_members')
      .set({ role, tier })
      .where('group_id', '=', groupId)
      .where('user_id', '=', userId)
      .execute();
    return;
  }
  await db
    .insertInto('group_members')
    .values({
      group_id: groupId,
      user_id: userId,
      role,
      tier,
      joined_at: new Date().toISOString(),
    })
    .execute();
}

async function postMessage(
  db: ReturnType<typeof openDb>,
  groupId: string,
  senderId: string | null,
  kind: 'text' | 'bot' | 'system',
  body: string,
  createdAt: string,
): Promise<void> {
  await db
    .insertInto('messages')
    .values({
      id: `m_${nanoid(12)}`,
      group_id: groupId,
      sender_id: senderId,
      kind,
      body,
      attachment_id: null,
      reply_to_id: null,
      mentions_bot: /@chord\b/i.test(body) ? 1 : 0,
      created_at: createdAt,
      source: null,
      external_message_id: null,
      chord_visible: 1,
      mentions_others: 0,
      auto_mirror: 1,
      bot_persona_id: null,
      is_proactive: 0,
    })
    .execute();
}

async function seedAttachment(
  db: ReturnType<typeof openDb>,
  opts: {
    groupId: string;
    uploadedBy: string;
    filename: string;
    summary: string;
    pinned?: boolean;
  },
): Promise<string> {
  const id = `a_${nanoid(12)}`;
  const now = new Date().toISOString();
  await db
    .insertInto('attachments')
    .values({
      id,
      scope_kind: 'group',
      scope_id: opts.groupId,
      uploaded_by: opts.uploadedBy,
      filename: opts.filename,
      mime_type: 'application/pdf',
      size: 12345,
      path: `files/group/${opts.groupId}/${id}/${opts.filename}`,
      summary: opts.summary,
      extracted_text: null,
      image_meta: null,
      pinned: opts.pinned ? 1 : 0,
      indexed_at: now,
      created_at: now,
    })
    .execute();
  return id;
}

/**
 * Populates the Doe-family corpus onto an already-open database. Idempotent-ish
 * in the same sense as the CLI: users are upserted by username; the shared
 * groups ("Doe Family" / "Seattle Trip") are detected by name and only given
 * seed messages / trip data on first creation. Safe to call from the demo-reset
 * route after wiping tables.
 */
export async function seedDemo(db: ReturnType<typeof openDb>): Promise<void> {
  logger.info('seeding Doe-family corpus');

  const john = await upsertUser(db, 'john', 'John Doe');
  const alice = await upsertUser(db, 'alice', 'Alice Doe');
  const ben = await upsertUser(db, 'ben', 'Ben Doe');
  const nolan = await upsertUser(db, 'nolan', 'Nolan Doe');

  // --- Doe Family (shared group) ---------------------------------------
  let familyFresh = false;
  const familyGroup = await (async () => {
    const existing = await db
      .selectFrom('groups')
      .selectAll()
      .where('name', '=', 'Doe Family')
      .executeTakeFirst();
    if (existing) return existing;
    familyFresh = true;
    return createGroup(db, {
      name: 'Doe Family',
      kind: 'group',
      createdBy: john,
    });
  })();
  await addMember(db, familyGroup.id, john, 'owner', 'verified');
  await addMember(db, familyGroup.id, alice, 'member', 'verified');
  await addMember(db, familyGroup.id, ben, 'member', 'trusted');
  await addMember(db, familyGroup.id, nolan, 'member', 'guest');

  // ADR 0026 — assignment is closed by default. The demo corpus pretends
  // the Doe family has already opted everyone into mutual task/event
  // assignment so that seeded cross-user tasks (e.g. Alice → Nolan
  // for school pickup) succeed without a fake "permission requested"
  // flow on first boot.
  const family = [john, alice, ben, nolan];
  for (const recipient of family) {
    for (const sender of family) {
      if (recipient === sender) continue;
      await setGrant(db, recipient, sender, ['task', 'event']);
    }
  }

  if (familyFresh) {
    const t0 = Date.now() - 2 * 24 * 60 * 60 * 1000;
    await postMessage(db, familyGroup.id, john, 'text', 'Hey family — trip to Seattle next month!', new Date(t0).toISOString());
    await postMessage(db, familyGroup.id, alice, 'text', "I'll handle the hotel.", new Date(t0 + 60_000).toISOString());
    await postMessage(db, familyGroup.id, ben, 'text', "I'm in. My flight arrives Friday.", new Date(t0 + 120_000).toISOString());
  }

  // --- Seattle Trip group (subset; an "adults-only" side channel) -------
  let tripFresh = false;
  const trip = await (async () => {
    const existing = await db
      .selectFrom('groups')
      .selectAll()
      .where('name', '=', 'Seattle Trip')
      .executeTakeFirst();
    if (existing) return existing;
    tripFresh = true;
    return createGroup(db, {
      name: 'Seattle Trip',
      kind: 'group',
      createdBy: john,
      adultsOnly: true,
    });
  })();
  await addMember(db, trip.id, john, 'owner', 'verified');
  await addMember(db, trip.id, alice, 'member', 'verified');
  await addMember(db, trip.id, ben, 'member', 'trusted');
  // nolan is added as a guest so the adults-only + guest-tier retrieval
  // block (see `fetchAttachmentsVisibleTo` in services/bot/retrieval.ts) is
  // observable: he can open the group and see tier shields, but asking
  // @Chord about Seattle Trip attachments returns nothing.
  await addMember(db, trip.id, nolan, 'member', 'guest');

  if (tripFresh) {
    // Attachment only visible via bot retrieval to non-guest tiers. Drives
    // the "nolan can't see adults-only docs" demo moment. Seeded only on
    // fresh trip creation so re-running demo:seed doesn't duplicate it.
    await seedAttachment(db, {
      groupId: trip.id,
      uploadedBy: john,
      filename: 'seattle-itinerary.pdf',
      summary:
        'Adults-only Seattle trip itinerary — hotel room arrangements, bar reservations, adult-beverage pairings.',
    });
  }

  // --- Memories (persona + group scoped) --------------------------------
  await upsertMemory(db, {
    groupId: familyGroup.id,
    personaId: john,
    scope: 'persona',
    key: 'home_airport',
    value: 'JFK',
    source: 'explicit',
    confidence: 0.95,
  });
  await upsertMemory(db, {
    groupId: familyGroup.id,
    personaId: alice,
    scope: 'persona',
    key: 'dietary_preference',
    value: 'vegetarian',
    source: 'explicit',
    confidence: 0.9,
  });
  await upsertMemory(db, {
    groupId: familyGroup.id,
    personaId: ben,
    scope: 'persona',
    key: 'kid_school',
    value: 'Stuyvesant High School',
    source: 'explicit',
    confidence: 0.9,
  });
  await upsertMemory(db, {
    groupId: familyGroup.id,
    personaId: nolan,
    scope: 'persona',
    key: 'allergy',
    value: 'peanuts',
    source: 'explicit',
    confidence: 0.95,
  });
  await upsertMemory(db, {
    groupId: familyGroup.id,
    personaId: null,
    scope: 'group',
    key: 'home_address',
    value: '120 Broadway, Brooklyn, NY',
    source: 'explicit',
    confidence: 0.9,
  });
  await upsertMemory(db, {
    groupId: familyGroup.id,
    personaId: null,
    scope: 'group',
    key: 'pet',
    value: 'Luna (dog)',
    source: 'explicit',
    confidence: 0.9,
  });

  // --- Tasks (only on fresh family group) -------------------------------
  if (familyFresh) {
    const task1 = await createTask(db, {
      groupId: familyGroup.id,
      createdBy: john,
      title: 'Book rental car for Seattle',
      assigneeId: john,
      remindAt: new Date(Date.now() + 90 * 1000).toISOString(),
      remindCue: 'tomorrow',
    });
    await enqueueFromTask(db, task1);
    await createTask(db, {
      groupId: familyGroup.id,
      createdBy: alice,
      title: 'Pick up Nolan from school',
      assigneeId: nolan,
    });

    await seedAttachment(db, {
      groupId: familyGroup.id,
      uploadedBy: john,
      filename: 'nolan-term-2.pdf',
      summary: 'Stuyvesant HS term 2 calendar — spring break Apr 14-21.',
      pinned: true,
    });
    await seedAttachment(db, {
      groupId: familyGroup.id,
      uploadedBy: alice,
      filename: 'costco-monthly.pdf',
      summary: 'Costco monthly savings — pet supplies + pantry staples.',
    });
  }

  // --- Trip with deliberate gap ----------------------------------------
  const existingTrip = await db
    .selectFrom('trips')
    .select(['id'])
    .where('group_id', '=', familyGroup.id)
    .where('name', '=', 'Seattle, Mar 14-18')
    .executeTakeFirst();
  if (!existingTrip) {
    const tripRow = await createTrip(db, {
      groupId: familyGroup.id,
      createdBy: john,
      name: 'Seattle, Mar 14-18',
      destination: 'Seattle',
      startDate: '2026-03-14',
      endDate: '2026-03-18',
      participantIds: [john, alice, ben],
    });
    // Only an inbound leg for John — return leg is the demo gap.
    await addTravelLeg(db, {
      tripId: tripRow.id,
      personaId: john,
      mode: 'flight',
      origin: 'JFK',
      destination: 'Seattle',
      departAt: '2026-03-14T08:00:00.000Z',
      arriveAt: '2026-03-14T14:30:00.000Z',
      carrier: 'AA',
      flightNo: '412',
      confirmation: 'ABC123',
    });
    // Only 3 of 4 nights covered — also a gap.
    await addAccommodation(db, {
      tripId: tripRow.id,
      propertyName: 'Kimpton Seattle',
      address: '1101 5th Ave, Seattle, WA',
      checkinDate: '2026-03-14',
      checkoutDate: '2026-03-17',
      roomCount: 2,
      confirmation: 'KIM-998',
    });
  }

  logger.info('seed complete');
  logger.info(`  family group: ${familyGroup.id}  invite ${familyGroup.invite_code}`);
  logger.info(`  trip group:   ${trip.id}  invite ${trip.invite_code}`);
  logger.info(`  users: john / alice / ben / nolan — sign in with any username`);
}

async function main(): Promise<void> {
  await runMigrations();
  const db = openDb();
  try {
    await seedDemo(db);
  } finally {
    await db.destroy();
  }
}

// Only run as a script when invoked directly (`npm run demo:seed`). Compare via
// pathToFileURL so the guard matches on Windows too — see the same guard in
// db/migrate.ts.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
