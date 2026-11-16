import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../db/prismaClient.js';
import { createPrismaRfqRepository } from './rfqRepository.js';

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
