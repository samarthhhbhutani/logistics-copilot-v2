import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';
import type { Config } from '@lc/core';

export interface AppDependencies {
  config: Config;
}

/**
 * Build the Express app without binding a port, so tests drive it with supertest and
 * index.ts owns listening and shutdown. Everything the app needs arrives as an argument.
 *
 * No metrics middleware: request latency and status come from OpenTelemetry's http/express
 * auto-instrumentation once instrumentation.ts lands (README, Telemetry).
 */
export function createAppInstance({ config }: AppDependencies): Express {
  const expressApp = express();
  expressApp.use(express.json({ limit: '1mb' }));

  expressApp.get('/health', (_request, response) => {
    response.json({ ok: true, stage: config.STAGE });
  });

  const v1Router = express.Router();
  // Feature routers mount here as they land: auth, mailboxes, emails, rfqs, agent.
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
