import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { loadConfig } from '@lc/core';
import type { Config } from '@lc/core';

/**
 * Lambda composition roots call this once at module scope. The function's environment holds only
 * the name of a Secrets Manager secret (LAMBDA_ENV_SECRET_NAME) whose JSON body carries the
 * values that must not sit in the function configuration (DATABASE_URL, TOKEN_ENCRYPTION_KEY).
 * Fetched once per container and merged over process.env, then validated like everywhere else.
 */
export async function loadLambdaConfig(env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  const secretName = env.LAMBDA_ENV_SECRET_NAME;
  if (!secretName) return loadConfig(env);
  const secretsManager = new SecretsManagerClient({});
  const secret = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretName }));
  if (!secret.SecretString) throw new Error(`secret ${secretName} has no string value`);
  const secretEnv = JSON.parse(secret.SecretString) as Record<string, string>;
  return loadConfig({ ...env, ...secretEnv });
}
