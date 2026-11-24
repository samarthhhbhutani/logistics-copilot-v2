import type { Request, Response } from 'express';
import { OPERATOR_TOKEN_TTL_SECONDS } from '@lc/core';
import type { SessionCookieOptions } from './sessionCookie.js';

/** Separate from lc_session so a person can be signed in as a mailbox and as the operator at once. */
export const OPERATOR_COOKIE_NAME = 'lc_operator';

/** httpOnly: JavaScript cannot read it. SameSite=Lax: not sent on cross-site POSTs. */
export function setOperatorCookie(
  response: Response,
  operatorToken: string,
  { secure }: SessionCookieOptions,
): void {
  response.cookie(OPERATOR_COOKIE_NAME, operatorToken, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: OPERATOR_TOKEN_TTL_SECONDS * 1000,
  });
}

export function clearOperatorCookie(response: Response, { secure }: SessionCookieOptions): void {
  response.clearCookie(OPERATOR_COOKIE_NAME, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
  });
}

export function readOperatorCookie(request: Request): string | undefined {
  const cookies = request.cookies as Record<string, string | undefined> | undefined;
  return cookies?.[OPERATOR_COOKIE_NAME];
}
