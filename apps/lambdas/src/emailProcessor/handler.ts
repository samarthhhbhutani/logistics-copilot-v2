import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';

/**
 * Drains the Gmail message-id queue. Shell: logs the ids and reports no failures so the messages
 * are deleted. The real handler (roadmap 1.4) fetches each message raw, stores the .eml in S3,
 * parses and classifies it, and reports per-message failures so only those return to the queue.
 */
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  console.info(
    JSON.stringify({
      message: 'emailProcessor shell invoked',
      messageIds: event.Records.map((record) => record.messageId),
      bodies: event.Records.map((record) => record.body),
    }),
  );
  return { batchItemFailures: [] };
}
