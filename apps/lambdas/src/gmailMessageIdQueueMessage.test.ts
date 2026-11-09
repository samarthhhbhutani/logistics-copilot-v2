import { describe, expect, it } from 'vitest';
import { parseGmailMessageIdQueueMessage } from './gmailMessageIdQueueMessage.js';

describe('parseGmailMessageIdQueueMessage', () => {
  it('accepts the body gmailPushReceiver writes', () => {
    const body = JSON.stringify({ tenantId: 't-1', mailboxId: 'm-1', gmailMessageId: 'gm-1' });
    expect(parseGmailMessageIdQueueMessage(body)).toEqual({
      tenantId: 't-1',
      mailboxId: 'm-1',
      gmailMessageId: 'gm-1',
    });
  });

  it.each([
    ['not json', 'nope'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a missing field', JSON.stringify({ tenantId: 't-1', mailboxId: 'm-1' })],
    ['an empty id', JSON.stringify({ tenantId: 't-1', mailboxId: 'm-1', gmailMessageId: '' })],
    ['a non-string id', JSON.stringify({ tenantId: 't-1', mailboxId: 'm-1', gmailMessageId: 7 })],
  ])('rejects %s', (_name, body) => {
    expect(parseGmailMessageIdQueueMessage(body)).toBeUndefined();
  });
});
