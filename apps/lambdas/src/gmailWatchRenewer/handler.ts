import type { ScheduledEvent } from 'aws-lambda';
import {
  createEncryptionUtil,
  createGoogleGmailWatch,
  createPrismaMailboxConnectionRepository,
  createPrismaMailboxSyncRepository,
  createPrismaTenantRepository,
  initializePrismaClient,
} from '@lc/core';
import { loadLambdaConfig } from '../lambdaConfig.js';
import { createGmailWatchRenewer } from './renewGmailWatches.js';
import type { GmailWatchRenewer } from './renewGmailWatches.js';

/**
 * EventBridge target, every 12 hours (infra GmailWatchRenewerSchedule). Composition root: built
 * once per container, on the first invocation, so a failing secret fetch fails that invocation
 * and is retried on the next. The stale-`sending` sweep (roadmap 4.5) gets its own Lambda.
 */
let renewerPromise: Promise<GmailWatchRenewer> | undefined;

async function buildRenewer(): Promise<GmailWatchRenewer> {
  const config = await loadLambdaConfig();
  if (!config.TOKEN_ENCRYPTION_KEY) throw new Error('TOKEN_ENCRYPTION_KEY is required');
  const prismaClient = initializePrismaClient(config, { maxConnections: 1 });
  return createGmailWatchRenewer({
    mailboxSyncRepository: createPrismaMailboxSyncRepository(prismaClient),
    mailboxConnectionRepository: createPrismaMailboxConnectionRepository(prismaClient),
    tenantRepository: createPrismaTenantRepository(prismaClient),
    encryptionUtil: createEncryptionUtil(config.TOKEN_ENCRYPTION_KEY),
    gmailWatch: createGoogleGmailWatch(),
  });
}

export async function handler(event: ScheduledEvent): Promise<void> {
  renewerPromise ??= buildRenewer().catch((error: unknown) => {
    renewerPromise = undefined;
    throw error;
  });
  const renewer = await renewerPromise;
  await renewer(event);
}
