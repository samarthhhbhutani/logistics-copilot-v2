import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../db/prismaClient.js';
import { createPrismaAttachmentRepository } from './attachmentRepository.js';
import { createPrismaEmailRepository } from './emailRepository.js';
import type { NewEmail } from './emailRepository.js';

const scope = { tenantId: 'tenant-1', mailboxId: 'mailbox-1' };
const emailId = '00000000-0000-4000-8000-000000000001';
const attachmentId = '00000000-0000-4000-8000-00000000000a';

const attachmentRow = {
  id: attachmentId,
  emailId,
  fileName: 'rate-card.pdf',
  contentType: 'application/pdf',
  sizeBytes: 10,
  sha256: 'ab'.repeat(32),
  s3Key: `tenant-1/attachments/${'ab'.repeat(32)}`,
  contentId: null,
  isInline: false,
};

/** Records every Prisma call's arguments and answers from a script, so the where-clauses (the real isolation) are asserted. */
function createPrismaStub(answers: { emailFindFirst?: unknown; attachmentFindFirst?: unknown }) {
  const calls: { model: string; method: string; args: unknown }[] = [];
  const record = (model: string, method: string, result: unknown) => async (args: unknown) => {
    calls.push({ model, method, args });
    return result;
  };
  const stub = {
    email: { findFirst: record('email', 'findFirst', answers.emailFindFirst) },
    attachment: { findFirst: record('attachment', 'findFirst', answers.attachmentFindFirst) },
  };
  return { prismaClient: stub as unknown as PrismaClient, calls };
}

describe('createPrismaAttachmentRepository', () => {
  it('lists through the email so mailbox and tenant are both checked, and keeps tenant_id on the rows', async () => {
    const { prismaClient, calls } = createPrismaStub({
      emailFindFirst: { attachments: [attachmentRow] },
    });

    const attachments = await createPrismaAttachmentRepository(prismaClient).listAttachments(
      scope,
      emailId,
    );

    expect(attachments).toEqual([{ ...attachmentRow, contentId: undefined }]);
    expect(calls).toEqual([
      {
        model: 'email',
        method: 'findFirst',
        args: expect.objectContaining({
          where: { id: emailId, mailboxId: 'mailbox-1', tenantId: 'tenant-1' },
          select: { attachments: expect.objectContaining({ where: { tenantId: 'tenant-1' } }) },
        }),
      },
    ]);
  });

  it("returns undefined, not an empty list, when the email is not the caller's", async () => {
    const { prismaClient } = createPrismaStub({ emailFindFirst: null });
    expect(
      await createPrismaAttachmentRepository(prismaClient).listAttachments(scope, emailId),
    ).toBeUndefined();
  });

  it("finds one attachment only inside the caller's email, mailbox and tenant", async () => {
    const { prismaClient, calls } = createPrismaStub({ attachmentFindFirst: attachmentRow });

    const found = await createPrismaAttachmentRepository(prismaClient).findAttachment(
      scope,
      emailId,
      attachmentId,
    );

    expect(found?.id).toBe(attachmentId);
    expect(calls[0]?.args).toEqual(
      expect.objectContaining({
        where: {
          id: attachmentId,
          tenantId: 'tenant-1',
          email: { id: emailId, mailboxId: 'mailbox-1', tenantId: 'tenant-1' },
        },
      }),
    );
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
  };
  const prismaClient = {
    $transaction: async (callback: (client: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient),
  } as unknown as PrismaClient;
  return { prismaClient, calls };
}

describe('createPrismaEmailRepository.insertEmailIfAbsent', () => {
  it('inserts the attachment rows with the returned email id and the same tenant', async () => {
    const { prismaClient, calls } = createTransactionStub(false);

    const inserted = await createPrismaEmailRepository(prismaClient).insertEmailIfAbsent(newEmail, [
      storedAttachment,
    ]);

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

    const inserted = await createPrismaEmailRepository(prismaClient).insertEmailIfAbsent(newEmail, [
      storedAttachment,
    ]);

    expect(inserted).toBe(false);
    expect(calls.map((call) => call.model)).toEqual(['email']);
  });

  it('does not touch the attachment table for a mail without attachments', async () => {
    const { prismaClient, calls } = createTransactionStub(false);
    expect(await createPrismaEmailRepository(prismaClient).insertEmailIfAbsent(newEmail, [])).toBe(
      true,
    );
    expect(calls.map((call) => call.model)).toEqual(['email']);
  });

  it('lets an attachment insert failure propagate so the transaction rolls the email back', async () => {
    const { prismaClient } = createTransactionStub(false, new Error('connection reset'));
    await expect(
      createPrismaEmailRepository(prismaClient).insertEmailIfAbsent(newEmail, [storedAttachment]),
    ).rejects.toThrow('connection reset');
  });
});
