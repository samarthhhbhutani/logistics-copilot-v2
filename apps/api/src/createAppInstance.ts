import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import type {
  Config,
  EmailRepository,
  GmailOAuth,
  GmailWatch,
  MailboxConnectionRepository,
  MailboxCredentialsRepository,
  EncryptionUtil,
  TenantRepository,
} from '@lc/core';
import { createAuthRouter } from './auth/authRouter.js';
import { createRequireSession, getSession } from './auth/requireSession.js';
import { createEmailsRouter } from './emails/emailsRouter.js';
import { createGmailConnectionRouter } from './gmail/gmailConnectionRouter.js';
import { createTenantsRouter } from './tenants/tenantsRouter.js';

export interface AppDependencies {
  config: Config;
  tenantRepository: TenantRepository;
  mailboxCredentialsRepository: MailboxCredentialsRepository;
  mailboxConnectionRepository: MailboxConnectionRepository;
  emailRepository: EmailRepository;
  /** Google OAuth operations; the real one in index.ts, an in-memory fake in tests. */
  gmailOAuth: GmailOAuth;
  /** Gmail users.watch / users.stop; same real-or-fake split as gmailOAuth. */
  gmailWatch: GmailWatch;
  /** Encrypts refresh tokens and tenant client secrets before they reach the database. */
  encryptionUtil: EncryptionUtil;
  /** HMAC key for session cookies; required here rather than optional on Config so index.ts fails fast. */
  sessionSecret: string;
}

/**
 * Build the Express app without binding a port, so tests drive it with supertest and
 * index.ts owns listening and shutdown. Everything the app needs arrives as an argument.
 *
 * No metrics middleware: request latency and status come from OpenTelemetry's http/express
 * auto-instrumentation once instrumentation.ts lands (README, Telemetry).
 */
export function createAppInstance({
  config,
  tenantRepository,
  mailboxCredentialsRepository,
  mailboxConnectionRepository,
  emailRepository,
  gmailOAuth,
  gmailWatch,
  encryptionUtil,
  sessionSecret,
}: AppDependencies): Express {
  const expressApp = express();
  expressApp.use(express.json({ limit: '1mb' }));
  expressApp.use(cookieParser());
  const sessionCookie = { secure: config.STAGE !== 'dev' };
  const requireSession = createRequireSession(sessionSecret);

  expressApp.get('/health', (_request, response) => {
    response.json({ ok: true, stage: config.STAGE });
  });

  const v1Router = express.Router();
  v1Router.use(
    '/auth',
    createAuthRouter({ mailboxCredentialsRepository, sessionSecret, sessionCookie }),
  );
  v1Router.use(
    '/tenants',
    createTenantsRouter({ tenantRepository, mailboxCredentialsRepository, encryptionUtil }),
  );
  // Who am I (mailbox + tenant): the smallest session-scoped route; what the frontend calls on load.
  v1Router.get('/me', requireSession, (_request, response) => {
    response.json(getSession(response));
  });
  v1Router.use(
    '/mailbox',
    createGmailConnectionRouter({
      mailboxConnectionRepository,
      tenantRepository,
      gmailOAuth,
      gmailWatch,
      encryptionUtil,
      requireSession,
      sessionSecret,
      frontendUrl: config.FRONTEND_URL,
    }),
  );
  v1Router.use('/mailbox/emails', createEmailsRouter({ emailRepository, requireSession }));
  // Feature routers mount here as they land: rfqs, agent.
  expressApp.use('/v1', v1Router);

  expressApp.use((request, response) => {
    response.status(404).json({ error: 'not_found', path: request.path });
  });

  expressApp.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const clientError = asClientError(error);
    if (clientError) {
      response.status(clientError.status).json({ error: clientError.message });
      return;
    }
    console.error(error);
    response.status(500).json({ error: 'internal_error' });
  });

  return expressApp;
}

interface ClientError {
  status: number;
  message: string;
}

/**
 * Express and its body parsers throw `http-errors` objects: a 4xx `status` plus `expose: true`
 * when the message is safe to return (e.g. malformed JSON). Anything else is a server fault.
 */
function asClientError(error: unknown): ClientError | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { status, expose, message } = error as Partial<ClientError & { expose: boolean }>;
  if (typeof status !== 'number' || status < 400 || status >= 500) return undefined;
  return { status, message: expose && typeof message === 'string' ? message : 'bad_request' };
}
