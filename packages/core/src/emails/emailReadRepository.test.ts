import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../db/prismaClient.js';
import { createPrismaEmailReadRepository } from './emailReadRepository.js';

const scope = { mailboxId: 'mailbox-1', tenantId: 'tenant-1' };

/** Answers email.findMany / findFirst with the given rows and records the where/order used. */
function stubPrisma(rows: unknown[], rawIdRows: { id: string }[] = []) {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  const rawQueries: { sql: string; values: unknown[] }[] = [];
  const prismaClient = {
    async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      rawQueries.push({ sql: strings.join('?'), values });
      return rawIdRows;
    },
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
  return { prismaClient, calls, rawQueries };
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
  gmailMessageId: 'gm-1',
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

describe('listEmails', () => {
  it('selects only the current classification with the scoped page, without bodies or per-email reads', async () => {
    const { prismaClient, calls } = stubPrisma([
      detailRow,
      { ...detailRow, id: 'email-2', classifications: [] },
    ]);
    const before = { receivedAt: new Date('2026-11-11T10:00:00Z'), id: 'email-9' };
    const emails = await createPrismaEmailReadRepository(prismaClient).listEmails(scope, {
      limit: 31,
      gmailLabel: 'inbox',
      before,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'findMany',
      args: {
        where: {
          ...scope,
          gmailLabel: 'INBOX',
          OR: [
            { receivedAt: { lt: before.receivedAt } },
            { receivedAt: before.receivedAt, id: { lt: before.id } },
          ],
        },
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        take: 31,
        select: { classifications: currentClassificationSelect },
      },
    });
    expect(calls[0]?.args.select).not.toHaveProperty('bodyText');
    expect(calls[0]?.args.select).not.toHaveProperty('bodyHtml');
    expect(emails[0]?.classification).toEqual({
      label: 'customer_reply',
      source: 'thread',
      confidence: null,
      classifiedAt: new Date('2026-11-10T10:00:05Z'),
    });
    expect(emails[1]?.classification).toBeNull();
    expect(emails[0]).not.toHaveProperty('bodyText');
  });

  it('filters by the current classification with one DISTINCT ON query for the page ids, then reads only those', async () => {
    const { prismaClient, calls, rawQueries } = stubPrisma([detailRow], [{ id: 'email-1' }]);
    const before = { receivedAt: new Date('2026-11-11T10:00:00Z'), id: 'email-9' };
    const emails = await createPrismaEmailReadRepository(prismaClient).listEmails(scope, {
      limit: 31,
      gmailLabel: 'inbox',
      classification: 'customer_request',
      before,
    });

    expect(rawQueries).toHaveLength(1);
    const [rawQuery] = rawQueries;
    expect(rawQuery?.sql).toMatch(
      /SELECT DISTINCT ON \(classification\.email_id\)[\s\S]*ORDER BY classification\.email_id, classification\.classified_at DESC, classification\.id DESC/,
    );
    expect(rawQuery?.sql).toMatch(/current_classification\.label = \?::classification_label/);
    expect(rawQuery?.sql).toMatch(/ORDER BY email\.received_at DESC, email\.id DESC\s+LIMIT \?/);
    expect(rawQuery?.values).toEqual([
      'tenant-1',
      'mailbox-1',
      'tenant-1',
      'customer_request',
      expect.anything(),
      expect.anything(),
      31,
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'findMany',
      args: {
        where: { ...scope, id: { in: ['email-1'] }, gmailLabel: 'INBOX' },
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        take: 31,
      },
    });
    expect(emails.map((email) => email.id)).toEqual(['email-1']);
  });

  it('does not read mail when no mail carries the classification', async () => {
    const { prismaClient, calls, rawQueries } = stubPrisma([detailRow], []);
    const emails = await createPrismaEmailReadRepository(prismaClient).listEmails(scope, {
      limit: 31,
      classification: 'rate_card',
    });
    expect(rawQueries).toHaveLength(1);
    expect(calls).toHaveLength(0);
    expect(emails).toEqual([]);
  });
});

describe('findEmail and listThreadEmails', () => {
  it('maps enums to snake_case, the newest classification to the current one, and bad jsonb to no recipients', async () => {
    const { prismaClient, calls } = stubPrisma([detailRow]);
    const repository = createPrismaEmailReadRepository(prismaClient);

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
      gmailMessageId: 'gm-1',
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
      await createPrismaEmailReadRepository(prismaClient).findEmail(scope, 'email-9'),
    ).toBeUndefined();
  });
});
