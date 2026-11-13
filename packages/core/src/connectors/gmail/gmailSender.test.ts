import { describe, expect, it } from 'vitest';
import { buildSendRequestBody, createGoogleGmailSender } from './gmailSender.js';

describe('buildSendRequestBody', () => {
  it('base64url-encodes the bytes (no +, / or padding) and sends threadId only when given', () => {
    const rawMessage = new TextEncoder().encode('Subject: x\r\n\r\n>>>???');
    const body = buildSendRequestBody(rawMessage, undefined);
    expect(body).toEqual({ raw: Buffer.from(rawMessage).toString('base64url') });
    expect(body.raw).not.toMatch(/[+/=]/);
    expect(Buffer.from(body.raw, 'base64url').toString()).toBe('Subject: x\r\n\r\n>>>???');
    expect(buildSendRequestBody(rawMessage, 'thread-9')).toMatchObject({ threadId: 'thread-9' });
  });
});

describe('createGoogleGmailSender', () => {
  it('applies the stage rule for safe mode when built', () => {
    expect(() => createGoogleGmailSender({ stage: 'staging' })).toThrow(
      /required when STAGE=staging/,
    );
    expect(() =>
      createGoogleGmailSender({ stage: 'staging', redirectAllMailTo: 'me@tenant.example' }),
    ).not.toThrow();
  });
});
