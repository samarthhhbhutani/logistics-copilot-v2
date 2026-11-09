import type { PrismaClient } from '../db/prismaClient.js';
import type { MailboxScope } from '../connectors/gmail/mailboxConnectionRepository.js';

/** One stored file, as the processor describes it once the bytes are in S3. The row's email is chosen by the caller. */
export interface StoredAttachment {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  /** Lowercase hex; the object is addressed by it, so equal content shares one object. */
  sha256: string;
  s3Key: string;
  contentId: string | undefined;
  /** Referenced from the HTML body (cid:), so a logo or signature image rather than a file someone attached. */
  isInline: boolean;
}

export interface AttachmentSummary extends StoredAttachment {
  id: string;
  emailId: string;
}

export interface AttachmentRepository {
  /**
   * The files of one email, inline parts included, or undefined when the email is not in the
   * mailbox and tenant, so "no files" and "not your email" stay distinguishable.
   */
  listAttachments(scope: MailboxScope, emailId: string): Promise<AttachmentSummary[] | undefined>;
  /** Undefined when the attachment, its email, or the mailbox is not the caller's. */
  findAttachment(
    scope: MailboxScope,
    emailId: string,
    attachmentId: string,
  ): Promise<AttachmentSummary | undefined>;
}

const attachmentSelect = {
  id: true,
  emailId: true,
  fileName: true,
  contentType: true,
  sizeBytes: true,
  sha256: true,
  s3Key: true,
  contentId: true,
  isInline: true,
} as const;

type AttachmentRow = {
  id: string;
  emailId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  s3Key: string;
  contentId: string | null;
  isInline: boolean;
};

function toAttachmentSummary(row: AttachmentRow): AttachmentSummary {
  return {
    id: row.id,
    emailId: row.emailId,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    s3Key: row.s3Key,
    contentId: row.contentId ?? undefined,
    isInline: row.isInline,
  };
}

export function createPrismaAttachmentRepository(prismaClient: PrismaClient): AttachmentRepository {
  return {
    async listAttachments({ mailboxId, tenantId }, emailId) {
      const email = await prismaClient.email.findFirst({
        where: { id: emailId, mailboxId, tenantId },
        select: {
          attachments: {
            // tenant_id on the row is the isolation check; the parent email already proved the mailbox.
            where: { tenantId },
            orderBy: [{ isInline: 'asc' }, { fileName: 'asc' }, { id: 'asc' }],
            select: attachmentSelect,
          },
        },
      });
      return email?.attachments.map(toAttachmentSummary);
    },

    async findAttachment({ mailboxId, tenantId }, emailId, attachmentId) {
      const row = await prismaClient.attachment.findFirst({
        where: { id: attachmentId, tenantId, email: { id: emailId, mailboxId, tenantId } },
        select: attachmentSelect,
      });
      return row ? toAttachmentSummary(row) : undefined;
    },
  };
}
