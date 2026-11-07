import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import { PROCESS_LAMBDA_TIMEOUT } from './stageConfig.js';
import type { Stage } from './stageConfig.js';

export interface LogisticsCopilotStackProps extends StackProps {
  stage: Stage;
}

/**
 * Everything the ingestion pipeline needs that is not a Lambda: where raw mail is kept, the queue
 * of Gmail message ids that ingest fills and process drains, and the one identity the Railway API
 * uses to reach them. Lambdas are added by a later change once their handlers exist.
 */
export class LogisticsCopilotStack extends Stack {
  readonly rawMailBucket: s3.Bucket;
  readonly gmailMessageIdQueue: sqs.Queue;
  readonly gmailMessageIdDeadLetterQueue: sqs.Queue;
  readonly railwayApiUser: iam.User;

  constructor(scope: Construct, id: string, props: LogisticsCopilotStackProps) {
    super(scope, id, props);
    const { stage } = props;

    this.rawMailBucket = new s3.Bucket(this, 'RawMailBucket', {
      // Name left to CloudFormation: S3 names are global and a fixed one fails on collision.
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      // Mail is the system of record for disputes; never let a stack delete take it along.
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'InfrequentAccessAfter30Days',
          // Raw .eml and attachments are read once at processing time, then rarely (UI download).
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: Duration.days(30),
            },
          ],
        },
      ],
    });

    this.gmailMessageIdDeadLetterQueue = new sqs.Queue(this, 'GmailMessageIdDeadLetterQueue', {
      queueName: `logistics-copilot-gmail-message-ids-dlq-${stage}`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      // Maximum SQS allows, so a bad deploy over a long weekend still leaves the ids to replay.
      retentionPeriod: Duration.days(14),
    });

    this.gmailMessageIdQueue = new sqs.Queue(this, 'GmailMessageIdQueue', {
      queueName: `logistics-copilot-gmail-message-ids-${stage}`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      // Lambda polls SQS; the message must stay invisible for the whole run plus retries of the poll.
      visibilityTimeout: Duration.seconds(PROCESS_LAMBDA_TIMEOUT.toSeconds() * 6),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: this.gmailMessageIdDeadLetterQueue, maxReceiveCount: 3 },
    });

    // The Railway-hosted API: reads mail and attachments for the UI, enqueues message ids on manual resync.
    // No access key is created here; it would land in the template. Create it with the CLI after
    // deploy and paste it into Railway.
    this.railwayApiUser = new iam.User(this, 'RailwayApiUser', {
      userName: `logistics-copilot-railway-api-${stage}`,
    });
    // Read for the UI, put for attachments uploaded via the API; never delete: mail is evidence.
    this.rawMailBucket.grantRead(this.railwayApiUser);
    this.rawMailBucket.grantPut(this.railwayApiUser);
    this.gmailMessageIdQueue.grantSendMessages(this.railwayApiUser);

    new CfnOutput(this, 'RawMailBucketName', { value: this.rawMailBucket.bucketName });
    new CfnOutput(this, 'GmailMessageIdQueueUrl', { value: this.gmailMessageIdQueue.queueUrl });
    new CfnOutput(this, 'GmailMessageIdDeadLetterQueueUrl', {
      value: this.gmailMessageIdDeadLetterQueue.queueUrl,
    });
    new CfnOutput(this, 'RailwayApiUserName', { value: this.railwayApiUser.userName });
  }
}
