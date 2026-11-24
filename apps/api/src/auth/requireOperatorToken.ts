import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import createHttpError from 'http-errors';

/**
 * Guards the operator routes (tenant and mailbox creation). The caller sends
 * `Authorization: Bearer <OPERATOR_TOKEN>`; anything else ends the request with 401 before any
 * handler runs. Constant-time comparison so a wrong token leaks nothing about the right one.
 */
export function createRequireOperatorToken(operatorToken: string): RequestHandler {
  const expected = Buffer.from(operatorToken);
  return (request: Request, _response: Response, next: NextFunction) => {
    const presented = Buffer.from(readBearerToken(request.headers.authorization) ?? '');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      next(createHttpError(401, 'not_operator'));
      return;
    }
    next();
  };
}

function readBearerToken(authorizationHeader: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader ?? '');
  return match?.[1];
}
