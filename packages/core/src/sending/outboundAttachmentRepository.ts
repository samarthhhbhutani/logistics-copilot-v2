import type { PrismaClient } from '../db/prismaClient.js';
import type { MailboxScope } from '../connectors/gmail/mailboxConnectionRepository.js';

/** One file uploaded from a composer for an outgoing mail. Unsent until `sentMailId` is set by the send. */
export interface OutboundAttachment {
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

export interface OutboundAttachmentToCreate {
  /** Chosen by the caller before the upload so the S3 key and the row agree. */
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  s3Key: string;
}

export interface OutboundAttachmentRepository {
  createOutboundAttachment(
    scope: MailboxScope,
    attachment: OutboundAttachmentToCreate,
  ): Promise<OutboundAttachment>;
  /** The subset of `attachmentIds` that belong to the mailbox, in the order given; unknown ids are skipped. */
  findOutboundAttachments(
    scope: MailboxScope,
    attachmentIds: string[],
  ): Promise<OutboundAttachment[]>;
  /** The files of one sent mail, oldest upload first. */
  listOutboundAttachmentsOfSentMail(
    scope: MailboxScope,
    sentMailId: string,
  ): Promise<OutboundAttachment[]>;
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
  deleteUnsentOutboundAttachment(
    scope: MailboxScope,
    attachmentId: string,
  ): Promise<OutboundAttachment | undefined>;
}

const outboundAttachmentSelect = {
  id: true,
  fileName: true,
  contentType: true,
  sizeBytes: true,
  sha256: true,
  s3Key: true,
  sentMailId: true,
  createdAt: true,
} as const;

export function createPrismaOutboundAttachmentRepository(
  prismaClient: PrismaClient,
): OutboundAttachmentRepository {
  return {
    async createOutboundAttachment({ mailboxId, tenantId }, attachment) {
      return prismaClient.outboundAttachment.create({
        data: { ...attachment, mailboxId, tenantId },
        select: outboundAttachmentSelect,
      });
    },

    async findOutboundAttachments({ mailboxId, tenantId }, attachmentIds) {
      if (attachmentIds.length === 0) return [];
      const rows = await prismaClient.outboundAttachment.findMany({
        where: { mailboxId, tenantId, id: { in: attachmentIds } },
        select: outboundAttachmentSelect,
      });
      const rowById = new Map(rows.map((row) => [row.id, row]));
      return attachmentIds.flatMap((attachmentId) => rowById.get(attachmentId) ?? []);
    },

    async listOutboundAttachmentsOfSentMail({ mailboxId, tenantId }, sentMailId) {
      return prismaClient.outboundAttachment.findMany({
        where: { mailboxId, tenantId, sentMailId },
        select: outboundAttachmentSelect,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    },

    async attachToSentMail({ mailboxId, tenantId }, attachmentIds, sentMailId) {
      if (attachmentIds.length === 0) return 0;
      // `sentMailId: null` in the where: a file already on a mail is never moved to another.
      const { count } = await prismaClient.outboundAttachment.updateMany({
        where: { mailboxId, tenantId, id: { in: attachmentIds }, sentMailId: null },
        data: { sentMailId },
      });
      return count;
    },

    async deleteUnsentOutboundAttachment({ mailboxId, tenantId }, attachmentId) {
      const attachment = await prismaClient.outboundAttachment.findFirst({
        where: { id: attachmentId, mailboxId, tenantId, sentMailId: null },
        select: outboundAttachmentSelect,
      });
      if (!attachment) return undefined;
      // Scoped delete with the unsent condition repeated: the findFirst above is not a lock.
      const { count } = await prismaClient.outboundAttachment.deleteMany({
        where: { id: attachmentId, mailboxId, tenantId, sentMailId: null },
      });
      return count === 1 ? attachment : undefined;
    },
  };
}
