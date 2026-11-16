import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../db/prismaClient.js';
import { createPrismaSentMailRepository } from './sentMailRepository.js';

const scope = { tenantId: 'tenant-1', mailboxId: 'mailbox-1' };
const gmailIds = { gmailMessageId: 'gm-9', gmailThreadId: 'thread-9' };

/** Answers sentMail.updateMany with the given row count and records the arguments used. */
function stubUpdateMany(count: number) {
  const calls: Record<string, unknown>[] = [];
  const prismaClient = {
    sentMail: {
      async updateMany(args: Record<string, unknown>) {
        calls.push(args);
        return { count };
      },
    },
  } as unknown as PrismaClient;
  return { prismaClient, calls };
}

describe('markSentByRfcMessageId', () => {
  it('moves only the sending row of this mailbox carrying the Message-ID, writing the Gmail ids', async () => {
    const { prismaClient, calls } = stubUpdateMany(1);
    const result = await createPrismaSentMailRepository(prismaClient).markSentByRfcMessageId(
      scope,
      '<id-1@desk.com>',
      gmailIds,
    );
    expect(result).toEqual({ moved: true });
    expect(calls).toEqual([
      {
        where: { rfcMessageId: '<id-1@desk.com>', ...scope, status: 'SENDING' },
        data: { ...gmailIds, errorCode: null, status: 'SENT' },
      },
    ]);
  });

  it('reports no move when no sending row carries the Message-ID', async () => {
    const { prismaClient } = stubUpdateMany(0);
    const result = await createPrismaSentMailRepository(prismaClient).markSentByRfcMessageId(
      scope,
      '<unknown@elsewhere.com>',
      gmailIds,
    );
    expect(result).toEqual({ moved: false });
  });
});

describe('markSent', () => {
  it('keys the move by row id and requires sending as the current status', async () => {
    const { prismaClient, calls } = stubUpdateMany(1);
    await createPrismaSentMailRepository(prismaClient).markSent(scope, 'sent-mail-1', gmailIds);
    expect(calls[0]?.where).toEqual({ id: 'sent-mail-1', ...scope, status: 'SENDING' });
  });
});

describe('findAnsweredSentMail', () => {
  const inThread = { gmailThreadId: 'thread-9', inReplyToMessageId: undefined };

  /** Answers sentMail.findMany with the given rows (already in createdAt order) and records the where clause. */
  function stubFindMany(rows: { id: string; rfcMessageId: string }[]) {
    const calls: Record<string, unknown>[] = [];
    const prismaClient = {
      sentMail: {
        async findMany(args: Record<string, unknown>) {
          calls.push(args);
          return rows;
        },
      },
    } as unknown as PrismaClient;
    return { prismaClient, calls };
  }

  it('prefers the mail the In-Reply-To names over an earlier one in the thread', async () => {
    const { prismaClient, calls } = stubFindMany([
      { id: 'rfq-mail', rfcMessageId: '<rfq@desk.com>' },
      { id: 'follow-up', rfcMessageId: '<follow-up@desk.com>' },
    ]);
    const result = await createPrismaSentMailRepository(prismaClient).findAnsweredSentMail(scope, {
      gmailThreadId: 'thread-9',
      inReplyToMessageId: '<follow-up@desk.com>',
    });
    expect(result).toEqual({ sentMailId: 'follow-up' });
    expect(calls[0]?.where).toEqual({
      ...scope,
      kind: 'RFQ',
      status: { not: 'FAILED' },
      OR: [{ gmailThreadId: 'thread-9' }, { rfcMessageId: '<follow-up@desk.com>' }],
    });
  });

  it('falls back to the earliest mail we sent in the thread when In-Reply-To matches none', async () => {
    const { prismaClient, calls } = stubFindMany([
      { id: 'rfq-mail', rfcMessageId: '<rfq@desk.com>' },
      { id: 'follow-up', rfcMessageId: '<follow-up@desk.com>' },
    ]);
    const result = await createPrismaSentMailRepository(prismaClient).findAnsweredSentMail(
      scope,
      inThread,
    );
    expect(result).toEqual({ sentMailId: 'rfq-mail' });
    expect(calls[0]?.where).toEqual({
      ...scope,
      kind: 'RFQ',
      status: { not: 'FAILED' },
      OR: [{ gmailThreadId: 'thread-9' }],
    });
  });

  it('finds nothing when we sent no RFQ mail the message could answer (plain replies never qualify)', async () => {
    const { prismaClient } = stubFindMany([]);
    const result = await createPrismaSentMailRepository(prismaClient).findAnsweredSentMail(
      scope,
      inThread,
    );
    expect(result).toBeUndefined();
  });
});

