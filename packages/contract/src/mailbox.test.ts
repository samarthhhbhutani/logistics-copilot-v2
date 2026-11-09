import { describe, expect, it } from 'vitest';
import {
  connectFlowErrorSchema,
  gmailConnectResponseSchema,
  mailboxResponseSchema,
} from './index.js';
import type { MailboxResponse } from './index.js';

const mailbox: MailboxResponse = {
  mailboxId: '0f8b6a52-3c1d-4e7a-9b2f-5d6c7e8f9a01',
  tenantId: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  emailAddress: 'ops@bhatia.example',
  gmailConnectionStatus: 'connected',
  gmailConnectedAt: '2026-11-09T12:00:00.000Z',
  watchExpiresAt: '2026-11-15T12:00:00.000Z',
};

describe('mailboxResponseSchema', () => {
  it('accepts a connected and a never-connected mailbox', () => {
    expect(mailboxResponseSchema.parse(mailbox)).toEqual(mailbox);
    const notConnected = {
      ...mailbox,
      gmailConnectionStatus: 'not_connected',
      gmailConnectedAt: null,
      watchExpiresAt: null,
    };
    expect(mailboxResponseSchema.parse(notConnected)).toEqual(notConnected);
  });

  it.each(['not_connected', 'connected', 'needs_reconnect'])('accepts status %s', (status) => {
    expect(
      mailboxResponseSchema.safeParse({ ...mailbox, gmailConnectionStatus: status }).success,
    ).toBe(true);
  });

  it.each([
    { ...mailbox, gmailConnectionStatus: 'CONNECTED' },
    { ...mailbox, gmailConnectedAt: 'yesterday' },
    { ...mailbox, watchExpiresAt: undefined },
    { ...mailbox, mailboxId: 'mailbox-1' },
  ])('rejects malformed %j', (body) => {
    expect(mailboxResponseSchema.safeParse(body).success).toBe(false);
  });
});

describe('gmailConnectResponseSchema', () => {
  it('accepts a Google consent URL', () => {
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&state=xyz';
    expect(gmailConnectResponseSchema.parse({ url })).toEqual({ url });
  });

  it.each([
    'http://accounts.google.com/o/oauth2/v2/auth',
    'https://accounts.google.com.evil.example/o/oauth2/v2/auth',
    'https://evil.example/o/oauth2/v2/auth',
    'https://accounts.google.com/logout',
    'javascript:alert(1)',
    'not a url',
  ])('rejects %s', (url) => {
    expect(gmailConnectResponseSchema.safeParse({ url }).success).toBe(false);
  });
});

describe('connectFlowErrorSchema', () => {
  it('lists every code the callback can report', () => {
    expect(connectFlowErrorSchema.options).toEqual([
      'denied',
      'invalid_state',
      'google_client_not_configured',
      'exchange_failed',
      'email_mismatch',
      'scope_not_granted',
      'pubsub_not_configured',
      'watch_failed',
    ]);
  });

  it('rejects an unknown code', () => {
    expect(connectFlowErrorSchema.safeParse('something_else').success).toBe(false);
  });
});
