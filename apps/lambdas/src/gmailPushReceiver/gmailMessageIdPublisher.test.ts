import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSqsGmailMessageIdPublisher } from './gmailMessageIdPublisher.js';

const sqsMock = mockClient(SQSClient);
const scope = { tenantId: 'tenant-1', mailboxId: 'mailbox-1' };
const queueUrl =
  'https://sqs.ap-south-1.amazonaws.com/123/logistics-copilot-gmail-message-ids-staging';

describe('createSqsGmailMessageIdPublisher', () => {
  beforeEach(() => sqsMock.reset());

  it('sends ids in batches of ten, one queue message per Gmail message', async () => {
    sqsMock.on(SendMessageBatchCommand).resolves({ Successful: [], Failed: [] });
    const queue = createSqsGmailMessageIdPublisher({ sqsClient: new SQSClient({}), queueUrl });
    const ids = Array.from({ length: 23 }, (_, index) => `gm-${index}`);

    await queue.publish(scope, ids);

    const calls = sqsMock.commandCalls(SendMessageBatchCommand);
    expect(calls.map((call) => call.args[0].input.Entries?.length)).toEqual([10, 10, 3]);
    expect(calls[0]?.args[0].input.QueueUrl).toBe(queueUrl);
    expect(JSON.parse(calls[2]?.args[0].input.Entries?.[2]?.MessageBody ?? '')).toEqual({
      tenantId: 'tenant-1',
      mailboxId: 'mailbox-1',
      gmailMessageId: 'gm-22',
    });
  });

  it('a partial batch failure is a failure naming the ids', async () => {
    sqsMock.on(SendMessageBatchCommand).resolves({
      Successful: [],
      Failed: [{ Id: '1', SenderFault: true, Code: 'InternalError', Message: 'boom' }],
    });
    const queue = createSqsGmailMessageIdPublisher({ sqsClient: new SQSClient({}), queueUrl });

    await expect(queue.publish(scope, ['gm-a', 'gm-b'])).rejects.toThrow(
      'SendMessageBatch failed for 1 of 2 ids: gm-b',
    );
  });
});
