import { describe, expect, it } from 'vitest';
import { toGmailApiError } from './gmailWatch.js';

function googleError(status: number, data: unknown): Error {
  return Object.assign(new Error('request failed'), { response: { status, data } });
}

function gmailApiError(status: number, reason: string, message: string): Error {
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

  it('a users.watch 400 can only be the topic: missing or in another project', () => {
    const error = toGmailApiError(
      gmailApiError(
        400,
        'invalidArgument',
        'Invalid topicName does not match projects/acme-logistics-mail/topics/*',
      ),
    );
    expect(error.code).toBe('topic_rejected');
    expect(error.httpStatus).toBe(400);
  });

  it('a 403 forbidden is the missing Publisher grant on the topic', () => {
    const error = toGmailApiError(
      gmailApiError(
        403,
        'forbidden',
        'Error sending test message to Cloud PubSub projects/acme/topics/gmail-notifications : User not authorized to perform this action.',
      ),
    );
    expect(error.code).toBe('topic_not_authorized');
  });

  it('a 403 accessNotConfigured is the Gmail API not enabled in the tenant project', () => {
    const error = toGmailApiError(
      gmailApiError(
        403,
        'accessNotConfigured',
        'Gmail API has not been used in project 123 before or it is disabled.',
      ),
    );
    expect(error.code).toBe('gmail_api_disabled');
  });

  it('anything else keeps the status and message for the log', () => {
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
  });
});
