import type { NextFunction, Request, Response } from 'express';

import { isMember } from '../services/groups.service.js';

export async function requireMember(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: 'group id required' });
    return;
  }
  if (!req.userId) {
    res.status(401).json({ error: 'not signed in' });
    return;
  }
  if (!(await isMember(req.db, id, req.userId))) {
    res.status(403).json({ error: 'not a member' });
    return;
  }
  next();
}
