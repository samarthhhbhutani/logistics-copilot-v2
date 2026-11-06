import { PrismaPg } from '@prisma/adapter-pg';
import type { Config } from '../config.js';
import { PrismaClient } from './generated/client.js';

export interface PrismaClientOptions {
  /** Pool size. Lambdas: 1 per container. Express: a handful. Default 4. */
  maxConnections?: number;
}

let prismaClientSingleton: PrismaClient | undefined;

/**
 * Build the one Prisma client for this process. Called exactly once at the composition root
 * (apps/api/src/index.ts, each Lambda module scope) with the loaded Config; everything else
 * reaches it through getPrismaClient(). Calling it again returns the existing instance.
 *
 * Engine-less client over node-postgres. DATABASE_URL must be Supabase's transaction pooler
 * (port 6543). Migrations never go through this client; they use DIRECT_URL via the Prisma CLI.
 */
export function initializePrismaClient(
  config: Pick<Config, 'DATABASE_URL'>,
  options: PrismaClientOptions = {},
): PrismaClient {
  if (prismaClientSingleton) return prismaClientSingleton;
  const adapter = new PrismaPg({
    connectionString: config.DATABASE_URL,
    max: options.maxConnections ?? 4,
  });
  prismaClientSingleton = new PrismaClient({ adapter });
  return prismaClientSingleton;
}

/** The process-wide Prisma client. Throws if the composition root has not initialized it yet. */
export function getPrismaClient(): PrismaClient {
  if (!prismaClientSingleton) {
    throw new Error(
      'Prisma client not initialized: call initializePrismaClient(config) at the composition root first',
    );
  }
  return prismaClientSingleton;
}

export { PrismaClient };
export type { Mailbox } from './generated/client.js';
