import OpenAI, { APIConnectionError, APIError } from 'openai';
import type { Response, ResponseInputContent } from 'openai/resources/responses/responses';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { CLASSIFICATION_LABELS } from '../../classification/classificationLabel.js';
import type { LlmClassification } from '../../classification/emailClassification.js';
import {
  CLASSIFY_EMAIL_MAX_BODY_CHARACTERS,
  CLASSIFY_EMAIL_PROMPT_VERSION,
  CLASSIFY_EMAIL_SYSTEM_PROMPT,
} from '../../classification/prompts/classifyEmailPromptV1.js';
import { runInsideSpan } from '../../telemetry/runInsideSpan.js';
import type { ParsedAttachment } from '../../utils/mime/parsedEmail.js';

export interface EmailToClassify {
  senderName: string;
  senderEmail: string | undefined;
  subject: string;
  bodyText: string;
  /** Every parsed part; inline images (body decoration) are filtered out here, the rest is sent only when the switch is on. */
  attachments: ParsedAttachment[];
}

/**
 * retry: the provider was unavailable or rate-limited; the caller returns the record to the queue.
 * failed: the request itself is wrong (rejected input, refusal, unparseable output); the caller
 * stores the mail unclassified and logs, because a broken prompt must never lose mail.
 */
export type ClassifierOutcome =
  | { outcome: 'classified'; classification: LlmClassification }
  | { outcome: 'retry'; detail: string }
  | { outcome: 'failed'; detail: string };

export interface EmailClassifier {
  classify(email: EmailToClassify): Promise<ClassifierOutcome>;
}

/** Per-request ceiling; SQS owns retries, so the SDK must not retry on its own. */
export const CLASSIFY_REQUEST_TIMEOUT_MS = 20_000;
/** Files the model reads natively. Anything else is named but not sent. */
const NATIVE_FILE_CONTENT_TYPES = new Set(['application/pdf']);
const NATIVE_IMAGE_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/**
 * Caps on what one classification may upload, measured as base64 (what the request carries, a third
 * larger than the file): tokens cost money, a retry pays again and the request has a size limit.
 */
export const MAX_ATTACHMENTS_SENT = 5;
export const MAX_ATTACHMENT_BASE64_CHARACTERS_SENT = 4 * 1024 * 1024;
/**
 * Room for the small JSON answer plus a reasoning model's hidden tokens, which count against the
 * same limit; an incomplete answer is stored as unclassified, so the ceiling is generous.
 */
const MAX_OUTPUT_TOKENS = 1000;
/** Structured output enforces type and enum but not string length; a cap would only make a valid label unparseable. */
const classificationOutputSchema = z.object({
  label: z.enum(CLASSIFICATION_LABELS),
  confidence: z.number().min(0).max(1),
  reason: z.string().describe('One short sentence.'),
});

export function createOpenAiClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey, maxRetries: 0, timeout: CLASSIFY_REQUEST_TIMEOUT_MS });
}

export interface OpenAiEmailClassifierOptions {
  openAiClient: OpenAI;
  model: string;
  /** LLM_CLASSIFY_INCLUDE_ATTACHMENTS: send PDF and image attachments to the model as well. */
  includeAttachments: boolean;
}

export function createOpenAiEmailClassifier({
  openAiClient,
  model,
  includeAttachments,
}: OpenAiEmailClassifierOptions): EmailClassifier {
  return {
    async classify(email) {
      const content = buildUserContent(email, includeAttachments);
      try {
        const response = await runInsideSpan(
          'openai.classifyEmail',
          () =>
            openAiClient.responses.parse({
              model,
              instructions: CLASSIFY_EMAIL_SYSTEM_PROMPT,
              input: [{ role: 'user', content }],
              text: { format: zodTextFormat(classificationOutputSchema, 'email_classification') },
              max_output_tokens: MAX_OUTPUT_TOKENS,
              store: false,
            }),
          { 'llm.model': model, 'llm.prompt_version': CLASSIFY_EMAIL_PROMPT_VERSION },
        );
        const parsed = response.output_parsed;
        if (!parsed) return { outcome: 'failed', detail: describeMissingOutput(response) };
        return {
          outcome: 'classified',
          classification: {
            source: 'llm',
            label: parsed.label,
            confidence: parsed.confidence,
            llmModel: response.model || model,
            promptVersion: CLASSIFY_EMAIL_PROMPT_VERSION,
          },
        };
      } catch (error) {
        return toClassifierOutcome(error);
      }
    },
  };
}

