import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../db/prismaClient.js';
import { createPrismaReplyAttachmentRepository } from './replyAttachmentRepository.js';

const scope = { tenantId: 'tenant-1', mailboxId: 'mailbox-1' };
const rateCardId = '00000000-0000-4000-8000-00000000000a';
const photoId = '00000000-0000-4000-8000-00000000000b';
const sentMailId = '00000000-0000-4000-8000-000000000050';
const rateCardToCreate = {
  id: rateCardId,
  fileName: 'Rate card Q4.pdf',
  contentType: 'application/pdf',
  sizeBytes: 120_000,
  sha256: 'a'.repeat(64),
  s3Key: `tenant-1/outbound/mailbox-1/${rateCardId}`,
};
const rateCardRow = {
  ...rateCardToCreate,
  sentMailId: null,
  createdAt: new Date('2026-11-22T10:00:00Z'),
};
const photoRow = {
  ...rateCardRow,
  id: photoId,
  fileName: 'container.jpg',
  contentType: 'image/jpeg',
};

/** Records every Prisma call's arguments and answers from a script, so the where-clauses (the real isolation) are asserted. */
function createPrismaStub(answers: {
  findMany?: unknown;
  findFirst?: unknown;
  create?: unknown;
  updateMany?: unknown;
  deleteMany?: unknown;
}) {
  const calls: { method: string; args: unknown }[] = [];
  const record = (method: string, result: unknown) => async (args: unknown) => {
    calls.push({ method, args });
    return result;
  };
  const stub = {
    replyAttachment: {
      findMany: record('findMany', answers.findMany ?? []),
      findFirst: record('findFirst', answers.findFirst ?? null),
      create: record('create', answers.create),
      updateMany: record('updateMany', answers.updateMany ?? { count: 0 }),
      deleteMany: record('deleteMany', answers.deleteMany ?? { count: 0 }),
    },
  };
  return { prismaClient: stub as unknown as PrismaClient, calls };
}

describe('createPrismaReplyAttachmentRepository', () => {
  it('creates with the scope columns set by the repository, not the caller', async () => {
    const { prismaClient, calls } = createPrismaStub({ create: rateCardRow });
    const created = await createPrismaReplyAttachmentRepository(prismaClient).createReplyAttachment(
      scope,
      rateCardToCreate,
    );
    expect(created).toEqual(rateCardRow);
    expect(calls).toEqual([
      {
        method: 'create',
        args: expect.objectContaining({
          data: { ...rateCardToCreate, mailboxId: 'mailbox-1', tenantId: 'tenant-1' },
        }),
      },
    ]);
  });

  it('finds by id inside the scope, in the order asked, skipping unknown ids and not querying for none', async () => {
    const { prismaClient, calls } = createPrismaStub({ findMany: [rateCardRow, photoRow] });
    const repository = createPrismaReplyAttachmentRepository(prismaClient);
    expect(await repository.findReplyAttachments(scope, [])).toEqual([]);
    expect(calls).toEqual([]);

    const found = await repository.findReplyAttachments(scope, [photoId, 'unknown', rateCardId]);
    expect(found).toEqual([photoRow, rateCardRow]);
    expect(calls[0]?.args).toEqual(
      expect.objectContaining({
        where: {
          mailboxId: 'mailbox-1',
          tenantId: 'tenant-1',
          id: { in: [photoId, 'unknown', rateCardId] },
        },
      }),
    );
  });

  it('lists the files of one sent mail inside the scope, oldest first', async () => {
    const { prismaClient, calls } = createPrismaStub({ findMany: [rateCardRow] });
    await createPrismaReplyAttachmentRepository(prismaClient).listReplyAttachmentsOfSentMail(
      scope,
      sentMailId,
    );
    expect(calls[0]?.args).toEqual(
      expect.objectContaining({
        where: { mailboxId: 'mailbox-1', tenantId: 'tenant-1', sentMailId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  it('stamps only unsent files of the mailbox with the sent mail and reports how many changed', async () => {
    const { prismaClient, calls } = createPrismaStub({ updateMany: { count: 1 } });
    const repository = createPrismaReplyAttachmentRepository(prismaClient);
    expect(await repository.attachToSentMail(scope, [], sentMailId)).toBe(0);
    expect(calls).toEqual([]);

    expect(await repository.attachToSentMail(scope, [rateCardId, photoId], sentMailId)).toBe(1);
    expect(calls).toEqual([
      {
        method: 'updateMany',
        args: {
          where: {
            mailboxId: 'mailbox-1',
            tenantId: 'tenant-1',
            id: { in: [rateCardId, photoId] },
            sentMailId: null,
          },
          data: { sentMailId },
        },
      },
    ]);
  });

  it('deletes only an unsent file inside the scope and reports it; undefined otherwise', async () => {
    const unsent = createPrismaStub({ findFirst: rateCardRow, deleteMany: { count: 1 } });
    expect(
      await createPrismaReplyAttachmentRepository(unsent.prismaClient).deleteUnsentReplyAttachment(
        scope,
        rateCardId,
      ),
    ).toEqual(rateCardRow);
    expect(unsent.calls.map((call) => call.method)).toEqual(['findFirst', 'deleteMany']);
    expect(unsent.calls[1]?.args).toEqual({
      where: { id: rateCardId, mailboxId: 'mailbox-1', tenantId: 'tenant-1', sentMailId: null },
    });

    // Already on a mail, or another mailbox's: the scoped findFirst finds nothing and nothing is deleted.
    const sentOrNotOurs = createPrismaStub({ findFirst: null });
    expect(
      await createPrismaReplyAttachmentRepository(
        sentOrNotOurs.prismaClient,
      ).deleteUnsentReplyAttachment(scope, rateCardId),
    ).toBeUndefined();
    expect(sentOrNotOurs.calls.map((call) => call.method)).toEqual(['findFirst']);
  });
});
