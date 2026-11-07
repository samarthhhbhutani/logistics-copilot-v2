import type { Request, Response } from 'express';
import { SESSION_TOKEN_TTL_SECONDS } from '@lc/core';

export const SESSION_COOKIE_NAME = 'lc_session';

export interface SessionCookieOptions {
  /** Send the cookie only over HTTPS. False for local dev on http://localhost. */
  secure: boolean;
}

/** httpOnly: JavaScript cannot read it. SameSite=Lax: not sent on cross-site POSTs. */
export function setSessionCookie(
  response: Response,
  sessionToken: string,
  { secure }: SessionCookieOptions,
): void {
  response.cookie(SESSION_COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TOKEN_TTL_SECONDS * 1000,
  });
}

export function clearSessionCookie(response: Response, { secure }: SessionCookieOptions): void {
  response.clearCookie(SESSION_COOKIE_NAME, { httpOnly: true, secure, sameSite: 'lax', path: '/' });
}

export function readSessionCookie(request: Request): string | undefined {
  const cookies = request.cookies as Record<string, string | undefined> | undefined;
  return cookies?.[SESSION_COOKIE_NAME];
}