/**
 * The mail as data, then (switch on) each real file: PDFs and images natively, the rest by name.
 * Header fields lose line breaks and every field loses "</email", so mail content cannot forge a
 * header line or close the data block and read as instructions.
 */
export function buildUserContent(
  email: EmailToClassify,
  includeAttachments: boolean,
): ResponseInputContent[] {
  const realFiles = email.attachments.filter((attachment) => !attachment.isInline);
  const bodyText = asEmailData(
    email.bodyText.length > CLASSIFY_EMAIL_MAX_BODY_CHARACTERS
      ? `${email.bodyText.slice(0, CLASSIFY_EMAIL_MAX_BODY_CHARACTERS)}\n[truncated]`
      : email.bodyText,
  );
  const attachmentLines = realFiles.map(
    (attachment) =>
      `- ${asHeaderField(attachment.fileName)} (${asHeaderField(attachment.contentType)}, ${attachment.sizeBytes} bytes)`,
  );
  const header = [
    `From: ${asHeaderField(email.senderName)} <${asHeaderField(email.senderEmail ?? 'unknown')}>`,
    `Subject: ${asHeaderField(email.subject)}`,
    attachmentLines.length > 0
      ? `Attachments:\n${attachmentLines.join('\n')}`
      : 'Attachments: none',
  ].join('\n');
  const content: ResponseInputContent[] = [
    { type: 'input_text', text: `<email>\n${header}\n\n${bodyText}\n</email>` },
  ];
  if (!includeAttachments) return content;

  let base64CharactersSent = 0;
  let filesSent = 0;
  for (const attachment of realFiles) {
    if (filesSent >= MAX_ATTACHMENTS_SENT) break;
    const isNativeFile = NATIVE_FILE_CONTENT_TYPES.has(attachment.contentType);
    const isNativeImage = NATIVE_IMAGE_CONTENT_TYPES.has(attachment.contentType);
    if (!isNativeFile && !isNativeImage) continue;
    const base64 = Buffer.from(attachment.content).toString('base64');
    if (base64CharactersSent + base64.length > MAX_ATTACHMENT_BASE64_CHARACTERS_SENT) continue;
    content.push(
      isNativeFile
        ? {
            type: 'input_file',
            filename: attachment.fileName,
            file_data: `data:${attachment.contentType};base64,${base64}`,
          }
        : {
            type: 'input_image',
            detail: 'low',
            image_url: `data:${attachment.contentType};base64,${base64}`,
          },
    );
    base64CharactersSent += base64.length;
    filesSent += 1;
  }
  return content;
}

const EMAIL_CLOSING_TAG_PATTERN = /<\/email/gi;

function asEmailData(text: string): string {
  return text.replace(EMAIL_CLOSING_TAG_PATTERN, '</ email');
}

function asHeaderField(text: string): string {
  return asEmailData(text.replace(/[\r\n]+/g, ' '));
}

/** Why a successful response carried no parsed answer: cut off, refused, or simply empty. */
function describeMissingOutput(response: Response): string {
  if (response.incomplete_details?.reason)
    return `incomplete: ${response.incomplete_details.reason}`;
  for (const item of response.output) {
    if (item.type !== 'message') continue;
    for (const part of item.content) {
      if (part.type === 'refusal') return `refusal: ${part.refusal}`;
    }
  }
  return 'no parsed output';
}

/** 429 is also what an account out of credit gets; that does not pass with time. */
const OUT_OF_CREDIT_ERROR_CODE = 'insufficient_quota';

/** 429 (rate limit) and 5xx are the provider's problem and worth another attempt; anything else is ours. */
function toClassifierOutcome(error: unknown): ClassifierOutcome {
  // Covers APIConnectionTimeoutError, a subclass.
  if (error instanceof APIConnectionError) return { outcome: 'retry', detail: error.message };
  if (error instanceof APIError) {
    const status = error.status ?? 0;
    const outOfCredit = error.code === OUT_OF_CREDIT_ERROR_CODE;
    const transient = !outOfCredit && (status === 429 || status >= 500);
    return { outcome: transient ? 'retry' : 'failed', detail: `${status} ${error.message}` };
  }
  return { outcome: 'failed', detail: error instanceof Error ? error.message : String(error) };
}
