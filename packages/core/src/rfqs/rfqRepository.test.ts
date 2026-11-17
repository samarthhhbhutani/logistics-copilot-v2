import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../db/prismaClient.js';
import { createPrismaRfqRepository, toRfqListItem } from './rfqRepository.js';

const scope = { tenantId: 'tenant-1', mailboxId: 'mailbox-1' };
const createdAt = new Date('2026-11-16T08:00:00Z');

const rfqRow = {
  id: 'rfq-1',
  sourceEmailId: 'email-1',
  originPort: 'Hazira, India',
  destinationPort: 'Jebel Ali, UAE',
  incoterm: 'FOB',
  status: 'OPEN',
  createdAt,
  updatedAt: createdAt,
};

/** Answers rfq.findFirst with the given row and records the arguments used. */
function stubFindFirst(row: Record<string, unknown> | null) {
  const calls: Record<string, unknown>[] = [];
  const prismaClient = {
    rfq: {
      async findFirst(args: Record<string, unknown>) {
        calls.push(args);
        return row;
      },
    },
  } as unknown as PrismaClient;
  return { prismaClient, calls };
}

describe('findRfqBySourceEmail', () => {
  it('looks the newest RFQ up by its source mail within the mailbox and tenant', async () => {
    const { prismaClient, calls } = stubFindFirst(rfqRow);
    const rfq = await createPrismaRfqRepository(prismaClient).findRfqBySourceEmail(
      scope,
      'email-1',
    );
    expect(rfq).toEqual({ ...rfqRow, status: 'open' });
    expect(calls[0]?.where).toEqual({ sourceEmailId: 'email-1', ...scope });
    expect(calls[0]?.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('finds nothing when no RFQ was sent from the mail', async () => {
    const { prismaClient } = stubFindFirst(null);
    const rfq = await createPrismaRfqRepository(prismaClient).findRfqBySourceEmail(
      scope,
      'email-without-rfq',
    );
    expect(rfq).toBeUndefined();
  });
});

/** Answers rfq.findMany with the given rows and records the arguments used. */
function stubFindMany(rows: Record<string, unknown>[]) {
  const calls: Record<string, unknown>[] = [];
  const prismaClient = {
    rfq: {
      async findMany(args: Record<string, unknown>) {
        calls.push(args);
        return rows;
      },
    },
  } as unknown as PrismaClient;
  return { prismaClient, calls };
}

const sourceEmailRow = {
  id: 'email-1',
  senderName: 'Ravi Kumar',
  senderEmail: 'ravi@acme.com',
  subject: 'RFQ: 2 x 20ft India to UAE',
  receivedAt: new Date('2026-11-10T10:00:00Z'),
};
const quoteClassification = {
  label: 'VENDOR_QUOTE',
  source: 'LLM',
  confidence: 0.9,
  createdAt: new Date('2026-11-16T09:31:00Z'),
};
const replyClassification = { ...quoteClassification, label: 'VENDOR_REPLY' };

describe('listRfqs', () => {
  it("pages newest first within the mailbox and tenant, pulling the source mail and each mail's newest reply along", async () => {
    const { prismaClient, calls } = stubFindMany([]);
    await createPrismaRfqRepository(prismaClient).listRfqs(scope, { limit: 26 });
    expect(calls[0]?.where).toEqual(scope);
    expect(calls[0]?.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(calls[0]?.take).toBe(26);
    expect(calls[0]?.select).toMatchObject({
      sourceEmail: { select: { id: true, senderName: true, subject: true, receivedAt: true } },
      sentMails: {
        select: {
          status: true,
          repliesReceived: { orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }], take: 1 },
        },
      },
    });
  });

  it('continues strictly after the cursor position in (created_at, id) order', async () => {
    const { prismaClient, calls } = stubFindMany([]);
    await createPrismaRfqRepository(prismaClient).listRfqs(scope, {
      limit: 10,
      before: { createdAt, id: 'rfq-5' },
    });
    expect(calls[0]?.where).toEqual({
      ...scope,
      OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: 'rfq-5' } }],
    });
  });

  it('counts vendors, not messages: failed mails are left out, a replied contact counts once, a quote is the newest reply saying so', () => {
    const rfqListItem = toRfqListItem({
      ...rfqRow,
      status: 'OPEN',
      sourceEmail: sourceEmailRow,
      sentMails: [
        // Quoted: two replies, the newest a quote.
        { status: 'SENT', repliesReceived: [{ classifications: [quoteClassification] }] },
        // Replied but the newest reply is not a quote.
        { status: 'SENT', repliesReceived: [{ classifications: [replyClassification] }] },
        // Replied, not yet classified.
        { status: 'SENT', repliesReceived: [{ classifications: [] }] },
        // Not reached: never counted.
        { status: 'FAILED', repliesReceived: [] },
        { status: 'PENDING', repliesReceived: [] },
      ],
    });
    expect(rfqListItem).toEqual({
      rfq: { ...rfqRow, status: 'open' },
      sourceEmail: sourceEmailRow,
      replies: { contactCount: 4, repliedCount: 3, quoteCount: 1 },
    });
  });
});
