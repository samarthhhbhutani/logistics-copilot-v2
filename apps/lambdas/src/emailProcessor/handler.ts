import { S3Client } from '@aws-sdk/client-s3';
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import {
  createEncryptionUtil,
  createGoogleGmailMessages,
  createOpenAiClient,
  createOpenAiEmailClassifier,
  createPrismaClassificationRuleRepository,
  createPrismaEmailIngestRepository,
  createPrismaMailboxConnectionRepository,
  createPrismaMailboxSyncRepository,
  createPrismaTenantRepository,
  initializePrismaClient,
} from '@lc/core';
import { loadLambdaConfig } from '../lambdaConfig.js';
import { log } from '../structuredLog.js';
import { createS3AttachmentStore } from './attachmentStore.js';
import { createGmailMessageProcessor } from './processGmailMessage.js';
import type { GmailMessageProcessor } from './processGmailMessage.js';
import { createS3RawMailStore } from './rawMailStore.js';

/**
 * Drains the Gmail message-id queue (one record per invocation, see infra). Composition root:
 * built once per container, on the first invocation, so a failing secret fetch fails that
 * invocation and is retried on the next.
 */
let processorPromise: Promise<GmailMessageProcessor> | undefined;

async function buildProcessor(): Promise<GmailMessageProcessor> {
  const config = await loadLambdaConfig();
  if (!config.TOKEN_ENCRYPTION_KEY) throw new Error('TOKEN_ENCRYPTION_KEY is required');
  if (!config.RAW_MAIL_BUCKET_NAME) throw new Error('RAW_MAIL_BUCKET_NAME is required');
  const prismaClient = initializePrismaClient(config, { maxConnections: 1 });
  const s3Client = new S3Client({});
  const emailClassifier = config.OPENAI_API_KEY
    ? createOpenAiEmailClassifier({
        openAiClient: createOpenAiClient(config.OPENAI_API_KEY),
        model: config.MODEL_CLASSIFY,
        includeAttachments: config.LLM_CLASSIFY_INCLUDE_ATTACHMENTS,
      })
    : undefined;
  if (!emailClassifier) {
    log('warn', 'OPENAI_API_KEY not set: mail no rule matches is stored unclassified');
  }
  return createGmailMessageProcessor({
    mailboxSyncRepository: createPrismaMailboxSyncRepository(prismaClient),
    mailboxConnectionRepository: createPrismaMailboxConnectionRepository(prismaClient),
    tenantRepository: createPrismaTenantRepository(prismaClient),
    encryptionUtil: createEncryptionUtil(config.TOKEN_ENCRYPTION_KEY),
    gmailMessages: createGoogleGmailMessages(),
    rawMailStore: createS3RawMailStore({ s3Client, bucketName: config.RAW_MAIL_BUCKET_NAME }),
    attachmentStore: createS3AttachmentStore({ s3Client, bucketName: config.RAW_MAIL_BUCKET_NAME }),
    emailIngestRepository: createPrismaEmailIngestRepository(prismaClient),
    classificationRuleRepository: createPrismaClassificationRuleRepository(prismaClient),
    emailClassifier,
  });
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  processorPromise ??= buildProcessor().catch((error: unknown) => {
    processorPromise = undefined;
    throw error;
  });
  const processor = await processorPromise;
  return processor(event);
}
