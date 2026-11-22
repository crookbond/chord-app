import { Router } from 'express';
import { nanoid } from 'nanoid';
import {
  API,
  WaitlistSignupRequest,
  type WaitlistSignupResponse,
} from '@chord/kernel';

import { logger } from '../config/logging.js';

export const waitlistRouter = Router();

waitlistRouter.post(API.waitlist, async (req, res, next) => {
  try {
    const parsed = WaitlistSignupRequest.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'invalid' });
      return;
    }
    const { email, name, note } = parsed.data;

    const existing = await req.db
      .selectFrom('waitlist')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirst();

    if (existing) {
      const body: WaitlistSignupResponse = { ok: true, alreadyOnList: true };
      res.json(body);
      return;
    }

    await req.db
      .insertInto('waitlist')
      .values({
        id: `w_${nanoid(12)}`,
        email,
        name: name ?? null,
        note: note ?? null,
        created_at: new Date().toISOString(),
      })
      .execute();

    logger.info('waitlist signup');
    const body: WaitlistSignupResponse = { ok: true, alreadyOnList: false };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