describe('listRfqMails', () => {
  const sentAt = new Date('2026-11-16T08:00:00Z');
  const repliedAt = new Date('2026-11-16T09:30:00Z');
  const classifiedAt = new Date('2026-11-16T09:31:00Z');

  /** One sent_mails row as RFQ_MAIL_WITH_REPLIES_SELECT returns it, with the given replies relation. */
  function rfqMailWithRepliesRow(
    id: string,
    repliesReceived: Record<string, unknown>[],
    replyCount: number,
  ) {
    return {
      id,
      kind: 'RFQ',
      status: 'SENT',
      inReplyToEmailId: null,
      rfqId: 'rfq-1',
      vendorId: 'vendor-1',
      vendorContactId: `contact-${id}`,
      gmailThreadId: `thread-${id}`,
      rfcMessageId: `<${id}@desk.com>`,
      toRecipients: [{ name: 'Asha Rao', address: 'asha@sealines.example' }],
      ccRecipients: [],
      subject: 'RFQ: carrier rates',
      bodyText: 'Dear Team,',
      gmailMessageId: `gm-${id}`,
      errorCode: null,
      createdAt: sentAt,
      updatedAt: sentAt,
      _count: { repliesReceived: replyCount },
      repliesReceived,
    };
  }

  function stubFindMany(rows: Record<string, unknown>[]) {
    const calls: Record<string, unknown>[] = [];
    const prismaClient = {
      sentMail: {
        async findMany(args: Record<string, unknown>) {
          calls.push(args);
          return rows;
        },
      },
    } as unknown as PrismaClient;
    return { prismaClient, calls };
  }

  it('reads the reply count and the newest reply with its current label in the one query', async () => {
    const { prismaClient, calls } = stubFindMany([
      rfqMailWithRepliesRow(
        'answered',
        [
          {
            id: 'email-quote',
            senderName: 'Asha Rao',
            senderEmail: 'asha@sealines.example',
            receivedAt: repliedAt,
            snippet: 'USD 1450 per 40ft, valid 7 days',
            classifications: [
              { label: 'VENDOR_QUOTE', source: 'LLM', confidence: 0.9, classifiedAt },
            ],
          },
        ],
        2,
      ),
      rfqMailWithRepliesRow('unanswered', [], 0),
    ]);

    const rfqMails = await createPrismaSentMailRepository(prismaClient).listRfqMails(
      scope,
      'rfq-1',
    );

    expect(rfqMails.map((rfqMail) => rfqMail.replies)).toEqual([
      {
        count: 2,
        latest: {
          emailId: 'email-quote',
          senderName: 'Asha Rao',
          senderEmail: 'asha@sealines.example',
          receivedAt: repliedAt,
          snippet: 'USD 1450 per 40ft, valid 7 days',
          classification: { label: 'vendor_quote', source: 'llm', confidence: 0.9, classifiedAt },
        },
      },
      { count: 0, latest: undefined },
    ]);
    expect(rfqMails[0]).toMatchObject({ id: 'answered', kind: 'rfq', status: 'sent' });
    const [call] = calls;
    expect(call?.where).toEqual({ rfqId: 'rfq-1', ...scope });
    expect(call?.select).toMatchObject({
      _count: { select: { repliesReceived: true } },
      repliesReceived: {
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        take: 1,
        select: {
          id: true,
          senderName: true,
          senderEmail: true,
          receivedAt: true,
          snippet: true,
          classifications: {
            orderBy: [{ classifiedAt: 'desc' }, { id: 'desc' }],
            take: 1,
          },
        },
      },
    });
  });

  it('reports an unclassified newest reply with a null label', async () => {
    const { prismaClient } = stubFindMany([
      rfqMailWithRepliesRow(
        'answered',
        [
          {
            id: 'email-ack',
            senderName: '',
            senderEmail: null,
            receivedAt: repliedAt,
            snippet: 'Received, will revert',
            classifications: [],
          },
        ],
        1,
      ),
    ]);
    const [rfqMailWithReplies] = await createPrismaSentMailRepository(prismaClient).listRfqMails(
      scope,
      'rfq-1',
    );
    expect(rfqMailWithReplies?.replies.latest).toEqual({
      emailId: 'email-ack',
      senderName: '',
      senderEmail: null,
      receivedAt: repliedAt,
      snippet: 'Received, will revert',
      classification: null,
    });
  });
});
