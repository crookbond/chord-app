/**
 * ADR 0326 - a signature picture, served to anyone who has its link. The link
 * is in mail the user sent, and the recipient's mail app (or its image proxy)
 * fetches it with no Chord session. Mounted before the general rate limit:
 * one mail provider's proxy fetches for many recipients from few addresses.
 */
import { Router } from 'express';

import { API } from '@chord/kernel';

import { readSignatureImage } from '../services/email/signature-images.js';

export const signatureImagesRouter = Router();

signatureImagesRouter.get(API.signatureImage(':id'), async (req, res, next) => {
  try {
    const image = await readSignatureImage(req.db, req.params.id);
    if (!image) {
      res.status(404).end();
      return;
    }
    res.set({
      'Content-Type': image.mime,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    });
    res.send(image.bytes);
  } catch (err) {
    next(err);
  }
});
