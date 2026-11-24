import createHttpError from 'http-errors';
import type {
  MailboxScope,
  OutboundMessageAttachment,
  OutboundAttachment,
  OutboundAttachmentRepository,
} from '@lc/core';
import { OUTBOUND_ATTACHMENTS_MAX_TOTAL_BYTES } from '@lc/contract';
import type { OutboundAttachmentStore } from './outboundAttachmentStore.js';

/** Who a send is about to hand the files to: the reply's sent_mails row, or the RFQ behind a batch of vendor mails. */
export type OutboundAttachmentOwner = { sentMailId: string } | { rfqId: string };

function isOwnedByAnother(attachment: OutboundAttachment, owner: OutboundAttachmentOwner): boolean {
  if (attachment.sentMailId === null && attachment.rfqId === null) return false;
  if ('sentMailId' in owner) return attachment.sentMailId !== owner.sentMailId;
  return attachment.rfqId !== owner.rfqId;
}

/**
 * The uploads a send names, in the order given, checked before anything is written: every id must
 * be this mailbox's (409 attachment_not_found), unused or already this very owner's (409
 * attachment_already_sent; a replay under the same id passes), and the total must fit one Gmail
 * message (413 attachments_too_large; every mail of an RFQ carries the whole set). Empty ids:
 * nothing to check, nothing returned.
 */
export async function findPickedOutboundAttachments(
  outboundAttachmentRepository: OutboundAttachmentRepository,
  scope: MailboxScope,
  attachmentIds: string[],
  owner: OutboundAttachmentOwner,
): Promise<OutboundAttachment[]> {
  if (attachmentIds.length === 0) return [];
  const attachments = await outboundAttachmentRepository.findOutboundAttachments(
    scope,
    attachmentIds,
  );
  if (attachments.length !== attachmentIds.length)
    throw createHttpError(409, 'attachment_not_found');
  if (attachments.some((attachment) => isOwnedByAnother(attachment, owner))) {
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
