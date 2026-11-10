import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../db/prismaClient.js';
import { createPrismaEmailIngestRepository } from './emailIngestRepository.js';
import type { NewEmail } from './emailIngestRepository.js';

const scope = { tenantId: 'tenant-1', mailboxId: 'mailbox-1' };

/** Answers email.findMany with the given rows and records the arguments used. */
function stubFindMany(rows: unknown[]) {
  const calls: Record<string, unknown>[] = [];
  const prismaClient = {
    email: {
      async findMany(args: Record<string, unknown>) {
        calls.push(args);
        return rows;
      },
    },
  } as unknown as PrismaClient;
  return { prismaClient, calls };
}

/** What findThreadContext asks Prisma for under `classifications`: the parent email's newest row, deterministically. */
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
    const { prismaClient, calls } = stubFindMany([]);
    const context = await createPrismaEmailIngestRepository(prismaClient).findThreadContext(
      scope,
      '1a1c',
      newMailReceivedAt,
    );
    expect(context).toEqual({ hasStoredEmail: false, currentLabels: [] });
    expect(calls[0]?.where).toEqual({ ...scope, gmailThreadId: '1a1c' });
    expect(calls[0]?.select).toEqual({
      receivedAt: true,
      classifications: currentClassificationSelect,
    });
  });

  it('collects the current label of each earlier message, skipping unclassified ones', async () => {
    const { prismaClient } = stubFindMany([
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
    const context = await createPrismaEmailIngestRepository(prismaClient).findThreadContext(
      scope,
      '1a1c',
      newMailReceivedAt,
    );
    expect(context).toEqual({
      hasStoredEmail: true,
      currentLabels: ['customer_request', 'general'],
    });
  });

  it('takes the newest row per message, so an operator correction (source USER) overrides what the model said', async () => {
    const { prismaClient } = stubFindMany([
      {
        receivedAt: earlier,
        // Prisma applies orderBy desc + take 1 server-side; the stub hands back what that returns: the user row.
        classifications: [
          {
            label: 'CUSTOMER_REQUEST',
            source: 'USER',
            confidence: null,
            classifiedAt: new Date('2026-11-10T11:30:00Z'),
          },
        ],
      },
    ]);
    const context = await createPrismaEmailIngestRepository(prismaClient).findThreadContext(
      scope,
      '1a1c',
      newMailReceivedAt,
    );
    expect(context.currentLabels).toEqual(['customer_request']);
  });

  it('ignores the label of a message received after the new one, but still counts it as stored', async () => {
    const { prismaClient } = stubFindMany([
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
    const context = await createPrismaEmailIngestRepository(prismaClient).findThreadContext(
      scope,
      '1a1c',
      newMailReceivedAt,
    );
    expect(context).toEqual({ hasStoredEmail: true, currentLabels: [] });
  });
});

const newEmail: NewEmail = {
  ...scope,
  gmailMessageId: 'gm-1',
  gmailThreadId: 'thread-1',
  gmailLabel: 'inbox',
  rfcMessageId: undefined,
  senderName: 'Ravi',
  senderEmail: 'ravi@acme.com',
  toRecipients: [],
  ccRecipients: [],
  subject: 'Rate card',
  snippet: '',
  bodyText: 'see attached',
  bodyHtml: undefined,
  rawEmailS3Key: 'tenant-1/mailbox-1/gm-1.eml',
  receivedAt: new Date('2026-11-09T12:00:00Z'),
};
const storedAttachment = {
  fileName: 'rate-card.pdf',
  contentType: 'application/pdf',
  sizeBytes: 10,
  sha256: 'ab'.repeat(32),
  s3Key: `tenant-1/attachments/${'ab'.repeat(32)}`,
  contentId: undefined,
  isInline: false,
};

const DATABASE_GENERATED_EMAIL_ID = '7f6c1b2e-3d4a-4b5c-8d9e-0f1a2b3c4d5e';

/** A transaction stub: the callback gets a client whose insert calls are recorded; a thrown error propagates. */
function createTransactionStub(emailAlreadyExists: boolean, attachmentError?: Error) {
  const calls: { model: string; args: { data: unknown } }[] = [];
  const transactionClient = {
    email: {
      // INSERT ... ON CONFLICT DO NOTHING RETURNING id: no rows when the email was already there.
      createManyAndReturn: async (args: { data: unknown }) => {
        calls.push({ model: 'email', args });
        return emailAlreadyExists ? [] : [{ id: DATABASE_GENERATED_EMAIL_ID }];
      },
    },
    attachment: {
      createMany: async (args: { data: unknown }) => {
        calls.push({ model: 'attachment', args });
        if (attachmentError) throw attachmentError;
        return { count: 1 };
      },
    },
    classification: {
      create: async (args: { data: unknown }) => {
        calls.push({ model: 'classification', args });
        return args.data;
      },
    },
  };
  const prismaClient = {
    $transaction: async (callback: (client: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient),
  } as unknown as PrismaClient;
  return { prismaClient, calls };
}

describe('insertEmailIfAbsent', () => {
  it('inserts the attachment rows with the returned email id and the same tenant', async () => {
    const { prismaClient, calls } = createTransactionStub(false);

    const inserted = await createPrismaEmailIngestRepository(prismaClient).insertEmailIfAbsent(
      newEmail,
      [storedAttachment],
    );

    expect(inserted).toBe(true);
    expect(calls.map((call) => call.model)).toEqual(['email', 'attachment']);
    const emailData = calls[0]!.args.data as { id?: string; tenantId: string };
    const attachmentData = calls[1]!.args.data as {
      emailId: string;
      tenantId: string;
      contentId: null;
    }[];
    expect(emailData.id).toBeUndefined();
    expect(attachmentData).toEqual([
      expect.objectContaining({
        emailId: DATABASE_GENERATED_EMAIL_ID,
        tenantId: 'tenant-1',
        contentId: null,
        s3Key: storedAttachment.s3Key,
      }),
    ]);
  });

  it('skips the attachment rows and reports false when the email already existed', async () => {
    const { prismaClient, calls } = createTransactionStub(true);

    const inserted = await createPrismaEmailIngestRepository(prismaClient).insertEmailIfAbsent(
      newEmail,
      [storedAttachment],
    );

    expect(inserted).toBe(false);
    expect(calls.map((call) => call.model)).toEqual(['email']);
  });

  it('does not touch the attachment table for a mail without attachments', async () => {
    const { prismaClient, calls } = createTransactionStub(false);
    expect(
      await createPrismaEmailIngestRepository(prismaClient).insertEmailIfAbsent(newEmail, []),
    ).toBe(true);
    expect(calls.map((call) => call.model)).toEqual(['email']);
  });

  it('writes the rule classification in the same transaction, after the email and attachments', async () => {
    const { prismaClient, calls } = createTransactionStub(false);

    const inserted = await createPrismaEmailIngestRepository(prismaClient).insertEmailIfAbsent(
      newEmail,
      [storedAttachment],
      { source: 'rule', label: 'customer_request', ruleId: 'rule-1' },
    );

    expect(inserted).toBe(true);
    expect(calls.map((call) => call.model)).toEqual(['email', 'attachment', 'classification']);
    expect(calls[2]!.args.data).toEqual({
      tenantId: 'tenant-1',
      emailId: DATABASE_GENERATED_EMAIL_ID,
      label: 'CUSTOMER_REQUEST',
      source: 'RULE',
      ruleId: 'rule-1',
    });
  });

  it('writes an LLM classification with model, prompt version and confidence, no rule', async () => {
    const { prismaClient, calls } = createTransactionStub(false);

    const inserted = await createPrismaEmailIngestRepository(prismaClient).insertEmailIfAbsent(
      newEmail,
      [],
      {
        source: 'llm',
        label: 'rate_card',
        confidence: 0.87,
        llmModel: 'gpt-test-2026',
        promptVersion: 'classify-email-v1',
      },
    );

    expect(inserted).toBe(true);
    expect(calls.map((call) => call.model)).toEqual(['email', 'classification']);
    expect(calls[1]!.args.data).toEqual({
      tenantId: 'tenant-1',
      emailId: DATABASE_GENERATED_EMAIL_ID,
      label: 'RATE_CARD',
      source: 'LLM',
      llmModel: 'gpt-test-2026',
      promptVersion: 'classify-email-v1',
      confidence: 0.87,
    });
  });

  it('writes a thread-derived classification with no rule, model or confidence', async () => {
    const { prismaClient, calls } = createTransactionStub(false);

    const inserted = await createPrismaEmailIngestRepository(prismaClient).insertEmailIfAbsent(
      newEmail,
      [],
      { source: 'thread', label: 'customer_reply' },
    );

    expect(inserted).toBe(true);
    expect(calls.map((call) => call.model)).toEqual(['email', 'classification']);
    expect(calls[1]!.args.data).toEqual({
      tenantId: 'tenant-1',
      emailId: DATABASE_GENERATED_EMAIL_ID,
      label: 'CUSTOMER_REPLY',
      source: 'THREAD',
    });
  });

  it('writes no classification when the email already existed, even if a rule matched', async () => {
    const { prismaClient, calls } = createTransactionStub(true);

    const inserted = await createPrismaEmailIngestRepository(prismaClient).insertEmailIfAbsent(
      newEmail,
      [],
      { source: 'rule', label: 'customer_request', ruleId: 'rule-1' },
    );

    expect(inserted).toBe(false);
    expect(calls.map((call) => call.model)).toEqual(['email']);
  });

  it('lets an attachment insert failure propagate so the transaction rolls the email back', async () => {
    const { prismaClient } = createTransactionStub(false, new Error('connection reset'));
    await expect(
      createPrismaEmailIngestRepository(prismaClient).insertEmailIfAbsent(newEmail, [
        storedAttachment,
      ]),
    ).rejects.toThrow('connection reset');
  });
});
