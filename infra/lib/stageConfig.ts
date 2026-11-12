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

/**
 * Browser origins allowed to GET raw-mail objects through presigned URLs (the inline reader's
 * images). Staging is the verified Railway frontend plus the Vite dev server. Production has no
 * default: its frontend origin must be verified and passed in, otherwise the bucket gets no CORS.
 */
const STAGING_FRONTEND_ORIGINS = [
  'https://frontend-staging-d909.up.railway.app',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
] as const;

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1']);

export function defaultFrontendOrigins(stage: Stage): readonly string[] {
  return stage === 'staging' ? STAGING_FRONTEND_ORIGINS : [];
}

export function frontendOriginsContextKey(stage: Stage): string {
  return `frontendOrigins:${stage}`;
}

/**
 * Reads `-c frontendOrigins:<stage>=<origin>[,<origin>...]` (or a string array in cdk.json).
 * Keyed by stage so a production synth can never pick up staging's list; an unkeyed
 * `frontendOrigins` is refused for the same reason. Absent means the stage default.
 */
export function resolveFrontendOrigins(app: App, stage: Stage): readonly string[] | undefined {
  if (app.node.tryGetContext('frontendOrigins') !== undefined) {
    throw new Error(
      `Context "frontendOrigins" is not stage-specific; use "${frontendOriginsContextKey(stage)}"`,
    );
  }
  const contextKey = frontendOriginsContextKey(stage);
  const configured: unknown = app.node.tryGetContext(contextKey);
  if (configured === undefined) {
    return undefined;
  }
  const origins = typeof configured === 'string' ? configured.split(',') : configured;
  if (!Array.isArray(origins) || !origins.every((origin) => typeof origin === 'string')) {
    throw new Error(
      `Context "${contextKey}" must be a comma-separated string or a list of strings`,
    );
  }
  const trimmedOrigins = origins.map((origin) => origin.trim());
  if (trimmedOrigins.some((origin) => origin === '')) {
    throw new Error(`Context "${contextKey}" has an empty origin`);
  }
  return trimmedOrigins;
}

/**
 * S3 matches CORS origins as exact strings, so each entry must already be a canonical origin
 * (scheme://host[:port], no path, no trailing slash, no wildcard). Plain http is only accepted
 * for loopback in staging, so a production deploy can never trust a local dev server.
 */
export function validateFrontendOrigins(stage: Stage, origins: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const origin of origins) {
    if (origin.includes('*')) {
      throw new Error(`Frontend origin "${origin}" must not contain a wildcard`);
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`Frontend origin "${origin}" is not a valid URL`);
    }
    if (parsed.origin !== origin) {
      throw new Error(
        `Frontend origin "${origin}" must be an exact origin like "${parsed.origin}" (no path, slash, credentials or default port)`,
      );
    }
    const isStagingLoopback =
      stage === 'staging' && parsed.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(parsed.hostname);
    if (parsed.protocol !== 'https:' && !isStagingLoopback) {
      throw new Error(
        `Frontend origin "${origin}" must use https; http is allowed only for localhost/127.0.0.1 in staging`,
      );
    }
    if (seen.has(origin)) {
      throw new Error(`Frontend origin "${origin}" is listed twice`);
    }
    seen.add(origin);
  }
  return [...seen];
}
