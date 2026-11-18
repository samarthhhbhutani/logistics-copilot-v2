import { S3Client } from '@aws-sdk/client-s3';
import {
  createGoogleGmailOAuth,
  createGoogleGmailSender,
  createGoogleGmailWatch,
  createOpenAiClient,
  createOpenAiRfqMailDrafter,
  createOpenAiRfqSuggester,
  createPrismaAttachmentRepository,
  createPrismaClassificationRuleRepository,
  createPrismaVendorRepository,
  createPrismaEmailClassificationRepository,
  createPrismaEmailReadRepository,
  createPrismaMailboxConnectionRepository,
  createPrismaMailboxCredentialsRepository,
  createPrismaRfqRepository,
  createPrismaSentMailRepository,
  createPrismaSignatureImageRepository,
  createPrismaTenantRepository,
  createEncryptionUtil,
  initializePrismaClient,
  loadConfig,
} from '@lc/core';
import { createAppInstance } from './createAppInstance.js';
import { createS3AttachmentContentReader } from './emails/attachmentContentReader.js';
import { createS3AttachmentDownloadUrlSigner } from './emails/attachmentDownloadUrlSigner.js';
import { createS3SignatureImageStore } from './signature/signatureImageStore.js';
import { shutdownTelemetry } from './instrumentation.js';

// Composition root: the only place in the API that reads process.env and builds singletons.
const config = loadConfig(process.env);
// Core treats these as optional (Lambdas need only some of them); the API needs all three, so
// a missing one stops the process at boot instead of failing the first request that uses it.
if (!config.SESSION_SECRET) throw new Error('SESSION_SECRET is required for the API');
if (!config.TOKEN_ENCRYPTION_KEY) throw new Error('TOKEN_ENCRYPTION_KEY is required for the API');
if (!config.GOOGLE_REDIRECT_URI) throw new Error('GOOGLE_REDIRECT_URI is required for the API');
const prismaClient = initializePrismaClient(config, { maxConnections: 4 });
// Optional: without a bucket the API still lists attachments, and download links answer 503.
// Credentials come from the standard AWS_* variables (the infra RailwayApiUser's access key).
const s3Client = new S3Client({ region: config.AWS_REGION });
const attachmentDownloadUrlSigner = config.RAW_MAIL_BUCKET_NAME
  ? createS3AttachmentDownloadUrlSigner({ s3Client, bucketName: config.RAW_MAIL_BUCKET_NAME })
  : undefined;
if (!attachmentDownloadUrlSigner)
  console.warn('RAW_MAIL_BUCKET_NAME unset: attachment downloads and signature images disabled');
// Optional for the same reason: without a bucket the signature image routes answer 503.
const signatureImageStore = config.RAW_MAIL_BUCKET_NAME
  ? createS3SignatureImageStore({ s3Client, bucketName: config.RAW_MAIL_BUCKET_NAME })
  : undefined;
// Optional: the suggester reads PDF and image attachments only when switched on and the bucket is known.
const attachmentContentReader =
  config.LLM_SUGGEST_RFQ_INCLUDE_ATTACHMENTS && config.RAW_MAIL_BUCKET_NAME
    ? createS3AttachmentContentReader({ s3Client, bucketName: config.RAW_MAIL_BUCKET_NAME })
    : undefined;
// Optional: without a key the RFQ page has no prefill and no drafts; both routes answer 503.
const openAiClient = config.OPENAI_API_KEY ? createOpenAiClient(config.OPENAI_API_KEY) : undefined;
const rfqSuggester = openAiClient
  ? createOpenAiRfqSuggester({ openAiClient, model: config.MODEL_SUGGEST_RFQ })
  : undefined;
const rfqMailDrafter = openAiClient
  ? createOpenAiRfqMailDrafter({ openAiClient, model: config.MODEL_DRAFT_RFQ })
  : undefined;
if (!openAiClient) console.warn('OPENAI_API_KEY unset: RFQ suggestions and drafts disabled');
const expressApp = createAppInstance({
  config,
  tenantRepository: createPrismaTenantRepository(prismaClient),
  mailboxCredentialsRepository: createPrismaMailboxCredentialsRepository(prismaClient),
  mailboxConnectionRepository: createPrismaMailboxConnectionRepository(prismaClient),
  emailReadRepository: createPrismaEmailReadRepository(prismaClient),
  attachmentRepository: createPrismaAttachmentRepository(prismaClient),
  classificationRuleRepository: createPrismaClassificationRuleRepository(prismaClient),
  vendorRepository: createPrismaVendorRepository(prismaClient),
  emailClassificationRepository: createPrismaEmailClassificationRepository(prismaClient),
  sentMailRepository: createPrismaSentMailRepository(prismaClient),
  rfqRepository: createPrismaRfqRepository(prismaClient),
  signatureImageRepository: createPrismaSignatureImageRepository(prismaClient),
  signatureImageStore,
  attachmentDownloadUrlSigner,
  rfqSuggester,
  attachmentContentReader,
  rfqMailDrafter,
  gmailOAuth: createGoogleGmailOAuth({ redirectUri: config.GOOGLE_REDIRECT_URI }),
  gmailWatch: createGoogleGmailWatch(),
  // Safe mode by stage: staging must set OUTBOUND_MAIL_REDIRECT_TO, prod must not; this throws otherwise.
  gmailSender: createGoogleGmailSender({
    stage: config.STAGE,
    redirectAllMailTo: config.OUTBOUND_MAIL_REDIRECT_TO,
  }),
  encryptionUtil: createEncryptionUtil(config.TOKEN_ENCRYPTION_KEY),
  sessionSecret: config.SESSION_SECRET,
});

const httpServer = expressApp.listen(config.PORT, () => {
  console.log(`api listening on :${config.PORT} (${config.STAGE})`);
});

// Railway sends SIGTERM on deploy; finish in-flight requests, flush telemetry, then exit.
const DRAIN_TIMEOUT_MS = 30_000;
function shutdown(signal: NodeJS.Signals): void {
  console.log(`${signal} received, draining`);
  httpServer.close(() => {
    Promise.all([shutdownTelemetry(), prismaClient.$disconnect()]).then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('telemetry shutdown failed', error);
        process.exit(1);
      },
    );
  });
  setTimeout(() => process.exit(1), DRAIN_TIMEOUT_MS).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
