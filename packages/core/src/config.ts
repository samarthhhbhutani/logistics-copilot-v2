import { z } from 'zod';

const envSchema = z.object({
  STAGE: z.enum(['dev', 'staging', 'prod']).default('dev'),
  /** Supabase transaction pooler (6543, pgbouncer=true). The only URL the application opens. */
  DATABASE_URL: z.string().url(),
  /** Supabase session pooler (5432). Used only by the Prisma CLI for migrations, never by the app. */
  DIRECT_URL: z.string().url().optional(),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  GOOGLE_REDIRECT_URI: z.string().url().optional(),
  GOOGLE_PUBSUB_TOPIC: z.string().min(1).optional(),
  AWS_REGION: z.string().default('ap-south-1'),
  S3_BUCKET: z.string().optional(),
  SQS_MESSAGES_QUEUE_URL: z.string().url().optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  MODEL_CLASSIFY: z.string().default('gpt-6-luna'),
  MODEL_AGENT: z.string().default('gpt-6.1-sol'),
  PORT: z.coerce.number().int().positive().default(8080),
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
