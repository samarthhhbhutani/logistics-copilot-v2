import { describe, expect, it } from 'vitest';
import type { SentMailResponse } from '@lc/contract';
import {
  anyMailSending,
  anyUnverifiableMail,
  countRetryableMails,
  describeRfqMailStatus,
  mailTextsForSend,
} from './rfqSend.js';
import { sendStatusHeading } from './rfqSendStatus.js';

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

describe('describeRfqMailStatus', () => {
  it('maps each status and the known failure codes to operator wording', () => {
    expect(describeRfqMailStatus(mail('sent'))).toEqual({
      tone: 'sent',
      label: 'Sent',
      detail: null,
    });
    expect(describeRfqMailStatus(mail('sending')).tone).toBe('sending');
    expect(describeRfqMailStatus(mail('pending'))).toMatchObject({
      tone: 'waiting',
      label: 'Not sent yet',
    });
    expect(describeRfqMailStatus(mail('failed', 'invalid_grant')).detail).toContain('reconnected');
    expect(describeRfqMailStatus(mail('failed', 'send_unconfirmed')).detail).toContain(
      'did not confirm',
    );
    expect(describeRfqMailStatus(mail('failed', 'send_unverifiable')).detail).toContain(
      'Sent folder',
    );
    expect(describeRfqMailStatus(mail('failed', 'odd_code')).detail).toBe(
      'Gmail refused the send (odd_code).',
    );
    expect(describeRfqMailStatus(mail('failed')).detail).toBe('Gmail refused the send.');
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
