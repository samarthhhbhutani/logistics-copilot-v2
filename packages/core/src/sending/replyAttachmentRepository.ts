import type { PrismaClient } from '../db/prismaClient.js';
import type { MailboxScope } from '../connectors/gmail/mailboxConnectionRepository.js';

/** One file uploaded for a reply. Unsent until `sentMailId` is set by the send. */
export interface ReplyAttachment {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** Hex digest of the bytes. */
  sha256: string;
  /** <tenantId>/outbound/<mailboxId>/<id> in the raw-mail bucket. */
  s3Key: string;
  /** The sent_mails row carrying it; null while the upload waits in the composer. */
  sentMailId: string | null;
  createdAt: Date;
}

export interface ReplyAttachmentToCreate {
  /** Chosen by the caller before the upload so the S3 key and the row agree. */
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  s3Key: string;
}

export interface ReplyAttachmentRepository {
  createReplyAttachment(
    scope: MailboxScope,
    attachment: ReplyAttachmentToCreate,
  ): Promise<ReplyAttachment>;
  /** The subset of `attachmentIds` that belong to the mailbox, in the order given; unknown ids are skipped. */
  findReplyAttachments(scope: MailboxScope, attachmentIds: string[]): Promise<ReplyAttachment[]>;
  /** The files of one sent mail, oldest upload first. */
  listReplyAttachmentsOfSentMail(
    scope: MailboxScope,
    sentMailId: string,
  ): Promise<ReplyAttachment[]>;
  /**
   * Stamps unsent attachments of the mailbox with the sent mail that carries them. Returns how many
   * rows changed: fewer than asked means an id was unknown, another mailbox's, or already sent.
   */
  attachToSentMail(
    scope: MailboxScope,
    attachmentIds: string[],
    sentMailId: string,
  ): Promise<number>;
  /** Deletes an upload nobody sent. Undefined when it is not the mailbox's or is already on a sent mail. */
  deleteUnsentReplyAttachment(
    scope: MailboxScope,
    attachmentId: string,
  ): Promise<ReplyAttachment | undefined>;
}

const replyAttachmentSelect = {
  id: true,
  fileName: true,
  contentType: true,
  sizeBytes: true,
  sha256: true,
  s3Key: true,
  sentMailId: true,
  createdAt: true,
} as const;

export function createPrismaReplyAttachmentRepository(
  prismaClient: PrismaClient,
): ReplyAttachmentRepository {
  return {
    async createReplyAttachment({ mailboxId, tenantId }, attachment) {
      return prismaClient.replyAttachment.create({
        data: { ...attachment, mailboxId, tenantId },
        select: replyAttachmentSelect,
      });
    },

    async findReplyAttachments({ mailboxId, tenantId }, attachmentIds) {
      if (attachmentIds.length === 0) return [];
      const rows = await prismaClient.replyAttachment.findMany({
        where: { mailboxId, tenantId, id: { in: attachmentIds } },
        select: replyAttachmentSelect,
      });
      const rowById = new Map(rows.map((row) => [row.id, row]));
      return attachmentIds.flatMap((attachmentId) => rowById.get(attachmentId) ?? []);
    },

    async listReplyAttachmentsOfSentMail({ mailboxId, tenantId }, sentMailId) {
      return prismaClient.replyAttachment.findMany({
        where: { mailboxId, tenantId, sentMailId },
        select: replyAttachmentSelect,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    },

    async attachToSentMail({ mailboxId, tenantId }, attachmentIds, sentMailId) {
      if (attachmentIds.length === 0) return 0;
      // `sentMailId: null` in the where: a file already on a mail is never moved to another.
      const { count } = await prismaClient.replyAttachment.updateMany({
        where: { mailboxId, tenantId, id: { in: attachmentIds }, sentMailId: null },
        data: { sentMailId },
      });
      return count;
    },

    async deleteUnsentReplyAttachment({ mailboxId, tenantId }, attachmentId) {
      const attachment = await prismaClient.replyAttachment.findFirst({
        where: { id: attachmentId, mailboxId, tenantId, sentMailId: null },
        select: replyAttachmentSelect,
      });
      if (!attachment) return undefined;
      // Scoped delete with the unsent condition repeated: the findFirst above is not a lock.
      const { count } = await prismaClient.replyAttachment.deleteMany({
        where: { id: attachmentId, mailboxId, tenantId, sentMailId: null },
      });
      return count === 1 ? attachment : undefined;
    },
  };
}
