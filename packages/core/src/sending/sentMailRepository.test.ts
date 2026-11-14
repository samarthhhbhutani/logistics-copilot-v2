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
