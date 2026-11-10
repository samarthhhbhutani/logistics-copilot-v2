import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../db/prismaClient.js';
import { createPrismaAttachmentRepository } from './attachmentRepository.js';

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
