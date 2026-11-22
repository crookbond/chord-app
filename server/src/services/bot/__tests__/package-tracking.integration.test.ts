/**
 * `suggest_external_action` kind `package_tracking`: which parcel, which
 * carrier — or a question, never a guessed link.
 */
import type { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DB } from '@/db/schema.js';
import { buildExternalAction } from '@/services/bot/external-actions.js';
import { resolvePackageTracking } from '@/services/bot/package-tracking.js';
import { newId } from '@/utils/ids.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

describe('resolvePackageTracking', () => {
  let db: Kysely<DB>;
  let userId: string;
  let otherId: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'shopper');
    otherId = await createUser(db, 'someone-else');
  });
  afterEach(async () => {
    await closeTestDb(db);
  });

  const seed = async (
    owner: string,
    fromName: string,
    subject: string,
    delivery: { carrier: string; trackingNumber: string; etaAt?: string },
    daysAgo = 1,
  ): Promise<void> => {
    const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    await db
      .insertInto('email_threads')
      .values({
        id: newId('emt'),
        user_id: owner,
        gmail_thread_id: newId('gt'),
        subject,
        snippet: subject,
        from_name: fromName,
        from_email: `ship@${fromName.toLowerCase().replace(/\s+/g, '')}.example`,
        delivery_json: JSON.stringify(delivery),
        last_message_at: at,
        created_at: at,
        updated_at: at,
      })
      .execute();
  };

  const personal = () => ({ userId, isPersonal: true });

  it('builds the carrier link for a number the user gave', async () => {
    const r = await resolvePackageTracking(db, personal(), { trackingNumber: '1Z999AA10123456784' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(buildExternalAction('package_tracking', r.query)).toEqual({
      url: 'https://www.ups.com/track?tracknum=1Z999AA10123456784',
      provider: 'UPS',
      meta: '1Z999AA10123456784',
    });
  });

  it('asks which carrier when the number fits two', async () => {
    const r = await resolvePackageTracking(db, personal(), { trackingNumber: '12345678901234567890' });
    expect(r).toMatchObject({ ok: false, reason: 'ambiguous_carrier' });
  });

  it('works in a shared group when the number is given — no mail is read', async () => {
    const r = await resolvePackageTracking(db, { userId, isPersonal: false }, { trackingNumber: '123456789012' });
    expect(r).toMatchObject({ ok: true, query: { carrier: 'FedEx' } });
  });

  it('finds "my REI package" in the user’s own shipping mail', async () => {
    await seed(userId, 'REI', 'Your REI order has shipped', { carrier: 'UPS', trackingNumber: '1Z999AA10123456784' });
    await seed(userId, 'Etsy', 'Your Etsy order is on its way', { carrier: 'USPS', trackingNumber: '9400111899223197428490' });
    const r = await resolvePackageTracking(db, personal(), { q: 'my REI package' });
    expect(r).toMatchObject({ ok: true, query: { trackingNumber: '1Z999AA10123456784', carrier: 'UPS' } });
  });

  it('collapses several emails about one parcel into one package', async () => {
    await seed(userId, 'REI', 'Shipped', { carrier: 'UPS', trackingNumber: '1Z999AA10123456784' }, 3);
    await seed(userId, 'REI', 'Out for delivery', { carrier: 'UPS', trackingNumber: '1Z999AA10123456784' }, 1);
    const r = await resolvePackageTracking(db, personal(), {});
    expect(r).toMatchObject({ ok: true, query: { carrier: 'UPS' } });
  });

  it('asks which one when several packages are on the way', async () => {
    await seed(userId, 'REI', 'Shipped', { carrier: 'UPS', trackingNumber: '1Z999AA10123456784' });
    await seed(userId, 'Etsy', 'Shipped', { carrier: 'USPS', trackingNumber: '9400111899223197428490' });
    const r = await resolvePackageTracking(db, personal(), {});
    expect(r).toMatchObject({ ok: false, reason: 'several_packages' });
    if (r.ok) return;
    expect(r.candidates).toHaveLength(2);
    // Candidates name the sender; the tracking number is not handed to the
    // model to carry into a later turn.
    expect(JSON.stringify(r.candidates)).not.toContain('1Z999AA10123456784');
  });

  it('names each candidate’s arrival as the user’s day and weekday, not a raw UTC time', async () => {
    await seed(userId, 'REI', 'Shipped', {
      carrier: 'UPS',
      trackingNumber: '1Z999AA10123456784',
      etaAt: '2026-09-29T02:00:00Z',
    });
    await seed(userId, 'Etsy', 'Shipped', {
      carrier: 'USPS',
      trackingNumber: '9400111899223197428490',
      etaAt: '2026-09-30',
    });
    const r = await resolvePackageTracking(db, { ...personal(), tz: 'America/New_York' }, {});
    if (r.ok) throw new Error('expected candidates');
    const arriving = (r.candidates as { arriving: string | null }[]).map((c) => c.arriving).sort();
    // 02:00Z on the 29th is still Monday evening in New York.
    expect(arriving).toEqual(['Monday 2026-09-28 22:00', 'Wednesday 2026-09-30 (all day)']);
  });

  it('never reads mail outside the personal chat, and never another user’s', async () => {
    await seed(userId, 'REI', 'Shipped', { carrier: 'UPS', trackingNumber: '1Z999AA10123456784' });
    expect(await resolvePackageTracking(db, { userId, isPersonal: false }, { q: 'REI' })).toMatchObject({
      ok: false,
      reason: 'needs_personal_chat',
    });
    expect(
      await resolvePackageTracking(db, { userId: otherId, isPersonal: true }, { q: 'REI' }),
    ).toMatchObject({ ok: false, reason: 'no_package_found' });
  });

  it('ignores shipping mail older than the lookback', async () => {
    await seed(userId, 'REI', 'Shipped', { carrier: 'UPS', trackingNumber: '1Z999AA10123456784' }, 90);
    expect(await resolvePackageTracking(db, personal(), { q: 'REI' })).toMatchObject({
      ok: false,
      reason: 'no_package_found',
    });
  });
});
