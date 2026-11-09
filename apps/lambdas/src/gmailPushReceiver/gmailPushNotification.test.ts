import { describe, expect, it } from 'vitest';
import { parseGmailPushNotification } from './gmailPushNotification.js';

function pushBody(data: unknown, messageId = 'pubsub-1'): string {
  return JSON.stringify({
    message: { data: Buffer.from(JSON.stringify(data)).toString('base64'), messageId },
    subscription: 'projects/acme/subscriptions/gmail-notifications-push',
  });
}

describe('parseGmailPushNotification', () => {
  it('decodes the Gmail payload out of the Pub/Sub envelope', () => {
    expect(
      parseGmailPushNotification(
        pushBody({ emailAddress: 'ops@acme.com', historyId: 1020624 }, 'm-42'),
      ),
    ).toEqual({ emailAddress: 'ops@acme.com', historyId: 1020624n, pubsubMessageId: 'm-42' });
  });

  it('accepts a string historyId (ids beyond double precision)', () => {
    expect(
      parseGmailPushNotification(
        pushBody({ emailAddress: 'ops@acme.com', historyId: '98765432109876543210' }),
      )?.historyId,
    ).toBe(98765432109876543210n);
  });

  it('rejects anything that is not a Gmail notification', () => {
    expect(parseGmailPushNotification(undefined)).toBeUndefined();
    expect(parseGmailPushNotification('not json')).toBeUndefined();
    expect(parseGmailPushNotification(JSON.stringify({ message: {} }))).toBeUndefined();
    expect(
      parseGmailPushNotification(
        JSON.stringify({
          message: { data: Buffer.from('hello').toString('base64'), messageId: 'x' },
        }),
      ),
    ).toBeUndefined();
    expect(parseGmailPushNotification(pushBody({ emailAddress: 'ops@acme.com' }))).toBeUndefined();
    expect(
      parseGmailPushNotification(pushBody({ emailAddress: 'ops@acme.com', historyId: '12a' })),
    ).toBeUndefined();
    expect(parseGmailPushNotification(pushBody({ historyId: 5 }))).toBeUndefined();
  });
});
