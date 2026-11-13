import { z } from 'zod';

const envSchema = z.object({
  STAGE: z.enum(['dev', 'staging', 'prod']).default('dev'),
  /** Supabase transaction pooler (6543, pgbouncer=true). The only URL the application opens. */
  DATABASE_URL: z.url(),
  /** Supabase session pooler (5432). Used only by the Prisma CLI for migrations, never by the app. */
  DIRECT_URL: z.url().optional(),
  /** Our Gmail OAuth callback, registered on every tenant's own Google client (clients are per tenant, in the DB). */
  GOOGLE_REDIRECT_URI: z.url().optional(),
  /** Frontend origin the Gmail callback redirects back to. Unset in local dev: the callback answers JSON instead. */
  FRONTEND_URL: z.url().optional(),
  AWS_REGION: z.string().default('ap-south-1'),
  /** Where emailProcessor stores every fetched message as .eml (infra RawMailBucket). */
  RAW_MAIL_BUCKET_NAME: z.string().min(1).optional(),
  /** Where the push receiver enqueues Gmail message ids for emailProcessor. */
  GMAIL_MESSAGE_ID_QUEUE_URL: z.url().optional(),
  /** Unset: the LLM classifier is off and unmatched inbound mail stays unclassified. */
  OPENAI_API_KEY: z.string().min(1).optional(),
  MODEL_CLASSIFY: z.string().default('gpt-6-luna'),
  /** Send PDF and image attachments to the classifier along with the mail. Off: mail text only (token cost). */
  LLM_CLASSIFY_INCLUDE_ATTACHMENTS: z.stringbool().default(false),
  MODEL_AGENT: z.string().default('gpt-6.1-sol'),
  PORT: z.coerce.number().int().positive().default(8080),
  /** HMAC key for session JWTs (API only). Generate: openssl rand -base64 48 */
  SESSION_SECRET: z.string().min(32).optional(),
  /** AES-256-GCM key for secrets at rest (createEncryptionUtil): 32 bytes, base64. Generate: openssl rand -base64 32 */
  TOKEN_ENCRYPTION_KEY: z.string().min(1).optional(),
  /**
   * Safe mode for outbound mail: every message is sent to this address instead of its real
   * recipients. createGoogleGmailSender requires it on staging and refuses it on prod; only the
   * process that builds a sender (the API) is held to that, Lambdas never send.
   */
  OUTBOUND_MAIL_REDIRECT_TO: z.email().optional(),
});

export type Config = z.infer<typeof envSchema>;

/**
 * Parse and validate an environment. Pure: no caching, no module state.
 *
 * Call it exactly once at each composition root (apps/api index, each Lambda module scope)
 * and pass the result down. Nothing outside the composition root reads process.env.
 * Throws with a readable list of missing/invalid keys.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${problems}`);
  }
  return result.data;
}
