import { describe, expect, it } from 'vitest';
import { GmailApiError, toGmailApiError } from './gmailApiError.js';

function googleError(status: number, data: unknown): Error {
  return Object.assign(new Error('request failed'), { response: { status, data } });
}

export function gmailApiError(status: number, reason: string, message: string): Error {
  return googleError(status, {
    error: { code: status, message, errors: [{ domain: 'global', reason, message }] },
  });
}

describe('toGmailApiError', () => {
  it('a dead refresh token (token endpoint invalid_grant) means the mailbox needs a reconnect', () => {
    const error = toGmailApiError(
      googleError(400, {
        error: 'invalid_grant',
        error_description: 'Token has been expired or revoked.',
      }),
    );
    expect(error.code).toBe('invalid_grant');
    expect(error.message).toBe('invalid_grant: Token has been expired or revoked.');
  });

  it('any other token endpoint error is a plain failure', () => {
    expect(toGmailApiError(googleError(401, { error: 'invalid_client' }))).toMatchObject({
      code: 'request_failed',
      httpStatus: 401,
      message: 'request_failed: invalid_client',
    });
  });

  it('maps Gmail statuses to codes without reading the message', () => {
    expect(toGmailApiError(gmailApiError(400, 'invalidArgument', 'anything')).code).toBe(
      'bad_request',
    );
    expect(toGmailApiError(gmailApiError(403, 'forbidden', 'anything')).code).toBe('forbidden');
    expect(toGmailApiError(gmailApiError(403, 'accessNotConfigured', 'anything')).code).toBe(
      'gmail_api_disabled',
    );
    expect(toGmailApiError(gmailApiError(404, 'notFound', 'anything')).code).toBe('not_found');
    expect(toGmailApiError(gmailApiError(429, 'rateLimitExceeded', 'anything')).code).toBe(
      'rate_limited',
    );
    expect(toGmailApiError(gmailApiError(403, 'userRateLimitExceeded', 'anything')).code).toBe(
      'rate_limited',
    );
  });

  it("keeps Google's message as detail for the log", () => {
    const error = toGmailApiError(
      gmailApiError(404, 'notFound', 'Requested entity was not found.'),
    );
    expect(error.detail).toBe('Requested entity was not found.');
    expect(error.message).toBe('not_found: Requested entity was not found.');
  });

  it('anything else keeps the status and message; an existing GmailApiError passes through', () => {
    expect(toGmailApiError(gmailApiError(503, 'backendError', 'Backend Error'))).toMatchObject({
      code: 'request_failed',
      httpStatus: 503,
      message: 'request_failed: Backend Error',
    });
    expect(toGmailApiError(new Error('ECONNRESET'))).toMatchObject({
      code: 'request_failed',
      httpStatus: undefined,
      message: 'request_failed: ECONNRESET',
    });
    const existing = new GmailApiError('invalid_grant', 400);
    expect(toGmailApiError(existing)).toBe(existing);
  });
});
