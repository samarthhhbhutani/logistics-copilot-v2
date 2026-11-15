import type { ScheduledEvent } from 'aws-lambda';
import {
  createEncryptionUtil,
  createGoogleGmailMessages,
  createPrismaMailboxConnectionRepository,
  createPrismaSentMailRepository,
  createPrismaTenantRepository,
  initializePrismaClient,
} from '@lc/core';
import { loadLambdaConfig } from '../lambdaConfig.js';
import { createSentMailSweeper } from './sweepStaleSentMails.js';
import type { SentMailSweeper } from './sweepStaleSentMails.js';

/**
 * EventBridge target, every 15 minutes (infra SentMailSweeperSchedule). Composition root: built
 * once per container, on the first invocation, so a failing secret fetch fails that invocation
 * and is retried on the next.
 */
let sweeperPromise: Promise<SentMailSweeper> | undefined;

async function buildSweeper(): Promise<SentMailSweeper> {
  const config = await loadLambdaConfig();
  if (!config.TOKEN_ENCRYPTION_KEY) throw new Error('TOKEN_ENCRYPTION_KEY is required');
  const prismaClient = initializePrismaClient(config, { maxConnections: 1 });
  return createSentMailSweeper({
    sentMailRepository: createPrismaSentMailRepository(prismaClient),
    mailboxConnectionRepository: createPrismaMailboxConnectionRepository(prismaClient),
    tenantRepository: createPrismaTenantRepository(prismaClient),
    encryptionUtil: createEncryptionUtil(config.TOKEN_ENCRYPTION_KEY),
    gmailMessages: createGoogleGmailMessages(),
  });
}

export async function handler(event: ScheduledEvent): Promise<void> {
  sweeperPromise ??= buildSweeper().catch((error: unknown) => {
    sweeperPromise = undefined;
    throw error;
  });
  const sweeper = await sweeperPromise;
  await sweeper(event);
}
