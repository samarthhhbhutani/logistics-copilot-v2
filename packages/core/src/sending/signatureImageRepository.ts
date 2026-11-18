import type { PrismaClient } from '../db/prismaClient.js';
import type { MailboxScope } from '../connectors/gmail/mailboxConnectionRepository.js';

/** One uploaded signature image. The signature HTML references it as `cid:<id>`. */
export interface SignatureImage {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** signatures/<mailboxId>/<id> in the raw-mail bucket. */
  s3Key: string;
  createdAt: Date;
}

export interface SignatureImageToCreate {
  /** Chosen by the caller before the upload so the S3 key and the row agree. */
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  s3Key: string;
}

export interface SignatureImageRepository {
  /** The mailbox's images, oldest first. */
  listSignatureImages(scope: MailboxScope): Promise<SignatureImage[]>;
  /** The subset of `imageIds` that belong to the mailbox, in the order given; unknown ids are skipped. */
  findSignatureImages(scope: MailboxScope, imageIds: string[]): Promise<SignatureImage[]>;
  createSignatureImage(scope: MailboxScope, image: SignatureImageToCreate): Promise<SignatureImage>;
  /** The deleted row, or undefined when the image is not the mailbox's. */
  deleteSignatureImage(scope: MailboxScope, imageId: string): Promise<SignatureImage | undefined>;
}

const signatureImageSelect = {
  id: true,
  fileName: true,
  contentType: true,
  sizeBytes: true,
  s3Key: true,
  createdAt: true,
} as const;

export function createPrismaSignatureImageRepository(
  prismaClient: PrismaClient,
): SignatureImageRepository {
  return {
    async listSignatureImages({ mailboxId, tenantId }) {
      return prismaClient.signatureImage.findMany({
        where: { mailboxId, tenantId },
        select: signatureImageSelect,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    },

    async findSignatureImages({ mailboxId, tenantId }, imageIds) {
      if (imageIds.length === 0) return [];
      const rows = await prismaClient.signatureImage.findMany({
        where: { mailboxId, tenantId, id: { in: imageIds } },
        select: signatureImageSelect,
      });
      const rowById = new Map(rows.map((row) => [row.id, row]));
      return imageIds.flatMap((imageId) => rowById.get(imageId) ?? []);
    },

    async createSignatureImage({ mailboxId, tenantId }, image) {
      return prismaClient.signatureImage.create({
        data: { ...image, mailboxId, tenantId },
        select: signatureImageSelect,
      });
    },

    async deleteSignatureImage({ mailboxId, tenantId }, imageId) {
      const image = await prismaClient.signatureImage.findFirst({
        where: { id: imageId, mailboxId, tenantId },
        select: signatureImageSelect,
      });
      if (!image) return undefined;
      // Scoped delete, not deleteMany by id alone: the findFirst above is not a lock.
      const { count } = await prismaClient.signatureImage.deleteMany({
        where: { id: imageId, mailboxId, tenantId },
      });
      return count === 1 ? image : undefined;
    },
  };
}
