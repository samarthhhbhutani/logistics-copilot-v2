import { describe, expect, it } from 'vitest';
import { buildOutboundMessageId, buildReplyMessage } from './buildReplyMessage.js';

const sentMailId = '11111111-1111-4111-8111-111111111111';

describe('buildOutboundMessageId', () => {
  it('uses the sending mailbox domain', () => {
    expect(buildOutboundMessageId(sentMailId, 'ops@bhatia.example')).toBe(
      `<${sentMailId}@bhatia.example>`,
    );
  });
});

describe('buildReplyMessage', () => {
  it('builds References from the thread oldest first ending in the answered mail, and tolerates a missing Message-ID', () => {
    const connection = {
      mailboxId: 'm',
      tenantId: 't',
      emailAddress: 'ops@bhatia.example',
      gmailConnectionStatus: 'connected' as const,
      gmailConnectedAt: null,
      encryptedRefreshToken: null,
      watchExpiresAt: null,
      signature: null,
    };
    const emailBase = {
      gmailThreadId: 'thread-1',
      senderName: 'Ravi',
      senderEmail: 'ravi@acme.com',
      toRecipients: [],
      ccRecipients: [],
      subject: 'RFQ',
      snippet: '',
      bodyText: '',
      bodyHtml: null,
      receivedAt: new Date(),
      classification: null,
    };
    const answeredEmail = {
      ...emailBase,
      id: 'e2',
      gmailLabel: 'inbox' as const,
      rfcMessageId: null,
    };
    const sentMail = {
      id: sentMailId,
      kind: 'reply' as const,
      status: 'pending' as const,
      inReplyToEmailId: 'e2',
      gmailThreadId: 'thread-1',
      rfcMessageId: `<${sentMailId}@bhatia.example>`,
      toRecipients: [{ name: 'Ravi', address: 'ravi@acme.com' }],
      ccRecipients: [],
      subject: 'Re: RFQ',
      bodyText: 'Hi',
      gmailMessageId: null,
      sentEmailId: null,
      errorCode: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const message = buildReplyMessage(
      sentMail,
      answeredEmail,
      [
        { ...emailBase, id: 'e1', gmailLabel: 'sent', rfcMessageId: '<a@bhatia.example>' },
        answeredEmail,
        { ...emailBase, id: 'e0', gmailLabel: 'inbox', rfcMessageId: null },
      ],
      connection,
    );
    expect(message.inReplyTo).toBeUndefined();
    expect(message.references).toEqual(['<a@bhatia.example>']);
    expect(message.cc).toBeUndefined();
    expect(message.signature).toBeUndefined();
  });
});
