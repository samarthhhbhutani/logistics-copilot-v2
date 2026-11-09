import type { App } from 'aws-cdk-lib';
import { Duration } from 'aws-cdk-lib';

/** Single account, single region (Mumbai: nearest to the operators and to Supabase ap-south-1). */
export const AWS_ACCOUNT_ID = '445457038961';
export const AWS_REGION = 'ap-south-1';

export const STAGES = ['staging', 'production'] as const;
export type Stage = (typeof STAGES)[number];

/**
 * The email processor Lambda's timeout, declared here because the SQS visibility timeout must be
 * derived from it (AWS recommends at least six times the function timeout) and both live in this stack.
 */
export const EMAIL_PROCESSOR_TIMEOUT = Duration.minutes(2);

/**
 * OpenTelemetry Node.js Lambda layer (open-telemetry/opentelemetry-lambda release layer-nodejs/0.24.0,
 * OTel JS 2.12.0). Pinned by version in the ARN so a deploy never picks up a layer we did not test.
 */
export const OTEL_LAMBDA_LAYER_ARN = `arn:aws:lambda:${AWS_REGION}:184161586896:layer:opentelemetry-nodejs-0_24_0:1`;

/** Grafana Cloud OTLP gateway for the stack's region. Public URL; the credential is a secret. */
export const GRAFANA_OTLP_ENDPOINT = 'https://otlp-gateway-prod-ap-south-1.grafana.net/otlp';

/**
 * SSM parameter (standard tier, free) holding the `Authorization=Basic ...` value for
 * OTEL_EXPORTER_OTLP_HEADERS. Put by hand once per stage; CloudFormation resolves it at deploy,
 * so the credential never enters the repo or the synthesized template. A plain String because
 * CloudFormation cannot inject SecureString values into Lambda environment variables.
 */
export function otelExporterHeadersParameterName(stage: Stage): string {
  return `/logistics-copilot/${stage}/otel-exporter-otlp-headers`;
}

/** Reads `-c stage=<staging|production>`; defaults to staging so a bare `cdk synth` is harmless. */
export function resolveStage(app: App): Stage {
  const requested: unknown = app.node.tryGetContext('stage') ?? 'staging';
  if (!isStage(requested)) {
    throw new Error(`Unknown stage "${String(requested)}"; expected one of ${STAGES.join(', ')}`);
  }
  return requested;
}

function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value);
}

/**
 * Secrets Manager secret the pipeline Lambdas read at cold start (JSON: DATABASE_URL,
 * TOKEN_ENCRYPTION_KEY). Created by hand per stage, never by CDK: the template holds only the name.
 */
export function lambdaEnvSecretName(stage: Stage): string {
  return `logistics-copilot/${stage}/lambda-env`;
}
