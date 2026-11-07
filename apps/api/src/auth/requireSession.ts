import type { NextFunction, Request, RequestHandler, Response } from 'express';
import createHttpError from 'http-errors';
import { verifySessionToken } from '@lc/core';
import type { SessionClaims } from '@lc/core';
import { readSessionCookie } from './sessionCookie.js';

const SESSION_LOCALS_KEY = 'session';

/**
 * Guards every tenant-scoped route. On success the claims are available to handlers through
 * getSession(response); on failure the request ends with 401 before any handler runs.
 */
export function createRequireSession(sessionSecret: string): RequestHandler {
  return async (request: Request, response: Response, next: NextFunction) => {
    const sessionToken = readSessionCookie(request);
    const claims = sessionToken ? await verifySessionToken(sessionToken, sessionSecret) : undefined;
    if (!claims) {
      next(createHttpError(401, 'not_authenticated'));
      return;
    }
    response.locals[SESSION_LOCALS_KEY] = claims;
    next();
  };
}

/** The verified session for this request. Only valid behind createRequireSession. */
export function getSession(response: Response): SessionClaims {
  const claims = response.locals[SESSION_LOCALS_KEY] as SessionClaims | undefined;
  if (!claims) throw new Error('getSession() called on a route without requireSession');
  return claims;
}
