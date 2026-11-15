import express from 'express';
import type { RequestHandler, Router } from 'express';
import createHttpError from 'http-errors';
import {
  MAX_ATTACHMENTS_SENT,
  MAX_ATTACHMENT_BASE64_CHARACTERS_SENT,
  isNativeAttachmentContentType,
} from '@lc/core';
import type {
  AttachmentRepository,
  AttachmentSummary,
  EmailReadRepository,
  MailboxScope,
  ParsedAttachment,
  RfqSuggester,
} from '@lc/core';
import type { RfqSuggestionResponse } from '@lc/contract';
import { getSession } from '../auth/requireSession.js';
import type { AttachmentContentReader } from '../emails/attachmentContentReader.js';
import { parseIdOr404 } from '../http/parseIdOr404.js';

export interface RfqSuggestionsRouterDependencies {
  emailReadRepository: EmailReadRepository;
  attachmentRepository: AttachmentRepository;
  /** Undefined when no OPENAI_API_KEY is configured: the route answers 503 and the operator fills the form by hand. */
  rfqSuggester: RfqSuggester | undefined;
  /**
   * Undefined when LLM_SUGGEST_RFQ_INCLUDE_ATTACHMENTS is off or no bucket is configured: the model
   * reads the mail text only. Set: its PDF and image attachments are fetched and sent along.
   */
  attachmentContentReader: AttachmentContentReader | undefined;
  requireSession: RequestHandler;
}

/**
 * Prefill for the RFQ form, mounted at /v1/mailbox/emails.
 *   POST /:emailId/rfq-suggestion   200 RfqSuggestionResponse; 404 email_not_found outside the session's
 *                                   mailbox; 503 suggestion_unavailable (LLM off or down, try again);
 *                                   422 suggestion_failed (the mail could not be read, fill the form by hand)
 * Nothing is stored: the operator's corrected form is what reaches drafting and sending.
 */
export function createRfqSuggestionsRouter({
  emailReadRepository,
  attachmentRepository,
  rfqSuggester,
  attachmentContentReader,
  requireSession,
}: RfqSuggestionsRouterDependencies): Router {
  const router = express.Router();

  router.post('/:emailId/rfq-suggestion', requireSession, async (request, response) => {
    const emailId = parseIdOr404(request.params.emailId);
    const scope = getSession(response);
    const email = await emailReadRepository.findEmail(scope, emailId);
    if (!email) throw createHttpError(404, 'email_not_found');
    // 5xx are answered here: the app's error handler reports any thrown 5xx as internal_error.
    if (!rfqSuggester) {
      response.status(503).json({ error: 'suggestion_unavailable' });
      return;
    }

    const attachments = attachmentContentReader
      ? await loadReadableAttachments(attachmentRepository, attachmentContentReader, scope, emailId)
      : [];
    const result = await rfqSuggester.suggest({
      senderName: email.senderName,
      senderEmail: email.senderEmail ?? undefined,
      subject: email.subject,
      bodyText: email.bodyText,
      attachments,
    });
    if (result.outcome === 'retry') {
      console.warn('rfq suggestion: provider unavailable', { emailId, detail: result.detail });
      response.status(503).json({ error: 'suggestion_unavailable' });
      return;
    }
    if (result.outcome === 'failed') {
      console.warn('rfq suggestion: failed', { emailId, detail: result.detail });
      throw createHttpError(422, 'suggestion_failed');
    }
    const body: RfqSuggestionResponse = {
      ...result.suggestion,
      model: result.model,
      promptVersion: result.promptVersion,
    };
    response.status(200).json(body);
  });

  return router;
}

/** base64 grows bytes by 4/3; a file that alone would blow the shared cap is not worth fetching. */
const MAX_FETCHED_ATTACHMENT_BYTES = Math.floor((MAX_ATTACHMENT_BASE64_CHARACTERS_SENT * 3) / 4);

/**
 * The files the model can read, fetched from the bucket: real (not inline) PDFs and images, within the
 * same count and size caps the classifier applies when it sends attachments. A fetch failure drops
 * that file and logs; the suggestion goes ahead on the text, as a half-read mail beats no prefill.
 */
async function loadReadableAttachments(
  attachmentRepository: AttachmentRepository,
  attachmentContentReader: AttachmentContentReader,
  scope: MailboxScope,
  emailId: string,
): Promise<ParsedAttachment[]> {
  const stored = (await attachmentRepository.listAttachments(scope, emailId)) ?? [];
  const readable = stored
    .filter(
      (attachment) =>
        !attachment.isInline &&
        isNativeAttachmentContentType(attachment.contentType) &&
        attachment.sizeBytes <= MAX_FETCHED_ATTACHMENT_BYTES,
    )
    .slice(0, MAX_ATTACHMENTS_SENT);
  const loaded = await Promise.all(
    readable.map(async (attachment): Promise<ParsedAttachment | undefined> => {
      try {
        return toParsedAttachment(
          attachment,
          await attachmentContentReader.readContent(attachment),
        );
      } catch (error) {
        console.warn('rfq suggestion: attachment not fetched, continuing without it', {
          emailId,
          attachmentId: attachment.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      }
    }),
  );
  return loaded.filter((attachment): attachment is ParsedAttachment => attachment !== undefined);
}

function toParsedAttachment(attachment: AttachmentSummary, content: Uint8Array): ParsedAttachment {
  return {
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    sizeBytes: content.byteLength,
    content,
    contentId: attachment.contentId,
    isInline: attachment.isInline,
  };
}
