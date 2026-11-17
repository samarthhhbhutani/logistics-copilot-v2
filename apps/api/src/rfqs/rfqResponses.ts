import type {
  Rfq,
  RfqListItem,
  RfqMailReplies,
  RfqMailWithReplies,
  RfqSourceEmail,
} from '@lc/core';
import type {
  RfqListItemResponse,
  RfqMailRepliesResponse,
  RfqMailWithRepliesResponse,
  RfqResponse,
  RfqSourceEmailResponse,
} from '@lc/contract';
import { toCurrentClassificationResponse } from '../emails/emailResponses.js';
import { toSentMailResponse } from '../sending/sentMailResponses.js';

export function toRfqResponse(rfq: Rfq): RfqResponse {
  return {
    id: rfq.id,
    sourceEmailId: rfq.sourceEmailId,
    originPort: rfq.originPort,
    destinationPort: rfq.destinationPort,
    incoterm: rfq.incoterm,
    status: rfq.status,
    createdAt: rfq.createdAt.toISOString(),
    updatedAt: rfq.updatedAt.toISOString(),
  };
}

export function toRfqMailWithRepliesResponse(
  rfqMailWithReplies: RfqMailWithReplies,
): RfqMailWithRepliesResponse {
  return {
    ...toSentMailResponse(rfqMailWithReplies),
    replies: toRfqMailRepliesResponse(rfqMailWithReplies.replies),
  };
}

function toRfqMailRepliesResponse({
  count: replyCount,
  latest: latestReply,
}: RfqMailReplies): RfqMailRepliesResponse {
  return {
    count: replyCount,
    latest: latestReply
      ? {
          emailId: latestReply.emailId,
          sender: { name: latestReply.senderName, email: latestReply.senderEmail },
          receivedAt: latestReply.receivedAt.toISOString(),
          snippet: latestReply.snippet,
          classification: latestReply.classification
            ? toCurrentClassificationResponse(latestReply.classification)
            : null,
        }
      : null,
  };
}

export function toRfqSourceEmailResponse(sourceEmail: RfqSourceEmail): RfqSourceEmailResponse {
  return {
    id: sourceEmail.id,
    sender: { name: sourceEmail.senderName, email: sourceEmail.senderEmail },
    subject: sourceEmail.subject,
    receivedAt: sourceEmail.receivedAt.toISOString(),
  };
}

/** The list row without its customer mail: the group it sits in carries that once for all its RFQs. */
export function toRfqListItemResponse(rfqListItem: RfqListItem): RfqListItemResponse {
  return { rfq: toRfqResponse(rfqListItem.rfq), replies: rfqListItem.replies };
}
