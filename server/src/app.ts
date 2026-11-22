import express, { type Express } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { Kysely } from 'kysely';

import { env } from './config/env.js';
import { logger } from './config/logging.js';
import type { DB } from './db/schema.js';
import { attachDb } from './middleware/db.js';
import { authLimiter, connectorLimiter, generalLimiter } from './middleware/rate-limit.js';
import { demoRouter } from './routes/demo.js';
import { emailRouter } from './routes/email.js';
import { eventsRouter } from './routes/events.js';
import { filesRouter } from './routes/files.js';
import { groupsRouter } from './routes/groups.js';
import { healthRouter } from './routes/health.js';
import { ingestRouter } from './routes/ingest.js';
import { listsRouter } from './routes/lists.js';
import { meRouter } from './routes/me.js';
import { memoriesRouter } from './routes/memories.js';
import { personasRouter } from './routes/personas.js';
import { familyPlanRouter } from './routes/family-plan.js';
import { openRouterRouter } from './routes/openrouter.js';
import { familyProfileRouter } from './routes/family-profile.js';
import { messagesRouter } from './routes/messages.js';
import { personalRouter } from './routes/personal.js';
import { proposalsRouter } from './routes/proposals.js';
import { savesRouter } from './routes/saves.js';
import { authRouter } from './routes/auth.js';
import { sessionRouter } from './routes/session.js';
import { streamRouter } from './routes/stream.js';
import { connectorsRouter } from './routes/connectors.js';
import { tasksRouter } from './routes/tasks.js';
import { tripsRouter } from './routes/trips.js';
import { waitlistRouter } from './routes/waitlist.js';
import { mailPushRouter } from './routes/mail-push.js';
import { webhooksRouter } from './routes/webhooks.js';
import { signatureImagesRouter } from './routes/signature-images.js';
// Imported last on purpose: it pulls the bot executor into the graph, and
// loading that earlier changes the order the LLM factory is first evaluated
// in. Tests that partially mock the factory (openrouter-connect) then get the
// real one through an import cycle and fail.
import { aiAppsMcpRouter, aiAppsMeRouter, aiAppsOauthRouter, aiAppsWellKnownRouter } from './routes/ai-apps.js';
import { redactUrl } from './utils/redact-url.js';
import { buildCorsOriginCheck } from './utils/cors-origins.js';
import { errorHandler } from './middleware/error-handler.js';

export function buildApp(db: Kysely<DB>): Express {
  const app = express();

  // ADR 0091 — nginx terminates TLS and proxies to 127.0.0.1, appending the
  // client to X-Forwarded-For. ONE hop, never `true`: trusting every hop lets
  // a client forge the header and choose its own apparent location (and its
  // own rate-limit bucket). Becomes 2 if a load balancer is put in front.
  app.set('trust proxy', 1);

  const corsOriginAllowed = buildCorsOriginCheck({
    production: env.NODE_ENV === 'production',
    extra: env.CORS_ALLOWED_ORIGINS,
    webOrigin: env.WEB_ORIGIN,
    signupUrl: env.SIGNUP_URL,
  });
  app.use(
    cors({
      origin: (origin, cb) => cb(null, corsOriginAllowed(origin)),
      credentials: true,
      // The client revalidates the email lists with If-None-Match; on a
      // cross-origin web build it cannot read the ETag unless it is exposed.
      exposedHeaders: ['ETag'],
    }),
  );
  // Baseline security headers. crossOriginResourcePolicy is relaxed so the
  // mobile/web clients on other origins can still load uploaded files.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cookieParser());
  // Capture the raw bytes alongside the parsed body so connectors that
  // sign the literal request payload (Slack HMAC, ADR 0010) can verify
  // against bytes — JSON.stringify after parsing breaks key ordering.
  app.use(
    express.json({
      limit: '2mb',
      verify: (req, _res, buf) => {
        (req as { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    }),
  );
  // Twilio WhatsApp webhooks arrive as application/x-www-form-urlencoded
  // (ADR 0053). express.json ignores them, so parse that media type too;
  // its signature is computed over the parsed params, not the raw bytes.
  app.use(
    express.urlencoded({
      extended: false,
      limit: '2mb',
      verify: (req, _res, buf) => {
        (req as { rawBody?: string }).rawBody = buf.toString('utf8');
      },
    }),
  );

  app.use(attachDb(db));

  app.use((req, _res, next) => {
    // ADR 0269 — the query can carry credentials (the web client's SSE
    // `?token=`, the image proxy's `?k=`, OAuth `code`/`state`).
    logger.debug(`${req.method} ${redactUrl(req.url)}`);
    next();
  });

  // Health (liveness/readiness) and the SSE stream bypass the general
  // limiter: liveness must always answer, and SSE holds long-lived
  // connections that a fixed-window request counter would choke. They are
  // mounted before generalLimiter so matched requests never reach it.
  app.use(healthRouter);
  app.use(streamRouter);
  // Signature pictures (ADR 0326): fetched by recipients' mail apps.
  app.use(signatureImagesRouter);

  // ADR 0335 - the MCP connector and its OAuth endpoints. Before the general
  // limiter, which counts per IP: Claude's and ChatGPT's servers send every
  // one of their users' calls from the same few addresses.
  app.use(aiAppsWellKnownRouter);
  app.use('/api/oauth', connectorLimiter);
  app.use('/api/mcp', connectorLimiter);
  app.use(aiAppsOauthRouter);
  app.use(aiAppsMcpRouter);

  app.use(generalLimiter);
  // Credential endpoints get the tighter limiter on top of the general one.
  app.use('/api/v1/session', authLimiter);
  app.use('/api/v1/auth', authLimiter);

  app.use(sessionRouter);
  app.use(authRouter);
  app.use(meRouter);
  app.use(aiAppsMeRouter);
  app.use(familyPlanRouter);
  app.use(openRouterRouter);
  app.use(emailRouter);
  app.use(groupsRouter);
  app.use(messagesRouter);
  app.use(filesRouter);
  app.use(tasksRouter);
  app.use(listsRouter);
  app.use(savesRouter);
  app.use(eventsRouter);
  app.use(personalRouter);
  app.use(memoriesRouter);
  app.use(personasRouter);
  app.use(familyProfileRouter);
  app.use(proposalsRouter);
  app.use(tripsRouter);
  app.use(ingestRouter);
  app.use(demoRouter);
  // Before the connector router: that one owns `/webhooks/:platform` as a
  // catch-all, and `mail` is not a platform (ADR 0118, same ordering care
  // ADR 0075 needed for the Stripe route).
  app.use(mailPushRouter);
  app.use(webhooksRouter);
  app.use(connectorsRouter);
  app.use(waitlistRouter);

  app.use(errorHandler);

  return app;
}
