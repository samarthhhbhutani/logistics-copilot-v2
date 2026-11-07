import type { App } from 'aws-cdk-lib';
import { Duration } from 'aws-cdk-lib';

/** Single account, single region (Mumbai: nearest to the operators and to Supabase ap-south-1). */
export const AWS_ACCOUNT_ID = '445457038961';
export const AWS_REGION = 'ap-south-1';

export const STAGES = ['staging', 'production'] as const;
export type Stage = (typeof STAGES)[number];

/**
 * The process Lambda's timeout, declared here because the SQS visibility timeout must be derived
 * from it (AWS recommends at least six times the function timeout) and both live in this stack.
 */
export const PROCESS_LAMBDA_TIMEOUT = Duration.minutes(2);

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
