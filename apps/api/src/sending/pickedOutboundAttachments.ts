import createHttpError from 'http-errors';
import type {
  MailboxScope,
  OutboundMessageAttachment,
  OutboundAttachment,
  OutboundAttachmentRepository,
} from '@lc/core';
import { OUTBOUND_ATTACHMENTS_MAX_TOTAL_BYTES } from '@lc/contract';
import type { OutboundAttachmentStore } from './outboundAttachmentStore.js';

/**
 * The uploads a send names, in the order given, checked before the sent_mails row is written: every
 * id must be this mailbox's (409 attachment_not_found), unsent or already on this very mail (409
 * attachment_already_sent; a replay under the same id passes), and the total must fit a Gmail
 * message (413 attachments_too_large). Empty ids: nothing to check, nothing returned.
 */
export async function findPickedOutboundAttachments(
  outboundAttachmentRepository: OutboundAttachmentRepository,
  scope: MailboxScope,
  attachmentIds: string[],
  sentMailId: string,
): Promise<OutboundAttachment[]> {
  if (attachmentIds.length === 0) return [];
  const attachments = await outboundAttachmentRepository.findOutboundAttachments(
    scope,
    attachmentIds,
  );
  if (attachments.length !== attachmentIds.length)
    throw createHttpError(409, 'attachment_not_found');
  if (
    attachments.some((attachment) => attachment.sentMailId && attachment.sentMailId !== sentMailId)
  ) {
    throw createHttpError(409, 'attachment_already_sent');
  }
  const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
  if (totalBytes > OUTBOUND_ATTACHMENTS_MAX_TOTAL_BYTES) {
    throw createHttpError(413, 'attachments_too_large');
  }
  return attachments;
}

/** The MIME parts for the files a sent mail carries, bytes from the bucket. */
export async function readOutboundAttachments(
  outboundAttachmentStore: OutboundAttachmentStore,
  attachments: OutboundAttachment[],
): Promise<OutboundMessageAttachment[]> {
  return Promise.all(
    attachments.map(async (attachment) => ({
      content: await outboundAttachmentStore.readAttachment(attachment),
      contentType: attachment.contentType,
      fileName: attachment.fileName,
    })),
  );
}
