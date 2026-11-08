import { SQSClient } from '@aws-sdk/client-sqs';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  createEncryptionUtil,
  createGoogleGmailHistory,
  createPrismaMailboxConnectionRepository,
  createPrismaMailboxSyncRepository,
  createPrismaTenantRepository,
  initializePrismaClient,
} from '@lc/core';
import { loadLambdaConfig } from '../lambdaConfig.js';
import { createSqsGmailMessageIdPublisher } from './gmailMessageIdPublisher.js';
import { createGooglePushTokenVerifier } from './pushTokenVerifier.js';
import { createGmailPushReceiver } from './receiveGmailPush.js';
import type { GmailPushHandler } from './receiveGmailPush.js';

/**
 * Target of every tenant's Gmail Pub/Sub push subscription (Function URL, no AWS auth: the
 * Google OIDC token is the authentication). Composition root: built once per container, on
 * the first invocation, so a failing secret fetch fails that invocation and is retried on the next.
 */
let receiverPromise: Promise<GmailPushHandler> | undefined;

async function buildReceiver(): Promise<GmailPushHandler> {
  const config = await loadLambdaConfig();
  if (!config.TOKEN_ENCRYPTION_KEY) throw new Error('TOKEN_ENCRYPTION_KEY is required');
  if (!config.GMAIL_MESSAGE_ID_QUEUE_URL) throw new Error('GMAIL_MESSAGE_ID_QUEUE_URL is required');
  const prismaClient = initializePrismaClient(config, { maxConnections: 1 });
  return createGmailPushReceiver({
    pushTokenVerifier: createGooglePushTokenVerifier(),
    mailboxSyncRepository: createPrismaMailboxSyncRepository(prismaClient),
    mailboxConnectionRepository: createPrismaMailboxConnectionRepository(prismaClient),
    tenantRepository: createPrismaTenantRepository(prismaClient),
    encryptionUtil: createEncryptionUtil(config.TOKEN_ENCRYPTION_KEY),
    gmailHistory: createGoogleGmailHistory(),
    gmailMessageIdPublisher: createSqsGmailMessageIdPublisher({
      sqsClient: new SQSClient({}),
      queueUrl: config.GMAIL_MESSAGE_ID_QUEUE_URL,
    }),
  });
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  receiverPromise ??= buildReceiver().catch((error: unknown) => {
    receiverPromise = undefined;
    throw error;
  });
  const receiver = await receiverPromise;
  return receiver(event);
}
