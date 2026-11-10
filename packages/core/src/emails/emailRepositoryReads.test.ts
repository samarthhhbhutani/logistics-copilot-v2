import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../db/prismaClient.js';
import { createPrismaEmailRepository } from './emailRepository.js';

const scope = { mailboxId: 'mailbox-1', tenantId: 'tenant-1' };

/** Answers email.findMany / findFirst with the given rows and records the where/order used. */
function stubPrisma(rows: unknown[]) {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const prismaClient = {
    email: {
      async findMany(args: Record<string, unknown>) {
        calls.push({ method: 'findMany', args });
        return rows;
      },
      async findFirst(args: Record<string, unknown>) {
        calls.push({ method: 'findFirst', args });
        return rows[0] ?? null;
      },
    },
  } as unknown as PrismaClient;
  return { prismaClient, calls };
}

const detailRow = {
  id: 'email-1',
  gmailThreadId: '1a1c',
  gmailLabel: 'INBOX',
  senderName: 'Ravi Kumar',
  senderEmail: 'ravi@acme.com',
  toRecipients: [{ name: '', address: 'ops@desk.com' }],
  ccRecipients: 'not an array',
  subject: 'RFQ',
  snippet: 'Need a quote',
  receivedAt: new Date('2026-11-10T10:00:00Z'),
  rfcMessageId: null,
  bodyText: 'Need a quote.',
  bodyHtml: null,
  classifications: [
    {
      label: 'CUSTOMER_REPLY',
      source: 'THREAD',
      confidence: null,
      classifiedAt: new Date('2026-11-10T10:00:05Z'),
    },
  ],
};

/** What every read asks Prisma for under `classifications`: the parent email's newest row, deterministically. */
const currentClassificationSelect = {
  orderBy: [{ classifiedAt: 'desc' }, { id: 'desc' }],
  take: 1,
  select: { label: true, source: true, confidence: true, classifiedAt: true },
};

const newMailReceivedAt = new Date('2026-11-10T12:00:00Z');
const earlier = new Date('2026-11-10T11:00:00Z');
const later = new Date('2026-11-10T13:00:00Z');

describe('findThreadContext', () => {
  it('reports an unknown thread as not stored with no labels', async () => {
    const { prismaClient, calls } = stubPrisma([]);
    const context = await createPrismaEmailRepository(prismaClient).findThreadContext(
      scope,
      '1a1c',
      newMailReceivedAt,
    );
    expect(context).toEqual({ hasStoredEmail: false, currentLabels: [] });
    expect(calls[0]?.args.where).toEqual({ ...scope, gmailThreadId: '1a1c' });
    expect(calls[0]?.args.select).toEqual({
      receivedAt: true,
      classifications: currentClassificationSelect,
    });
  });

  it('collects the current label of each earlier message, skipping unclassified ones', async () => {
    const { prismaClient } = stubPrisma([
      {
        receivedAt: earlier,
        classifications: [
          { label: 'CUSTOMER_REQUEST', source: 'LLM', confidence: 0.9, classifiedAt: new Date() },
        ],
      },
      { receivedAt: earlier, classifications: [] },
      {
        receivedAt: earlier,
        classifications: [
          { label: 'GENERAL', source: 'RULE', confidence: null, classifiedAt: new Date() },
        ],
      },
    ]);
    const context = await createPrismaEmailRepository(prismaClient).findThreadContext(
      scope,
      '1a1c',
      newMailReceivedAt,
    );
    expect(context).toEqual({
      hasStoredEmail: true,
      currentLabels: ['customer_request', 'general'],
    });
  });

  it('ignores the label of a message received after the new one, but still counts it as stored', async () => {
    const { prismaClient } = stubPrisma([
      {
        receivedAt: later,
        classifications: [
          { label: 'CUSTOMER_REQUEST', source: 'RULE', confidence: null, classifiedAt: new Date() },
        ],
      },
      {
        receivedAt: newMailReceivedAt,
        classifications: [
          { label: 'CUSTOMER_REQUEST', source: 'RULE', confidence: null, classifiedAt: new Date() },
        ],
      },
    ]);
    const context = await createPrismaEmailRepository(prismaClient).findThreadContext(
      scope,
      '1a1c',
      newMailReceivedAt,
    );
    expect(context).toEqual({ hasStoredEmail: true, currentLabels: [] });
  });
});

describe('findEmail and listThreadEmails', () => {
  it('maps enums to snake_case, the newest classification to the current one, and bad jsonb to no recipients', async () => {
    const { prismaClient, calls } = stubPrisma([detailRow]);
    const repository = createPrismaEmailRepository(prismaClient);

    const email = await repository.findEmail(scope, 'email-1');
    expect(email).toEqual({
      id: 'email-1',
      gmailThreadId: '1a1c',
      gmailLabel: 'inbox',
      senderName: 'Ravi Kumar',
      senderEmail: 'ravi@acme.com',
      toRecipients: [{ name: '', address: 'ops@desk.com' }],
      ccRecipients: [],
      subject: 'RFQ',
      snippet: 'Need a quote',
      receivedAt: new Date('2026-11-10T10:00:00Z'),
      rfcMessageId: null,
      bodyText: 'Need a quote.',
      bodyHtml: null,
      classification: {
        label: 'customer_reply',
        source: 'thread',
        confidence: null,
        classifiedAt: new Date('2026-11-10T10:00:05Z'),
      },
    });
    expect(calls[0]?.args.where).toEqual({ id: 'email-1', ...scope });
    expect((calls[0]?.args.select as { classifications: unknown }).classifications).toEqual(
      currentClassificationSelect,
    );

    const thread = await repository.listThreadEmails(scope, '1a1c');
    expect(thread).toHaveLength(1);
    expect(calls[1]?.args.where).toEqual({ ...scope, gmailThreadId: '1a1c' });
    expect(calls[1]?.args.orderBy).toEqual([{ receivedAt: 'asc' }, { id: 'asc' }]);
    expect((calls[1]?.args.select as { classifications: unknown }).classifications).toEqual(
      currentClassificationSelect,
    );
  });

  it('returns undefined when the email is not in the scope', async () => {
    const { prismaClient } = stubPrisma([]);
    expect(
      await createPrismaEmailRepository(prismaClient).findEmail(scope, 'email-9'),
    ).toBeUndefined();
  });
});
