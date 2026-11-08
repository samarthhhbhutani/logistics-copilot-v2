import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { MailboxScope } from '@lc/core';

/** One queue message = one Gmail message to fetch; the body emailProcessor reads. */
export interface GmailMessageIdQueueMessage extends MailboxScope {
  gmailMessageId: string;
}

export interface GmailMessageIdPublisher {
  /** Sends every id or throws; a partial batch failure is a failure (the cursor must not move). */
  publish(scope: MailboxScope, gmailMessageIds: string[]): Promise<void>;
}

const SQS_BATCH_SIZE = 10;

export function createSqsGmailMessageIdPublisher(input: {
  sqsClient: SQSClient;
  queueUrl: string;
}): GmailMessageIdPublisher {
  const { sqsClient, queueUrl } = input;
  return {
    async publish(scope, gmailMessageIds) {
      for (let offset = 0; offset < gmailMessageIds.length; offset += SQS_BATCH_SIZE) {
        const batch = gmailMessageIds.slice(offset, offset + SQS_BATCH_SIZE);
        const result = await sqsClient.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: batch.map((gmailMessageId, index) => ({
              Id: String(index),
              MessageBody: JSON.stringify({
                tenantId: scope.tenantId,
                mailboxId: scope.mailboxId,
                gmailMessageId,
              } satisfies GmailMessageIdQueueMessage),
            })),
          }),
        );
        if (result.Failed && result.Failed.length > 0) {
          const failedIds = result.Failed.map((failure) => batch[Number(failure.Id)]);
          throw new Error(
            `SendMessageBatch failed for ${result.Failed.length} of ${batch.length} ids: ${failedIds.join(', ')}`,
          );
        }
      }
    },
  };
}
