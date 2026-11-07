import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { LogisticsCopilotStack } from './logisticsCopilotStack.js';
import {
  AWS_ACCOUNT_ID,
  AWS_REGION,
  OTEL_LAMBDA_LAYER_ARN,
  EMAIL_PROCESSOR_TIMEOUT,
  resolveStage,
} from './stageConfig.js';

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
      VisibilityTimeout: EMAIL_PROCESSOR_TIMEOUT.toSeconds() * 6,
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
    const policies = template.findResources('AWS::IAM::Policy', {
      Properties: { Users: Match.anyValue() },
    });
    expect(Object.keys(policies)).toHaveLength(1);
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

  it('exports what Railway and the Pub/Sub subscription need', () => {
    const outputs = Object.keys(template.toJSON().Outputs ?? {});
    expect(outputs).toEqual(
      expect.arrayContaining([
        'RawMailBucketName',
        'GmailMessageIdQueueUrl',
        'GmailMessageIdDeadLetterQueueUrl',
        'RailwayApiUserName',
        'GmailPushReceiverUrl',
      ]),
    );
  });

  it('three Lambdas on Node 22 arm64 with the pinned OTel layer and the exporter wired to Grafana', () => {
    template.resourceCountIs('AWS::Lambda::Function', 3);
    for (const name of ['gmail-push-receiver', 'email-processor', 'gmail-watch-renewer']) {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: `logistics-copilot-${name}-staging`,
        Runtime: 'nodejs22.x',
        Architectures: ['arm64'],
        Layers: [OTEL_LAMBDA_LAYER_ARN],
        Environment: {
          Variables: Match.objectLike({
            STAGE: 'staging',
            AWS_LAMBDA_EXEC_WRAPPER: '/opt/otel-handler',
            OTEL_SERVICE_NAME: `logistics-copilot-${name}`,
            OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment.name=staging',
            OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
            // aws-lambda provides the root span and the end-of-invocation flush; without it spans are lost.
            OTEL_NODE_ENABLED_INSTRUMENTATIONS: Match.stringLikeRegexp('(^|,)aws-lambda(,|$)'),
            OTEL_EXPORTER_OTLP_HEADERS: { Ref: Match.stringLikeRegexp('^SsmParameterValue') },
          }),
        },
      });
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: `/aws/lambda/logistics-copilot-${name}-staging`,
        RetentionInDays: 30,
      });
    }
  });

  it('the Grafana credential comes from SSM at deploy time and is never inlined in the template', () => {
    template.hasParameter('*', {
      Type: 'AWS::SSM::Parameter::Value<String>',
      Default: '/logistics-copilot/staging/otel-exporter-otlp-headers',
    });
    expect(JSON.stringify(template.toJSON())).not.toMatch(/Authorization=Basic/);
  });

  it('email processor drains the queue one message at a time, reports item failures, 10 concurrent', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      ScalingConfig: { MaximumConcurrency: 10 },
      EventSourceArn: Match.anyValue(),
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'logistics-copilot-email-processor-staging',
      Timeout: EMAIL_PROCESSOR_TIMEOUT.toSeconds(),
      MemorySize: 1024,
    });
  });

  it('Gmail push receiver has a public Function URL (Google OIDC is verified in code) and can enqueue', () => {
    template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'NONE' });
    const pushReceiverPolicies = template.findResources('AWS::IAM::Policy', {
      Properties: { PolicyName: Match.stringLikeRegexp('^GmailPushReceiver') },
    });
    expect(JSON.stringify(pushReceiverPolicies)).toContain('sqs:SendMessage');
    expect(JSON.stringify(pushReceiverPolicies)).not.toContain('s3:');
  });

  it('Gmail watch renewer runs every 12 hours', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(12 hours)',
      State: 'ENABLED',
    });
  });
});

describe('resolveStage', () => {
  it('defaults to staging and rejects unknown stages', () => {
    expect(resolveStage(new App())).toBe('staging');
    expect(resolveStage(new App({ context: { stage: 'production' } }))).toBe('production');
    expect(() => resolveStage(new App({ context: { stage: 'prod' } }))).toThrow(/Unknown stage/);
  });
});
