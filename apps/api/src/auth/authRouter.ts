import express from 'express';
import type { Router } from 'express';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { createSessionToken, verifyPassword } from '@lc/core';
import type { MailboxCredentialsRepository } from '@lc/core';
import { parseRequestBody } from '../http/parseRequestBody.js';
import { clearSessionCookie, setSessionCookie } from './sessionCookie.js';
import type { SessionCookieOptions } from './sessionCookie.js';

export interface AuthRouterDependencies {
  mailboxCredentialsRepository: MailboxCredentialsRepository;
  sessionSecret: string;
  sessionCookie: SessionCookieOptions;
}

export const emailAddressSchema = z
  .email()
  .max(254)
  .transform((emailAddress) => emailAddress.toLowerCase());
export const passwordSchema = z.string().min(6).max(256);

const loginBodySchema = z.object({ email: emailAddressSchema, password: passwordSchema });

/** POST /login is the only way to obtain a session cookie; POST /logout clears it. */
export function createAuthRouter({
  mailboxCredentialsRepository,
  sessionSecret,
  sessionCookie,
}: AuthRouterDependencies): Router {
  const router = express.Router();

  router.post('/login', async (request, response) => {
    const body = parseRequestBody(loginBodySchema, request.body);
    const credentials = await mailboxCredentialsRepository.findMailboxCredentials(body.email);
    // Same response for unknown email and wrong password: no account enumeration.
    if (!credentials || !(await verifyPassword(credentials.passwordHash, body.password))) {
      throw createHttpError(401, 'invalid_credentials');
    }
    const claims = { mailboxId: credentials.mailboxId, tenantId: credentials.tenantId };
    setSessionCookie(response, await createSessionToken(claims, sessionSecret), sessionCookie);
    response.json(claims);
  });

  router.post('/logout', (_request, response) => {
    clearSessionCookie(response, sessionCookie);
    response.status(204).end();
  });

  return router;
}
