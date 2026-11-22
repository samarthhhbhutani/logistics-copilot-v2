import { describe, expect, it } from 'vitest';
import type { RfqMailWithRepliesResponse, SentMailResponse } from '@lc/contract';
import {
  anyMailSending,
  anyUnverifiableMail,
  countReachableContacts,
  countRepliedContacts,
  countRetryableMails,
  describeSentMailStatus,
  mailTextsForSend,
  rfqProgressLabel,
} from './rfqSend.js';
import { rfqStatusHeading, sendStatusHeading } from './rfqSendStatus.js';

function mail(
  status: SentMailResponse['status'],
  errorCode: string | null = null,
): SentMailResponse {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'rfq',
    status,
    inReplyToEmailId: null,
    rfqId: '22222222-2222-4222-8222-222222222222',
    vendorId: '33333333-3333-4333-8333-333333333333',
    vendorContactId: '44444444-4444-4444-8444-444444444444',
    gmailThreadId: null,
    rfcMessageId: '<x@example.com>',
    toRecipients: [{ name: 'Ravi', address: 'ravi@example.com' }],
    ccRecipients: [],
    subject: 'RFQ',
    bodyText: 'Dear Ravi',
    gmailMessageId: null,
    errorCode,
    createdAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T00:00:00.000Z',
  };
}

describe('mailTextsForSend', () => {
  it('returns trimmed texts for every ticked category, in category order', () => {
    const result = mailTextsForSend(['cha', 'carrier'], {
      cha: { subject: '  Clearance  ', bodyText: 'Dear Team\n' },
      carrier: { subject: 'Rates', bodyText: 'Hello' },
    });
    expect(result).toEqual({
      ok: true,
      mails: [
        { category: 'cha', subject: 'Clearance', bodyText: 'Dear Team' },
        { category: 'carrier', subject: 'Rates', bodyText: 'Hello' },
      ],
    });
  });

  it('names the first gap: missing draft, blank subject, blank message', () => {
    expect(mailTextsForSend(['carrier'], null)).toEqual({
      ok: false,
      message: 'No mail drafted for Carriers yet. Write the vendor mails first.',
    });
    expect(mailTextsForSend(['cha'], { cha: { subject: ' ', bodyText: 'x' } })).toEqual({
      ok: false,
      message: 'The Customs house agents mail needs a subject.',
    });
    expect(mailTextsForSend(['cha'], { cha: { subject: 'x', bodyText: '\n' } })).toEqual({
      ok: false,
      message: 'The Customs house agents mail needs a message.',
    });
  });
});

describe('describeSentMailStatus', () => {
  it('maps each status and the known failure codes to operator wording', () => {
    expect(describeSentMailStatus(mail('sent'))).toEqual({
      tone: 'sent',
      label: 'Sent',
      detail: null,
    });
    expect(describeSentMailStatus(mail('sending')).tone).toBe('sending');
    expect(describeSentMailStatus(mail('pending'))).toMatchObject({
      tone: 'waiting',
      label: 'Not sent yet',
    });
    expect(describeSentMailStatus(mail('failed', 'invalid_grant')).detail).toContain('reconnected');
    expect(describeSentMailStatus(mail('failed', 'send_unconfirmed')).detail).toContain(
      'did not confirm',
    );
    expect(describeSentMailStatus(mail('failed', 'send_unverifiable')).detail).toContain(
      'Sent folder',
    );
    expect(describeSentMailStatus(mail('failed', 'odd_code')).detail).toBe(
      'Gmail refused the send (odd_code).',
    );
    expect(describeSentMailStatus(mail('failed')).detail).toBe('Gmail refused the send.');
  });
});

describe('batch summaries', () => {
  it('counts what a retry would send and flags unverifiable rows', () => {
    const mails = [
      mail('sent'),
      mail('failed', 'bad_request'),
      mail('pending'),
      mail('sending'),
      mail('failed', 'send_unverifiable'),
    ];
    expect(countRetryableMails(mails)).toBe(3);
    expect(anyMailSending(mails)).toBe(true);
    expect(anyUnverifiableMail(mails)).toBe(true);
    expect(anyMailSending([mail('sent'), mail('failed')])).toBe(false);
    expect(anyUnverifiableMail([mail('failed', 'send_unconfirmed')])).toBe(false);
  });
});

describe('sendStatusHeading', () => {
  it('reports sent, still sending and not sent for one mail and for a batch', () => {
    expect(sendStatusHeading(1, 1, 0)).toBe('Mail sent');
    expect(sendStatusHeading(1, 0, 1)).toBe('Mail sending');
    expect(sendStatusHeading(1, 0, 0)).toBe('Mail not sent');
    expect(sendStatusHeading(3, 3, 0)).toBe('All 3 mails sent');
    expect(sendStatusHeading(3, 1, 1)).toBe('1 of 3 mails sent, 1 still sending');
    expect(sendStatusHeading(3, 1, 0)).toBe('1 of 3 mails sent');
  });
});

/** A mail with `replyCount` inbound mails linked to it; the newest carries `label` (null: not yet classified). */
function mailWithReplies(
  status: SentMailResponse['status'],
  replyCount: number,
  label: 'vendor_quote' | 'vendor_reply' | null = 'vendor_reply',
): RfqMailWithRepliesResponse {
  return {
    ...mail(status, status === 'failed' ? 'bad_request' : null),
    replies: {
      count: replyCount,
      latest:
        replyCount === 0
          ? null
          : {
              emailId: '55555555-5555-4555-8555-555555555555',
              sender: { name: 'Ravi', email: 'ravi@example.com' },
              receivedAt: '2026-11-16T09:30:00.000Z',
              snippet: 'USD 1450',
              classification: label
                ? {
                    label,
                    source: 'llm',
                    confidence: 0.9,
                    classifiedAt: '2026-11-16T09:31:00.000Z',
                  }
                : null,
            },
    },
  };
}

describe('reply counts', () => {
  it('counts vendors, not messages, and leaves out mails that never reached anyone', () => {
    const mails = [
      mailWithReplies('sent', 2, 'vendor_quote'),
      mailWithReplies('sent', 1, null),
      mailWithReplies('sent', 0),
      mailWithReplies('sending', 0),
      mailWithReplies('failed', 0),
    ];
    expect(countReachableContacts(mails)).toBe(4);
    expect(countRepliedContacts(mails)).toBe(2);
  });

  it('labels the collapsed panel with how many vendors came back', () => {
    expect(
      rfqProgressLabel([
        mailWithReplies('sent', 1),
        mailWithReplies('sent', 0),
        mailWithReplies('sent', 0),
      ]),
    ).toBe('Vendor quotes: 1 of 3 replied');
    expect(rfqProgressLabel([mailWithReplies('sent', 0), mailWithReplies('failed', 0)])).toBe(
      'Vendor quotes: 1 vendor asked, none replied yet',
    );
    expect(rfqProgressLabel([mailWithReplies('sent', 0), mailWithReplies('pending', 0)])).toBe(
      'Vendor quotes: 2 vendors asked, none replied yet',
    );
    expect(rfqProgressLabel([mailWithReplies('failed', 0)])).toBe(
      'Vendor quotes: no mail reached a vendor',
    );
  });

  it('adds the replied count to the send heading only once someone wrote back', () => {
    expect(rfqStatusHeading([mailWithReplies('sent', 0), mailWithReplies('sent', 0)])).toBe(
      'All 2 mails sent',
    );
    expect(rfqStatusHeading([mailWithReplies('sent', 3), mailWithReplies('sending', 0)])).toBe(
      '1 of 2 mails sent, 1 still sending · 1 of 2 replied',
    );
  });
});
