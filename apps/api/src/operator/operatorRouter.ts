import express from 'express';
import type { RequestHandler, Router } from 'express';
import createHttpError from 'http-errors';
import { createOperatorSessionToken, verifyPassword } from '@lc/core';
import type { OperatorRepository } from '@lc/core';
import { operatorLoginRequestSchema } from '@lc/contract';
import type { OperatorSessionResponse } from '@lc/contract';
import { parseRequestBody } from '../http/parseRequestBody.js';
import { clearOperatorCookie, setOperatorCookie } from '../auth/operatorCookie.js';
import { getOperatorSession } from '../auth/requireOperator.js';
import type { SessionCookieOptions } from '../auth/sessionCookie.js';

export interface OperatorRouterDependencies {
  operatorRepository: OperatorRepository;
  sessionSecret: string;
  sessionCookie: SessionCookieOptions;
  requireOperator: RequestHandler;
}

/**
 * Operator sign-in. Accounts come from `npm run operator:create`, never from here. POST /login is the
 * only way to obtain an lc_operator cookie, POST /logout clears it, GET /me says who is signed in.
 */
export function createOperatorRouter({
  operatorRepository,
  sessionSecret,
  sessionCookie,
  requireOperator,
}: OperatorRouterDependencies): Router {
  const router = express.Router();

  router.post('/login', async (request, response) => {
    const body = parseRequestBody(operatorLoginRequestSchema, request.body);
    const operator = await operatorRepository.findOperatorByEmail(body.email);
    // Same response for unknown email and wrong password: no account enumeration.
    if (!operator || !(await verifyPassword(operator.passwordHash, body.password))) {
      throw createHttpError(401, 'invalid_credentials');
    }
    const claims: OperatorSessionResponse = {
      operatorId: operator.operatorId,
      email: operator.email,
    };
    setOperatorCookie(
      response,
      await createOperatorSessionToken(claims, sessionSecret),
      sessionCookie,
    );
    response.json(claims);
  });

  router.post('/logout', (_request, response) => {
    clearOperatorCookie(response, sessionCookie);
    response.status(204).end();
  });

  router.get('/me', requireOperator, (_request, response) => {
    const claims: OperatorSessionResponse = getOperatorSession(response);
    response.json(claims);
  });

  return router;
}
