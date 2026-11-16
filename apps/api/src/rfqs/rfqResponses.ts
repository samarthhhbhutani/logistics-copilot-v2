import type { Rfq, RfqMailReplies, RfqMailWithReplies } from '@lc/core';
import type { RfqMailRepliesResponse, RfqMailWithRepliesResponse, RfqResponse } from '@lc/contract';
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
