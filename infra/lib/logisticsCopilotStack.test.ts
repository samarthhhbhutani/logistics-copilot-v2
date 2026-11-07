import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { LogisticsCopilotStack } from './logisticsCopilotStack.js';
import { AWS_ACCOUNT_ID, AWS_REGION, PROCESS_LAMBDA_TIMEOUT, resolveStage } from './stageConfig.js';

function synthesize(stage: 'staging' | 'production' = 'staging'): Template {
  const app = new App();
  const stack = new LogisticsCopilotStack(app, `LogisticsCopilot-${stage}`, {
    stage,
    env: { account: AWS_ACCOUNT_ID, region: AWS_REGION },
  });
  return Template.fromStack(stack);
}

describe('LogisticsCopilotStack', () => {
  const template = synthesize();

  it('raw-mail bucket is private, encrypted, SSL-only, retained, and moves to IA after 30 days', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
      LifecycleConfiguration: {
        Rules: [
          Match.objectLike({
            Status: 'Enabled',
            Transitions: [{ StorageClass: 'STANDARD_IA', TransitionInDays: 30 }],
          }),
        ],
      },
    });
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Action: 's3:*',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  it('Gmail message-id queue dead-letters after 3 receives and outlives the Lambda timeout six times', () => {
    template.resourceCountIs('AWS::SQS::Queue', 2);
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'logistics-copilot-gmail-message-ids-staging',
      VisibilityTimeout: PROCESS_LAMBDA_TIMEOUT.toSeconds() * 6,
      RedrivePolicy: {
        maxReceiveCount: 3,
        deadLetterTargetArn: Match.anyValue(),
      },
    });
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'logistics-copilot-gmail-message-ids-dlq-staging',
      MessageRetentionPeriod: 14 * 24 * 60 * 60,
    });
  });

  it('Railway user can read and put in the bucket and send to the message-id queue; no delete, no access key', () => {
    template.hasResourceProperties('AWS::IAM::User', {
      UserName: 'logistics-copilot-railway-api-staging',
    });
    template.resourceCountIs('AWS::IAM::AccessKey', 0);
    const policies = template.findResources('AWS::IAM::Policy');
    const statements = Object.values(policies).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement as { Action: string | string[] }[],
    );
    const actions = statements.flatMap((statement) =>
      Array.isArray(statement.Action) ? statement.Action : [statement.Action],
    );
    expect(actions.every((action) => action.startsWith('s3:') || action.startsWith('sqs:'))).toBe(
      true,
    );
    expect(actions).toContain('sqs:SendMessage');
    expect(actions).not.toContain('sqs:ReceiveMessage');
    expect(actions.some((action) => action.startsWith('s3:Delete'))).toBe(false);
  });

  it('names resources per stage so staging and production can share the account', () => {
    synthesize('production').hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'logistics-copilot-gmail-message-ids-production',
    });
  });

  it('exports what Railway and the Lambda change need', () => {
    const outputs = Object.keys(template.toJSON().Outputs ?? {});
    expect(outputs).toEqual(
      expect.arrayContaining([
        'RawMailBucketName',
        'GmailMessageIdQueueUrl',
        'GmailMessageIdDeadLetterQueueUrl',
        'RailwayApiUserName',
      ]),
    );
  });
});

describe('resolveStage', () => {
  it('defaults to staging and rejects unknown stages', () => {
    expect(resolveStage(new App())).toBe('staging');
    expect(resolveStage(new App({ context: { stage: 'production' } }))).toBe('production');
    expect(() => resolveStage(new App({ context: { stage: 'prod' } }))).toThrow(/Unknown stage/);
  });
});
