import type { OutboundAttachment, SentMail } from '@lc/core';
import type { SentMailResponse } from '@lc/contract';
import { toOutboundAttachmentResponse } from './outboundAttachmentsRouter.js';

/** `attachments` is what the reply carries; an `rfq` mail has none and leaves it out. */
export function toSentMailResponse(
  sentMail: SentMail,
  attachments: OutboundAttachment[] = [],
): SentMailResponse {
  return {
    id: sentMail.id,
    kind: sentMail.kind,
    status: sentMail.status,
    inReplyToEmailId: sentMail.inReplyToEmailId,
    rfqId: sentMail.rfqId,
    vendorId: sentMail.vendorId,
    vendorContactId: sentMail.vendorContactId,
    gmailThreadId: sentMail.gmailThreadId,
    rfcMessageId: sentMail.rfcMessageId,
    toRecipients: sentMail.toRecipients,
    ccRecipients: sentMail.ccRecipients,
    subject: sentMail.subject,
    bodyText: sentMail.bodyText,
    gmailMessageId: sentMail.gmailMessageId,
    errorCode: sentMail.errorCode,
    attachments: attachments.map(toOutboundAttachmentResponse),
    createdAt: sentMail.createdAt.toISOString(),
    updatedAt: sentMail.updatedAt.toISOString(),
  };
}
