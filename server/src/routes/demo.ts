import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { API } from '@chord/kernel';

import { env } from '../config/env.js';
import { logger } from '../config/logging.js';
import { loadSession, requireSession } from '../middleware/auth.js';
import { runDailyScanForUserNow } from '../services/proactive.service.js';
import { ensurePersonalGroup } from '../services/groups.service.js';
import { seedDemo } from '../scripts/seed.js';

export const demoRouter = Router();

demoRouter.use(loadSession);

/**
 * Wipes all user-data tables (keeps `_migrations`), deletes the uploaded-files
 * tree under DATA_DIR/files, and re-runs the seed corpus. Gated by
 * DEMO_MODE=1 in .env — off by default. Intended as a presenter-facing
 * safety net during live demos. Returns a small summary of what was reset.
 */
demoRouter.post('/api/v1/demo/reset', async (req, res, next) => {
  if (!env.DEMO_MODE) {
    res.status(403).json({ error: 'demo mode disabled (set DEMO_MODE=1)' });
    return;
  }
  try {
    // Deliberate: `users` and `sessions` are NOT wiped. The presenter is
    // mid-demo and doesn't want to be kicked back to the sign-in screen by
    // their own reset tap. Since `sessions.user_id` cascades on user delete,
    // wiping users would implicitly wipe sessions too — so we preserve
    // identity rows and let the seed's upsert-by-username no-op.
    // Any ad-hoc users the presenter created during the demo (outside the
    // Doe corpus) stay around; that's fine — they just have no groups.
    const tables = [
      'messages',
      'attachments',
      'tasks',
      'list_items',
      'lists',
      'saves',
      'rsvps',
      'events',
      'memories',
      'document_permissions',
      'proactive_messages',
      'travel_legs',
      'accommodations',
      'trip_participants',
      'trips',
      'places',
      'contacts',
      'media_items',
      'group_members',
      'groups',
    ] as const;

    for (const t of tables) {
      await req.db.deleteFrom(t as never).execute();
    }

    const filesDir = path.join(env.DATA_DIR, 'files');
    if (fs.existsSync(filesDir)) {
      fs.rmSync(filesDir, { recursive: true, force: true });
    }
    fs.mkdirSync(filesDir, { recursive: true });

    await seedDemo(req.db);

    // Invariant: every user has a personal group. The wipe above
    // dropped them; re-ensure for everyone (Doe corpus + any ad-hoc
    // users — sim personas, BYOK testers, etc.) so users created
    // before this rule landed don't end up grouple-ss.
    const allUsers = await req.db
      .selectFrom('users')
      .select(['id', 'display_name', 'username'])
      .execute();
    for (const u of allUsers) {
      await ensurePersonalGroup(req.db, u.id);
    }

    logger.warn(
      `demo data reset (all tables wiped, reseeded, personal groups ensured for ${allUsers.length} users)`,
    );
    res.json({ ok: true, tablesWiped: tables.length, personalGroupsEnsured: allUsers.length });
  } catch (err) {
    next(err);
  }
});

/**
 * Queue an immediate `daily_morning_scan` for the authenticated user and fire
 * just that row inline, so the briefing lands within the request rather than
 * waiting for the user's scheduled nudge time. User-scoped (it only touches
 * the caller's personal group), so unlike the demo reset above it is NOT
 * gated by DEMO_MODE — it backs the "Send me a briefing now" button for real
 * users. Returns { ok, posted }; posted=false when the user has no personal
 * group or the scan found nothing worth surfacing.
 */
demoRouter.post(API.devProactiveScan, requireSession, async (req, res, next) => {
  try {
    const posted = await runDailyScanForUserNow(req.db, req.userId!);
    res.json({ ok: true, posted });
  } catch (err) {
    next(err);
  }
});
