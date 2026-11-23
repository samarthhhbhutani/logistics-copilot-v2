import createHttpError from 'http-errors';
import type {
  MailboxScope,
  OutboundAttachment,
  ReplyAttachment,
  ReplyAttachmentRepository,
} from '@lc/core';
import { REPLY_ATTACHMENTS_MAX_TOTAL_BYTES } from '@lc/contract';
import type { ReplyAttachmentStore } from './replyAttachmentStore.js';

/**
 * The uploads a send names, checked before the sent_mails row is written: every id must be this
 * mailbox's (409 attachment_not_found), unsent or already on this very mail (409
 * attachment_already_sent, a replay under the same id passes), and the total must fit a Gmail
 * message (413 attachments_too_large). Empty ids: nothing to check.
 */
export async function checkPickedReplyAttachments(
  replyAttachmentRepository: ReplyAttachmentRepository,
  scope: MailboxScope,
  attachmentIds: string[],
  sentMailId: string,
): Promise<void> {
  if (attachmentIds.length === 0) return;
  const attachments = await replyAttachmentRepository.findReplyAttachments(scope, attachmentIds);
  if (attachments.length !== attachmentIds.length)
    throw createHttpError(409, 'attachment_not_found');
  if (
    attachments.some((attachment) => attachment.sentMailId && attachment.sentMailId !== sentMailId)
  ) {
    throw createHttpError(409, 'attachment_already_sent');
  }
  const totalBytes = attachments.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
  if (totalBytes > REPLY_ATTACHMENTS_MAX_TOTAL_BYTES) {
    throw createHttpError(413, 'attachments_too_large');
  }
}

/** The MIME parts for the files a sent mail carries, bytes from the bucket. */
export async function readOutboundAttachments(
  replyAttachmentStore: ReplyAttachmentStore,
  attachments: ReplyAttachment[],
): Promise<OutboundAttachment[]> {
  return Promise.all(
    attachments.map(async (attachment) => ({
      content: await replyAttachmentStore.readAttachment(attachment),
      contentType: attachment.contentType,
      fileName: attachment.fileName,
    })),
  );
}
