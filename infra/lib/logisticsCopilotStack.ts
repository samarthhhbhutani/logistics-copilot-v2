import { CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { PipelineLambda } from './pipelineLambda.js';
import { EMAIL_PROCESSOR_TIMEOUT, lambdaEnvSecretName } from './stageConfig.js';
import type { Stage } from './stageConfig.js';

export interface LogisticsCopilotStackProps extends StackProps {
  stage: Stage;
}

/**
 * The ingestion pipeline: where raw mail is kept, the queue of Gmail message ids that the push
 * receiver fills and the email processor drains, the Lambdas around it, and the one identity the
 * Railway API uses to reach the bucket and the queue.
 */
export class LogisticsCopilotStack extends Stack {
  readonly rawMailBucket: s3.Bucket;
  readonly gmailMessageIdQueue: sqs.Queue;
  readonly gmailMessageIdDeadLetterQueue: sqs.Queue;
  readonly railwayApiUser: iam.User;
  readonly gmailPushReceiver: PipelineLambda;
  readonly emailProcessor: PipelineLambda;
  readonly gmailWatchRenewer: PipelineLambda;
  readonly gmailPushReceiverUrl: lambda.FunctionUrl;

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

    // Long polling: a ReceiveMessage call waits for a message instead of returning empty, so any
    // consumer other than Lambda's own poller (CLI redrive, local debugging) does not burn requests.
    const SQS_LONG_POLL_WAIT = Duration.seconds(20);

    this.gmailMessageIdDeadLetterQueue = new sqs.Queue(this, 'GmailMessageIdDeadLetterQueue', {
      queueName: `logistics-copilot-gmail-message-ids-dlq-${stage}`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      // Maximum SQS allows, so a bad deploy over a long weekend still leaves the ids to replay.
      retentionPeriod: Duration.days(14),
      receiveMessageWaitTime: SQS_LONG_POLL_WAIT,
    });

    this.gmailMessageIdQueue = new sqs.Queue(this, 'GmailMessageIdQueue', {
      queueName: `logistics-copilot-gmail-message-ids-${stage}`,
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      // Lambda polls SQS; the message must stay invisible for the whole run plus retries of the poll.
      visibilityTimeout: Duration.seconds(EMAIL_PROCESSOR_TIMEOUT.toSeconds() * 6),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: this.gmailMessageIdDeadLetterQueue, maxReceiveCount: 3 },
      receiveMessageWaitTime: SQS_LONG_POLL_WAIT,
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

    // Pub/Sub push target. Auth NONE at the URL: Google signs each push with an OIDC token that the
    // handler verifies itself (roadmap 1.2); IAM auth is not an option for Pub/Sub.
    // DATABASE_URL and TOKEN_ENCRYPTION_KEY stay out of the function configuration: each Lambda
    // fetches this secret once per container (apps/lambdas/src/lambdaConfig.ts).
    const lambdaEnvSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'LambdaEnvSecret',
      lambdaEnvSecretName(stage),
    );

    this.gmailPushReceiver = new PipelineLambda(this, 'GmailPushReceiver', {
      stage,
      name: 'gmailPushReceiver',
      // history.list pages plus up to a few SQS batches; a push is otherwise sub-second.
      timeout: Duration.seconds(60),
      memorySize: 512,
      // TODO(quota): reservedConcurrentExecutions: 5 once the account's Lambda concurrency quota is
      // above the new-account default of 10; Lambda refuses any reservation that leaves fewer than
      // 10 unreserved. Until then the Supabase pooler is the connection ceiling.
      environment: {
        LAMBDA_ENV_SECRET_NAME: lambdaEnvSecret.secretName,
        GMAIL_MESSAGE_ID_QUEUE_URL: this.gmailMessageIdQueue.queueUrl,
      },
    });
    // No AWS auth on the URL: the Google OIDC token on each push is the authentication.
    this.gmailPushReceiverUrl = this.gmailPushReceiver.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });
    this.gmailMessageIdQueue.grantSendMessages(this.gmailPushReceiver);
    lambdaEnvSecret.grantRead(this.gmailPushReceiver);

    this.emailProcessor = new PipelineLambda(this, 'EmailProcessor', {
      stage,
      name: 'emailProcessor',
      timeout: EMAIL_PROCESSOR_TIMEOUT,
      memorySize: 1024,
      environment: {
        LAMBDA_ENV_SECRET_NAME: lambdaEnvSecret.secretName,
        RAW_MAIL_BUCKET_NAME: this.rawMailBucket.bucketName,
      },
    });
    this.emailProcessor.addEventSource(
      new SqsEventSource(this.gmailMessageIdQueue, {
        // One Gmail message per invocation: a failure returns exactly that id to the queue.
        batchSize: 1,
        reportBatchItemFailures: true,
        // Caps parallel Gmail fetches and LLM calls per mailbox fleet, well under API quotas.
        maxConcurrency: 10,
      }),
    );
    this.rawMailBucket.grantRead(this.emailProcessor);
    this.rawMailBucket.grantPut(this.emailProcessor);
    lambdaEnvSecret.grantRead(this.emailProcessor);

    this.gmailWatchRenewer = new PipelineLambda(this, 'GmailWatchRenewer', {
      stage,
      name: 'gmailWatchRenewer',
      // Renewals run one mailbox at a time, about a second each; room for a few hundred mailboxes.
      timeout: Duration.minutes(5),
      memorySize: 512,
      environment: { LAMBDA_ENV_SECRET_NAME: lambdaEnvSecret.secretName },
    });
    lambdaEnvSecret.grantRead(this.gmailWatchRenewer);
    new events.Rule(this, 'GmailWatchRenewerSchedule', {
      // Gmail watches last 7 days and are renewed when under 36 h remain; twice a day gives three tries.
      schedule: events.Schedule.rate(Duration.hours(12)),
      targets: [new eventsTargets.LambdaFunction(this.gmailWatchRenewer)],
    });

    new CfnOutput(this, 'GmailPushReceiverUrl', { value: this.gmailPushReceiverUrl.url });
    new CfnOutput(this, 'RawMailBucketName', { value: this.rawMailBucket.bucketName });
    new CfnOutput(this, 'GmailMessageIdQueueUrl', { value: this.gmailMessageIdQueue.queueUrl });
    new CfnOutput(this, 'GmailMessageIdDeadLetterQueueUrl', {
      value: this.gmailMessageIdDeadLetterQueue.queueUrl,
    });
    new CfnOutput(this, 'RailwayApiUserName', { value: this.railwayApiUser.userName });
  }
}
