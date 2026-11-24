import type { NextFunction, Request, RequestHandler, Response } from 'express';
import createHttpError from 'http-errors';
import { verifyOperatorSessionToken } from '@lc/core';
import type { OperatorSessionClaims } from '@lc/core';
import { readOperatorCookie } from './operatorCookie.js';

const OPERATOR_LOCALS_KEY = 'operator';

/**
 * Guards the operator routes (tenant and mailbox creation, GET /operator/me). A valid lc_operator
 * cookie from POST /operator/login gets through; anything else, including a mailbox session, ends
 * the request with 401 before any handler runs.
 */
export function createRequireOperator(sessionSecret: string): RequestHandler {
  return async (request: Request, response: Response, next: NextFunction) => {
    const operatorToken = readOperatorCookie(request);
    const claims = operatorToken
      ? await verifyOperatorSessionToken(operatorToken, sessionSecret)
      : undefined;
    if (!claims) {
      next(createHttpError(401, 'not_operator'));
      return;
    }
    response.locals[OPERATOR_LOCALS_KEY] = claims;
    next();
  };
}

/** The verified operator for this request. Only valid behind createRequireOperator. */
export function getOperatorSession(response: Response): OperatorSessionClaims {
  const claims = response.locals[OPERATOR_LOCALS_KEY] as OperatorSessionClaims | undefined;
  if (!claims) throw new Error('getOperatorSession() called on a route without requireOperator');
  return claims;
}
