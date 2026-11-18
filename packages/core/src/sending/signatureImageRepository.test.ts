import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../db/prismaClient.js';
import { createPrismaSignatureImageRepository } from './signatureImageRepository.js';

const scope = { tenantId: 'tenant-1', mailboxId: 'mailbox-1' };
const logoId = '00000000-0000-4000-8000-00000000000a';
const badgeId = '00000000-0000-4000-8000-00000000000b';
const logoRow = {
  id: logoId,
  fileName: 'logo.png',
  contentType: 'image/png',
  sizeBytes: 10,
  s3Key: `signatures/mailbox-1/${logoId}`,
  createdAt: new Date('2026-11-19T00:00:00Z'),
};
const badgeRow = { ...logoRow, id: badgeId, fileName: 'badge.gif', contentType: 'image/gif' };

/** Records every Prisma call's arguments and answers from a script, so the where-clauses (the real isolation) are asserted. */
function createPrismaStub(answers: {
  findMany?: unknown;
  findFirst?: unknown;
  create?: unknown;
  deleteMany?: unknown;
}) {
  const calls: { method: string; args: unknown }[] = [];
  const record = (method: string, result: unknown) => async (args: unknown) => {
    calls.push({ method, args });
    return result;
  };
  const stub = {
    signatureImage: {
      findMany: record('findMany', answers.findMany ?? []),
      findFirst: record('findFirst', answers.findFirst ?? null),
      create: record('create', answers.create),
      deleteMany: record('deleteMany', answers.deleteMany ?? { count: 0 }),
    },
  };
  return { prismaClient: stub as unknown as PrismaClient, calls };
}

describe('createPrismaSignatureImageRepository', () => {
  it('lists the mailbox and tenant only, oldest first', async () => {
    const { prismaClient, calls } = createPrismaStub({ findMany: [logoRow, badgeRow] });
    const images =
      await createPrismaSignatureImageRepository(prismaClient).listSignatureImages(scope);
    expect(images).toEqual([logoRow, badgeRow]);
    expect(calls).toEqual([
      {
        method: 'findMany',
        args: expect.objectContaining({
          where: { mailboxId: 'mailbox-1', tenantId: 'tenant-1' },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      },
    ]);
  });

  it('finds by id inside the scope, in the order asked, skipping unknown ids and not querying for none', async () => {
    const { prismaClient, calls } = createPrismaStub({ findMany: [logoRow, badgeRow] });
    const repository = createPrismaSignatureImageRepository(prismaClient);
    expect(await repository.findSignatureImages(scope, [badgeId, 'missing', logoId])).toEqual([
      badgeRow,
      logoRow,
    ]);
    expect(calls[0]?.args).toEqual(
      expect.objectContaining({
        where: {
          mailboxId: 'mailbox-1',
          tenantId: 'tenant-1',
          id: { in: [badgeId, 'missing', logoId] },
        },
      }),
    );
    expect(await repository.findSignatureImages(scope, [])).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('creates with the scope columns set by the repository, not the caller', async () => {
    const { prismaClient, calls } = createPrismaStub({ create: logoRow });
    const imageToCreate = {
      id: logoRow.id,
      fileName: logoRow.fileName,
      contentType: logoRow.contentType,
      sizeBytes: logoRow.sizeBytes,
      s3Key: logoRow.s3Key,
    };
    const created = await createPrismaSignatureImageRepository(prismaClient).createSignatureImage(
      scope,
      imageToCreate,
    );
    expect(created).toEqual(logoRow);
    expect(calls[0]?.args).toEqual(
      expect.objectContaining({
        data: { ...imageToCreate, mailboxId: 'mailbox-1', tenantId: 'tenant-1' },
      }),
    );
  });

  it("deletes only inside the scope and reports the removed row; undefined when it is not the caller's", async () => {
    const found = createPrismaStub({ findFirst: logoRow, deleteMany: { count: 1 } });
    expect(
      await createPrismaSignatureImageRepository(found.prismaClient).deleteSignatureImage(
        scope,
        logoId,
      ),
    ).toEqual(logoRow);
    expect(found.calls.map((call) => call.method)).toEqual(['findFirst', 'deleteMany']);
    expect(found.calls[1]?.args).toEqual({
      where: { id: logoId, mailboxId: 'mailbox-1', tenantId: 'tenant-1' },
    });

    const notOurs = createPrismaStub({ findFirst: null });
    expect(
      await createPrismaSignatureImageRepository(notOurs.prismaClient).deleteSignatureImage(
        scope,
        logoId,
      ),
    ).toBeUndefined();
    expect(notOurs.calls.map((call) => call.method)).toEqual(['findFirst']);
  });
});
